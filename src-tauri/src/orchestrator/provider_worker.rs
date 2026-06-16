// ABOUTME: Orchestrator worker that delegates execution to the local provider runtime.
// ABOUTME: Connects to the desktop/browser-local provider runtime over WebSocket and streams provider events.

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
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
const SETTINGS_STORE: &str = "settings.json";
const APP_SETTINGS_KEY: &str = "app";

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

/// Prefix that marks an ephemeral, one-shot-owned provider session. A one-shot
/// only ever spawns and terminates a session carrying this prefix; it never
/// borrows or releases a serving/standby chat session. #2399.
const ONESHOT_LOCAL_SESSION_PREFIX: &str = "oneshot-";

/// True when `session_id` names an ephemeral session created by a one-shot.
/// The terminate in [`complete_oneshot`] is gated on this so a one-shot can
/// never cancel a serving/standby chat session.
fn is_ephemeral_oneshot_session(session_id: &str) -> bool {
    session_id.starts_with(ONESHOT_LOCAL_SESSION_PREFIX)
}

/// Run one toolless prompt on a fresh, ephemeral provider session and return
/// the assistant text.
///
/// Ownership states for a provider session touched by a one-shot:
/// - **Ephemeral** — spawned and owned by this call (`oneshot-<uuid>`); the
///   only state reachable today. Safe to prompt and to terminate.
/// - **Borrowed standby** — a warm session lent to a one-shot. No reuse path
///   exists yet; when added it must serialize prompts and never share context
///   with the live chat session.
/// - **Serving chat** — an interactive chat session. A one-shot must NEVER
///   prompt, cancel, or terminate it.
/// - **Released/terminated** — torn down. Release is idempotent/best-effort.
///
/// Every one-shot currently spawns and tears down its own Ephemeral session and
/// never borrows. The terminate below enforces the invariant for any future
/// reuse: it fires only for the Ephemeral session this call created, so a
/// one-shot can never cancel a Serving/Borrowed chat session. Streamed events
/// are already isolated by `sessionId` in [`collect_provider_prompt`]. #2399.
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
    let local_session_id = format!("{ONESHOT_LOCAL_SESSION_PREFIX}{}", uuid::Uuid::new_v4());
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
    if agent_type == "lmstudio" {
        if let Some(base_url) = app_setting_string(app, "lmStudioBaseUrl") {
            spawn_params["lmStudioBaseUrl"] = json!(base_url);
        }
        if let Some(api_key) = app_setting_string(app, "lmStudioApiKey") {
            spawn_params["lmStudioApiKey"] = json!(api_key);
        }
    }
    if agent_type == "claude-code" || agent_type == "lmstudio" {
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

    // We own — and may terminate — this session only if spawn echoed back the
    // ephemeral id we asked it to create. If a future reuse path ever returns a
    // borrowed/serving session id instead, we must not terminate it.
    let owns_ephemeral_session =
        session_id == local_session_id && is_ephemeral_oneshot_session(&session_id);

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

        // Gemini's model is fixed by the `--model` flag at spawn time; the
        // runtime's set_session_model is a no-op against the running process,
        // so the Gemini one-shot intentionally runs on the agent's default
        // model. For Claude/Codex, setting the model is best-effort: Codex
        // rejects an unknown model id with a hard error, but a toolless
        // summarization does not need an exact model — log and proceed on the
        // agent default rather than failing the whole completion. #2398.
        if agent_type != "gemini" {
            if let Some(model) = request
                .model
                .as_deref()
                .filter(|model| !model.trim().is_empty())
            {
                if let Err(err) = provider_request(
                    &mut socket,
                    SET_MODEL_ONESHOT_REQUEST_ID,
                    "provider_set_session_model",
                    json!({
                        "sessionId": session_id,
                        "modelId": model,
                    }),
                )
                .await
                {
                    log::warn!(
                        "[provider-one-shot] set_session_model({model}) failed; continuing on agent default model: {err}"
                    );
                }
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

    // Release: terminate ONLY the ephemeral session this call created. A
    // one-shot must never cancel a serving/standby chat session, so if spawn
    // ever returned a non-ephemeral id we leave it alone. Terminate is
    // best-effort (warn-on-error) so a double-release or runtime restart can't
    // surface as a hard failure. #2399.
    if owns_ephemeral_session {
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
    } else {
        log::warn!(
            "[provider-one-shot] spawn returned non-ephemeral session id {session_id:?}; \
             not terminating (one-shots never cancel serving/standby chat sessions)"
        );
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

        match classify_oneshot_provider_event(method, &params) {
            Ok(Some(text)) => content.push_str(&text),
            Ok(None) => {}
            Err(message) => return Err(message),
        }
    }

    Err("Provider runtime socket closed before prompt completed.".to_string())
}

/// Decide how a `provider://` event affects a toolless one-shot completion.
/// `Ok(Some(text))` appends assistant text, `Ok(None)` is ignored, and `Err`
/// fails the completion.
///
/// Tool calls AND permission requests both fail closed. The three agents
/// diverge here: Claude `plan` mode auto-denies a tool attempt and continues,
/// but Codex `ask` mode and Gemini `plan` mode instead emit
/// `provider://permission-request` and block on a `respondToPermission` RPC
/// that the headless one-shot never sends — without this the Codex/Gemini
/// one-shot hangs until the socket/spawn timeout. Failing closed on the
/// permission request (then terminating the ephemeral session) makes all three
/// agents behave identically: no tool execution, no approval UI. #2398.
fn classify_oneshot_provider_event(method: &str, params: &Value) -> Result<Option<String>, String> {
    match method {
        "provider://message-chunk" => {
            if params
                .get("isThought")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Ok(None);
            }
            Ok(params
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string))
        }
        "provider://prompt-complete" => Ok(None),
        "provider://tool-call" => {
            Err("provider one-shot attempted a tool call; toolless completion aborted".to_string())
        }
        "provider://permission-request" => Err(
            "provider one-shot requested tool approval; toolless completion aborted".to_string(),
        ),
        "provider://error" => Err(params
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Local provider runtime error.")
            .to_string()),
        _ => Ok(None),
    }
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

fn app_setting_string(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(SETTINGS_STORE).ok()?;
    let raw = store.get(APP_SETTINGS_KEY)?;
    let raw = raw.as_str()?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    parsed
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oneshot_appends_assistant_text_and_ignores_thoughts() {
        assert_eq!(
            classify_oneshot_provider_event(
                "provider://message-chunk",
                &json!({ "sessionId": "oneshot-x", "text": "hello" }),
            ),
            Ok(Some("hello".to_string()))
        );
        // Thinking chunks and empty text never contribute to the completion.
        assert_eq!(
            classify_oneshot_provider_event(
                "provider://message-chunk",
                &json!({ "text": "scratch", "isThought": true }),
            ),
            Ok(None)
        );
        assert_eq!(
            classify_oneshot_provider_event("provider://message-chunk", &json!({ "text": "" })),
            Ok(None)
        );
        assert_eq!(
            classify_oneshot_provider_event("provider://prompt-complete", &json!({})),
            Ok(None)
        );
        assert_eq!(
            classify_oneshot_provider_event("provider://session-status", &json!({})),
            Ok(None)
        );
    }

    #[test]
    fn oneshot_fails_closed_on_tool_call_and_permission_request() {
        // Both the Claude tool-call path and the Codex(ask)/Gemini(plan)
        // permission-request path must fail closed instead of hanging on an
        // approval the headless one-shot can never answer. #2398.
        let tool = classify_oneshot_provider_event(
            "provider://tool-call",
            &json!({ "toolCallId": "t1", "title": "Run command" }),
        )
        .expect_err("tool-call must fail closed");
        assert!(tool.contains("toolless completion aborted"), "{tool}");

        let permission = classify_oneshot_provider_event(
            "provider://permission-request",
            &json!({ "requestId": "r1", "options": [] }),
        )
        .expect_err("permission-request must fail closed");
        assert!(
            permission.contains("toolless completion aborted"),
            "{permission}"
        );
    }

    #[test]
    fn oneshot_surfaces_provider_error_string_for_classification() {
        // The raw error string must pass through so audio::llm can classify
        // capacity vs auth vs safety for fallback. #2397/#2398.
        assert_eq!(
            classify_oneshot_provider_event(
                "provider://error",
                &json!({ "sessionId": "oneshot-x", "error": "Rate limit exceeded" }),
            ),
            Err("Rate limit exceeded".to_string())
        );
        assert_eq!(
            classify_oneshot_provider_event("provider://error", &json!({})),
            Err("Local provider runtime error.".to_string())
        );
    }

    #[test]
    fn oneshot_permission_mode_is_plan_or_ask_per_agent() {
        // Claude plan auto-denies tools; Gemini plan and Codex ask emit a
        // permission-request that the collector fails closed on. No agent
        // gets an auto-approving mode in a one-shot.
        assert_eq!(provider_oneshot_permission_mode("claude-code"), "plan");
        assert_eq!(provider_oneshot_permission_mode("gemini"), "plan");
        assert_eq!(provider_oneshot_permission_mode("codex"), "ask");
        assert_eq!(provider_oneshot_permission_mode("lmstudio"), "ask");
        assert_eq!(provider_oneshot_permission_mode("unknown"), "ask");
    }

    #[test]
    fn build_provider_prompt_prepends_system_when_present() {
        assert_eq!(build_provider_prompt(Some("SYS"), "BODY"), "SYS\n\nBODY");
        assert_eq!(build_provider_prompt(Some("  "), "BODY"), "BODY");
        assert_eq!(build_provider_prompt(None, "BODY"), "BODY");
    }

    #[test]
    fn only_ephemeral_oneshot_sessions_are_terminable() {
        // The terminate guard fires only for the ephemeral id a one-shot
        // created. Serving/standby chat session ids (raw uuids, codex thread
        // ids, chat-* ids) must be rejected so a one-shot can never cancel a
        // live chat session. #2399.
        assert!(is_ephemeral_oneshot_session(
            "oneshot-7b1f3c2a-0000-4a1b-9c2d-1234567890ab"
        ));
        assert!(is_ephemeral_oneshot_session(&format!(
            "{ONESHOT_LOCAL_SESSION_PREFIX}abc"
        )));
        for serving in [
            "7b1f3c2a-0000-4a1b-9c2d-1234567890ab",
            "chat-12345",
            "thread_abc123",
            "",
        ] {
            assert!(
                !is_ephemeral_oneshot_session(serving),
                "serving/standby id must not be terminable: {serving:?}"
            );
        }
    }
}
