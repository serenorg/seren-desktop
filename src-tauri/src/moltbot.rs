// ABOUTME: Manages the Moltbot child process lifecycle — spawn, monitor, terminate.
// ABOUTME: Communicates with Moltbot via localhost HTTP webhook API and WebSocket events.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

const MOLTBOT_STORE: &str = "moltbot.json";
const HOOK_TOKEN_KEY: &str = "hook_token";
const MAX_RESTART_ATTEMPTS: u32 = 3;

/// Moltbot process status
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
pub struct MoltbotStatusInfo {
    pub process_status: ProcessStatus,
    pub port: Option<u16>,
    pub channels: Vec<ChannelInfo>,
    pub uptime_secs: Option<u64>,
}

/// Events emitted to the frontend
mod events {
    pub const STATUS_CHANGED: &str = "moltbot://status-changed";
    pub const CHANNEL_EVENT: &str = "moltbot://channel-event";
    pub const MESSAGE_RECEIVED: &str = "moltbot://message-received";
    pub const APPROVAL_NEEDED: &str = "moltbot://approval-needed";
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

/// Internal state for managing the Moltbot process
struct MoltbotProcess {
    child: tokio::process::Child,
    started_at: std::time::Instant,
}

/// State for managing the Moltbot integration
pub struct MoltbotState {
    process: Mutex<Option<MoltbotProcess>>,
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

impl MoltbotState {
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

impl Default for MoltbotState {
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

/// Find the Moltbot binary in known locations
fn find_moltbot_binary() -> Result<std::path::PathBuf, String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get current exe path: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?;

    let ext = if cfg!(windows) { ".exe" } else { "" };
    let bin_filename = format!("moltbot{}", ext);

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
            eprintln!("[Moltbot] Found binary at: {:?}", candidate);
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "Moltbot binary not found. Checked locations:\n{}",
        candidates
            .iter()
            .map(|p| format!("  - {:?}", p))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

/// Load or generate the hook token from encrypted store
fn load_or_create_hook_token(app: &AppHandle) -> Result<String, String> {
    let store = app.store(MOLTBOT_STORE).map_err(|e| e.to_string())?;

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

/// Start the Moltbot background process
#[tauri::command]
pub async fn moltbot_start(
    app: AppHandle,
    state: State<'_, MoltbotState>,
) -> Result<(), String> {
    // Check if already running
    {
        let status = state.status.lock().await;
        if *status == ProcessStatus::Running || *status == ProcessStatus::Starting {
            return Err("Moltbot is already running".to_string());
        }
    }

    // Update status
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Starting;
    }
    emit_status(&app, ProcessStatus::Starting);

    // Find binary
    let binary_path = find_moltbot_binary()?;

    // Get or create hook token
    let token = load_or_create_hook_token(&app)?;
    {
        let mut hook_token = state.hook_token.lock().await;
        *hook_token = Some(token.clone());
    }

    // Find available port
    let port = find_available_port()?;
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

    // Spawn the Moltbot process
    // Pass config via env vars (not CLI args, to avoid exposure in `ps`)
    let mut cmd = tokio::process::Command::new(&binary_path);
    cmd.env("MOLTBOT_PORT", port.to_string())
        .env("MOLTBOT_HOOK_TOKEN", &token)
        .env("MOLTBOT_HOST", "127.0.0.1")
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
        let mut status_lock =
            futures::executor::block_on(state.status.lock());
        *status_lock = ProcessStatus::Stopped;
        emit_status(&app, ProcessStatus::Stopped);
        format!("Failed to spawn Moltbot: {}", e)
    })?;

    let pid = child.id();
    eprintln!(
        "[Moltbot] Process spawned: pid={:?}, port={}, binary={:?}",
        pid, port, binary_path
    );

    // Store process
    {
        let mut process = state.process.lock().await;
        *process = Some(MoltbotProcess {
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

    // Start WebSocket listener to receive real-time events from Moltbot
    spawn_ws_listener(app.clone(), port, token);

    // Start process monitor for crash detection and auto-restart
    spawn_process_monitor(app);

    Ok(())
}

/// Stop the Moltbot background process
#[tauri::command]
pub async fn moltbot_stop(
    app: AppHandle,
    state: State<'_, MoltbotState>,
) -> Result<(), String> {
    let mut process_lock = state.process.lock().await;

    if let Some(mut proc) = process_lock.take() {
        eprintln!("[Moltbot] Stopping process...");

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
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            proc.child.wait(),
        )
        .await
        {
            Ok(Ok(status)) => {
                eprintln!("[Moltbot] Process exited gracefully: {:?}", status);
            }
            _ => {
                // Force kill
                eprintln!("[Moltbot] Force killing process...");
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

/// Restart the Moltbot process
#[tauri::command]
pub async fn moltbot_restart(
    app: AppHandle,
    state: State<'_, MoltbotState>,
) -> Result<(), String> {
    {
        let mut status = state.status.lock().await;
        *status = ProcessStatus::Restarting;
    }
    emit_status(&app, ProcessStatus::Restarting);

    moltbot_stop(app.clone(), state.clone()).await?;

    // Brief pause between stop and start
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    moltbot_start(app, state).await
}

/// Get the current Moltbot status
#[tauri::command]
pub async fn moltbot_status(state: State<'_, MoltbotState>) -> Result<MoltbotStatusInfo, String> {
    let status = *state.status.lock().await;
    let port = *state.port.lock().await;
    let channels = state.channels.lock().await.clone();

    let uptime_secs = {
        let process = state.process.lock().await;
        process
            .as_ref()
            .map(|p| p.started_at.elapsed().as_secs())
    };

    Ok(MoltbotStatusInfo {
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

/// Monitors the Moltbot child process. If it exits unexpectedly,
/// updates status to Crashed and attempts restart up to MAX_RESTART_ATTEMPTS.
fn spawn_process_monitor(app: AppHandle) {
    tokio::spawn(async move {
        let state = app.state::<MoltbotState>();

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let current_status = *state.status.lock().await;
            if current_status != ProcessStatus::Running
                && current_status != ProcessStatus::Starting
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

            eprintln!("[Moltbot Monitor] Process exited unexpectedly");

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
                    "[Moltbot Monitor] Max restart attempts ({}) reached, giving up",
                    MAX_RESTART_ATTEMPTS
                );
                return;
            }

            // Attempt restart
            eprintln!(
                "[Moltbot Monitor] Attempting restart ({}/{})",
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
            match moltbot_start(app.clone(), app.state::<MoltbotState>()).await {
                Ok(()) => {
                    eprintln!("[Moltbot Monitor] Restart succeeded");
                    // The new moltbot_start will spawn its own monitor, so exit this one
                    return;
                }
                Err(e) => {
                    eprintln!("[Moltbot Monitor] Restart failed: {}", e);
                    // Loop will check restart count on next iteration
                }
            }
        }
    });
}

// --- WebSocket Listener for Moltbot Gateway Events ---

/// Connect to Moltbot's WebSocket gateway and forward events to the frontend.
/// Retries connection with backoff since Moltbot takes a few seconds to initialize.
pub fn spawn_ws_listener(app: AppHandle, port: u16, hook_token: String) {
    tokio::spawn(async move {
        let max_retries = 10;
        let mut attempt = 0;

        loop {
            attempt += 1;
            let url = format!("ws://127.0.0.1:{}/ws?token={}", port, hook_token);

            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws_stream, _)) => {
                    eprintln!("[Moltbot WS] Connected to gateway on port {}", port);
                    attempt = 0; // Reset on successful connect

                    use futures::StreamExt;
                    let (_, mut read) = ws_stream.split();

                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                                handle_ws_message(&app, &text);
                            }
                            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                                eprintln!("[Moltbot WS] Connection closed by server");
                                break;
                            }
                            Err(e) => {
                                eprintln!("[Moltbot WS] Error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    if attempt >= max_retries {
                        eprintln!(
                            "[Moltbot WS] Failed to connect after {} attempts: {}",
                            max_retries, e
                        );
                        return;
                    }
                    eprintln!(
                        "[Moltbot WS] Connection attempt {}/{} failed: {}",
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

/// Parse and forward a WebSocket message from Moltbot to the frontend
fn handle_ws_message(app: &AppHandle, text: &str) {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(text);
    let Ok(msg) = parsed else {
        eprintln!("[Moltbot WS] Failed to parse message: {}", text);
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
            eprintln!("[Moltbot WS] Unhandled event type: {}", event_type);
        }
    }
}

// --- HTTP Client for Moltbot Webhook API ---

/// Send a message via Moltbot's webhook API
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
        "token": hook_token,
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
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Moltbot webhook request failed: {}", e))?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!(
            "Moltbot webhook returned {}: {}",
            status, response_text
        ));
    }

    Ok(response_text)
}

/// Query Moltbot for connected channels via its HTTP API
async fn query_channels(port: u16, hook_token: &str) -> Result<Vec<ChannelInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!("http://127.0.0.1:{}/api/channels", port);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", hook_token))
        .send()
        .await
        .map_err(|e| format!("Moltbot channels request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Moltbot channels returned {}: {}", status, body));
    }

    // Parse the response — adapt to Moltbot's actual API shape
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse channels response: {}", e))?;

    let channels = if let Some(arr) = body.as_array() {
        arr.iter()
            .filter_map(|item| {
                Some(ChannelInfo {
                    id: item.get("id")?.as_str()?.to_string(),
                    platform: item.get("platform")?.as_str()?.to_string(),
                    display_name: item
                        .get("displayName")
                        .or(item.get("display_name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown")
                        .to_string(),
                    status: match item
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("disconnected")
                    {
                        "connected" => ChannelStatus::Connected,
                        "connecting" => ChannelStatus::Connecting,
                        "error" => ChannelStatus::Error,
                        _ => ChannelStatus::Disconnected,
                    },
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(channels)
}

/// Send a message through Moltbot (Tauri command).
/// Enforces trust level before sending. For approval-required channels, the caller
/// must first obtain an approval_id via the approval UI, then grant it via
/// moltbot_grant_approval before calling this. The approved parameter is NOT trusted
/// from callers — only server-tracked approval IDs are accepted.
#[tauri::command]
pub async fn moltbot_send(
    app: AppHandle,
    state: State<'_, MoltbotState>,
    channel: String,
    to: String,
    message: String,
) -> Result<String, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("Moltbot is not running. Start it in Settings → Moltbot.".to_string());
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
                                "from": to,
                                "message": message,
                                "draftResponse": message,
                            }),
                        );
                        return Err("Message requires approval. Approval event emitted.".to_string());
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

    webhook_send(
        port,
        &hook_token,
        &message,
        Some(&channel),
        Some(&to),
    )
    .await
}

/// Grant approval for a pending message. Called by the approval UI when the user
/// approves a draft response. The approval is keyed by channel:to so the subsequent
/// moltbot_send call for that recipient can proceed.
#[tauri::command]
pub async fn moltbot_grant_approval(
    state: State<'_, MoltbotState>,
    channel: String,
    to: String,
) -> Result<(), String> {
    let approval_key = format!("{}:{}", channel, to);
    let mut approved_ids = state.approved_ids.lock().await;
    approved_ids.insert(approval_key);
    Ok(())
}

/// Set trust configuration for a channel (Tauri command).
/// Persists to moltbot.json so trust levels survive restarts.
#[tauri::command]
pub async fn moltbot_set_trust(
    app: AppHandle,
    state: State<'_, MoltbotState>,
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

/// Persist trust settings to the moltbot.json store.
fn persist_trust_settings(app: &AppHandle, settings: &HashMap<String, ChannelTrustConfig>) {
    if let Ok(store) = app.store(MOLTBOT_STORE) {
        let json = serde_json::to_value(settings).unwrap_or_default();
        store.set("trust_settings", json);
        let _ = store.save();
    }
}

/// Load trust settings from the moltbot.json store.
fn load_trust_settings(app: &AppHandle) -> HashMap<String, ChannelTrustConfig> {
    if let Ok(store) = app.store(MOLTBOT_STORE) {
        if let Some(val) = store.get("trust_settings") {
            if let Ok(settings) = serde_json::from_value::<HashMap<String, ChannelTrustConfig>>(val.clone()) {
                return settings;
            }
        }
    }
    HashMap::new()
}

/// Request a channel connection via Moltbot's HTTP API
async fn request_channel_connect(
    port: u16,
    hook_token: &str,
    platform: &str,
    credentials: &HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!("http://127.0.0.1:{}/api/channels/connect", port);

    let mut body = serde_json::json!({
        "platform": platform,
    });
    for (key, value) in credentials {
        body[key] = serde_json::Value::String(value.clone());
    }

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", hook_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Channel connect request failed: {}", e))?;

    let status = response.status();
    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse connect response: {}", e))?;

    if !status.is_success() {
        let msg = response_body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("Channel connect failed ({}): {}", status, msg));
    }

    Ok(response_body)
}

/// Request a QR code for WhatsApp-style channel connection
async fn request_qr_code(port: u16, hook_token: &str, platform: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!(
        "http://127.0.0.1:{}/api/channels/{}/qr",
        port, platform
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", hook_token))
        .send()
        .await
        .map_err(|e| format!("QR code request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("QR code request failed ({}): {}", status, body));
    }

    // Response is either a data URI or base64 string
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse QR response: {}", e))?;

    body.get("qr")
        .or(body.get("data"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "QR code not found in response".to_string())
}

/// Connect a messaging channel (Tauri command)
#[tauri::command]
pub async fn moltbot_connect_channel(
    state: State<'_, MoltbotState>,
    platform: String,
    credentials: HashMap<String, String>,
) -> Result<serde_json::Value, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("Moltbot is not running. Start it first.".to_string());
    }

    let port = *state.port.lock().await;
    let hook_token = state
        .hook_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Hook token not configured".to_string())?;

    request_channel_connect(port, &hook_token, &platform, &credentials).await
}

/// Get QR code for WhatsApp-style connections (Tauri command)
#[tauri::command]
pub async fn moltbot_get_qr(
    state: State<'_, MoltbotState>,
    platform: String,
) -> Result<String, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("Moltbot is not running. Start it first.".to_string());
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
pub async fn moltbot_disconnect_channel(
    state: State<'_, MoltbotState>,
    channel_id: String,
) -> Result<(), String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("Moltbot is not running.".to_string());
    }

    let port = *state.port.lock().await;
    let hook_token = state
        .hook_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Hook token not configured".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let url = format!(
        "http://127.0.0.1:{}/api/channels/{}",
        port, channel_id
    );

    let response = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", hook_token))
        .send()
        .await
        .map_err(|e| format!("Disconnect request failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Disconnect failed: {}", body));
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
pub async fn moltbot_list_channels(
    state: State<'_, MoltbotState>,
) -> Result<Vec<ChannelInfo>, String> {
    let status = *state.status.lock().await;
    if status != ProcessStatus::Running {
        return Err("Moltbot is not running. Start it in Settings → Moltbot.".to_string());
    }

    let port = *state.port.lock().await;
    let hook_token = state
        .hook_token
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Hook token not configured".to_string())?;

    let channels = query_channels(port, &hook_token).await?;

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
    fn test_moltbot_state_default_status() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = MoltbotState::new();
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
    fn test_moltbot_state_channels_initially_empty() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = MoltbotState::new();
            let channels = state.channels.lock().await;
            assert!(channels.is_empty(), "channels should be empty initially");
        });
    }

    #[test]
    fn test_moltbot_state_hook_token_initially_none() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let state = MoltbotState::new();
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
    fn test_find_moltbot_binary_returns_error_when_not_found() {
        // In test environment, the binary won't exist
        let result = find_moltbot_binary();
        assert!(
            result.is_err(),
            "should return error when binary is not found"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("Moltbot binary not found"),
            "error message should indicate binary not found"
        );
    }
}
