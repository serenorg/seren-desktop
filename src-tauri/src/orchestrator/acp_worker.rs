// ABOUTME: ACP worker adapter that wraps the existing ACP sidecar infrastructure.
// ABOUTME: Translates ACP session events into WorkerEvent types for the orchestrator.

use async_trait::async_trait;
use log;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, mpsc};

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

/// ACP worker adapter that delegates to the existing ACP session infrastructure.
///
/// Holds a reference to the Tauri `AppHandle` to access `AcpState` and emit events.
/// The actual ACP session lifecycle (spawn, terminate) is managed by the existing
/// ACP commands — this adapter only handles prompt execution and event translation.
pub struct AcpWorker {
    app: AppHandle,
    session_id: Arc<Mutex<Option<String>>>,
}

impl AcpWorker {
    pub fn new(app: AppHandle, session_id: Option<String>) -> Self {
        Self {
            app,
            session_id: Arc::new(Mutex::new(session_id)),
        }
    }
}

#[async_trait]
impl Worker for AcpWorker {
    fn id(&self) -> &str {
        "acp_agent"
    }

    async fn execute(
        &self,
        prompt: &str,
        _conversation_context: &[Value],
        routing: &RoutingDecision,
        _skill_content: &str,
        _app: &tauri::AppHandle,
        _images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "No active ACP session".to_string())?;

        log::info!(
            "[AcpWorker] Executing prompt on session {} with model {}",
            session_id,
            routing.model_id
        );
        log::debug!(
            "[AcpWorker] Prompt preview: {}",
            &prompt[..prompt.len().min(50)]
        );

        // Access AcpState through the AppHandle
        let acp_state: tauri::State<'_, crate::acp::AcpState> = self.app.state();

        // Get the command channel for the session
        let command_tx = {
            let sessions = acp_state.sessions.read().await;
            let session_arc = sessions
                .get(&session_id)
                .ok_or_else(|| format!("ACP session '{}' not found", session_id))?;
            let session = session_arc.lock().await;
            session
                .command_tx
                .clone()
                .ok_or_else(|| "ACP session not initialized".to_string())?
        };

        // Send the prompt via the existing command channel
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();

        command_tx
            .send(crate::acp::AcpCommand::Prompt {
                prompt: prompt.to_string(),
                context: None,
                response_tx,
            })
            .await
            .map_err(|_| "Failed to send prompt to ACP session".to_string())?;

        // Wait for the prompt to complete
        // Note: During execution, the existing ACP infrastructure emits events via app.emit().
        // In Phase 3 (service.rs), we'll intercept these events and forward them through event_tx.
        // For now, we wait for completion and send a final Complete event.
        let result = response_rx
            .await
            .map_err(|_| "ACP worker thread dropped".to_string())?;

        match result {
            Ok(()) => {
                event_tx
                    .send(WorkerEvent::Complete {
                        final_content: String::new(),
                        thinking: None,
                        cost: None,
                    })
                    .await
                    .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                Ok(())
            }
            Err(e) => {
                event_tx
                    .send(WorkerEvent::Error { message: e.clone() })
                    .await
                    .map_err(|send_err| format!("Failed to send Error event: {}", send_err))?;
                Err(e)
            }
        }
    }

    async fn cancel(&self) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "No active ACP session".to_string())?;

        let acp_state: tauri::State<'_, crate::acp::AcpState> = self.app.state();

        let command_tx = {
            let sessions = acp_state.sessions.read().await;
            let session_arc = sessions
                .get(&session_id)
                .ok_or_else(|| format!("ACP session '{}' not found", session_id))?;
            let session = session_arc.lock().await;
            session
                .command_tx
                .clone()
                .ok_or_else(|| "ACP session not initialized".to_string())?
        };

        let (response_tx, response_rx) = tokio::sync::oneshot::channel();

        command_tx
            .send(crate::acp::AcpCommand::Cancel { response_tx })
            .await
            .map_err(|_| "Failed to send cancel to ACP session".to_string())?;

        response_rx
            .await
            .map_err(|_| "ACP worker thread dropped".to_string())?
    }
}

// =============================================================================
// ACP Event → WorkerEvent Mapping
// =============================================================================

/// Map an ACP message chunk event to a WorkerEvent.
///
/// ACP emits: `{ "sessionId": "...", "text": "...", "isThought": false }`
pub fn map_message_chunk(payload: &Value) -> Option<WorkerEvent> {
    let text = payload.get("text")?.as_str()?.to_string();
    let is_thought = payload
        .get("isThought")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if text.is_empty() {
        return None;
    }

    if is_thought {
        Some(WorkerEvent::Thinking { text })
    } else {
        Some(WorkerEvent::Content { text })
    }
}

/// Map an ACP tool call event to a WorkerEvent.
///
/// ACP emits: `{ "sessionId": "...", "toolCallId": "...", "title": "...", "kind": "...", "status": "..." }`
pub fn map_tool_call(payload: &Value) -> Option<WorkerEvent> {
    let tool_call_id = payload.get("toolCallId")?.as_str()?.to_string();
    let title = payload
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let kind = payload
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(WorkerEvent::ToolCall {
        tool_call_id,
        name: kind.clone(),
        arguments: String::new(),
        title,
    })
}

/// Map an ACP tool result event to a WorkerEvent.
///
/// ACP emits: `{ "sessionId": "...", "toolCallId": "...", "status": "..." }`
pub fn map_tool_result(payload: &Value) -> Option<WorkerEvent> {
    let tool_call_id = payload.get("toolCallId")?.as_str()?.to_string();
    let status = payload
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    let is_error =
        status.to_lowercase().contains("error") || status.to_lowercase().contains("fail");

    Some(WorkerEvent::ToolResult {
        tool_call_id,
        content: String::new(),
        is_error,
    })
}

/// Map an ACP diff event to a WorkerEvent.
///
/// ACP emits: `{ "sessionId": "...", "toolCallId": "...", "path": "...", "oldText": "...", "newText": "..." }`
pub fn map_diff(payload: &Value) -> Option<WorkerEvent> {
    let path = payload.get("path")?.as_str()?.to_string();
    let old_text = payload
        .get("oldText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let new_text = payload
        .get("newText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_call_id = payload
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(WorkerEvent::Diff {
        path,
        old_text,
        new_text,
        tool_call_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_message_chunk_to_content() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "text": "hello",
            "isThought": false
        });
        let event = map_message_chunk(&payload).unwrap();
        match event {
            WorkerEvent::Content { text } => assert_eq!(text, "hello"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn maps_thought_chunk_to_thinking() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "text": "reasoning about the problem",
            "isThought": true
        });
        let event = map_message_chunk(&payload).unwrap();
        match event {
            WorkerEvent::Thinking { text } => assert_eq!(text, "reasoning about the problem"),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn ignores_empty_message_chunk() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "text": "",
            "isThought": false
        });
        assert!(map_message_chunk(&payload).is_none());
    }

    #[test]
    fn maps_tool_call_event() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "toolCallId": "tc_1",
            "title": "read_file",
            "kind": "file",
            "status": "Pending"
        });
        let event = map_tool_call(&payload).unwrap();
        match event {
            WorkerEvent::ToolCall {
                tool_call_id,
                name,
                title,
                ..
            } => {
                assert_eq!(tool_call_id, "tc_1");
                assert_eq!(title, "read_file");
                assert_eq!(name, "file");
            }
            _ => panic!("Expected ToolCall event"),
        }
    }

    #[test]
    fn maps_tool_result_success() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "toolCallId": "tc_1",
            "status": "Completed"
        });
        let event = map_tool_result(&payload).unwrap();
        match event {
            WorkerEvent::ToolResult {
                tool_call_id,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "tc_1");
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult event"),
        }
    }

    #[test]
    fn maps_tool_result_error() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "toolCallId": "tc_1",
            "status": "Error"
        });
        let event = map_tool_result(&payload).unwrap();
        match event {
            WorkerEvent::ToolResult { is_error, .. } => assert!(is_error),
            _ => panic!("Expected ToolResult event"),
        }
    }

    #[test]
    fn maps_diff_event() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "toolCallId": "tc_2",
            "path": "src/main.rs",
            "oldText": "fn main() {}",
            "newText": "fn main() { println!(\"hello\"); }"
        });
        let event = map_diff(&payload).unwrap();
        match event {
            WorkerEvent::Diff {
                path,
                old_text,
                new_text,
                tool_call_id,
            } => {
                assert_eq!(path, "src/main.rs");
                assert_eq!(old_text, "fn main() {}");
                assert!(new_text.contains("hello"));
                assert_eq!(tool_call_id, Some("tc_2".to_string()));
            }
            _ => panic!("Expected Diff event"),
        }
    }

    #[test]
    fn maps_diff_without_tool_call_id() {
        let payload = serde_json::json!({
            "sessionId": "s1",
            "path": "README.md",
            "oldText": "old content",
            "newText": "new content"
        });
        let event = map_diff(&payload).unwrap();
        match event {
            WorkerEvent::Diff { tool_call_id, .. } => {
                assert_eq!(tool_call_id, None);
            }
            _ => panic!("Expected Diff event"),
        }
    }

    #[test]
    fn returns_none_for_missing_required_fields() {
        // Missing text
        let payload = serde_json::json!({ "sessionId": "s1" });
        assert!(map_message_chunk(&payload).is_none());

        // Missing toolCallId
        let payload = serde_json::json!({ "sessionId": "s1", "title": "test" });
        assert!(map_tool_call(&payload).is_none());

        // Missing path
        let payload = serde_json::json!({ "sessionId": "s1", "oldText": "", "newText": "" });
        assert!(map_diff(&payload).is_none());
    }
}
