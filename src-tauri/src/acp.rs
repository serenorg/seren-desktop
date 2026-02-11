// ABOUTME: ACP (Agent Client Protocol) integration for spawning and communicating with AI coding agents.
// ABOUTME: Supports Claude Code agents via ndjson stdio communication.

use agent_client_protocol::{Agent, Client, ClientSideConnection, Result as AcpResult};
use agent_client_protocol::{
    CancelNotification, ClientCapabilities, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, EnvVariable, ExtNotification, ExtRequest, ExtResponse, Implementation,
    InitializeRequest, KillTerminalCommandRequest, KillTerminalCommandResponse, McpServer,
    McpServerStdio, ModelId, NewSessionRequest, PromptRequest, ProtocolVersion,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionRequest, RequestPermissionResponse, SessionModeId, SessionNotification,
    SessionUpdate, SetSessionModeRequest, SetSessionModelRequest, TerminalOutputRequest,
    TerminalOutputResponse, TextContent, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
    WriteTextFileRequest, WriteTextFileResponse,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock, mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

/// Extract a human-readable error message from an ACP JSON-RPC error.
/// Prefers the `data` string (more specific) over the generic `message` field.
fn format_acp_error(e: &agent_client_protocol::Error) -> String {
    if let Some(ref data) = e.data {
        if let Some(s) = data.as_str() {
            return s.to_string();
        }
    }
    e.message.clone()
}

/// Check if an error message indicates an authentication/login failure
fn is_auth_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("invalid api key")
        || lower.contains("authentication required")
        || lower.contains("authentication_error")
        || lower.contains("auth required")
        || lower.contains("please run /login")
        || lower.contains("authrequired")
        || lower.contains("not logged in")
        || lower.contains("login required")
        || lower.contains("oauth token has expired")
        || lower.contains("token has expired")
        || lower.contains("token expired")
        || lower.contains("please obtain a new token")
        || lower.contains("refresh your existing token")
        || lower.contains("401")
        // Codex-specific: "Invalid request" usually means missing/invalid OpenAI credentials
        || (lower.contains("codex") && lower.contains("invalid request"))
        || (lower.contains("codex") && lower.contains("-32600"))
        || lower.contains("openai api key")
        || lower.contains("codex connection error")
}

/// Return a user-friendly auth error message for the given agent type
fn launch_claude_login() {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("osascript")
            .args([
                "-e",
                r#"tell application "Terminal" to do script "claude login""#,
            ])
            .spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/c", "claude login"])
            .spawn()
    } else {
        std::process::Command::new("x-terminal-emulator")
            .args(["-e", "claude login"])
            .spawn()
    };

    match result {
        Ok(_) => log::info!("[ACP] Launched claude login terminal"),
        Err(e) => log::warn!("[ACP] Failed to launch claude login terminal: {}", e),
    }
}

/// Open a terminal running the Codex CLI login flow so the user can authenticate
fn launch_codex_login() {
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("osascript")
            .args([
                "-e",
                r#"tell application "Terminal" to do script "codex login""#,
            ])
            .spawn()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd", "/c", "codex login"])
            .spawn()
    } else {
        std::process::Command::new("x-terminal-emulator")
            .args(["-e", "codex login"])
            .spawn()
    };

    match result {
        Ok(_) => log::info!("[ACP] Launched codex login terminal"),
        Err(e) => log::warn!("[ACP] Failed to launch codex login terminal: {}", e),
    }
}

/// Agent types supported by the ACP integration
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentType {
    ClaudeCode,
    Codex,
}

impl AgentType {
    /// Get the sidecar binary name for this agent
    fn sidecar_name(&self) -> &'static str {
        match self {
            AgentType::ClaudeCode => "seren-acp-claude",
            AgentType::Codex => "seren-acp-codex",
        }
    }

    /// Get the command to spawn this agent
    ///
    /// Agent binaries are bundled in embedded-runtime/bin/ and named:
    /// - seren-acp-claude (Claude ACP sidecar)
    /// - seren-acp-codex (Codex ACP sidecar)
    ///
    /// The binaries are located at:
    /// - Development: src-tauri/embedded-runtime/bin/
    /// - Production: bundled in the app's resource directory
    fn command(&self) -> Result<std::path::PathBuf, String> {
        let bin_name = self.sidecar_name();

        // Check various locations for the binary
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?;
        let exe_dir = exe_path
            .parent()
            .ok_or_else(|| "Failed to get exe directory".to_string())?;

        // Platform-specific extension
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let bin_filename = format!("{}{}", bin_name, ext);

        // Locations to check (in order of priority):
        let candidates = [
            // 1. Production macOS: In Resources/embedded-runtime/bin/
            exe_dir
                .join("../Resources/embedded-runtime/bin")
                .join(&bin_filename),
            // 2. Production Linux/Windows: In resource dir next to exe
            exe_dir.join("embedded-runtime/bin").join(&bin_filename),
            // 3. Development: In src-tauri/embedded-runtime/bin/
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("embedded-runtime")
                .join("bin")
                .join(&bin_filename),
        ];

        for candidate in &candidates {
            if candidate.exists() {
                log::info!("[ACP] Found {} binary at: {:?}", bin_name, candidate);
                return Ok(candidate.clone());
            }
        }

        Err(format!(
            "Agent binary '{}' not found. Checked locations:\n{}",
            bin_name,
            candidates
                .iter()
                .map(|p| format!("  - {:?}", p))
                .collect::<Vec<_>>()
                .join("\n")
        ))
    }

    /// Get additional arguments for the command
    fn args(&self) -> Vec<&'static str> {
        match self {
            AgentType::ClaudeCode => vec![],
            AgentType::Codex => vec![],
        }
    }
}

fn auth_error_message(agent_type: AgentType) -> String {
    match agent_type {
        AgentType::ClaudeCode => "Claude login required. A terminal window has been opened to run `claude login`. Complete authentication there and retry."
            .to_string(),
        AgentType::Codex => "Codex login required. A terminal window has been opened to run `codex login`. Complete authentication there and retry."
            .to_string(),
    }
}

/// Maximum time to wait for an agent prompt to produce any response (2 minutes).
/// If the agent process is hung or the API is unreachable, this prevents infinite waits.
const PROMPT_TIMEOUT_SECS: u64 = 120;

/// Debounce window: suppress duplicate login launches within this many seconds.
const LOGIN_DEBOUNCE_SECS: i64 = 15;

/// Timestamp (epoch secs) of the last successful login launch.
static LAST_LOGIN_LAUNCH: AtomicI64 = AtomicI64::new(0);

fn launch_agent_login(agent_type: AgentType) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let last = LAST_LOGIN_LAUNCH.load(Ordering::Relaxed);
    if now - last < LOGIN_DEBOUNCE_SECS {
        log::info!(
            "[ACP] Skipping duplicate login launch (last was {}s ago)",
            now - last
        );
        return;
    }
    LAST_LOGIN_LAUNCH.store(now, Ordering::Relaxed);

    match agent_type {
        AgentType::ClaudeCode => launch_claude_login(),
        AgentType::Codex => launch_codex_login(),
    }
}

/// Get the path to the seren-mcp sidecar binary.
///
/// The binary is located in the same embedded-runtime/bin/ directory as other sidecars.
/// Returns None if the binary is not found (seren-mcp is optional).
fn get_seren_mcp_path() -> Option<std::path::PathBuf> {
    let exe_path = std::env::current_exe().ok()?;
    let exe_dir = exe_path.parent()?;

    let ext = if cfg!(windows) { ".exe" } else { "" };
    let bin_filename = format!("seren-mcp{}", ext);

    // Locations to check (same as AgentType::command):
    let candidates = [
        // 1. Production macOS: In Resources/embedded-runtime/bin/
        exe_dir
            .join("../Resources/embedded-runtime/bin")
            .join(&bin_filename),
        // 2. Production Linux/Windows: In resource dir next to exe
        exe_dir.join("embedded-runtime/bin").join(&bin_filename),
        // 3. Development: In src-tauri/embedded-runtime/bin/
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("embedded-runtime")
            .join("bin")
            .join(&bin_filename),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            log::info!("[ACP] Found seren-mcp binary at: {:?}", candidate);
            return Some(candidate.clone());
        }
    }

    log::debug!(
        "[ACP] seren-mcp binary not found. Checked locations:\n{}",
        candidates
            .iter()
            .map(|p| format!("  - {:?}", p))
            .collect::<Vec<_>>()
            .join("\n")
    );
    None
}

/// Build MCP server configurations for a new ACP session.
///
/// If seren-mcp is available and an API key is provided, includes it as a stdio MCP server.
fn build_mcp_servers(api_key: Option<&str>) -> Vec<McpServer> {
    let mut servers = Vec::new();

    // Add seren-mcp if binary is available and we have an API key
    if let (Some(mcp_path), Some(key)) = (get_seren_mcp_path(), api_key) {
        log::info!("[ACP] Adding seren-mcp to session MCP servers");
        let mcp_server = McpServerStdio::new("seren-mcp", mcp_path)
            .args(vec!["start".to_string()])
            .env(vec![EnvVariable::new("API_KEY", key)]);
        servers.push(McpServer::Stdio(mcp_server));
    } else if api_key.is_none() {
        log::debug!("[ACP] No API key provided, skipping seren-mcp");
    }

    servers
}

/// Information about an ACP session
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionInfo {
    pub id: String,
    pub agent_type: AgentType,
    pub cwd: String,
    pub status: SessionStatus,
    pub created_at: String,
}

/// Session status
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Initializing,
    Ready,
    Prompting,
    Error,
    Terminated,
}

/// Commands sent to the ACP session worker thread
#[derive(Debug)]
pub(crate) enum AcpCommand {
    Prompt {
        prompt: String,
        context: Option<Vec<serde_json::Value>>,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    SetMode {
        mode: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    SetModel {
        model_id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Terminate,
}

/// Internal session state (stored in main thread)
pub(crate) struct AcpSession {
    pub(crate) id: String,
    agent_type: AgentType,
    cwd: String,
    status: SessionStatus,
    created_at: jiff::Timestamp,
    /// Channel to send commands to the worker thread
    pub(crate) command_tx: Option<mpsc::Sender<AcpCommand>>,
    /// Handle to the worker thread
    _worker_handle: Option<thread::JoinHandle<()>>,
    /// Pending permission requests awaiting user response (shared with ClientDelegate)
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Pending diff proposals awaiting user accept/reject (shared with ClientDelegate)
    pending_diff_proposals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

/// State for managing ACP sessions
pub struct AcpState {
    pub(crate) sessions: RwLock<HashMap<String, Arc<Mutex<AcpSession>>>>,
}

impl AcpState {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for AcpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Events emitted to frontend
mod events {
    pub const MESSAGE_CHUNK: &str = "acp://message-chunk";
    pub const TOOL_CALL: &str = "acp://tool-call";
    pub const TOOL_RESULT: &str = "acp://tool-result";
    pub const DIFF: &str = "acp://diff";
    pub const PLAN_UPDATE: &str = "acp://plan-update";
    pub const PROMPT_COMPLETE: &str = "acp://prompt-complete";
    pub const PERMISSION_REQUEST: &str = "acp://permission-request";
    pub const SESSION_STATUS: &str = "acp://session-status";
    pub const ERROR: &str = "acp://error";
    pub const DIFF_PROPOSAL: &str = "acp://diff-proposal";
}

/// Client delegate that handles requests from the agent
struct ClientDelegate {
    app: AppHandle,
    session_id: String,
    cwd: String,
    terminals: Arc<Mutex<crate::terminal::TerminalManager>>,
    sandbox_mode: crate::sandbox::SandboxMode,
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    /// Pending diff proposals awaiting user accept/reject
    pending_diff_proposals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// Maps terminal IDs to tool call IDs for tracking command activity in the UI
    terminal_tool_calls: Arc<Mutex<HashMap<String, String>>>,
    /// Signalled on every session notification so the prompt timeout resets on activity
    activity_notify: Arc<tokio::sync::Notify>,
}

impl ClientDelegate {
    /// Emit a tool-call event to the frontend so the UI can show agent activity.
    fn emit_tool_call(&self, tool_call_id: &str, title: &str, kind: &str, status: &str, parameters: Option<serde_json::Value>) {
        log::debug!(
            "[ACP] Emitting tool call: session={}, tool_call_id={}, title={}, kind={}, status={}, parameters={:?}",
            self.session_id,
            tool_call_id,
            title,
            kind,
            status,
            parameters
        );
        let mut payload = serde_json::json!({
            "sessionId": self.session_id,
            "toolCallId": tool_call_id,
            "title": title,
            "kind": kind,
            "status": status
        });
        if let Some(params) = parameters {
            payload["parameters"] = params;
        }
        let emit_result = self.app.emit(
            events::TOOL_CALL,
            payload,
        );
        if let Err(ref e) = emit_result {
            log::error!(
                "[ACP] Failed to emit tool call {} for session {}: {}",
                tool_call_id,
                self.session_id,
                e
            );
        }
    }

    /// Emit a tool-result event to update a tool call's status in the UI.
    fn emit_tool_result(&self, tool_call_id: &str, status: &str, result: Option<String>, error: Option<String>) {
        log::debug!(
            "[ACP] Emitting tool result: session={}, tool_call_id={}, status={}, result_len={:?}, error={:?}",
            self.session_id,
            tool_call_id,
            status,
            result.as_ref().map(|r| r.len()),
            error
        );
        let mut payload = serde_json::json!({
            "sessionId": self.session_id,
            "toolCallId": tool_call_id,
            "status": status
        });
        if let Some(r) = result {
            // Truncate result to avoid massive payloads
            let truncated = if r.len() > 5000 {
                format!("{}... ({} bytes total)", &r[..5000], r.len())
            } else {
                r
            };
            payload["result"] = serde_json::Value::String(truncated);
        }
        if let Some(e) = error {
            payload["error"] = serde_json::Value::String(e);
        }
        let emit_result = self.app.emit(
            events::TOOL_RESULT,
            payload,
        );
        if let Err(ref e) = emit_result {
            log::error!(
                "[ACP] Failed to emit tool result {} for session {}: {}",
                tool_call_id,
                self.session_id,
                e
            );
        }
    }
}

#[async_trait::async_trait(?Send)]
impl Client for ClientDelegate {
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> AcpResult<RequestPermissionResponse> {
        let request_id = Uuid::new_v4().to_string();
        let (response_tx, response_rx) = oneshot::channel::<String>();

        let tool_name = serde_json::to_value(&args.tool_call)
            .ok()
            .and_then(|v| v.get("title").and_then(|n| n.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown".to_string());

        log::info!(
            "[ACP] Permission request {} for session {}: tool={}",
            request_id,
            self.session_id,
            tool_name
        );

        // Store the response channel so the frontend can send back a decision
        let pending_count = {
            let mut perms = self.pending_permissions.lock().await;
            perms.insert(request_id.clone(), response_tx);
            perms.len()
        };
        log::debug!(
            "[ACP] Permission request {} stored (total pending: {})",
            request_id,
            pending_count
        );

        // Emit permission request to frontend with request_id for correlation
        let emit_result = self.app.emit(
            events::PERMISSION_REQUEST,
            serde_json::json!({
                "sessionId": self.session_id,
                "requestId": request_id,
                "toolCall": serde_json::to_value(&args.tool_call).ok(),
                "options": serde_json::to_value(&args.options).ok(),
            }),
        );
        if let Err(ref e) = emit_result {
            log::error!(
                "[ACP] Failed to emit permission request {} to frontend: {}",
                request_id,
                e
            );
        }

        // Wait for user response (5-minute timeout)
        log::debug!("[ACP] Waiting for permission response {} ...", request_id);
        let option_id_str =
            match tokio::time::timeout(std::time::Duration::from_secs(300), response_rx).await {
                Ok(Ok(id)) => {
                    log::info!(
                        "[ACP] Permission {} responded with option: {}",
                        request_id,
                        id
                    );
                    id
                }
                Ok(Err(_)) => {
                    log::warn!(
                        "[ACP] Permission {} channel dropped (session may have been cleaned up)",
                        request_id
                    );
                    self.pending_permissions.lock().await.remove(&request_id);
                    return Err(agent_client_protocol::Error::internal_error().data(
                        serde_json::Value::String("Permission request cancelled".into()),
                    ));
                }
                Err(_) => {
                    log::warn!("[ACP] Permission {} timed out after 5 minutes", request_id);
                    self.pending_permissions.lock().await.remove(&request_id);
                    return Err(agent_client_protocol::Error::internal_error().data(
                        serde_json::Value::String("Permission request timed out".into()),
                    ));
                }
            };

        self.pending_permissions.lock().await.remove(&request_id);

        Ok(RequestPermissionResponse::new(
            agent_client_protocol::RequestPermissionOutcome::Selected(
                agent_client_protocol::SelectedPermissionOutcome::new(
                    agent_client_protocol::PermissionOptionId::new(option_id_str),
                ),
            ),
        ))
    }

    async fn write_text_file(
        &self,
        args: WriteTextFileRequest,
    ) -> AcpResult<WriteTextFileResponse> {
        let path = std::path::Path::new(&self.cwd).join(&args.path);

        // Read existing content for diff comparison
        let old_text = tokio::fs::read_to_string(&path).await.unwrap_or_default();

        let proposal_id = Uuid::new_v4().to_string();
        let (response_tx, response_rx) = oneshot::channel::<bool>();

        // Store the response channel
        self.pending_diff_proposals
            .lock()
            .await
            .insert(proposal_id.clone(), response_tx);

        // Emit diff proposal to frontend
        let _ = self.app.emit(
            events::DIFF_PROPOSAL,
            serde_json::json!({
                "sessionId": self.session_id,
                "proposalId": proposal_id,
                "path": args.path,
                "oldText": old_text,
                "newText": args.content,
            }),
        );

        // Wait for user response (5-minute timeout)
        let accepted =
            match tokio::time::timeout(std::time::Duration::from_secs(300), response_rx).await {
                Ok(Ok(accepted)) => accepted,
                Ok(Err(_)) => {
                    self.pending_diff_proposals
                        .lock()
                        .await
                        .remove(&proposal_id);
                    return Err(agent_client_protocol::Error::internal_error()
                        .data(serde_json::Value::String("Diff proposal dismissed".into())));
                }
                Err(_) => {
                    self.pending_diff_proposals
                        .lock()
                        .await
                        .remove(&proposal_id);
                    return Err(agent_client_protocol::Error::internal_error()
                        .data(serde_json::Value::String("Diff proposal timed out".into())));
                }
            };

        self.pending_diff_proposals
            .lock()
            .await
            .remove(&proposal_id);

        if !accepted {
            return Err(agent_client_protocol::Error::internal_error()
                .data(serde_json::Value::String("User rejected the edit".into())));
        }

        match tokio::fs::write(&path, &args.content).await {
            Ok(_) => Ok(WriteTextFileResponse::new()),
            Err(e) => Err(agent_client_protocol::Error::internal_error()
                .data(serde_json::Value::String(e.to_string()))),
        }
    }

    async fn read_text_file(&self, args: ReadTextFileRequest) -> AcpResult<ReadTextFileResponse> {
        let path = std::path::Path::new(&self.cwd).join(&args.path);
        let display_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| args.path.to_string_lossy().to_string());
        let tool_call_id = Uuid::new_v4().to_string();

        let parameters = serde_json::json!({
            "path": args.path.to_string_lossy().to_string(),
        });
        self.emit_tool_call(&tool_call_id, &format!("Read {display_name}"), "File", "Running", Some(parameters));

        match tokio::fs::read_to_string(&path).await {
            Ok(content) => {
                let lines = content.lines().count();
                let bytes = content.len();
                let result = format!("{} lines, {} bytes", lines, bytes);
                self.emit_tool_result(&tool_call_id, "Completed", Some(result), None);
                Ok(ReadTextFileResponse::new(content))
            }
            Err(e) => {
                let error_msg = e.to_string();
                self.emit_tool_result(&tool_call_id, "Failed", None, Some(error_msg.clone()));
                Err(agent_client_protocol::Error::internal_error()
                    .data(serde_json::Value::String(error_msg)))
            }
        }
    }

    async fn create_terminal(
        &self,
        args: CreateTerminalRequest,
    ) -> AcpResult<CreateTerminalResponse> {
        let terminal_id = Uuid::new_v4().to_string();
        let cwd_path = args
            .cwd
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new(&self.cwd));
        let sandbox_config = crate::sandbox::SandboxConfig::from_mode(self.sandbox_mode, cwd_path);

        // Build env vars from request
        let env_vars: Vec<(String, String)> = args
            .env
            .iter()
            .map(|e| (e.name.clone(), e.value.clone()))
            .collect();

        // Get embedded runtime PATH
        let env_path = crate::embedded_runtime::get_embedded_path().to_string();

        // Emit tool activity for the terminal command
        let tool_call_id = Uuid::new_v4().to_string();
        let cmd_label = if args.args.is_empty() {
            args.command.clone()
        } else {
            let full = format!("{} {}", args.command, args.args.join(" "));
            if full.len() > 80 {
                format!("{}...", &full[..77])
            } else {
                full
            }
        };
        let parameters = serde_json::json!({
            "command": args.command,
            "args": args.args,
            "cwd": args.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
        });
        self.emit_tool_call(&tool_call_id, &cmd_label, "Terminal", "Running", Some(parameters));

        // Track terminal→tool_call mapping for status updates on exit
        self.terminal_tool_calls
            .lock()
            .await
            .insert(terminal_id.clone(), tool_call_id);

        let mut terminals = self.terminals.lock().await;
        terminals
            .create(
                terminal_id.clone(),
                &args.command,
                &args.args,
                &env_vars,
                cwd_path,
                args.output_byte_limit,
                &sandbox_config,
                &env_path,
            )
            .await
            .map_err(|e| {
                agent_client_protocol::Error::internal_error().data(serde_json::Value::String(e))
            })?;

        Ok(CreateTerminalResponse::new(
            agent_client_protocol::TerminalId::new(terminal_id),
        ))
    }

    async fn terminal_output(
        &self,
        args: TerminalOutputRequest,
    ) -> AcpResult<TerminalOutputResponse> {
        let terminals = self.terminals.lock().await;
        let (output, truncated, exit_status) = terminals
            .get_output(&args.terminal_id.0)
            .await
            .map_err(|e| {
                agent_client_protocol::Error::internal_error().data(serde_json::Value::String(e))
            })?;

        let mut response = TerminalOutputResponse::new(output, truncated);
        if let Some(status) = exit_status {
            let mut acp_status = agent_client_protocol::TerminalExitStatus::new();
            if let Some(code) = status.exit_code {
                acp_status = acp_status.exit_code(code);
            }
            if let Some(sig) = status.signal {
                acp_status = acp_status.signal(sig);
            }
            response = response.exit_status(acp_status);
        }
        Ok(response)
    }

    async fn release_terminal(
        &self,
        args: ReleaseTerminalRequest,
    ) -> AcpResult<ReleaseTerminalResponse> {
        // Clean up tool call tracking if terminal released without waiting for exit
        if let Some(tool_call_id) = self
            .terminal_tool_calls
            .lock()
            .await
            .remove(args.terminal_id.0.as_ref())
        {
            self.emit_tool_result(&tool_call_id, "Completed", Some("Terminal released".to_string()), None);
        }

        let mut terminals = self.terminals.lock().await;
        let _ = terminals.release(&args.terminal_id.0);
        Ok(ReleaseTerminalResponse::default())
    }

    async fn wait_for_terminal_exit(
        &self,
        args: WaitForTerminalExitRequest,
    ) -> AcpResult<WaitForTerminalExitResponse> {
        let terminals = self.terminals.lock().await;
        let status = terminals
            .wait_for_exit(&args.terminal_id.0)
            .await
            .map_err(|e| {
                agent_client_protocol::Error::internal_error().data(serde_json::Value::String(e))
            })?;

        // Update the tool call status for this terminal
        if let Some(tool_call_id) = self
            .terminal_tool_calls
            .lock()
            .await
            .remove(args.terminal_id.0.as_ref())
        {
            let (result_status, result_msg, error_msg) = match status.exit_code {
                Some(0) => ("Completed", Some(format!("Exit code: 0")), None),
                Some(code) => ("Failed", None, Some(format!("Exit code: {}", code))),
                None => {
                    if let Some(ref sig) = status.signal {
                        ("Failed", None, Some(format!("Terminated by signal {}", sig)))
                    } else {
                        ("Failed", None, Some("Process terminated".to_string()))
                    }
                }
            };
            self.emit_tool_result(&tool_call_id, result_status, result_msg, error_msg);
        }

        let mut acp_status = agent_client_protocol::TerminalExitStatus::new();
        if let Some(code) = status.exit_code {
            acp_status = acp_status.exit_code(code);
        }
        if let Some(sig) = status.signal {
            acp_status = acp_status.signal(sig);
        }
        Ok(WaitForTerminalExitResponse::new(acp_status))
    }

    async fn kill_terminal_command(
        &self,
        args: KillTerminalCommandRequest,
    ) -> AcpResult<KillTerminalCommandResponse> {
        let terminals = self.terminals.lock().await;
        let _ = terminals.kill(&args.terminal_id.0);
        Ok(KillTerminalCommandResponse::default())
    }

    async fn session_notification(&self, args: SessionNotification) -> AcpResult<()> {
        self.activity_notify.notify_one();
        handle_session_notification(&self.app, &self.session_id, args);
        Ok(())
    }

    async fn ext_method(&self, _args: ExtRequest) -> AcpResult<ExtResponse> {
        Err(agent_client_protocol::Error::method_not_found())
    }

    async fn ext_notification(&self, _args: ExtNotification) -> AcpResult<()> {
        Ok(())
    }
}

/// Handle a session notification from the agent
fn handle_session_notification(
    app: &AppHandle,
    session_id: &str,
    notification: SessionNotification,
) {
    log::debug!("[ACP] Received notification: {:?}", notification.update);
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            // Extract text from ContentBlock if it's a text block
            let text = match &chunk.content {
                ContentBlock::Text(text_content) => text_content.text.clone(),
                _ => format!("{:?}", chunk.content),
            };
            log::debug!(
                "[ACP] Emitting MESSAGE_CHUNK to frontend: sessionId={}, text_len={}",
                session_id,
                text.len()
            );
            let emit_result = app.emit(
                events::MESSAGE_CHUNK,
                serde_json::json!({
                    "sessionId": session_id,
                    "text": text
                }),
            );
            log::debug!("[ACP] MESSAGE_CHUNK emit result: {:?}", emit_result);
        }
        SessionUpdate::ToolCall(tool_call) => {
            let kind_str = serde_json::to_value(&tool_call.kind)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "other".to_string());
            let status_str = serde_json::to_value(&tool_call.status)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "pending".to_string());
            log::debug!(
                "[ACP] Emitting TOOL_CALL: session={}, tool_call_id={}, title={}, kind={}, status={}",
                session_id,
                tool_call.tool_call_id,
                tool_call.title,
                kind_str,
                status_str
            );
            let mut payload = serde_json::json!({
                "sessionId": session_id,
                "toolCallId": tool_call.tool_call_id.to_string(),
                "title": tool_call.title,
                "kind": kind_str,
                "status": status_str
            });
            if let Some(ref raw_input) = tool_call.raw_input {
                payload["parameters"] = raw_input.clone();
            }
            let emit_result = app.emit(events::TOOL_CALL, payload);
            if let Err(ref e) = emit_result {
                log::error!(
                    "[ACP] Failed to emit TOOL_CALL {} for session {}: {}",
                    tool_call.tool_call_id,
                    session_id,
                    e
                );
            }
        }
        SessionUpdate::ToolCallUpdate(update) => {
            // Defensive: if the update has a title, also emit a TOOL_CALL event
            // so the frontend creates a card even if no prior ToolCall was sent.
            if let Some(ref title) = update.fields.title {
                let kind_str = update.fields.kind
                    .as_ref()
                    .and_then(|k| serde_json::to_value(k).ok())
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "other".to_string());
                let status_str = update.fields.status
                    .as_ref()
                    .and_then(|s| serde_json::to_value(s).ok())
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "pending".to_string());
                let _ = app.emit(
                    events::TOOL_CALL,
                    serde_json::json!({
                        "sessionId": session_id,
                        "toolCallId": update.tool_call_id.to_string(),
                        "title": title,
                        "kind": kind_str,
                        "status": status_str
                    }),
                );
            }

            // Check for diffs in content
            if let Some(ref content) = update.fields.content {
                for block in content {
                    if let agent_client_protocol::ToolCallContent::Diff(diff) = block {
                        log::debug!(
                            "[ACP] Emitting DIFF: session={}, tool_call_id={}, path={}",
                            session_id,
                            update.tool_call_id,
                            diff.path.display()
                        );
                        let emit_result = app.emit(
                            events::DIFF,
                            serde_json::json!({
                                "sessionId": session_id,
                                "toolCallId": update.tool_call_id.to_string(),
                                "path": diff.path.display().to_string(),
                                "oldText": diff.old_text,
                                "newText": diff.new_text
                            }),
                        );
                        if let Err(ref e) = emit_result {
                            log::error!(
                                "[ACP] Failed to emit DIFF for tool_call {} session {}: {}",
                                update.tool_call_id,
                                session_id,
                                e
                            );
                        }
                    }
                }
            }

            // Serialize status using serde (not Debug format) for consistent
            // values like "in_progress", "completed" that the frontend expects.
            let result_status_str = update.fields.status
                .as_ref()
                .and_then(|s| serde_json::to_value(s).ok())
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| "running".to_string());
            log::debug!(
                "[ACP] Emitting TOOL_RESULT: session={}, tool_call_id={}, status={}",
                session_id,
                update.tool_call_id,
                result_status_str
            );
            let mut result_payload = serde_json::json!({
                "sessionId": session_id,
                "toolCallId": update.tool_call_id.to_string(),
                "status": result_status_str,
            });
            // Include text content as result so the frontend can display it
            if let Some(ref content) = update.fields.content {
                let text_parts: Vec<String> = content
                    .iter()
                    .filter_map(|block| {
                        if let agent_client_protocol::ToolCallContent::Content(c) = block {
                            if let ContentBlock::Text(t) = &c.content {
                                Some(t.text.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    })
                    .collect();
                if !text_parts.is_empty() {
                    let joined = text_parts.join("\n");
                    let truncated = if joined.len() > 5000 {
                        format!("{}... ({} bytes total)", &joined[..5000], joined.len())
                    } else {
                        joined
                    };
                    result_payload["result"] = serde_json::Value::String(truncated);
                }
            }
            let emit_result = app.emit(
                events::TOOL_RESULT,
                result_payload,
            );
            if let Err(ref e) = emit_result {
                log::error!(
                    "[ACP] Failed to emit TOOL_RESULT {} for session {}: {}",
                    update.tool_call_id,
                    session_id,
                    e
                );
            }
        }
        SessionUpdate::Plan(plan) => {
            let plan_entries: Vec<serde_json::Value> = plan
                .entries
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "content": e.content,
                        "status": format!("{:?}", e.status)
                    })
                })
                .collect();

            let _ = app.emit(
                events::PLAN_UPDATE,
                serde_json::json!({
                    "sessionId": session_id,
                    "entries": plan_entries
                }),
            );
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = match &chunk.content {
                ContentBlock::Text(text_content) => text_content.text.clone(),
                _ => format!("{:?}", chunk.content),
            };
            log::debug!(
                "[ACP] Emitting THOUGHT_CHUNK to frontend: sessionId={}, text_len={}",
                session_id,
                text.len()
            );
            let emit_result = app.emit(
                events::MESSAGE_CHUNK,
                serde_json::json!({
                    "sessionId": session_id,
                    "text": text,
                    "isThought": true
                }),
            );
            log::debug!("[ACP] THOUGHT_CHUNK emit result: {:?}", emit_result);
        }
        SessionUpdate::CurrentModeUpdate(update) => {
            log::info!(
                "[ACP] Mode changed: session={}, currentModeId={}",
                session_id,
                &*update.current_mode_id.0
            );
            let _ = app.emit(
                events::SESSION_STATUS,
                serde_json::json!({
                    "sessionId": session_id,
                    "status": "ready",
                    "modes": {
                        "currentModeId": &*update.current_mode_id.0
                    }
                }),
            );
        }
        _ => {
            log::debug!("[ACP] Unhandled session update: {:?}", notification.update);
        }
    }
}

fn normalize_cwd(cwd: &str) -> Result<String, String> {
    let cwd_path = std::path::PathBuf::from(cwd);
    let cwd_abs = if cwd_path.is_absolute() {
        cwd_path
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to resolve current directory: {e}"))?
            .join(cwd_path)
    };

    if !cwd_abs.is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            cwd_abs.display()
        ));
    }

    Ok(cwd_abs
        .canonicalize()
        .unwrap_or(cwd_abs)
        .to_string_lossy()
        .to_string())
}

/// Spawn a new ACP agent session
#[tauri::command]
pub async fn acp_spawn(
    app: AppHandle,
    state: State<'_, AcpState>,
    agent_type: AgentType,
    cwd: String,
    sandbox_mode: Option<String>,
    api_key: Option<String>,
) -> Result<AcpSessionInfo, String> {
    let cwd = normalize_cwd(&cwd)?;
    let parsed_sandbox_mode = sandbox_mode
        .as_deref()
        .map(|s| s.parse::<crate::sandbox::SandboxMode>())
        .transpose()
        .map_err(|e| e)?
        .unwrap_or_default();
    let session_id = Uuid::new_v4().to_string();
    let now = jiff::Timestamp::now();

    // Create channel for commands to the worker thread
    let (command_tx, command_rx) = mpsc::channel::<AcpCommand>(32);

    // Create session entry
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_diff_proposals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let session = AcpSession {
        id: session_id.clone(),
        agent_type,
        cwd: cwd.clone(),
        status: SessionStatus::Initializing,
        created_at: now,
        command_tx: Some(command_tx),
        _worker_handle: None,
        pending_permissions: Arc::clone(&pending_permissions),
        pending_diff_proposals: Arc::clone(&pending_diff_proposals),
    };

    let session_arc = Arc::new(Mutex::new(session));

    // Store session
    {
        let mut sessions = state.sessions.write().await;
        sessions.insert(session_id.clone(), session_arc.clone());
    }

    // Emit initial status
    let _ = app.emit(
        events::SESSION_STATUS,
        serde_json::json!({
            "sessionId": session_id,
            "status": "initializing"
        }),
    );

    // Spawn worker thread for this session (handles !Send ACP futures)
    let app_handle = app.clone();
    let session_id_clone = session_id.clone();
    let cwd_clone = cwd.clone();
    let session_arc_clone = session_arc.clone();
    let api_key_clone = api_key.clone();

    let session_arc_for_worker = session_arc_clone.clone();

    let worker_handle = thread::spawn(move || {
        // Create a new single-threaded runtime for this session
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create runtime");

        let local = tokio::task::LocalSet::new();

        local.block_on(&rt, async move {
            match run_session_worker(
                app_handle.clone(),
                session_id_clone.clone(),
                agent_type,
                cwd_clone,
                command_rx,
                pending_permissions,
                pending_diff_proposals,
                parsed_sandbox_mode,
                api_key_clone,
            )
            .await
            {
                Ok(_) => {}
                Err(e) => {
                    // Update session state so acp_list_sessions reflects the error
                    {
                        let mut session = session_arc_for_worker.lock().await;
                        session.status = SessionStatus::Error;
                    }

                    let error_msg = if is_auth_error(&e) {
                        launch_agent_login(agent_type);
                        auth_error_message(agent_type)
                    } else {
                        e
                    };

                    let _ = app_handle.emit(
                        events::ERROR,
                        serde_json::json!({
                            "sessionId": session_id_clone,
                            "error": error_msg
                        }),
                    );
                    let _ = app_handle.emit(
                        events::SESSION_STATUS,
                        serde_json::json!({
                            "sessionId": session_id_clone,
                            "status": "error"
                        }),
                    );
                }
            }

            // Clean up session from map when worker exits (prevents ghost sessions)
            let cleanup_session_id = session_id_clone.clone();
            let state = app_handle.state::<AcpState>();

            // Check if there are pending permissions before cleanup
            {
                let sessions_read = state.sessions.read().await;
                if let Some(session_arc) = sessions_read.get(&cleanup_session_id) {
                    let session = session_arc.lock().await;
                    let pending = session.pending_permissions.lock().await;
                    if !pending.is_empty() {
                        log::warn!(
                            "[ACP] Session {} worker exiting with {} pending permission requests: {:?}",
                            cleanup_session_id, pending.len(),
                            pending.keys().collect::<Vec<_>>()
                        );
                    }
                }
            }

            let mut sessions = state.sessions.write().await;
            sessions.remove(&cleanup_session_id);
            log::info!("[ACP] Session {} removed from map after worker exit", cleanup_session_id);
        });
    });

    // Store worker handle
    {
        let mut session = session_arc_clone.lock().await;
        session._worker_handle = Some(worker_handle);
    }

    Ok(AcpSessionInfo {
        id: session_id,
        agent_type,
        cwd,
        status: SessionStatus::Initializing,
        created_at: now.to_string(),
    })
}

/// Worker function that runs in a dedicated thread with LocalSet for !Send futures
async fn run_session_worker(
    app: AppHandle,
    session_id: String,
    agent_type: AgentType,
    cwd: String,
    mut command_rx: mpsc::Receiver<AcpCommand>,
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    pending_diff_proposals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    sandbox_mode: crate::sandbox::SandboxMode,
    api_key: Option<String>,
) -> Result<(), String> {
    let command = agent_type.command()?;
    let args = agent_type.args();

    log::info!("[ACP] Spawning agent: {:?} {:?} in {}", command, args, cwd);

    // Spawn the agent process
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    // Ensure the agent can find bundled Node/Git and installed CLI tools.
    // We intentionally avoid mutating the process-wide PATH; we only inject it into this child.
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    let cli_tools_bin = get_cli_tools_bin_dir(&app);

    let full_path = match (&cli_tools_bin, embedded_path.is_empty()) {
        (Some(bin), false) => {
            let sep = if cfg!(target_os = "windows") {
                ";"
            } else {
                ":"
            };
            format!("{}{}{}", bin.display(), sep, embedded_path)
        }
        (Some(bin), true) => bin.to_string_lossy().to_string(),
        (None, false) => embedded_path.to_string(),
        (None, true) => String::new(),
    };

    // Prepend our paths to the existing system PATH so agents can still find
    // system-installed binaries (e.g. `codex` at /usr/local/bin).
    if !full_path.is_empty() {
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        let system_path = std::env::var("PATH").unwrap_or_default();
        let combined = if system_path.is_empty() {
            full_path.clone()
        } else {
            format!("{}{}{}", full_path, sep, system_path)
        };
        cmd.env("PATH", &combined);
    }

    // Set CLAUDE_CLI_PATH so the SDK can find the Claude CLI directly without relying on PATH.
    // This is more reliable than PATH resolution, especially when the claude binary is a Node.js
    // script that requires finding Node.js via its shebang.
    if let Some(ref bin) = cli_tools_bin {
        let claude_binary = if cfg!(target_os = "windows") {
            bin.join("claude.cmd")
        } else {
            bin.join("claude")
        };
        if claude_binary.exists() {
            cmd.env("CLAUDE_CLI_PATH", &claude_binary);
            log::info!(
                "[ACP] Set CLAUDE_CLI_PATH to: {}",
                claude_binary.display()
            );
        } else {
            log::warn!(
                "[ACP] Bundled Claude CLI not found at: {}. SDK will fall back to PATH resolution.",
                claude_binary.display()
            );
        }
    } else {
        log::warn!(
            "[ACP] cli_tools_bin directory not available. SDK will fall back to PATH resolution."
        );
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn {:?} {:?}: {}. Run 'pnpm build:sidecar' to build the acp_agent binary.",
            command, args, e
        )
    })?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    const STDERR_TAIL_MAX_LINES: usize = 200;
    const STDERR_TAIL_ON_ERROR: usize = 50;
    let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    // Spawn a task to log stderr from the agent, keep a tail buffer, and emit to frontend.
    let stderr_tail_for_task = Arc::clone(&stderr_tail);
    let stderr_app = app.clone();
    let stderr_session_id = session_id.clone();
    tokio::task::spawn_local(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut buf = stderr_tail_for_task.lock().await;
                if buf.len() >= STDERR_TAIL_MAX_LINES {
                    buf.pop_front();
                }
                buf.push_back(line.clone());
            }
            log::warn!("[ACP Agent stderr] {}", line);
            let _ = stderr_app.emit(
                "acp://agent-stderr",
                serde_json::json!({
                    "sessionId": stderr_session_id,
                    "line": line
                }),
            );
        }
    });

    // Convert tokio streams to futures-compatible streams using compat layer
    let stdout_compat = stdout.compat();
    let stdin_compat = stdin.compat_write();

    // Create client delegate (keep terminals ref for cleanup on session exit)
    let terminals = Arc::new(Mutex::new(crate::terminal::TerminalManager::new()));
    let activity_notify = Arc::new(tokio::sync::Notify::new());
    let delegate = ClientDelegate {
        app: app.clone(),
        session_id: session_id.clone(),
        cwd: cwd.clone(),
        terminals: Arc::clone(&terminals),
        sandbox_mode,
        pending_permissions,
        pending_diff_proposals,
        terminal_tool_calls: Arc::new(Mutex::new(HashMap::new())),
        activity_notify: Arc::clone(&activity_notify),
    };

    // Create ACP connection - use spawn_local since we're in a LocalSet
    let (connection, io_task) =
        ClientSideConnection::new(delegate, stdin_compat, stdout_compat, |fut| {
            tokio::task::spawn_local(async move {
                fut.await;
            });
        });

    // Spawn the IO task locally
    log::info!("[ACP] Spawning IO task...");
    tokio::task::spawn_local(async move {
        log::info!("[ACP] IO task started");
        if let Err(e) = io_task.await {
            log::error!("[ACP] IO task error: {:?}", e);
        }
        log::info!("[ACP] IO task finished");
    });

    // Give the IO task a moment to start
    tokio::task::yield_now().await;
    log::info!("[ACP] IO task spawned, proceeding with initialization...");

    // Initialize the agent (with 30-second timeout to prevent infinite hang)
    log::info!("[ACP] Sending initialize request...");
    let init_request = InitializeRequest::new(ProtocolVersion::LATEST)
        .client_info(Implementation::new(
            "seren-desktop",
            env!("CARGO_PKG_VERSION"),
        ))
        .client_capabilities(ClientCapabilities::default());

    let init_future = connection.initialize(init_request);
    let init_result = tokio::time::timeout(std::time::Duration::from_secs(30), init_future).await;

    let init_response = match init_result {
        Err(_elapsed) => {
            return Err(
                "Agent initialization timed out after 30 seconds. The agent binary may be hung."
                    .to_string(),
            );
        }
        Ok(result) => match result {
            Ok(resp) => resp,
            Err(e) => {
                let exit_status = child.try_wait().ok().flatten();
                let stderr_lines = {
                    let buf = stderr_tail.lock().await;
                    buf.iter()
                        .rev()
                        .take(STDERR_TAIL_ON_ERROR)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                };

                let mut msg = format!("Failed to initialize agent: {:?}", e);
                if let Some(status) = exit_status {
                    msg.push_str(&format!("\nAgent exit status: {status}"));
                }
                if !stderr_lines.is_empty() {
                    msg.push_str("\nACP agent stderr (tail):\n");
                    msg.push_str(&stderr_lines.join("\n"));
                }
                return Err(msg);
            }
        },
    };
    log::info!("[ACP] Initialize response received");

    // Create a new session with the agent
    log::info!("[ACP] Creating new session...");
    let mcp_servers = build_mcp_servers(api_key.as_deref());
    log::info!("[ACP] MCP servers for session: {:?}", mcp_servers.len());
    let new_session_request = NewSessionRequest::new(&cwd).mcp_servers(mcp_servers);

    let new_session_response = match connection.new_session(new_session_request).await {
        Ok(resp) => resp,
        Err(e) => {
            let exit_status = child.try_wait().ok().flatten();
            let stderr_lines = {
                let buf = stderr_tail.lock().await;
                buf.iter()
                    .rev()
                    .take(STDERR_TAIL_ON_ERROR)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
            };

            let mut msg = format!("Failed to create agent session: {:?}", e);
            if let Some(status) = exit_status {
                msg.push_str(&format!("\nAgent exit status: {status}"));
            }
            if !stderr_lines.is_empty() {
                msg.push_str("\nACP agent stderr (tail):\n");
                msg.push_str(&stderr_lines.join("\n"));
            }
            return Err(msg);
        }
    };
    log::info!(
        "[ACP] Session created: {:?}",
        new_session_response.session_id
    );

    let agent_session_id = new_session_response.session_id;

    // Emit ready status with agent info
    let agent_info = init_response.agent_info.as_ref();
    log::info!(
        "[ACP] Emitting ready status for session {} (agent: {:?})",
        session_id,
        agent_info.map(|i| i.name.as_str())
    );
    // Extract model state from session response (if agent supports model selection)
    let models_json = new_session_response.models.as_ref().map(|m| {
        serde_json::json!({
            "currentModelId": &*m.current_model_id.0,
            "availableModels": m.available_models.iter().map(|info| {
                serde_json::json!({
                    "modelId": &*info.model_id.0,
                    "name": &info.name,
                })
            }).collect::<Vec<_>>()
        })
    });

    // Extract mode state from session response (if agent supports mode selection)
    let modes_json = new_session_response.modes.as_ref().map(|m| {
        serde_json::json!({
            "currentModeId": &*m.current_mode_id.0,
            "availableModes": m.available_modes.iter().map(|mode| {
                serde_json::json!({
                    "modeId": &*mode.id.0,
                    "name": &mode.name,
                    "description": &mode.description,
                })
            }).collect::<Vec<_>>()
        })
    });

    let emit_result = app.emit(
        events::SESSION_STATUS,
        serde_json::json!({
            "sessionId": session_id,
            "status": "ready",
            "agentInfo": {
                "name": agent_info.map(|i| i.name.as_str()).unwrap_or("Unknown"),
                "version": agent_info.map(|i| i.version.as_str()).unwrap_or("Unknown")
            },
            "models": models_json,
            "modes": modes_json
        }),
    );
    log::debug!("[ACP] Emit result: {:?}", emit_result);

    // Auto-set the user's preferred permission mode if the agent advertises modes.
    // Map Seren sandbox mode names to agent mode IDs by matching name patterns.
    if let Some(mode_state) = &new_session_response.modes {
        let preferred = match sandbox_mode {
            crate::sandbox::SandboxMode::ReadOnly => "read",
            crate::sandbox::SandboxMode::WorkspaceWrite => "default",
            crate::sandbox::SandboxMode::FullAccess => "full",
        };

        let target_mode = mode_state
            .available_modes
            .iter()
            .find(|m| m.name.to_lowercase().contains(preferred))
            .map(|m| m.id.clone());

        if let Some(mode_id) = target_mode {
            if mode_id != mode_state.current_mode_id {
                log::info!(
                    "[ACP] Auto-setting mode to {:?} (user preference: {:?})",
                    &*mode_id.0,
                    preferred
                );
                let request = SetSessionModeRequest::new(agent_session_id.clone(), mode_id);
                match connection.set_session_mode(request).await {
                    Ok(_) => log::info!("[ACP] Mode set successfully"),
                    Err(e) => log::warn!("[ACP] Failed to auto-set mode: {:?}", e),
                }
            }
        }
    }

    // Command processing loop
    while let Some(cmd) = command_rx.recv().await {
        match cmd {
            AcpCommand::Prompt {
                prompt,
                context,
                response_tx,
            } => {
                let _ = app.emit(
                    events::SESSION_STATUS,
                    serde_json::json!({
                        "sessionId": session_id,
                        "status": "prompting"
                    }),
                );

                // Build content blocks
                let mut content_blocks = vec![ContentBlock::Text(TextContent::new(prompt.clone()))];

                if let Some(ctx) = context {
                    for item in ctx {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            content_blocks.push(ContentBlock::Text(TextContent::new(text)));
                        }
                    }
                }

                let prompt_request = PromptRequest::new(agent_session_id.clone(), content_blocks);

                log::info!(
                    "[ACP] Sending prompt to agent session: {}",
                    agent_session_id
                );

                // Run the prompt while remaining responsive to Cancel/Terminate commands.
                // Without select!, the loop blocks on connection.prompt() and cannot
                // process cancel requests until the prompt finishes.
                let mut prompt_fut = std::pin::pin!(connection.prompt(prompt_request));
                let mut cancelled = false;
                let mut cancel_deadline: Option<tokio::time::Instant> = None;
                let mut force_stopped = false;
                // Activity-aware timeout: resets whenever the agent sends a
                // notification (message chunk, tool call, tool result, etc.).
                // Only fires when the agent is truly silent for PROMPT_TIMEOUT_SECS.
                let mut idle_deadline = tokio::time::Instant::now()
                    + std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS);

                let prompt_result = loop {
                    // If cancel was sent, enforce a deadline for the prompt to finish
                    if let Some(deadline) = cancel_deadline {
                        tokio::select! {
                            result = &mut prompt_fut => {
                                break result;
                            }
                            _ = tokio::time::sleep_until(deadline) => {
                                log::warn!("[ACP] Prompt did not resolve within 5s after cancel — agent unresponsive");
                                force_stopped = true;
                                break Err(agent_client_protocol::Error::internal_error().data(
                                    serde_json::Value::String("Agent unresponsive — session will restart automatically".into()),
                                ));
                            }
                            cmd = command_rx.recv() => {
                                match cmd {
                                    Some(AcpCommand::Terminate) => {
                                        log::info!("[ACP] Terminate received after cancel");
                                        let _ = response_tx.send(Err("Session terminated".to_string()));
                                        drop(child);
                                        return Ok(());
                                    }
                                    Some(AcpCommand::Cancel { response_tx: dup_cancel_tx }) => {
                                        log::info!("[ACP] Duplicate cancel received — already cancelling");
                                        let _ = dup_cancel_tx.send(Ok(()));
                                    }
                                    _ => {
                                        // Ignore other commands while waiting for cancel to take effect
                                    }
                                }
                            }
                        }
                    } else {
                        tokio::select! {
                            result = &mut prompt_fut => {
                                break result;
                            }
                            _ = tokio::time::sleep_until(idle_deadline) => {
                                log::warn!(
                                    "[ACP] Prompt timed out after {}s of inactivity — agent unresponsive",
                                    PROMPT_TIMEOUT_SECS
                                );
                                force_stopped = true;
                                break Err(agent_client_protocol::Error::internal_error().data(
                                    serde_json::Value::String(
                                        "Agent unresponsive — session will restart automatically".into(),
                                    ),
                                ));
                            }
                            _ = activity_notify.notified() => {
                                // Agent sent a notification — reset the idle deadline
                                idle_deadline = tokio::time::Instant::now()
                                    + std::time::Duration::from_secs(PROMPT_TIMEOUT_SECS);
                            }
                            cmd = command_rx.recv() => {
                                match cmd {
                                    Some(AcpCommand::Cancel { response_tx: cancel_tx }) => {
                                        log::info!("[ACP] Cancel received during active prompt");
                                        let cancel = CancelNotification::new(agent_session_id.clone());
                                        let cancel_result = connection.cancel(cancel).await;
                                        let _ = cancel_tx.send(cancel_result.map_err(|e| format!("{:?}", e)));
                                        cancelled = true;
                                        cancel_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(5));
                                    }
                                    Some(AcpCommand::Terminate) => {
                                        log::info!("[ACP] Terminate received during active prompt");
                                        let _ = response_tx.send(Err("Session terminated".to_string()));
                                        drop(child);
                                        return Ok(());
                                    }
                                    Some(other) => {
                                        log::info!("[ACP] Rejecting command while prompt is active");
                                        if let AcpCommand::Prompt { response_tx: tx, .. } = other {
                                            let _ = tx.send(Err("Another prompt is already active".to_string()));
                                        } else if let AcpCommand::SetMode { response_tx: tx, .. } = other {
                                            let _ = tx.send(Err("Cannot change mode while prompt is active".to_string()));
                                        }
                                    }
                                    None => {
                                        let _ = response_tx.send(Err("Command channel closed".to_string()));
                                        return Ok(());
                                    }
                                }
                            }
                        }
                    }
                };

                match prompt_result {
                    Ok(response) => {
                        if cancelled {
                            log::info!(
                                "[ACP] Prompt completed after cancellation: {:?}",
                                response.stop_reason
                            );
                        } else {
                            log::info!(
                                "[ACP] Prompt completed successfully: {:?}",
                                response.stop_reason
                            );
                        }
                        let _ = app.emit(
                            events::PROMPT_COMPLETE,
                            serde_json::json!({
                                "sessionId": session_id,
                                "stopReason": format!("{:?}", response.stop_reason)
                            }),
                        );
                        let _ = response_tx.send(Ok(()));
                    }
                    Err(e) => {
                        log::error!("[ACP] Prompt error: {:?}", e);
                        let friendly = format_acp_error(&e);
                        let _ = app.emit(
                            events::ERROR,
                            serde_json::json!({
                                "sessionId": session_id,
                                "error": &friendly
                            }),
                        );
                        let _ = response_tx.send(Err(friendly));
                    }
                }

                // If the agent was force-stopped (timeout or unresponsive cancel),
                // kill the agent process and exit the worker. The frontend will
                // detect the dead session and auto-recover with a fresh spawn.
                if force_stopped {
                    log::info!("[ACP] Session force-stopped — exiting worker to kill agent process");
                    break;
                }

                let _ = app.emit(
                    events::SESSION_STATUS,
                    serde_json::json!({
                        "sessionId": session_id,
                        "status": "ready"
                    }),
                );
            }
            AcpCommand::Cancel { response_tx } => {
                // Cancel received when no prompt is active — still send it to the agent
                let cancel = CancelNotification::new(agent_session_id.clone());
                match connection.cancel(cancel).await {
                    Ok(_) => {
                        let _ = response_tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = response_tx.send(Err(format!("{:?}", e)));
                    }
                }
            }
            AcpCommand::SetMode { mode, response_tx } => {
                let mode_id = SessionModeId::new(mode);
                let request = SetSessionModeRequest::new(agent_session_id.clone(), mode_id);
                match connection.set_session_mode(request).await {
                    Ok(_) => {
                        let _ = response_tx.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = response_tx.send(Err(format!("{:?}", e)));
                    }
                }
            }
            AcpCommand::SetModel {
                model_id,
                response_tx,
            } => {
                let request = SetSessionModelRequest::new(
                    agent_session_id.clone(),
                    ModelId::new(model_id),
                );
                match connection.set_session_model(request).await {
                    Ok(_) => {
                        let _ = response_tx.send(Ok(()));
                    }
                    Err(e) => {
                        log::error!("[ACP] Failed to set model: {:?}", e);
                        let _ = response_tx.send(Err(format_acp_error(&e)));
                    }
                }
            }
            AcpCommand::Terminate => {
                break;
            }
        }
    }

    // Cleanup: release all terminals to prevent orphaned processes
    terminals.lock().await.release_all();

    // Cleanup: child process will be dropped
    drop(child);
    Ok(())
}

/// Send a prompt to an ACP agent
#[tauri::command]
pub async fn acp_prompt(
    state: State<'_, AcpState>,
    session_id: String,
    prompt: String,
    context: Option<Vec<serde_json::Value>>,
) -> Result<(), String> {
    let (command_tx, agent_type) = {
        let sessions = state.sessions.read().await;
        let session_arc = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        let session = session_arc.lock().await;
        let agent_type = session.agent_type;
        let tx = session
            .command_tx
            .clone()
            .ok_or_else(|| "Session not initialized".to_string())?;
        (tx, agent_type)
    };

    let (response_tx, response_rx) = oneshot::channel();

    command_tx
        .send(AcpCommand::Prompt {
            prompt,
            context,
            response_tx,
        })
        .await
        .map_err(|_| "Failed to send prompt command".to_string())?;

    // Wait for the prompt to complete
    let result = response_rx
        .await
        .map_err(|_| "Worker thread dropped".to_string())?;

    if let Err(ref e) = result {
        if is_auth_error(e) {
            launch_agent_login(agent_type);
            return Err(auth_error_message(agent_type));
        }
    }

    result
}

/// Cancel an ongoing prompt
#[tauri::command]
pub async fn acp_cancel(state: State<'_, AcpState>, session_id: String) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        let session_arc = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        let session = session_arc.lock().await;
        session
            .command_tx
            .clone()
            .ok_or_else(|| "Session not initialized".to_string())?
    };

    let (response_tx, response_rx) = oneshot::channel();

    command_tx
        .send(AcpCommand::Cancel { response_tx })
        .await
        .map_err(|_| "Failed to send cancel command".to_string())?;

    response_rx
        .await
        .map_err(|_| "Worker thread dropped".to_string())?
}

/// Terminate an ACP session
#[tauri::command]
pub async fn acp_terminate(state: State<'_, AcpState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.write().await;

    if let Some(session_arc) = sessions.remove(&session_id) {
        let mut session = session_arc.lock().await;
        session.status = SessionStatus::Terminated;

        // Send terminate command to worker thread
        if let Some(tx) = session.command_tx.take() {
            let _ = tx.send(AcpCommand::Terminate).await;
        }
        // Worker thread and child process will be cleaned up
    }

    Ok(())
}

/// List all ACP sessions
#[tauri::command]
pub async fn acp_list_sessions(state: State<'_, AcpState>) -> Result<Vec<AcpSessionInfo>, String> {
    let sessions = state.sessions.read().await;
    let mut result = Vec::new();

    for session_arc in sessions.values() {
        let session = session_arc.lock().await;
        result.push(AcpSessionInfo {
            id: session.id.clone(),
            agent_type: session.agent_type,
            cwd: session.cwd.clone(),
            status: session.status,
            created_at: session.created_at.to_string(),
        });
    }

    Ok(result)
}

/// Set the permission mode for a session
#[tauri::command]
pub async fn acp_set_permission_mode(
    state: State<'_, AcpState>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        let session_arc = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        let session = session_arc.lock().await;
        session
            .command_tx
            .clone()
            .ok_or_else(|| "Session not initialized".to_string())?
    };

    let (response_tx, response_rx) = oneshot::channel();

    command_tx
        .send(AcpCommand::SetMode { mode, response_tx })
        .await
        .map_err(|_| "Failed to send set mode command".to_string())?;

    response_rx
        .await
        .map_err(|_| "Worker thread dropped".to_string())?
}

/// Set the AI model for an ACP session.
#[tauri::command]
pub async fn acp_set_model(
    state: State<'_, AcpState>,
    session_id: String,
    model_id: String,
) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        let session_arc = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        let session = session_arc.lock().await;
        session
            .command_tx
            .clone()
            .ok_or_else(|| "Session not initialized".to_string())?
    };

    let (response_tx, response_rx) = oneshot::channel();

    command_tx
        .send(AcpCommand::SetModel {
            model_id,
            response_tx,
        })
        .await
        .map_err(|_| "Failed to send set model command".to_string())?;

    response_rx
        .await
        .map_err(|_| "Worker thread dropped".to_string())?
}

/// Respond to a permission request from the frontend
#[tauri::command]
pub async fn acp_respond_to_permission(
    state: State<'_, AcpState>,
    session_id: String,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    log::info!(
        "[ACP] Frontend responding to permission {}: session={}, option={}",
        request_id,
        session_id,
        option_id
    );

    let sessions = state.sessions.read().await;
    let session_arc = sessions.get(&session_id).ok_or_else(|| {
        let msg = format!(
            "Session '{}' not found (may have been cleaned up). Active sessions: {:?}",
            session_id,
            sessions.keys().collect::<Vec<_>>()
        );
        log::error!("[ACP] {}", msg);
        msg
    })?;
    let session = session_arc.lock().await;

    log::debug!("[ACP] Session {} status: {:?}", session_id, session.status);

    let mut permissions = session.pending_permissions.lock().await;
    log::debug!(
        "[ACP] Pending permissions for session {}: {:?}",
        session_id,
        permissions.keys().collect::<Vec<_>>()
    );

    let sender = permissions.remove(&request_id).ok_or_else(|| {
        let msg = format!(
            "Permission request '{}' not found in session '{}'. Pending: {:?}",
            request_id,
            session_id,
            permissions.keys().collect::<Vec<_>>()
        );
        log::error!("[ACP] {}", msg);
        msg
    })?;

    sender.send(option_id.clone()).map_err(|_| {
        let msg = format!(
            "Permission request {} channel closed (worker may have exited)",
            request_id
        );
        log::error!("[ACP] {}", msg);
        msg
    })?;

    log::info!("[ACP] Permission {} delivered successfully", request_id);
    Ok(())
}

/// Respond to a diff proposal from the frontend (accept or reject)
#[tauri::command]
pub async fn acp_respond_to_diff_proposal(
    state: State<'_, AcpState>,
    session_id: String,
    proposal_id: String,
    accepted: bool,
) -> Result<(), String> {
    let sessions = state.sessions.read().await;
    let session_arc = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;
    let session = session_arc.lock().await;

    let mut proposals = session.pending_diff_proposals.lock().await;
    let sender = proposals
        .remove(&proposal_id)
        .ok_or_else(|| format!("Diff proposal '{}' not found", proposal_id))?;

    sender
        .send(accepted)
        .map_err(|_| "Diff proposal channel closed".to_string())
}

/// Get available agents with actual availability checks.
#[tauri::command]
pub async fn acp_get_available_agents(app: AppHandle) -> Vec<serde_json::Value> {
    let claude_binary_available = acp_check_agent_available(AgentType::ClaudeCode)
        .await
        .unwrap_or(false);
    let cli_tools_available = get_cli_tools_bin_dir(&app)
        .map(|bin| {
            let claude = if cfg!(target_os = "windows") {
                bin.join("claude.cmd")
            } else {
                bin.join("claude")
            };
            claude.exists()
        })
        .unwrap_or(false);
    let claude_available = claude_binary_available || cli_tools_available;

    let codex_available = acp_check_agent_available(AgentType::Codex)
        .await
        .unwrap_or(false);

    let mut claude = serde_json::json!({
        "type": "claude-code",
        "name": "Claude Code",
        "description": "AI coding assistant powered by Claude",
        "command": "seren-acp-claude",
        "available": claude_available,
    });

    if !claude_available {
        claude["unavailableReason"] =
            serde_json::Value::String("Claude Code agent binary not found".to_string());
    }

    let mut codex = serde_json::json!({
        "type": "codex",
        "name": "Codex",
        "description": "AI coding assistant powered by OpenAI Codex",
        "command": "seren-acp-codex",
        "available": codex_available,
    });

    if !codex_available {
        codex["unavailableReason"] =
            serde_json::Value::String("Codex agent binary not found".to_string());
    }

    vec![claude, codex]
}

/// Check if an agent binary is available
#[tauri::command]
pub async fn acp_check_agent_available(agent_type: AgentType) -> Result<bool, String> {
    match agent_type.command() {
        Ok(path) => Ok(path.exists()),
        Err(_) => Ok(false),
    }
}

/// Launch the authentication flow for an agent (Claude login or Codex OAuth).
#[tauri::command]
pub fn acp_launch_login(agent_type: AgentType) {
    launch_agent_login(agent_type);
}

/// Ensure Claude Code CLI is installed, auto-installing via npm if needed.
/// Returns the bin directory path containing the claude binary.
#[tauri::command]
pub async fn acp_ensure_claude_cli(app: AppHandle) -> Result<String, String> {
    let cli_tools_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {e}"))?
        .join("cli-tools");

    let bin_dir = cli_tools_dir.join("node_modules").join(".bin");
    let claude_bin = if cfg!(target_os = "windows") {
        bin_dir.join("claude.cmd")
    } else {
        bin_dir.join("claude")
    };

    // Minimum required CLI version for SDK compatibility
    const MIN_CLI_VERSION: &str = "2.1.30";

    // Already installed locally? Check version and upgrade if needed.
    if claude_bin.exists() {
        // Check version - must set PATH so the claude shebang can find Node.js
        let embedded_path = crate::embedded_runtime::get_embedded_path();
        if let Ok(output) = std::process::Command::new(&claude_bin)
            .arg("--version")
            .env("PATH", embedded_path)
            .output()
        {
            let version_str = String::from_utf8_lossy(&output.stdout);
            let version = version_str
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().next())
                .unwrap_or("")
                .trim();

            if is_version_sufficient(version, MIN_CLI_VERSION) {
                log::info!(
                    "[ACP] Claude CLI {} at: {}",
                    version,
                    claude_bin.display()
                );
                return Ok(bin_dir.to_string_lossy().to_string());
            }

            // Version is outdated - upgrade silently
            log::info!(
                "[ACP] Claude CLI {} is outdated (need {}), upgrading...",
                version,
                MIN_CLI_VERSION
            );

            if let Err(e) = upgrade_claude_cli_sync(&cli_tools_dir, &app) {
                log::warn!("[ACP] Auto-upgrade failed: {}. Will retry on next launch.", e);
            } else {
                log::info!("[ACP] Claude CLI upgraded successfully");
            }

            return Ok(bin_dir.to_string_lossy().to_string());
        }

        // Couldn't check version, return existing path
        log::info!(
            "[ACP] Claude CLI at: {}",
            claude_bin.display()
        );
        return Ok(bin_dir.to_string_lossy().to_string());
    }

    // Check if claude is available on the system PATH
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let which_arg = if cfg!(target_os = "windows") {
        "claude.cmd"
    } else {
        "claude"
    };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg(which_arg)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(parent) = std::path::Path::new(&path).parent() {
                log::info!("[ACP] Found claude on system PATH: {}", path);
                return Ok(parent.to_string_lossy().to_string());
            }
        }
    }

    log::info!("[ACP] Claude CLI not found, installing via npm...");

    let _ = app.emit(
        "acp://cli-install-progress",
        serde_json::json!({
            "stage": "installing",
            "message": "Installing Claude Code CLI..."
        }),
    );

    // Create directory
    std::fs::create_dir_all(&cli_tools_dir)
        .map_err(|e| format!("Failed to create cli-tools dir: {e}"))?;

    // Run npm install using embedded Node runtime.
    // We invoke node directly with the npm CLI script because the top-level
    // `npm` shim has a broken require path in the extracted Node tarball.
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    let paths = crate::embedded_runtime::discover_embedded_runtime(&app);
    let node_bin = paths
        .node_dir
        .as_ref()
        .map(|d| {
            if cfg!(target_os = "windows") {
                d.join("node.exe")
            } else {
                d.join("node")
            }
        })
        .ok_or_else(|| "Embedded Node.js not found".to_string())?;

    // Find the npm CLI script relative to the node binary.
    // On macOS/Linux: node is at node/bin/node, npm at node/lib/node_modules/npm/bin/npm-cli.js
    // On Windows: node is at node/node.exe, npm at node/node_modules/npm/bin/npm-cli.js
    let npm_cli = if cfg!(target_os = "windows") {
        node_bin
            .parent()
            .unwrap()
            .join("node_modules/npm/bin/npm-cli.js")
    } else {
        node_bin
            .parent()
            .unwrap()
            .join("../lib/node_modules/npm/bin/npm-cli.js")
    };
    let npm_cli = npm_cli.canonicalize().map_err(|e| {
        format!(
            "npm CLI script not found at {:?}: {}. Ensure embedded Node.js runtime is properly installed.",
            npm_cli, e
        )
    })?;

    let output = tokio::process::Command::new(&node_bin)
        .args([
            npm_cli.to_string_lossy().as_ref(),
            "install",
            "--prefix",
            &cli_tools_dir.to_string_lossy(),
            "@anthropic-ai/claude-code",
        ])
        .env("PATH", embedded_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run npm install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = app.emit(
            "acp://cli-install-progress",
            serde_json::json!({
                "stage": "error",
                "message": format!("Install failed: {stderr}")
            }),
        );
        return Err(format!("npm install failed: {stderr}"));
    }

    // Verify the binary exists
    if !claude_bin.exists() {
        return Err("Install completed but claude binary not found".to_string());
    }

    log::info!(
        "[ACP] Claude CLI installed successfully at: {}",
        claude_bin.display()
    );

    let _ = app.emit(
        "acp://cli-install-progress",
        serde_json::json!({
            "stage": "complete",
            "message": "Claude Code CLI installed successfully"
        }),
    );

    Ok(bin_dir.to_string_lossy().to_string())
}

/// Get the cli-tools bin directory if it exists.
fn get_cli_tools_bin_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let bin_dir = app
        .path()
        .app_data_dir()
        .ok()?
        .join("cli-tools")
        .join("node_modules")
        .join(".bin");
    if bin_dir.exists() {
        Some(bin_dir)
    } else {
        None
    }
}

/// Check if a CLI version meets the minimum requirement.
fn is_version_sufficient(version: &str, min_version: &str) -> bool {
    let parse = |v: &str| -> Option<(u32, u32, u32)> {
        let parts: Vec<&str> = v.trim_start_matches('v').split('.').collect();
        if parts.len() < 3 {
            return None;
        }
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    };

    let Some((cur_maj, cur_min, cur_patch)) = parse(version) else {
        return false;
    };
    let Some((min_maj, min_min, min_patch)) = parse(min_version) else {
        return false;
    };

    (cur_maj, cur_min, cur_patch) >= (min_maj, min_min, min_patch)
}

/// Ensure Codex CLI (`@openai/codex`) is installed and meets the minimum version.
/// Installs or upgrades via npm into the shared cli-tools directory.
/// Returns the bin directory path containing the codex binary.
#[tauri::command]
pub async fn acp_ensure_codex_cli(app: AppHandle) -> Result<String, String> {
    let cli_tools_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {e}"))?
        .join("cli-tools");

    let bin_dir = cli_tools_dir.join("node_modules").join(".bin");
    let codex_bin = if cfg!(target_os = "windows") {
        bin_dir.join("codex.cmd")
    } else {
        bin_dir.join("codex")
    };

    // Minimum required Codex CLI version for app-server protocol compatibility
    const MIN_CODEX_CLI_VERSION: &str = "0.98.0";

    // Already installed locally? Check version and upgrade if needed.
    if codex_bin.exists() {
        let embedded_path = crate::embedded_runtime::get_embedded_path();
        if let Ok(output) = std::process::Command::new(&codex_bin)
            .arg("--version")
            .env("PATH", embedded_path)
            .output()
        {
            // `codex --version` outputs "codex-cli X.Y.Z"
            let version_str = String::from_utf8_lossy(&output.stdout);
            let version = version_str
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().last())
                .unwrap_or("")
                .trim();

            if is_version_sufficient(version, MIN_CODEX_CLI_VERSION) {
                log::info!(
                    "[ACP] Codex CLI {} at: {}",
                    version,
                    codex_bin.display()
                );
                return Ok(bin_dir.to_string_lossy().to_string());
            }

            log::info!(
                "[ACP] Codex CLI {} is outdated (need {}), upgrading...",
                version,
                MIN_CODEX_CLI_VERSION
            );

            if let Err(e) = upgrade_codex_cli_sync(&cli_tools_dir, &app) {
                log::warn!("[ACP] Codex CLI auto-upgrade failed: {}. Will retry on next launch.", e);
            } else {
                log::info!("[ACP] Codex CLI upgraded successfully");
            }

            return Ok(bin_dir.to_string_lossy().to_string());
        }

        log::info!("[ACP] Codex CLI at: {}", codex_bin.display());
        return Ok(bin_dir.to_string_lossy().to_string());
    }

    // Check if codex is available on the system PATH
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let which_arg = if cfg!(target_os = "windows") {
        "codex.cmd"
    } else {
        "codex"
    };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg(which_arg)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(parent) = std::path::Path::new(&path).parent() {
                // Check version of system-installed codex
                let embedded_path = crate::embedded_runtime::get_embedded_path();
                if let Ok(ver_output) = std::process::Command::new(&path)
                    .arg("--version")
                    .env("PATH", &embedded_path)
                    .output()
                {
                    let version_str = String::from_utf8_lossy(&ver_output.stdout);
                    let version = version_str
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().last())
                        .unwrap_or("")
                        .trim();

                    if is_version_sufficient(version, MIN_CODEX_CLI_VERSION) {
                        log::info!("[ACP] Found codex {} on system PATH: {}", version, path);
                        return Ok(parent.to_string_lossy().to_string());
                    }

                    log::info!(
                        "[ACP] System codex {} is outdated (need {}), installing locally...",
                        version,
                        MIN_CODEX_CLI_VERSION
                    );
                    // Fall through to install locally
                } else {
                    log::info!("[ACP] Found codex on system PATH: {}", path);
                    return Ok(parent.to_string_lossy().to_string());
                }
            }
        }
    }

    log::info!("[ACP] Codex CLI not found or outdated, installing via npm...");

    let _ = app.emit(
        "acp://cli-install-progress",
        serde_json::json!({
            "stage": "installing",
            "message": "Installing Codex CLI..."
        }),
    );

    // Create directory
    std::fs::create_dir_all(&cli_tools_dir)
        .map_err(|e| format!("Failed to create cli-tools dir: {e}"))?;

    let embedded_path = crate::embedded_runtime::get_embedded_path();
    let paths = crate::embedded_runtime::discover_embedded_runtime(&app);
    let node_bin = paths
        .node_dir
        .as_ref()
        .map(|d| {
            if cfg!(target_os = "windows") {
                d.join("node.exe")
            } else {
                d.join("node")
            }
        })
        .ok_or_else(|| "Embedded Node.js not found".to_string())?;

    let npm_cli = if cfg!(target_os = "windows") {
        node_bin
            .parent()
            .unwrap()
            .join("node_modules/npm/bin/npm-cli.js")
    } else {
        node_bin
            .parent()
            .unwrap()
            .join("../lib/node_modules/npm/bin/npm-cli.js")
    };
    let npm_cli = npm_cli.canonicalize().map_err(|e| {
        format!(
            "npm CLI script not found at {:?}: {}. Ensure embedded Node.js runtime is properly installed.",
            npm_cli, e
        )
    })?;

    let output = tokio::process::Command::new(&node_bin)
        .args([
            npm_cli.to_string_lossy().as_ref(),
            "install",
            "--prefix",
            &cli_tools_dir.to_string_lossy(),
            "@openai/codex",
        ])
        .env("PATH", embedded_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run npm install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = app.emit(
            "acp://cli-install-progress",
            serde_json::json!({
                "stage": "error",
                "message": format!("Install failed: {stderr}")
            }),
        );
        return Err(format!("npm install failed: {stderr}"));
    }

    if !codex_bin.exists() {
        return Err("Install completed but codex binary not found".to_string());
    }

    log::info!(
        "[ACP] Codex CLI installed successfully at: {}",
        codex_bin.display()
    );

    let _ = app.emit(
        "acp://cli-install-progress",
        serde_json::json!({
            "stage": "complete",
            "message": "Codex CLI installed successfully"
        }),
    );

    Ok(bin_dir.to_string_lossy().to_string())
}

/// Upgrade Codex CLI synchronously (blocking).
fn upgrade_codex_cli_sync(
    cli_tools_dir: &std::path::Path,
    app: &AppHandle,
) -> Result<(), String> {
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);

    let node_bin = paths
        .node_dir
        .as_ref()
        .map(|d| {
            if cfg!(target_os = "windows") {
                d.join("node.exe")
            } else {
                d.join("node")
            }
        })
        .ok_or_else(|| "Embedded Node.js not found".to_string())?;

    let npm_cli = if cfg!(target_os = "windows") {
        node_bin
            .parent()
            .unwrap()
            .join("node_modules/npm/bin/npm-cli.js")
    } else {
        node_bin
            .parent()
            .unwrap()
            .join("../lib/node_modules/npm/bin/npm-cli.js")
    };
    let npm_cli = npm_cli
        .canonicalize()
        .map_err(|e| format!("npm CLI not found: {e}"))?;

    let output = std::process::Command::new(&node_bin)
        .args([
            npm_cli.to_string_lossy().as_ref(),
            "install",
            "--prefix",
            &cli_tools_dir.to_string_lossy(),
            "@openai/codex@latest",
        ])
        .env("PATH", embedded_path)
        .output()
        .map_err(|e| format!("Failed to run npm: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {stderr}"));
    }

    Ok(())
}

/// Upgrade Claude CLI synchronously (blocking).
fn upgrade_claude_cli_sync(
    cli_tools_dir: &std::path::Path,
    app: &AppHandle,
) -> Result<(), String> {
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);

    let node_bin = paths
        .node_dir
        .as_ref()
        .map(|d| {
            if cfg!(target_os = "windows") {
                d.join("node.exe")
            } else {
                d.join("node")
            }
        })
        .ok_or_else(|| "Embedded Node.js not found".to_string())?;

    // Platform-specific npm CLI path (same logic as acp_ensure_claude_cli)
    let npm_cli = if cfg!(target_os = "windows") {
        node_bin
            .parent()
            .unwrap()
            .join("node_modules/npm/bin/npm-cli.js")
    } else {
        node_bin
            .parent()
            .unwrap()
            .join("../lib/node_modules/npm/bin/npm-cli.js")
    };
    let npm_cli = npm_cli
        .canonicalize()
        .map_err(|e| format!("npm CLI not found: {e}"))?;

    let output = std::process::Command::new(&node_bin)
        .args([
            npm_cli.to_string_lossy().as_ref(),
            "install",
            "--prefix",
            &cli_tools_dir.to_string_lossy(),
            "@anthropic-ai/claude-code@latest",
        ])
        .env("PATH", embedded_path)
        .output()
        .map_err(|e| format!("Failed to run npm: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {stderr}"));
    }

    Ok(())
}
