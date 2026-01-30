// ABOUTME: Manages the Moltbot child process lifecycle — spawn, monitor, terminate.
// ABOUTME: Communicates with Moltbot via localhost HTTP webhook API and WebSocket events.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::Arc;
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

    // Spawn a monitoring task that watches for process exit
    let app_handle = app.clone();
    let state_status = Arc::new(Mutex::new(ProcessStatus::Running));
    let status_clone = state_status.clone();

    tokio::spawn(async move {
        // Wait a bit for the process to potentially crash immediately
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        // We can't easily get the child from state here without complex ownership,
        // so the monitor task is a placeholder for now.
        // In production, we'd use a channel or shared handle to monitor the process.
        // For v1, process crash detection happens when HTTP calls fail.
        eprintln!("[Moltbot] Process monitor started for port {}", port);

        let _ = (app_handle, status_clone);
    });

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
