// ABOUTME: Supervises the local Happy bridge process and exposes lifecycle status.
// ABOUTME: Builds its provider-runtime config in Rust so secrets never enter argv.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub const HAPPY_RELAY_URL: &str = "https://api.cluster-fluster.com";
const MAX_RESTART_ATTEMPTS: u32 = 3;
const MAX_BACKOFF_SECONDS: u64 = 30;
const STOP_GRACE_PERIOD: Duration = Duration::from_secs(5);
const STATUS_EVENT: &str = "happy-bridge://status";
const CREDENTIAL_STORE: &str = "happy_bridge.json";
const CREDENTIAL_KEY: &str = "credential_blob";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HappyBridgeState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct HappyBridgeStatus {
    pub state: HappyBridgeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HappyBridgeConfig {
    provider_runtime: ProviderRuntimeConnection,
    relay_url: String,
    machine_identity: Option<serde_json::Value>,
    machine_name: String,
}

#[derive(Debug, Serialize)]
struct ProviderRuntimeConnection {
    host: String,
    port: u16,
    token: String,
}

struct HappyBridgeProcess {
    child: Child,
    _stdin: ChildStdin,
}

pub struct HappyBridgeManager {
    process: Arc<Mutex<Option<HappyBridgeProcess>>>,
    monitor_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    status: Arc<Mutex<HappyBridgeStatus>>,
}

impl HappyBridgeManager {
    pub fn new() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
            monitor_handle: Mutex::new(None),
            status: Arc::new(Mutex::new(HappyBridgeStatus {
                state: HappyBridgeState::Stopped,
                detail: None,
            })),
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut guard = self.process.lock().await;
            if let Some(process) = guard.as_mut() {
                if process
                    .child
                    .try_wait()
                    .map_err(|err| format!("Failed checking Happy bridge: {err}"))?
                    .is_none()
                {
                    return Ok(());
                }
            }
            *guard = None;
        }

        self.set_status(app, HappyBridgeState::Starting, None).await;
        if let Err(error) = self.start_process(app).await {
            self.set_status(app, HappyBridgeState::Error, Some(error.clone()))
                .await;
            return Err(error);
        }

        self.set_status(app, HappyBridgeState::Running, None).await;
        self.ensure_monitor(app.clone()).await;
        Ok(())
    }

    async fn start_process(&self, app: &AppHandle) -> Result<(), String> {
        let provider_runtime = app
            .state::<crate::provider_runtime::ProviderRuntimeState>()
            .ensure_started(app)
            .await?;
        let node_binary = resolve_node_binary(app);
        let bridge_entry = find_happy_bridge_mjs()?;
        let config = HappyBridgeConfig {
            provider_runtime: ProviderRuntimeConnection {
                host: provider_runtime.host,
                port: provider_runtime.port,
                token: provider_runtime.token,
            },
            relay_url: HAPPY_RELAY_URL.to_string(),
            machine_identity: None,
            machine_name: "seren-desktop".to_string(),
        };

        let mut command = Command::new(node_binary);
        command
            .arg(&bridge_entry)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::embedded_runtime::sanitize_spawn_env(&mut command);

        #[cfg(windows)]
        command.creation_flags(0x08000000);

        let mut child = command
            .spawn()
            .map_err(|err| format!("Failed to spawn Happy bridge: {err}"))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Happy bridge stdin was not piped".to_string())?;
        let encoded = serde_json::to_vec(&config)
            .map_err(|err| format!("Failed to encode Happy bridge config: {err}"))?;
        stdin
            .write_all(&encoded)
            .await
            .map_err(|err| format!("Failed to write Happy bridge config: {err}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|err| format!("Failed to finish Happy bridge config: {err}"))?;
        stdin
            .flush()
            .await
            .map_err(|err| format!("Failed to flush Happy bridge config: {err}"))?;

        pipe_bridge_output(&mut child);
        *self.process.lock().await = Some(HappyBridgeProcess {
            child,
            _stdin: stdin,
        });
        Ok(())
    }

    async fn ensure_monitor(&self, app: AppHandle) {
        let mut guard = self.monitor_handle.lock().await;
        if guard.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }
        guard.take();
        let process = Arc::clone(&self.process);
        let status = Arc::clone(&self.status);
        *guard = Some(tokio::spawn(async move {
            monitor_process(app, process, status).await;
        }));
    }

    pub async fn stop(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(handle) = self.monitor_handle.lock().await.take() {
            handle.abort();
        }

        let process = self.process.lock().await.take();
        if let Some(mut process) = process {
            terminate_child(&mut process.child).await?;
        }
        self.set_status(app, HappyBridgeState::Stopped, None).await;
        Ok(())
    }

    pub async fn status(&self) -> HappyBridgeStatus {
        self.status.lock().await.clone()
    }

    /// Store the opaque credential received during future pairing. This follows
    /// the existing encrypted Tauri store pattern used by auth.rs; no bridge
    /// identity is generated locally in Phase 1.
    pub fn store_pairing_credential(
        &self,
        app: &AppHandle,
        credential: &str,
    ) -> Result<(), String> {
        if credential.trim().is_empty() {
            return Err("pairing credential must not be empty".to_string());
        }
        let store = app.store(CREDENTIAL_STORE).map_err(|err| err.to_string())?;
        store.set(CREDENTIAL_KEY, serde_json::json!(credential));
        store.save().map_err(|err| err.to_string())
    }

    pub fn load_pairing_credential(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let store = app.store(CREDENTIAL_STORE).map_err(|err| err.to_string())?;
        Ok(store
            .get(CREDENTIAL_KEY)
            .and_then(|value| value.as_str().map(String::from)))
    }

    pub fn delete_pairing_credential(&self, app: &AppHandle) -> Result<(), String> {
        let store = app.store(CREDENTIAL_STORE).map_err(|err| err.to_string())?;
        store.delete(CREDENTIAL_KEY);
        store.save().map_err(|err| err.to_string())
    }

    async fn set_status(&self, app: &AppHandle, state: HappyBridgeState, detail: Option<String>) {
        let status = HappyBridgeStatus { state, detail };
        *self.status.lock().await = status.clone();
        let _ = app.emit(STATUS_EVENT, status);
    }

    pub fn kill_sync(&self) {
        if let Ok(mut guard) = self.monitor_handle.try_lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
        if let Ok(mut guard) = self.process.try_lock() {
            if let Some(process) = guard.as_ref() {
                if let Some(pid) = process.child.id() {
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &pid.to_string()])
                            .creation_flags(0x08000000)
                            .spawn();
                    }
                }
            }
            *guard = None;
        }
    }
}

impl Default for HappyBridgeManager {
    fn default() -> Self {
        Self::new()
    }
}

async fn monitor_process(
    app: AppHandle,
    process: Arc<Mutex<Option<HappyBridgeProcess>>>,
    status: Arc<Mutex<HappyBridgeStatus>>,
) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let exited = {
            let mut guard = process.lock().await;
            match guard.as_mut() {
                None => return,
                Some(process) => match process.child.try_wait() {
                    Ok(None) => false,
                    Ok(Some(_)) => {
                        *guard = None;
                        true
                    }
                    Err(error) => {
                        log::warn!("[HappyBridge] Failed checking process status: {error}");
                        false
                    }
                },
            }
        };
        if !exited {
            continue;
        }

        for attempt in 0..MAX_RESTART_ATTEMPTS {
            let delay = restart_delay(attempt);
            {
                let mut current = status.lock().await;
                current.state = HappyBridgeState::Starting;
                current.detail = Some(format!(
                    "restart attempt {}/{}",
                    attempt + 1,
                    MAX_RESTART_ATTEMPTS
                ));
                let _ = app.emit(STATUS_EVENT, current.clone());
            }
            tokio::time::sleep(delay).await;

            let manager = app.state::<HappyBridgeManager>();
            match manager.start_process(&app).await {
                Ok(()) => {
                    let running = HappyBridgeStatus {
                        state: HappyBridgeState::Running,
                        detail: None,
                    };
                    *status.lock().await = running.clone();
                    let _ = app.emit(STATUS_EVENT, running);
                    break;
                }
                Err(error) if attempt + 1 == MAX_RESTART_ATTEMPTS => {
                    let failed = HappyBridgeStatus {
                        state: HappyBridgeState::Error,
                        detail: Some(error),
                    };
                    *status.lock().await = failed.clone();
                    let _ = app.emit(STATUS_EVENT, failed);
                }
                Err(error) => {
                    log::warn!("[HappyBridge] Restart failed: {error}");
                }
            }
        }
    }
}

async fn terminate_child(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }

    match tokio::time::timeout(STOP_GRACE_PERIOD, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => child
            .kill()
            .await
            .map_err(|err| format!("Failed to stop Happy bridge: {err}")),
    }
}

fn restart_delay(attempt: u32) -> Duration {
    let seconds = 2u64.saturating_pow(attempt).min(MAX_BACKOFF_SECONDS);
    Duration::from_secs(seconds)
}

fn resolve_node_binary(app: &AppHandle) -> PathBuf {
    if let Some(node_dir) = crate::embedded_runtime::discover_embedded_runtime(app).node_dir {
        let candidate = if cfg!(target_os = "windows") {
            node_dir.join("node.exe")
        } else {
            node_dir.join("node")
        };
        if candidate.exists() {
            return candidate;
        }
    }
    if cfg!(target_os = "windows") {
        PathBuf::from("node.exe")
    } else {
        PathBuf::from("node")
    }
}

fn find_happy_bridge_mjs() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|err| format!("Failed to get current exe path: {err}"))?
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?
        .to_path_buf();
    let platform = crate::embedded_runtime::platform_subdir();
    let candidates = [
        exe_dir
            .join("../Resources/embedded-runtime")
            .join(&platform)
            .join("provider-runtime/happy-bridge.mjs"),
        exe_dir.join("../Resources/embedded-runtime/provider-runtime/happy-bridge.mjs"),
        exe_dir
            .join("embedded-runtime")
            .join(&platform)
            .join("provider-runtime/happy-bridge.mjs"),
        exe_dir.join("embedded-runtime/provider-runtime/happy-bridge.mjs"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("embedded-runtime/provider-runtime/happy-bridge.mjs"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bin/happy-bridge.mjs"),
    ];
    candidates
        .iter()
        .find(|candidate| candidate.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "happy-bridge.mjs not found in {}",
                candidates
                    .iter()
                    .map(|candidate| candidate.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn pipe_bridge_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(_line)) = lines.next_line().await {}
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!("[HappyBridge] {line}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::restart_delay;
    use std::time::Duration;

    #[test]
    fn restart_backoff_is_capped() {
        assert_eq!(restart_delay(0), Duration::from_secs(1));
        assert_eq!(restart_delay(1), Duration::from_secs(2));
        assert_eq!(restart_delay(2), Duration::from_secs(4));
        assert_eq!(restart_delay(10), Duration::from_secs(30));
    }
}
