// ABOUTME: Bridge for routing non-local tool calls to the frontend for execution.
// ABOUTME: ChatModelWorker registers pending tool calls; frontend submits results.

use std::collections::HashMap;
use tokio::sync::{Mutex, oneshot};

/// Result of a tool execution performed by the frontend.
pub struct ToolExecutionResult {
    pub content: String,
    pub is_error: bool,
}

/// Shared bridge between the Rust ChatModelWorker and the frontend tool executor.
///
/// When ChatModelWorker encounters a non-local tool (gateway__, mcp__, openclaw__),
/// it registers a pending request here and waits. The frontend executes the tool
/// and submits the result via the `submit_tool_result` Tauri command.
pub struct ToolResultBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<ToolExecutionResult>>>,
}

impl ToolResultBridge {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Register a pending tool call. Returns a receiver that the worker awaits.
    pub async fn register(&self, tool_call_id: &str) -> oneshot::Receiver<ToolExecutionResult> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        pending.insert(tool_call_id.to_string(), tx);
        rx
    }

    /// Submit a tool result from the frontend. Returns true if a pending request was found.
    pub async fn submit(
        &self,
        tool_call_id: &str,
        content: String,
        is_error: bool,
    ) -> bool {
        let mut pending = self.pending.lock().await;
        if let Some(tx) = pending.remove(tool_call_id) {
            let _ = tx.send(ToolExecutionResult { content, is_error });
            true
        } else {
            log::warn!(
                "[ToolResultBridge] No pending request for tool_call_id: {}",
                tool_call_id
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_submit_round_trip() {
        let bridge = ToolResultBridge::new();

        let rx = bridge.register("tc_1").await;

        let submitted = bridge
            .submit("tc_1", "result content".to_string(), false)
            .await;
        assert!(submitted);

        let result = rx.await.unwrap();
        assert_eq!(result.content, "result content");
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn submit_unknown_id_returns_false() {
        let bridge = ToolResultBridge::new();
        let submitted = bridge.submit("nonexistent", "data".to_string(), false).await;
        assert!(!submitted);
    }

    #[tokio::test]
    async fn submit_error_result() {
        let bridge = ToolResultBridge::new();
        let rx = bridge.register("tc_err").await;

        bridge
            .submit("tc_err", "tool failed".to_string(), true)
            .await;

        let result = rx.await.unwrap();
        assert_eq!(result.content, "tool failed");
        assert!(result.is_error);
    }

    #[tokio::test]
    async fn multiple_concurrent_requests() {
        let bridge = ToolResultBridge::new();

        let rx1 = bridge.register("tc_a").await;
        let rx2 = bridge.register("tc_b").await;

        bridge.submit("tc_b", "result_b".to_string(), false).await;
        bridge.submit("tc_a", "result_a".to_string(), false).await;

        let r1 = rx1.await.unwrap();
        let r2 = rx2.await.unwrap();
        assert_eq!(r1.content, "result_a");
        assert_eq!(r2.content, "result_b");
    }
}
