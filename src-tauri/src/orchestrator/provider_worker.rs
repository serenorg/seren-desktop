// ABOUTME: Orchestrator worker that delegates execution to the local provider runtime.
// ABOUTME: Connects to the desktop/browser-local provider runtime over WebSocket and streams provider events.

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const AUTH_REQUEST_ID: i64 = 1;
const PROMPT_REQUEST_ID: i64 = 2;
const CANCEL_REQUEST_ID: i64 = 3;

pub struct ProviderRuntimeWorker {
    app: AppHandle,
    session_id: Arc<Mutex<Option<String>>>,
}

impl ProviderRuntimeWorker {
    pub fn new(app: AppHandle, session_id: Option<String>) -> Self {
        Self {
            app,
            session_id: Arc::new(Mutex::new(session_id)),
        }
    }
}

#[async_trait]
impl Worker for ProviderRuntimeWorker {
    fn id(&self) -> &str {
        "local_provider_agent"
    }

    async fn execute(
        &self,
        _conversation_id: &str,
        prompt: &str,
        _conversation_context: &[Value],
        _routing: &RoutingDecision,
        skill_content: &str,
        _app: &tauri::AppHandle,
        _images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "No active local provider session".to_string())?;

        let state: tauri::State<'_, crate::provider_runtime::ProviderRuntimeState> =
            self.app.state();
        let config = state.ensure_started(&self.app).await?;

        let (mut socket, _response) = connect_async(config.ws_base_url.clone())
            .await
            .map_err(|err| format!("Failed to connect to provider runtime: {}", err))?;

        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "id": AUTH_REQUEST_ID,
                    "method": "auth",
                    "params": { "token": config.token },
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|err| format!("Failed to authenticate provider runtime socket: {}", err))?;

        wait_for_response(&mut socket, AUTH_REQUEST_ID)
            .await
            .map(|_| ())?;

        let context = if skill_content.trim().is_empty() {
            None
        } else {
            Some(vec![json!({
                "type": "text",
                "text": skill_content,
            })])
        };

        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "id": PROMPT_REQUEST_ID,
                    "method": "provider_prompt",
                    "params": {
                        "sessionId": session_id,
                        "prompt": prompt,
                        "context": context,
                    },
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|err| format!("Failed to send provider prompt: {}", err))?;

        let mut saw_complete = false;
        while let Some(message) = socket.next().await {
            let message =
                message.map_err(|err| format!("Provider runtime socket error: {}", err))?;
            let Message::Text(text) = message else {
                continue;
            };

            let payload: Value = serde_json::from_str(&text)
                .map_err(|err| format!("Invalid provider runtime payload: {}", err))?;

            if let Some(id) = payload.get("id").and_then(|value| value.as_i64()) {
                if id != PROMPT_REQUEST_ID {
                    continue;
                }

                if let Some(error_message) = response_error_message(&payload) {
                    let _ = event_tx
                        .send(WorkerEvent::Error {
                            message: error_message.clone(),
                        })
                        .await;
                    return Err(error_message);
                }

                if !saw_complete {
                    event_tx
                        .send(WorkerEvent::Complete {
                            final_content: String::new(),
                            thinking: None,
                            cost: None,
                            rlm_steps: None,
                        })
                        .await
                        .map_err(|err| format!("Failed to send completion event: {}", err))?;
                }

                return Ok(());
            }

            if payload.get("id").is_some() || payload.get("method").is_none() {
                continue;
            }

            let method = payload
                .get("method")
                .and_then(|value| value.as_str())
                .unwrap_or_default();

            if !method.starts_with("provider://") {
                continue;
            }

            let params = payload.get("params").cloned().unwrap_or(Value::Null);
            if event_session_id(&params) != Some(session_id.as_str()) {
                continue;
            }

            match map_provider_event(method, &params) {
                Some(WorkerEvent::Complete { .. }) => {
                    saw_complete = true;
                    event_tx
                        .send(WorkerEvent::Complete {
                            final_content: String::new(),
                            thinking: None,
                            cost: None,
                            rlm_steps: None,
                        })
                        .await
                        .map_err(|err| format!("Failed to send completion event: {}", err))?;
                }
                Some(worker_event) => {
                    event_tx
                        .send(worker_event)
                        .await
                        .map_err(|err| format!("Failed to forward provider event: {}", err))?;
                }
                None => {}
            }
        }

        Err("Provider runtime socket closed before prompt completed.".to_string())
    }

    async fn cancel(&self) -> Result<(), String> {
        let session_id = self
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "No active local provider session".to_string())?;

        let state: tauri::State<'_, crate::provider_runtime::ProviderRuntimeState> =
            self.app.state();
        let config = state.ensure_started(&self.app).await?;
        let (mut socket, _response) = connect_async(config.ws_base_url.clone())
            .await
            .map_err(|err| format!("Failed to connect to provider runtime: {}", err))?;

        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "id": AUTH_REQUEST_ID,
                    "method": "auth",
                    "params": { "token": config.token },
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|err| format!("Failed to authenticate provider runtime socket: {}", err))?;
        wait_for_response(&mut socket, AUTH_REQUEST_ID)
            .await
            .map(|_| ())?;

        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0",
                    "id": CANCEL_REQUEST_ID,
                    "method": "provider_cancel",
                    "params": {
                        "sessionId": session_id,
                    },
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|err| format!("Failed to send provider cancel: {}", err))?;

        wait_for_response(&mut socket, CANCEL_REQUEST_ID)
            .await
            .map(|_| ())
    }
}

async fn wait_for_response(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    request_id: i64,
) -> Result<Value, String> {
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| format!("Provider runtime socket error: {}", err))?;
        let Message::Text(text) = message else {
            continue;
        };
        let payload: Value = serde_json::from_str(&text)
            .map_err(|err| format!("Invalid provider runtime payload: {}", err))?;

        if payload
            .get("id")
            .and_then(|value| value.as_i64())
            .is_some_and(|id| id == request_id)
        {
            if let Some(error_message) = response_error_message(&payload) {
                return Err(error_message);
            }
            return Ok(payload);
        }
    }

    Err("Provider runtime socket closed before response.".to_string())
}

fn response_error_message(payload: &Value) -> Option<String> {
    payload
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_str())
        .map(String::from)
}

fn event_session_id(payload: &Value) -> Option<&str> {
    payload.get("sessionId").and_then(|value| value.as_str())
}

fn map_provider_event(method: &str, payload: &Value) -> Option<WorkerEvent> {
    match method {
        "provider://message-chunk" => {
            let text = payload.get("text")?.as_str()?.to_string();
            if text.is_empty() {
                return None;
            }

            if payload
                .get("isThought")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                Some(WorkerEvent::Thinking { text })
            } else {
                Some(WorkerEvent::Content { text })
            }
        }
        "provider://tool-call" => {
            let tool_call_id = payload.get("toolCallId")?.as_str()?.to_string();
            let title = payload
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Tool call")
                .to_string();
            let name = payload
                .get("kind")
                .and_then(|value| value.as_str())
                .unwrap_or("tool")
                .to_string();
            let arguments = payload
                .get("parameters")
                .map(|value| value.to_string())
                .unwrap_or_else(|| "{}".to_string());

            Some(WorkerEvent::ToolCall {
                tool_call_id,
                name,
                arguments,
                title,
            })
        }
        "provider://tool-result" => Some(WorkerEvent::ToolResult {
            tool_call_id: payload.get("toolCallId")?.as_str()?.to_string(),
            content: payload
                .get("result")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            is_error: payload.get("error").is_some()
                || payload
                    .get("status")
                    .and_then(|value| value.as_str())
                    .map(|status| {
                        let lower = status.to_lowercase();
                        lower.contains("error") || lower.contains("fail")
                    })
                    .unwrap_or(false),
        }),
        "provider://diff" => Some(WorkerEvent::Diff {
            path: payload.get("path")?.as_str()?.to_string(),
            old_text: payload
                .get("oldText")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            new_text: payload
                .get("newText")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            tool_call_id: payload
                .get("toolCallId")
                .and_then(|value| value.as_str())
                .map(String::from),
        }),
        "provider://error" => Some(WorkerEvent::Error {
            message: payload
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Local provider runtime error.")
                .to_string(),
        }),
        "provider://prompt-complete" => Some(WorkerEvent::Complete {
            final_content: String::new(),
            thinking: None,
            cost: None,
            rlm_steps: None,
        }),
        _ => None,
    }
}
