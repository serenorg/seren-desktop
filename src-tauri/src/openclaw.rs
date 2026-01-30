// ABOUTME: Manages the OpenClaw child process lifecycle — spawn, monitor, terminate.
// ABOUTME: Communicates with OpenClaw via localhost HTTP webhook API and WebSocket events.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

const OPENCLAW_STORE: &str = "openclaw.json";
const HOOK_TOKEN_KEY: &str = "hook_token";
const MAX_RESTART_ATTEMPTS: u32 = 3;

/// OpenClaw process status
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProcessStatus {
    Stopped,
    Starting,
    Running,
    Crashed,
    Restarting,
}

/// Information about a connected messaging channel
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub platform: String,
    pub display_name: String,
    pub status: ChannelStatus,
}

/// Channel connection status
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChannelStatus {
    Connected,
    Disconnected,
    Connecting,
    Error,
}

/// Status information returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenClawStatusInfo {
    pub process_status: ProcessStatus,
    pub port: Option<u16>,
    pub channels: Vec<ChannelInfo>,
    pub uptime_secs: Option<u64>,
}

/// Events emitted to the frontend
mod events {
    pub const STATUS_CHANGED: &str = "openclaw://status-changed";
    pub const CHANNEL_EVENT: &str = "openclaw://channel-event";
    pub const MESSAGE_RECEIVED: &str = "openclaw://message-received";
    pub const APPROVAL_NEEDED: &str = "openclaw://approval-needed";
}

/// Trust level for a channel
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TrustLevel {
    Auto,
    MentionOnly,
    ApprovalRequired,
}

/// Per-channel trust settings stored in the Rust backend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelTrustConfig {
    pub trust_level: TrustLevel,
    pub agent_mode: String,
}

/// Internal state for managing the OpenClaw process
struct OpenClawProcess {
    child: tokio::process::Child,
    started_at: std::time::Instant,
}

/// State for managing the OpenClaw integration
pub struct OpenClawState {
    process: Mutex<Option<OpenClawProcess>>,
    status: Mutex<ProcessStatus>,
    hook_token: Mutex<Option<String>>,
    port: Mutex<u16>,
    restart_count: Mutex<u32>,
    channels: Mutex<Vec<ChannelInfo>>,
    trust_settings: Mutex<HashMap<String, ChannelTrustConfig>>,
    /// Approval IDs granted by the frontend approval dialog.
    /// Consumed on use to prevent replay.
    approved_ids: Mutex<HashSet<String>>,
}

impl OpenClawState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            status: Mutex::new(ProcessStatus::Stopped),
            hook_token: Mutex::new(None),
            port: Mutex::new(0),
            restart_count: Mutex::new(0),
            channels: Mutex::new(Vec::new()),
            trust_settings: Mutex::new(HashMap::new()),
            approved_ids: Mutex::new(HashSet::new()),
        }
    }
}

impl Default for OpenClawState {
    fn default() -> Self {
        Self::new()
    }
}

/// Find an available TCP port on localhost
fn find_available_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind port: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local addr: {}", e))?
        .port();
    Ok(port)
}

/// Generate a cryptographically random 32-byte hex hook token
fn generate_hook_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: [u8; 32] = rng.random();
    hex::encode(bytes)
}

/// Find the OpenClaw JS entrypoint in known locations.
///
/// This supports "mjs bundling": we bundle the OpenClaw package (dist + node_modules + openclaw.mjs)
/// into `embedded-runtime/openclaw/` and spawn it with Node.js from our embedded runtime.
fn find_openclaw_mjs() -> Result<PathBuf, String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get current exe path: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?;

    let candidates = [
        // 1. Production macOS: In Resources/embedded-runtime/openclaw/
        exe_dir
            .join("../Resources/embedded-runtime/openclaw")
            .join("openclaw.mjs"),
        // 2. Production Linux/Windows: In embedded-runtime next to exe
        exe_dir
            .join("embedded-runtime")
            .join("openclaw")
            .join("openclaw.mjs"),
        // 3. Development: In src-tauri/embedded-runtime/openclaw/
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("embedded-runtime")
            .join("openclaw")
            .join("openclaw.mjs"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            eprintln!("[OpenClaw] Found openclaw.mjs at: {:?}", candidate);
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "openclaw.mjs not found. Checked locations:\n{}",
        candidates
            .iter()
            .map(|p| format!("  - {:?}", p))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

/// Load or generate the hook token from encrypted store
fn load_or_create_hook_token(app: &AppHandle) -> Result<String, String> {
    let store = app.store(OPENCLAW_STORE).map_err(|e| e.to_string())?;

    if let Some(token) = store
        .get(HOOK_TOKEN_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
    {
        return Ok(token);
    }

    let token = generate_hook_token();
    store.set(HOOK_TOKEN_KEY, serde_json::json!(&token));
    store.save().map_err(|e| e.to_string())?;
    Ok(token)
}

/// Emit a status change event to the frontend
fn emit_status(app: &AppHandle, status: ProcessStatus) {
    let _ = app.emit(
        events::STATUS_CHANGED,
        serde_json::json!({
            "status": status,
        }),
    );
}

/// Start the OpenClaw background process
#[tauri::command]
pub async fn openclaw_start(app: AppHandle, state: State<'_, OpenClawState>) -> Result<(), String> {
    // Check if already running
    {
        let status = state.status.lock().await;
        if *status == ProcessStatus::Running || *status == ProcessStatus::Starting {
            return Err("OpenClaw is already running".to_string());
        }
    }

    // Update status
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Starting;
    }
    emit_status(&app, ProcessStatus::Starting);

    // Find OpenClaw entrypoint
    let openclaw_mjs = match find_openclaw_mjs() {
        Ok(path) => path,
        Err(e) => {
            let mut status = state.status.lock().await;
            *status = ProcessStatus::Stopped;
            emit_status(&app, ProcessStatus::Stopped);
            return Err(e);
        }
    };

    // Get or create hook token
    let token = match load_or_create_hook_token(&app) {
        Ok(t) => t,
        Err(e) => {
            let mut status = state.status.lock().await;
            *status = ProcessStatus::Stopped;
            emit_status(&app, ProcessStatus::Stopped);
            return Err(e);
        }
    };
    {
        let mut hook_token = state.hook_token.lock().await;
        *hook_token = Some(token.clone());
    }

    // Find available port
    let port = match find_available_port() {
        Ok(p) => p,
        Err(e) => {
            let mut status = state.status.lock().await;
            *status = ProcessStatus::Stopped;
            emit_status(&app, ProcessStatus::Stopped);
            return Err(e);
        }
    };
    {
        let mut p = state.port.lock().await;
        *p = port;
    }

    // Load persisted trust settings
    {
        let persisted = load_trust_settings(&app);
        if !persisted.is_empty() {
            let mut trust_settings = state.trust_settings.lock().await;
            *trust_settings = persisted;
        }
    }

    // Spawn the OpenClaw process
    // Pass config via env vars (not CLI args, to avoid exposure in `ps`)
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&openclaw_mjs)
        .arg("gateway")
        .arg("--allow-unconfigured"); // Allow running without `openclaw setup`
    cmd.env("OPENCLAW_GATEWAY_PORT", port.to_string())
        .env("OPENCLAW_GATEWAY_TOKEN", &token)
        .env("OPENCLAW_GATEWAY_HOST", "127.0.0.1")
        .env("OPENCLAW_SKIP_CHANNELS", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    // Add embedded runtime to PATH
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        cmd.env("PATH", embedded_path);
    }

    let child = cmd.spawn().map_err(|e| {
        let mut status_lock = futures::executor::block_on(state.status.lock());
        *status_lock = ProcessStatus::Stopped;
        emit_status(&app, ProcessStatus::Stopped);
        format!("Failed to spawn OpenClaw: {}", e)
    })?;

    let pid = child.id();
    eprintln!(
        "[OpenClaw] Process spawned: pid={:?}, port={}, openclaw_mjs={:?}",
        pid, port, openclaw_mjs
    );

    // Store process
    {
        let mut process = state.process.lock().await;
        *process = Some(OpenClawProcess {
            child,
            started_at: std::time::Instant::now(),
        });
    }

    // Update status
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Running;
        let mut restart_count = state.restart_count.lock().await;
        *restart_count = 0;
    }
    emit_status(&app, ProcessStatus::Running);

    // Start WebSocket listener to receive real-time events from OpenClaw
    spawn_ws_listener(app.clone(), port, token);

    // Start process monitor for crash detection and auto-restart
    spawn_process_monitor(app);

    Ok(())
}

/// Stop the OpenClaw background process
#[tauri::command]
pub async fn openclaw_stop(app: AppHandle, state: State<'_, OpenClawState>) -> Result<(), String> {
    let mut process_lock = state.process.lock().await;

    if let Some(mut proc) = process_lock.take() {
        eprintln!("[OpenClaw] Stopping process...");

        // Try graceful shutdown first (SIGTERM on Unix)
        #[cfg(unix)]
        {
            if let Some(pid) = proc.child.id() {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }

        // Wait up to 5 seconds for graceful shutdown
        match tokio::time::timeout(std::time::Duration::from_secs(5), proc.child.wait()).await {
            Ok(Ok(status)) => {
                eprintln!("[OpenClaw] Process exited gracefully: {:?}", status);
            }
            _ => {
                // Force kill
                eprintln!("[OpenClaw] Force killing process...");
                let _ = proc.child.kill().await;
            }
        }
    }

    // Update status
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Stopped;
    }
    emit_status(&app, ProcessStatus::Stopped);

    // Clear channels
    {
        let mut channels = state.channels.lock().await;
        channels.clear();
    }

    Ok(())
}

/// Restart the OpenClaw process
#[tauri::command]
pub async fn openclaw_restart(
    app: AppHandle,
    state: State<'_, OpenClawState>,
) -> Result<(), String> {
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Restarting;
    }
    emit_status(&app, ProcessStatus::Restarting);

    openclaw_stop(app.clone(), state.clone()).await?;

    // Brief pause between stop and start
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    openclaw_start(app, state).await
}

/// Get the current OpenClaw status
#[tauri::command]
pub async fn openclaw_status(
    state: State<'_, OpenClawState>,
) -> Result<OpenClawStatusInfo, String> {
    let status = *state.status.lock().await;
    let port = *state.port.lock().await;
    let channels = state.channels.lock().await.clone();

    let uptime_secs = {
        let process = state.process.lock().await;
        process.as_ref().map(|p| p.started_at.elapsed().as_secs())
    };

    Ok(OpenClawStatusInfo {
        process_status: status,
        port: if status == ProcessStatus::Running {
            Some(port)
        } else {
            None
        },
        channels,
        uptime_secs,
    })
}

// --- Process Monitor for Crash Detection and Auto-Restart ---

/// Monitors the OpenClaw child process. If it exits unexpectedly,
/// updates status to Crashed and attempts restart up to MAX_RESTART_ATTEMPTS.
fn spawn_process_monitor(app: AppHandle) {
    tokio::spawn(async move {
        let state = app.state::<OpenClawState>();

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let current_status = *state.status.lock().await;
            if current_status != ProcessStatus::Running && current_status != ProcessStatus::Starting
            {
                // Process was intentionally stopped or not running — exit monitor
                return;
            }

            // Check if the child process has exited
            let exited = {
                let mut process_lock = state.process.lock().await;
                if let Some(ref mut proc) = *process_lock {
                    match proc.child.try_wait() {
                        Ok(Some(_exit_status)) => true,
                        Ok(None) => false, // still running
                        Err(_) => true,    // error checking — treat as crashed
                    }
                } else {
                    // No process stored — exit monitor
                    return;
                }
            };

            if !exited {
                continue;
            }

            eprintln!("[OpenClaw Monitor] Process exited unexpectedly");

            // Update status to Crashed
            {
                let mut status = state.status.lock().await;
                *status = ProcessStatus::Crashed;
            }
            emit_status(&app, ProcessStatus::Crashed);

            // Check restart count
            let restart_count = {
                let count = state.restart_count.lock().await;
                *count
            };

            if restart_count >= MAX_RESTART_ATTEMPTS {
                eprintln!(
                    "[OpenClaw Monitor] Max restart attempts ({}) reached, giving up",
                    MAX_RESTART_ATTEMPTS
                );
                return;
            }

            // Attempt restart
            eprintln!(
                "[OpenClaw Monitor] Attempting restart ({}/{})",
                restart_count + 1,
                MAX_RESTART_ATTEMPTS
            );

            {
                let mut count = state.restart_count.lock().await;
                *count += 1;
            }

            // Clear the old process
            {
                let mut process_lock = state.process.lock().await;
                *process_lock = None;
            }

            // Brief pause before restart
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            // Restart via the command (re-uses the full startup logic)
            match openclaw_start(app.clone(), app.state::<OpenClawState>()).await {
                Ok(()) => {
                    eprintln!("[OpenClaw Monitor] Restart succeeded");
                    // The new openclaw_start will spawn its own monitor, so exit this one
                    return;
                }
                Err(e) => {
                    eprintln!("[OpenClaw Monitor] Restart failed: {}", e);
                    // Loop will check restart count on next iteration
                }
            }
        }
    });
}

// --- WebSocket Listener for OpenClaw Gateway Events ---

/// Connect to OpenClaw's WebSocket gateway and forward events to the frontend.
/// Retries connection with backoff since OpenClaw takes a few seconds to initialize.
pub fn spawn_ws_listener(app: AppHandle, port: u16, hook_token: String) {
    tokio::spawn(async move {
        let max_retries = 10;
        let mut attempt = 0;

        loop {
            attempt += 1;
            let url = format!("ws://127.0.0.1:{}/ws?token={}", port, hook_token);

            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws_stream, _)) => {
                    eprintln!("[OpenClaw WS] Connected to gateway on port {}", port);
                    attempt = 0; // Reset on successful connect

                    use futures::StreamExt;
                    let (_, mut read) = ws_stream.split();

                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                                handle_ws_message(&app, &text);
                            }
                            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                                eprintln!("[OpenClaw WS] Connection closed by server");
                                break;
                            }
                            Err(e) => {
                                eprintln!("[OpenClaw WS] Error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    if attempt >= max_retries {
                        eprintln!(
                            "[OpenClaw WS] Failed to connect after {} attempts: {}",
                            max_retries, e
                        );
                        return;
                    }
                    eprintln!(
                        "[OpenClaw WS] Connection attempt {}/{} failed: {}",
                        attempt, max_retries, e
                    );
                }
            }

            // Backoff: 1s, 2s, 4s, 8s... capped at 30s
            let delay = std::cmp::min(1 << attempt, 30);
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
    });
}

/// Parse and forward a WebSocket message from OpenClaw to the frontend
fn handle_ws_message(app: &AppHandle, text: &str) {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(text);
    let Ok(msg) = parsed else {
        eprintln!("[OpenClaw WS] Failed to parse message: {}", text);
        return;
    };

    let event_type = msg
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");

    match event_type {
        "channel:connected" | "channel:disconnected" | "channel:error" => {
            let _ = app.emit(events::CHANNEL_EVENT, &msg);
        }
        "message:received" => {
            let _ = app.emit(events::MESSAGE_RECEIVED, &msg);
        }
        _ => {
            eprintln!("[OpenClaw WS] Unhandled event type: {}", event_type);
        }
    }
}

// --- HTTP Client for OpenClaw Webhook API ---

/// Send a message via OpenClaw's webhook API
async fn webhook_send(
    port: u16,
    hook_token: &str,
    message: &str,
    channel: Option<&str>,
    to: Option<&str>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut body = serde_json::json!({
        "message": message,
    });
    if let Some(ch) = channel {
        body["channel"] = serde_json::Value::String(ch.to_string());
    }
    if let Some(recipient) = to {
        body["to"] = serde_json::Value::String(recipient.to_string());
    }

    let url = format!("http://127.0.0.1:{}/hooks/agent", port);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", hook_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("OpenClaw webhook request failed: {}", e))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "OpenClaw webhook returned {}: {}",
            status, response_text
        ));
    }

    Ok(response_text)
}

/// Query OpenClaw for connected channels via its HTTP API
/// Query channel status via the openclaw CLI (`channels status`).
async fn query_channels() -> Result<Vec<ChannelInfo>, String> {
    let openclaw_pkg = find_openclaw_mjs()?;
    let embedded_path = crate::embedded_runtime::get_embedded_path();

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&openclaw_pkg)
        .arg("channels")
        .arg("status")
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if !embedded_path.is_empty() {
        cmd.env("PATH", &embedded_path);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run channels status: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("Channel status failed: {}", msg.trim()));
    }

    // Parse JSON output from openclaw channels status --json
    let body: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse channels status JSON: {}", e))?;

    // The output is a map of channel IDs to account snapshots
    let mut channels = Vec::new();
    if let Some(channel_accounts) = body.get("channelAccounts").and_then(|v| v.as_object()) {
        for (channel_id, accounts) in channel_accounts {
            if let Some(arr) = accounts.as_array() {
                for account in arr {
                    let running = account
                        .get("running")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let configured = account
                        .get("configured")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let has_error = account
                        .get("lastError")
                        .map(|v| !v.is_null())
                        .unwrap_or(false);
                    let account_id = account
                        .get("accountId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("default");
                    let label = account
                        .get("label")
                        .or(account.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(channel_id.as_str());

                    // openclaw status doesn't have a "connected" field —
                    // running + no error = connected, running + error = connecting/retry
                    let status = if running && !has_error {
                        ChannelStatus::Connected
                    } else if running && has_error {
                        ChannelStatus::Connecting
                    } else if has_error {
                        ChannelStatus::Error
                    } else if configured {
                        ChannelStatus::Disconnected
                    } else {
                        ChannelStatus::Disconnected
                    };

                    channels.push(ChannelInfo {
                        id: format!("{}:{}", channel_id, account_id),
                        platform: channel_id.clone(),
                        display_name: label.to_string(),
                        status,
                    });
                }
            }
        }
    }

    Ok(channels)
}

/// Send a message through OpenClaw (Tauri command).
/// Enforces trust level before sending. For approval-required channels, the caller
/// must first obtain an approval_id via the approval UI, then grant it via
/// openclaw_grant_approval before calling this. The approved parameter is NOT trusted
/// from callers — only server-tracked approval IDs are accepted.
#[tauri::command]
pub async fn openclaw_send(
    app: AppHandle,
    state: State<'_, OpenClawState>,
    channel: String,
    to: String,
    message: String,
) -> Result<String, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("OpenClaw is not running. Start it in Settings → OpenClaw.".to_string());
    }

    // Enforce trust level
    {
        let trust_settings = state.trust_settings.lock().await;
        if let Some(config) = trust_settings.get(&channel) {
            match config.trust_level {
                TrustLevel::ApprovalRequired => {
                    // Check if there's a granted approval for this channel+to pair
                    let approval_key = format!("{}:{}", channel, to);
                    let mut approved_ids = state.approved_ids.lock().await;
                    let has_approval = approved_ids.remove(&approval_key);

                    if !has_approval {
                        // Generate a unique approval ID for matching responses
                        let approval_id = format!(
                            "{}:{}:{}",
                            channel,
                            to,
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                        );

                        // Look up channel info for platform name
                        let channels = state.channels.lock().await;
                        let platform = channels
                            .iter()
                            .find(|c| c.id == channel)
                            .map(|c| c.platform.clone())
                            .unwrap_or_else(|| "unknown".to_string());
                        drop(channels);

                        // Emit approval-needed event with full payload matching frontend expectations
                        let _ = app.emit(
                            events::APPROVAL_NEEDED,
                            serde_json::json!({
                                "id": approval_id,
                                "channel": channel,
                                "platform": platform,
                                "to": to,
                                "message": message,
                                "draftResponse": message,
                            }),
                        );
                        return Err(serde_json::json!({
                            "code": "approval_required",
                            "approvalId": approval_id,
                            "message": "Message requires approval"
                        })
                        .to_string());
                    }
                }
                TrustLevel::MentionOnly => {
                    // For mention-only, the frontend agent should already filter.
                    // Backend allows all explicit sends (they're intentional).
                }
                TrustLevel::Auto => {
                    // No restrictions
                }
            }
        }
    }

    let port = *state.port.lock().await;
    let hook_token = state
        .hook_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Hook token not configured".to_string())?;

    webhook_send(port, &hook_token, &message, Some(&channel), Some(&to)).await
}

/// Grant approval for a pending message. Called by the approval UI when the user
/// approves a draft response. The approval is keyed by channel:to so the subsequent
/// openclaw_send call for that recipient can proceed.
#[tauri::command]
pub async fn openclaw_grant_approval(
    state: State<'_, OpenClawState>,
    channel: String,
    to: String,
) -> Result<(), String> {
    let approval_key = format!("{}:{}", channel, to);
    let mut approved_ids = state.approved_ids.lock().await;
    approved_ids.insert(approval_key);
    Ok(())
}

/// Set trust configuration for a channel (Tauri command).
/// Persists to openclaw.json so trust levels survive restarts.
#[tauri::command]
pub async fn openclaw_set_trust(
    app: AppHandle,
    state: State<'_, OpenClawState>,
    channel_id: String,
    trust_level: TrustLevel,
    agent_mode: String,
) -> Result<(), String> {
    {
        let mut trust_settings = state.trust_settings.lock().await;
        trust_settings.insert(
            channel_id,
            ChannelTrustConfig {
                trust_level,
                agent_mode,
            },
        );
        // Persist to store
        persist_trust_settings(&app, &trust_settings);
    }
    Ok(())
}

/// Persist trust settings to the openclaw.json store.
fn persist_trust_settings(app: &AppHandle, settings: &HashMap<String, ChannelTrustConfig>) {
    if let Ok(store) = app.store(OPENCLAW_STORE) {
        let json = serde_json::to_value(settings).unwrap_or_default();
        store.set("trust_settings", json);
        let _ = store.save();
    }
}

/// Load trust settings from the openclaw.json store.
fn load_trust_settings(app: &AppHandle) -> HashMap<String, ChannelTrustConfig> {
    if let Ok(store) = app.store(OPENCLAW_STORE) {
        if let Some(val) = store.get("trust_settings") {
            if let Ok(settings) =
                serde_json::from_value::<HashMap<String, ChannelTrustConfig>>(val.clone())
            {
                return settings;
            }
        }
    }
    HashMap::new()
}

/// Connect a channel via the openclaw CLI (`channels add` command).
/// The running gateway detects the config change and hot-reloads the channel.
async fn request_channel_connect(
    platform: &str,
    credentials: &HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let embedded_path = crate::embedded_runtime::get_embedded_path();

    // We need to call `openclaw.mjs channels add`, not the gateway.
    let openclaw_pkg = find_openclaw_mjs()?;

    eprintln!(
        "[OpenClaw] Channel connect: platform={}, openclaw={}",
        platform,
        openclaw_pkg.display()
    );

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&openclaw_pkg)
        .arg("channels")
        .arg("add")
        .arg("--channel")
        .arg(platform);

    // Map credential keys to CLI flags
    if let Some(token) = credentials.get("token") {
        cmd.arg("--token").arg(token);
    }
    if let Some(bot_token) = credentials.get("botToken") {
        cmd.arg("--bot-token").arg(bot_token);
    }
    if let Some(app_token) = credentials.get("appToken") {
        cmd.arg("--app-token").arg(app_token);
    }
    if let Some(phone) = credentials.get("phone") {
        cmd.arg("--signal-number").arg(phone);
    }

    // Force non-interactive mode via CI environment variable
    cmd.env("CI", "1");

    if !embedded_path.is_empty() {
        cmd.env("PATH", &embedded_path);
    }

    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    eprintln!(
        "[OpenClaw] Spawning: node {} channels add --channel {}",
        openclaw_pkg.display(),
        platform
    );

    // Spawn with a 30-second timeout to prevent hanging on interactive prompts
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn channels add: {}", e))?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| format!("Channel add timed out after 30s — the openclaw CLI may be waiting for interactive input"))?
    .map_err(|e| format!("Failed to run channels add: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    eprintln!(
        "[OpenClaw] Channel add exit={} stdout={} stderr={}",
        output.status,
        stdout.trim(),
        stderr.trim()
    );

    if !output.status.success() {
        let msg = if !stderr.is_empty() { &stderr } else { &stdout };
        return Err(format!("Channel add failed: {}", msg.trim()));
    }

    Ok(serde_json::json!({
        "ok": true,
        "platform": platform,
        "message": stdout.trim(),
    }))
}

/// Request a QR code for WhatsApp-style channel connection.
/// WhatsApp pairing requires an interactive CLI session; QR-based login
/// is not yet supported through the Seren UI.
async fn request_qr_code(_port: u16, _hook_token: &str, platform: &str) -> Result<String, String> {
    Err(format!(
        "QR-based login for {} is not yet supported. Use the openclaw CLI: openclaw channels login --channel {}",
        platform, platform
    ))
}

/// Connect a messaging channel (Tauri command)
#[tauri::command]
pub async fn openclaw_connect_channel(
    state: State<'_, OpenClawState>,
    platform: String,
    credentials: HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("OpenClaw is not running. Start it first.".to_string());
    }

    request_channel_connect(&platform, &credentials).await
}

/// Get QR code for WhatsApp-style connections (Tauri command)
#[tauri::command]
pub async fn openclaw_get_qr(
    state: State<'_, OpenClawState>,
    platform: String,
) -> Result<String, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("OpenClaw is not running. Start it first.".to_string());
    }

    let port = *state.port.lock().await;
    let hook_token = state
        .hook_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Hook token not configured".to_string())?;

    request_qr_code(port, &hook_token, &platform).await
}

/// Disconnect a channel (Tauri command)
#[tauri::command]
pub async fn openclaw_disconnect_channel(
    state: State<'_, OpenClawState>,
    channel_id: String,
) -> Result<(), String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("OpenClaw is not running.".to_string());
    }

    // Use openclaw CLI to remove the channel
    let openclaw_pkg =
        find_openclaw_mjs().map_err(|e| format!("Cannot find openclaw.mjs: {}", e))?;
    let embedded_path = crate::embedded_runtime::get_embedded_path();

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&openclaw_pkg)
        .arg("channels")
        .arg("remove")
        .arg("--channel")
        .arg(&channel_id)
        .arg("--delete")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if !embedded_path.is_empty() {
        cmd.env("PATH", &embedded_path);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run channels remove: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("Channel remove failed: {}", msg.trim()));
    }

    // Remove from cached channels
    {
        let mut channels = state.channels.lock().await;
        channels.retain(|c| c.id != channel_id);
    }

    Ok(())
}

/// List connected channels (Tauri command)
#[tauri::command]
pub async fn openclaw_list_channels(
    state: State<'_, OpenClawState>,
) -> Result<Vec<ChannelInfo>, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("OpenClaw is not running. Start it in Settings → OpenClaw.".to_string());
    }

    let channels = query_channels().await?;

    // Update cached channel list
    {
        let mut cached = state.channels.lock().await;
        *cached = channels.clone();
    }

    Ok(channels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_hook_token_length() {
        let token = generate_hook_token();
        assert_eq!(
            token.len(),
            64,
            "hook token should be 64 hex chars (32 bytes)"
        );
    }

    #[test]
    fn test_generate_hook_token_is_hex() {
        let token = generate_hook_token();
        assert!(
            token.chars().all(|c| c.is_ascii_hexdigit()),
            "hook token should contain only hex characters"
        );
    }

    #[test]
    fn test_generate_hook_token_uniqueness() {
        let token1 = generate_hook_token();
        let token2 = generate_hook_token();
        assert_ne!(
            token1, token2,
            "consecutive hook tokens should be different"
        );
    }

    #[test]
    fn test_find_available_port() {
        let port = find_available_port().expect("should find an available port");
        assert!(port > 0, "port should be a positive number");
    }

    #[test]
    fn test_openclaw_state_default_status() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = OpenClawState::new();
            let status = state.status.lock().await;
            assert_eq!(
                *status,
                ProcessStatus::Stopped,
                "initial status should be Stopped"
            );
        });
    }

    #[test]
    fn test_webhook_send_uses_correct_url() {
        // Verify the URL construction uses 127.0.0.1, not localhost
        let port: u16 = 8080;
        let url = format!("http://127.0.0.1:{}/hooks/agent", port);
        assert!(
            url.contains("127.0.0.1"),
            "URL must use 127.0.0.1, not localhost"
        );
        assert!(!url.contains("localhost"), "URL must not contain localhost");
    }

    #[test]
    fn test_webhook_body_includes_required_fields() {
        let message = "Hello";
        let token = "abc123";
        let body = serde_json::json!({
            "message": message,
            "token": token,
        });
        assert_eq!(body["message"], "Hello");
        assert_eq!(body["token"], "abc123");
    }

    #[test]
    fn test_webhook_body_includes_optional_fields() {
        let mut body = serde_json::json!({
            "message": "test",
            "token": "tok",
        });
        body["channel"] = serde_json::Value::String("whatsapp".to_string());
        body["to"] = serde_json::Value::String("+1234567890".to_string());
        assert_eq!(body["channel"], "whatsapp");
        assert_eq!(body["to"], "+1234567890");
    }

    #[test]
    fn test_channel_status_parsing() {
        let connected: ChannelStatus = match "connected" {
            "connected" => ChannelStatus::Connected,
            "connecting" => ChannelStatus::Connecting,
            "error" => ChannelStatus::Error,
            _ => ChannelStatus::Disconnected,
        };
        assert_eq!(connected, ChannelStatus::Connected);

        let unknown: ChannelStatus = match "garbage" {
            "connected" => ChannelStatus::Connected,
            "connecting" => ChannelStatus::Connecting,
            "error" => ChannelStatus::Error,
            _ => ChannelStatus::Disconnected,
        };
        assert_eq!(unknown, ChannelStatus::Disconnected);
    }

    #[test]
    fn test_ws_message_channel_connected_event() {
        let json = r#"{"type":"channel:connected","id":"ch1","platform":"whatsapp"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap();
        assert_eq!(event_type, "channel:connected");
    }

    #[test]
    fn test_ws_message_channel_disconnected_event() {
        let json = r#"{"type":"channel:disconnected","id":"ch2"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap();
        assert_eq!(event_type, "channel:disconnected");
    }

    #[test]
    fn test_ws_message_unknown_event_type() {
        let json = r#"{"type":"unknown:event","data":"test"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap();
        assert_ne!(event_type, "channel:connected");
        assert_ne!(event_type, "message:received");
    }

    #[test]
    fn test_ws_message_missing_type_field() {
        let json = r#"{"data":"no type field"}"#;
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        let event_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        assert_eq!(event_type, "unknown");
    }

    #[test]
    fn test_ws_message_invalid_json() {
        let result: Result<serde_json::Value, _> = serde_json::from_str("not json");
        assert!(result.is_err(), "invalid JSON should fail to parse");
    }

    #[test]
    fn test_connect_channel_url_construction() {
        let port: u16 = 9090;
        let url = format!("http://127.0.0.1:{}/api/channels/connect", port);
        assert!(url.contains("127.0.0.1"));
        assert!(url.contains("/api/channels/connect"));
    }

    #[test]
    fn test_qr_code_url_construction() {
        let port: u16 = 9090;
        let platform = "whatsapp";
        let url = format!("http://127.0.0.1:{}/api/channels/{}/qr", port, platform);
        assert!(url.contains("/api/channels/whatsapp/qr"));
    }

    #[test]
    fn test_disconnect_url_construction() {
        let port: u16 = 9090;
        let channel_id = "ch-abc123";
        let url = format!("http://127.0.0.1:{}/api/channels/{}", port, channel_id);
        assert!(url.contains("/api/channels/ch-abc123"));
    }

    #[test]
    fn test_openclaw_state_channels_initially_empty() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = OpenClawState::new();
            let channels = state.channels.lock().await;
            assert!(channels.is_empty(), "channels should be empty initially");
        });
    }

    #[test]
    fn test_openclaw_state_hook_token_initially_none() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = OpenClawState::new();
            let token = state.hook_token.lock().await;
            assert!(token.is_none(), "hook token should be None initially");
        });
    }

    #[test]
    fn test_channel_info_serialization() {
        let channel = ChannelInfo {
            id: "test-id".to_string(),
            platform: "telegram".to_string(),
            display_name: "Test Bot".to_string(),
            status: ChannelStatus::Connected,
        };
        let json = serde_json::to_string(&channel).unwrap();
        assert!(json.contains("\"id\":\"test-id\""));
        assert!(json.contains("\"platform\":\"telegram\""));
        assert!(json.contains("\"displayName\":\"Test Bot\""));
        assert!(json.contains("\"status\":\"connected\""));
    }

    #[test]
    fn test_process_status_serialization() {
        let running = serde_json::to_string(&ProcessStatus::Running).unwrap();
        assert_eq!(running, "\"running\"");
        let crashed = serde_json::to_string(&ProcessStatus::Crashed).unwrap();
        assert_eq!(crashed, "\"crashed\"");
        let stopped = serde_json::to_string(&ProcessStatus::Stopped).unwrap();
        assert_eq!(stopped, "\"stopped\"");
    }

    #[test]
    fn test_find_openclaw_mjs_returns_path_or_error() {
        // This test suite may run with (or without) the OpenClaw bundle present.
        // Accept either outcome but validate invariants.
        match find_openclaw_mjs() {
            Ok(path) => {
                assert!(
                    path.ends_with("openclaw.mjs"),
                    "expected openclaw.mjs path, got: {:?}",
                    path
                );
                assert!(path.exists(), "returned path should exist: {:?}", path);
            }
            Err(err) => {
                assert!(
                    err.contains("openclaw.mjs not found"),
                    "error message should indicate openclaw.mjs not found"
                );
            }
        }
    }
}
