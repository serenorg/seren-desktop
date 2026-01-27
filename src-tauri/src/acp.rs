// ABOUTME: ACP (Agent Client Protocol) integration for spawning and communicating with AI coding agents.
// ABOUTME: Supports Claude Code agents via ndjson stdio communication.

use agent_client_protocol::{Agent, Client, ClientSideConnection, Result as AcpResult};
use agent_client_protocol::{
    CancelNotification, ClientCapabilities, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, ExtNotification, ExtRequest, ExtResponse, Implementation,
    InitializeRequest, KillTerminalCommandRequest, KillTerminalCommandResponse, NewSessionRequest,
    PromptRequest, ProtocolVersion, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionRequest,
    RequestPermissionResponse, SessionModeId, SessionNotification, SessionUpdate,
    SetSessionModeRequest, TerminalOutputRequest, TerminalOutputResponse, TextContent,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse, WriteTextFileRequest,
    WriteTextFileResponse,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock, mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use uuid::Uuid;

/// Agent types supported by the ACP integration
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentType {
    ClaudeCode,
    Codex,
}

impl AgentType {
    /// Get the command to spawn this agent
    ///
    /// For ClaudeCode, we use the bundled seren-acp-agent binary which wraps
    /// claude-code-acp-rs. This binary is built alongside the main Seren app
    /// and provides ACP protocol support over stdio.
    fn command(&self) -> String {
        match self {
            AgentType::ClaudeCode => {
                // Get the path to the bundled seren-acp-agent binary
                // In development, it's in the target directory
                // In production, it's bundled with the app
                if let Ok(exe_path) = std::env::current_exe() {
                    if let Some(exe_dir) = exe_path.parent() {
                        let agent_path = exe_dir.join("seren-acp-agent");
                        if agent_path.exists() {
                            return agent_path.to_string_lossy().to_string();
                        }
                    }
                }
                // Fallback to assuming it's in PATH
                "seren-acp-agent".to_string()
            }
            AgentType::Codex => "codex".to_string(),
        }
    }

    /// Get additional arguments for the command
    fn args(&self) -> Vec<&'static str> {
        match self {
            AgentType::ClaudeCode => vec![],
            AgentType::Codex => vec![],
        }
    }
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
enum AcpCommand {
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
    Terminate,
}

/// Internal session state (stored in main thread)
struct AcpSession {
    id: String,
    agent_type: AgentType,
    cwd: String,
    status: SessionStatus,
    created_at: jiff::Timestamp,
    /// Channel to send commands to the worker thread
    command_tx: Option<mpsc::Sender<AcpCommand>>,
    /// Handle to the worker thread
    _worker_handle: Option<thread::JoinHandle<()>>,
}

/// State for managing ACP sessions
pub struct AcpState {
    sessions: RwLock<HashMap<String, Arc<Mutex<AcpSession>>>>,
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
}

/// Client delegate that handles requests from the agent
struct ClientDelegate {
    app: AppHandle,
    session_id: String,
    cwd: String,
}

#[async_trait::async_trait(?Send)]
impl Client for ClientDelegate {
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> AcpResult<RequestPermissionResponse> {
        // Emit permission request to frontend
        let _ = self.app.emit(
            events::PERMISSION_REQUEST,
            serde_json::json!({
                "sessionId": self.session_id,
                "toolCall": serde_json::to_value(&args.tool_call).ok(),
                "options": serde_json::to_value(&args.options).ok(),
            }),
        );

        // For now, auto-approve with the first option if available
        // In a full implementation, we'd wait for user response
        let option_id = args
            .options
            .first()
            .map(|o| o.option_id.clone())
            .unwrap_or_else(|| agent_client_protocol::PermissionOptionId::new("allow_once"));

        Ok(RequestPermissionResponse::new(
            agent_client_protocol::RequestPermissionOutcome::Selected(
                agent_client_protocol::SelectedPermissionOutcome::new(option_id),
            ),
        ))
    }

    async fn write_text_file(
        &self,
        args: WriteTextFileRequest,
    ) -> AcpResult<WriteTextFileResponse> {
        let path = std::path::Path::new(&self.cwd).join(&args.path);

        match tokio::fs::write(&path, &args.content).await {
            Ok(_) => Ok(WriteTextFileResponse::new()),
            Err(e) => Err(agent_client_protocol::Error::internal_error()
                .data(serde_json::Value::String(e.to_string()))),
        }
    }

    async fn read_text_file(&self, args: ReadTextFileRequest) -> AcpResult<ReadTextFileResponse> {
        let path = std::path::Path::new(&self.cwd).join(&args.path);

        match tokio::fs::read_to_string(&path).await {
            Ok(content) => Ok(ReadTextFileResponse::new(content)),
            Err(e) => Err(agent_client_protocol::Error::internal_error()
                .data(serde_json::Value::String(e.to_string()))),
        }
    }

    async fn create_terminal(
        &self,
        _args: CreateTerminalRequest,
    ) -> AcpResult<CreateTerminalResponse> {
        // Terminal creation not yet implemented
        Err(agent_client_protocol::Error::internal_error()
            .data(serde_json::Value::String("Terminal not implemented".into())))
    }

    async fn terminal_output(
        &self,
        _args: TerminalOutputRequest,
    ) -> AcpResult<TerminalOutputResponse> {
        Err(agent_client_protocol::Error::internal_error()
            .data(serde_json::Value::String("Terminal not implemented".into())))
    }

    async fn release_terminal(
        &self,
        _args: ReleaseTerminalRequest,
    ) -> AcpResult<ReleaseTerminalResponse> {
        Ok(ReleaseTerminalResponse::default())
    }

    async fn wait_for_terminal_exit(
        &self,
        _args: WaitForTerminalExitRequest,
    ) -> AcpResult<WaitForTerminalExitResponse> {
        Err(agent_client_protocol::Error::internal_error()
            .data(serde_json::Value::String("Terminal not implemented".into())))
    }

    async fn kill_terminal_command(
        &self,
        _args: KillTerminalCommandRequest,
    ) -> AcpResult<KillTerminalCommandResponse> {
        Ok(KillTerminalCommandResponse::default())
    }

    async fn session_notification(&self, args: SessionNotification) -> AcpResult<()> {
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
    eprintln!("[ACP] Received notification: {:?}", notification.update);
    match notification.update {
        SessionUpdate::AgentMessageChunk(chunk) => {
            // Extract text from ContentBlock if it's a text block
            let text = match &chunk.content {
                ContentBlock::Text(text_content) => text_content.text.clone(),
                _ => format!("{:?}", chunk.content),
            };
            eprintln!(
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
            eprintln!("[ACP] MESSAGE_CHUNK emit result: {:?}", emit_result);
        }
        SessionUpdate::ToolCall(tool_call) => {
            let _ = app.emit(
                events::TOOL_CALL,
                serde_json::json!({
                    "sessionId": session_id,
                    "toolCallId": tool_call.tool_call_id.to_string(),
                    "title": tool_call.title,
                    "kind": format!("{:?}", tool_call.kind),
                    "status": format!("{:?}", tool_call.status)
                }),
            );
        }
        SessionUpdate::ToolCallUpdate(update) => {
            // Check for diffs in content
            if let Some(ref content) = update.fields.content {
                for block in content {
                    if let agent_client_protocol::ToolCallContent::Diff(diff) = block {
                        let _ = app.emit(
                            events::DIFF,
                            serde_json::json!({
                                "sessionId": session_id,
                                "toolCallId": update.tool_call_id.to_string(),
                                "path": diff.path,
                                "oldText": diff.old_text,
                                "newText": diff.new_text
                            }),
                        );
                    }
                }
            }

            let _ = app.emit(
                events::TOOL_RESULT,
                serde_json::json!({
                    "sessionId": session_id,
                    "toolCallId": update.tool_call_id.to_string(),
                    "status": format!("{:?}", update.fields.status),
                }),
            );
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
            eprintln!(
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
            eprintln!("[ACP] THOUGHT_CHUNK emit result: {:?}", emit_result);
        }
        _ => {
            // Handle other notification types as needed
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
) -> Result<AcpSessionInfo, String> {
    let cwd = normalize_cwd(&cwd)?;
    let session_id = Uuid::new_v4().to_string();
    let now = jiff::Timestamp::now();

    // Create channel for commands to the worker thread
    let (command_tx, command_rx) = mpsc::channel::<AcpCommand>(32);

    // Create session entry
    let session = AcpSession {
        id: session_id.clone(),
        agent_type,
        cwd: cwd.clone(),
        status: SessionStatus::Initializing,
        created_at: now,
        command_tx: Some(command_tx),
        _worker_handle: None,
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
            )
            .await
            {
                Ok(_) => {}
                Err(e) => {
                    let _ = app_handle.emit(
                        events::ERROR,
                        serde_json::json!({
                            "sessionId": session_id_clone,
                            "error": e
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
) -> Result<(), String> {
    let command = agent_type.command();
    let args = agent_type.args();

    eprintln!("[ACP] Spawning agent: {} {:?} in {}", command, args, cwd);

    // Spawn the agent process
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    // Ensure the agent can find bundled Node/Git when running inside the app bundle.
    // We intentionally avoid mutating the process-wide PATH; we only inject it into this child.
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        cmd.env("PATH", embedded_path);
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn {} {:?}: {}. Make sure seren-acp-agent is built and available.",
            command, args, e
        )
    })?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    // Spawn a task to log stderr from the agent
    tokio::task::spawn_local(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[ACP Agent stderr] {}", line);
        }
    });

    // Convert tokio streams to futures-compatible streams using compat layer
    let stdout_compat = stdout.compat();
    let stdin_compat = stdin.compat_write();

    // Create client delegate
    let delegate = ClientDelegate {
        app: app.clone(),
        session_id: session_id.clone(),
        cwd: cwd.clone(),
    };

    // Create ACP connection - use spawn_local since we're in a LocalSet
    let (connection, io_task) =
        ClientSideConnection::new(delegate, stdin_compat, stdout_compat, |fut| {
            tokio::task::spawn_local(async move {
                fut.await;
            });
        });

    // Spawn the IO task locally
    eprintln!("[ACP] Spawning IO task...");
    tokio::task::spawn_local(async move {
        eprintln!("[ACP] IO task started");
        if let Err(e) = io_task.await {
            eprintln!("[ACP] IO task error: {:?}", e);
        }
        eprintln!("[ACP] IO task finished");
    });

    // Give the IO task a moment to start
    tokio::task::yield_now().await;
    eprintln!("[ACP] IO task spawned, proceeding with initialization...");

    // Initialize the agent
    eprintln!("[ACP] Sending initialize request...");
    let init_request = InitializeRequest::new(ProtocolVersion::LATEST)
        .client_info(Implementation::new(
            "seren-desktop",
            env!("CARGO_PKG_VERSION"),
        ))
        .client_capabilities(ClientCapabilities::default());

    let init_response = connection
        .initialize(init_request)
        .await
        .map_err(|e| format!("Failed to initialize agent: {:?}", e))?;
    eprintln!("[ACP] Initialize response received");

    // Create a new session with the agent
    eprintln!("[ACP] Creating new session...");
    let new_session_request = NewSessionRequest::new(&cwd);

    let new_session_response = connection
        .new_session(new_session_request)
        .await
        .map_err(|e| format!("Failed to create agent session: {:?}", e))?;
    eprintln!(
        "[ACP] Session created: {:?}",
        new_session_response.session_id
    );

    let agent_session_id = new_session_response.session_id;

    // Emit ready status with agent info
    let agent_info = init_response.agent_info.as_ref();
    eprintln!(
        "[ACP] Emitting ready status for session {} (agent: {:?})",
        session_id,
        agent_info.map(|i| i.name.as_str())
    );
    let emit_result = app.emit(
        events::SESSION_STATUS,
        serde_json::json!({
            "sessionId": session_id,
            "status": "ready",
            "agentInfo": {
                "name": agent_info.map(|i| i.name.as_str()).unwrap_or("Unknown"),
                "version": agent_info.map(|i| i.version.as_str()).unwrap_or("Unknown")
            }
        }),
    );
    eprintln!("[ACP] Emit result: {:?}", emit_result);

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

                eprintln!(
                    "[ACP] Sending prompt to agent session: {}",
                    agent_session_id
                );
                match connection.prompt(prompt_request).await {
                    Ok(response) => {
                        eprintln!(
                            "[ACP] Prompt completed successfully: {:?}",
                            response.stop_reason
                        );
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
                        eprintln!("[ACP] Prompt error: {:?}", e);
                        let _ = app.emit(
                            events::ERROR,
                            serde_json::json!({
                                "sessionId": session_id,
                                "error": format!("{:?}", e)
                            }),
                        );
                        let _ = response_tx.send(Err(format!("{:?}", e)));
                    }
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
            AcpCommand::Terminate => {
                break;
            }
        }
    }

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
        .send(AcpCommand::Prompt {
            prompt,
            context,
            response_tx,
        })
        .await
        .map_err(|_| "Failed to send prompt command".to_string())?;

    // Wait for the prompt to complete
    response_rx
        .await
        .map_err(|_| "Worker thread dropped".to_string())?
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

/// Get available agents
#[tauri::command]
pub fn acp_get_available_agents() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "type": "claude-code",
            "name": "Claude Code",
            "description": "AI coding assistant powered by Claude",
            "command": "claude-code-acp-rs",
            "available": true
        }),
        serde_json::json!({
            "type": "codex",
            "name": "Codex",
            "description": "AI coding assistant powered by OpenAI Codex",
            "command": "codex-acp",
            "available": false,
            "unavailableReason": "Codex ACP has dependency issues - coming soon"
        }),
    ]
}

/// Check if an agent binary is available
#[tauri::command]
pub async fn acp_check_agent_available(agent_type: AgentType) -> Result<bool, String> {
    let command = agent_type.command();

    // For bundled agents, check if the file exists directly
    if std::path::Path::new(&command).exists() {
        return Ok(true);
    }

    // Otherwise, check if it's in PATH
    match tokio::process::Command::new("which")
        .arg(&command)
        .output()
        .await
    {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}
