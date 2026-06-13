// ABOUTME: Orchestrator worker that delegates execution to the local provider runtime.
// ABOUTME: Connects to the desktop/browser-local provider runtime over WebSocket and streams provider events.

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const AUTH_REQUEST_ID: i64 = 1;
const PROMPT_REQUEST_ID: i64 = 2;
const CANCEL_REQUEST_ID: i64 = 3;
const LIST_AGENTS_REQUEST_ID: i64 = 4;
const SPAWN_ONESHOT_REQUEST_ID: i64 = 5;
const SET_MODEL_ONESHOT_REQUEST_ID: i64 = 6;
const TERMINATE_ONESHOT_REQUEST_ID: i64 = 7;
const SET_MODE_ONESHOT_REQUEST_ID: i64 = 8;

type RuntimeSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProviderAgentStatus {
    #[serde(rename = "type")]
    pub agent_type: String,
    pub available: bool,
    #[serde(default)]
    pub authenticated: bool,
}

pub struct ProviderOneShotRequest {
    pub agent_type: String,
    pub model: Option<String>,
    pub system: Option<String>,
    pub prompt: String,
}

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
        let mut socket = connect_authenticated_provider_socket(&self.app, &state).await?;

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
        let mut socket = connect_authenticated_provider_socket(&self.app, &state).await?;

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

pub async fn list_provider_agents(app: &AppHandle) -> Result<Vec<ProviderAgentStatus>, String> {
    let state: tauri::State<'_, crate::provider_runtime::ProviderRuntimeState> = app.state();
    let mut socket = connect_authenticated_provider_socket(app, &state).await?;
    let result = provider_request(
        &mut socket,
        LIST_AGENTS_REQUEST_ID,
        "provider_get_available_agents",
        json!({}),
    )
    .await?;
    serde_json::from_value(result).map_err(|err| format!("Invalid provider agent list: {err}"))
}

pub async fn complete_oneshot(
    app: &AppHandle,
    request: ProviderOneShotRequest,
) -> Result<String, String> {
    if request.agent_type.trim().is_empty() {
        return Err("no provider agent selected for completion".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("completion prompt is empty".to_string());
    }

    let agent_type = request.agent_type.clone();
    let state: tauri::State<'_, crate::provider_runtime::ProviderRuntimeState> = app.state();
    let mut socket = connect_authenticated_provider_socket(app, &state).await?;
    let local_session_id = format!("oneshot-{}", uuid::Uuid::new_v4());
    let cwd = provider_oneshot_cwd(app)?;

    let mut spawn_params = json!({
        "agentType": agent_type,
        "localSessionId": local_session_id,
        "cwd": cwd,
        "apiKey": Value::Null,
        "mcpServers": [],
        "approvalPolicy": "on-request",
        "sandboxMode": "read-only",
        "networkEnabled": false,
        "timeoutSecs": 180,
    });
    if agent_type == "claude-code" {
        if let Some(model) = request
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty())
        {
            spawn_params["initialModelId"] = json!(model);
        }
    }

    let spawn_result = provider_request(
        &mut socket,
        SPAWN_ONESHOT_REQUEST_ID,
        "provider_spawn",
        spawn_params,
    )
    .await?;
    let session_id = spawn_result
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "provider one-shot spawn returned no session id".to_string())?
        .to_string();

    let completion_result = async {
        provider_request(
            &mut socket,
            SET_MODE_ONESHOT_REQUEST_ID,
            "provider_set_permission_mode",
            json!({
                "sessionId": session_id,
                "mode": provider_oneshot_permission_mode(&agent_type),
            }),
        )
        .await?;

        if agent_type != "gemini" {
            if let Some(model) = request
                .model
                .as_deref()
                .filter(|model| !model.trim().is_empty())
            {
                provider_request(
                    &mut socket,
                    SET_MODEL_ONESHOT_REQUEST_ID,
                    "provider_set_session_model",
                    json!({
                        "sessionId": session_id,
                        "modelId": model,
                    }),
                )
                .await?;
            }
        }

        collect_provider_prompt(
            &mut socket,
            &session_id,
            &build_provider_prompt(request.system.as_deref(), &request.prompt),
        )
        .await
    }
    .await;

    if let Err(err) = provider_request(
        &mut socket,
        TERMINATE_ONESHOT_REQUEST_ID,
        "provider_terminate",
        json!({ "sessionId": session_id }),
    )
    .await
    {
        log::warn!("[provider-one-shot] failed to terminate ephemeral session: {err}");
    }

    let content = completion_result?;
    if content.trim().is_empty() {
        return Err("provider one-shot returned no content".to_string());
    }
    Ok(content)
}

async fn connect_authenticated_provider_socket(
    app: &AppHandle,
    state: &tauri::State<'_, crate::provider_runtime::ProviderRuntimeState>,
) -> Result<RuntimeSocket, String> {
    let config = state.ensure_started(app).await?;

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
    Ok(socket)
}

async fn provider_request(
    socket: &mut RuntimeSocket,
    request_id: i64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|err| format!("Failed to send provider runtime request {method}: {err}"))?;

    wait_for_response(socket, request_id)
        .await
        .map(|payload| payload.get("result").cloned().unwrap_or(Value::Null))
}

async fn wait_for_response(socket: &mut RuntimeSocket, request_id: i64) -> Result<Value, String> {
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

async fn collect_provider_prompt(
    socket: &mut RuntimeSocket,
    session_id: &str,
    prompt: &str,
) -> Result<String, String> {
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": PROMPT_REQUEST_ID,
                "method": "provider_prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": prompt,
                    "context": Value::Null,
                },
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|err| format!("Failed to send provider prompt: {err}"))?;

    let mut content = String::new();
    while let Some(message) = socket.next().await {
        let message = message.map_err(|err| format!("Provider runtime socket error: {}", err))?;
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
                return Err(error_message);
            }
            return Ok(content);
        }

        if payload.get("id").is_some() || payload.get("method").is_none() {
            continue;
        }
        let method = payload
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !method.starts_with("provider://") {
            continue;
        }
        let params = payload.get("params").cloned().unwrap_or(Value::Null);
        if event_session_id(&params) != Some(session_id) {
            continue;
        }

        match method {
            "provider://message-chunk" => {
                if params
                    .get("isThought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Some(text) = params.get("text").and_then(Value::as_str) {
                    content.push_str(text);
                }
            }
            "provider://prompt-complete" => {}
            "provider://tool-call" => {
                return Err(
                    "provider one-shot attempted a tool call; toolless completion aborted"
                        .to_string(),
                );
            }
            "provider://error" => {
                return Err(params
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Local provider runtime error.")
                    .to_string());
            }
            _ => {}
        }
    }

    Err("Provider runtime socket closed before prompt completed.".to_string())
}

fn build_provider_prompt(system: Option<&str>, prompt: &str) -> String {
    match system.map(str::trim).filter(|system| !system.is_empty()) {
        Some(system) => format!("{system}\n\n{prompt}"),
        None => prompt.to_string(),
    }
}

fn provider_oneshot_cwd(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data dir: {err}"))?
        .join("provider-oneshot");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create provider one-shot dir: {err}"))?;
    Ok(dir.to_string_lossy().to_string())
}

fn provider_oneshot_permission_mode(agent_type: &str) -> &'static str {
    match agent_type {
        "claude-code" | "gemini" => "plan",
        "codex" => "ask",
        _ => "ask",
    }
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
