// ABOUTME: Supervises the local Node-based provider runtime used by desktop-native mode.
// ABOUTME: Starts the bundled runtime on localhost and returns connection config to the frontend.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub api_base_url: String,
    pub ws_base_url: String,
}

const MAX_RESTART_ATTEMPTS: u32 = 3;

struct ProviderRuntimeProcess {
    child: Child,
    config: ProviderRuntimeConfig,
}

pub struct ProviderRuntimeState {
    process: Mutex<Option<ProviderRuntimeProcess>>,
    monitor_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ProviderRuntimeState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            monitor_handle: Mutex::new(None),
        }
    }

    pub(crate) async fn ensure_started(&self, app: &AppHandle) -> Result<ProviderRuntimeConfig, String> {
        let mut guard = self.process.lock().await;

        if let Some(process) = guard.as_mut() {
            match process.child.try_wait() {
                Ok(None) => return Ok(process.config.clone()),
                Ok(Some(status)) => {
                    log::warn!(
                        "[ProviderRuntime] Existing process exited before reuse: {}",
                        status
                    );
                }
                Err(err) => {
                    log::warn!(
                        "[ProviderRuntime] Failed checking existing process status: {}",
                        err
                    );
                }
            }

            *guard = None;
        }

        let host = "127.0.0.1".to_string();
        let port = find_available_port()?;
        let token = generate_auth_token();
        let config = ProviderRuntimeConfig {
            api_base_url: format!("http://{}:{}", host, port),
            ws_base_url: format!("ws://{}:{}", host, port),
            host: host.clone(),
            port,
            token: token.clone(),
        };

        let node_bin = resolve_node_binary(app);
        let runtime_entry = find_provider_runtime_mjs()?;

        let mut command = Command::new(&node_bin);
        command
            .arg(&runtime_entry)
            .arg("--host")
            .arg(&host)
            .arg("--port")
            .arg(port.to_string())
            .arg("--token")
            .arg(&token)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let embedded_path = crate::embedded_runtime::get_embedded_path();
        if !embedded_path.is_empty() {
            command.env("PATH", embedded_path);
        }

        let mut child = command
            .spawn()
            .map_err(|err| format!("Failed to spawn provider runtime: {}", err))?;

        if let Some(stdout) = child.stdout.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => log::info!("[ProviderRuntime stdout] {}", line),
                        Ok(None) => break, // EOF
                        Err(err) => {
                            log::warn!("[ProviderRuntime stdout] Read error: {}", err);
                            break;
                        }
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => log::warn!("[ProviderRuntime stderr] {}", line),
                        Ok(None) => break, // EOF
                        Err(err) => {
                            log::warn!("[ProviderRuntime stderr] Read error: {}", err);
                            break;
                        }
                    }
                }
            });
        }

        wait_for_provider_runtime(&config, &mut child).await?;
        *guard = Some(ProviderRuntimeProcess {
            child,
            config: config.clone(),
        });
        drop(guard);

        // Start crash monitor
        let monitor = spawn_process_monitor(app.clone());
        *self.monitor_handle.lock().await = Some(monitor);

        Ok(config)
    }
}

impl Default for ProviderRuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

fn find_available_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to bind provider runtime port: {}", err))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("Failed to read provider runtime port: {}", err))
}

fn generate_auth_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

fn resolve_node_binary(app: &AppHandle) -> PathBuf {
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);
    if let Some(node_dir) = paths.node_dir {
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

fn find_provider_runtime_mjs() -> Result<PathBuf, String> {
    let exe_path =
        std::env::current_exe().map_err(|err| format!("Failed to get current exe path: {}", err))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?;
    let platform_subdir = crate::embedded_runtime::platform_subdir();

    let candidates = [
        exe_dir
            .join("../Resources/embedded-runtime")
            .join(&platform_subdir)
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        exe_dir
            .join("../Resources/embedded-runtime")
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        exe_dir
            .join("embedded-runtime")
            .join(&platform_subdir)
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        exe_dir
            .join("embedded-runtime")
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("embedded-runtime")
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            log::info!(
                "[ProviderRuntime] Found provider-runtime.mjs at {:?}",
                candidate
            );
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "provider-runtime.mjs not found. Checked locations:\n{}",
        candidates
            .iter()
            .map(|path| format!("  - {:?}", path))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

async fn wait_for_provider_runtime(
    config: &ProviderRuntimeConfig,
    child: &mut Child,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let health_url = format!("{}/__seren/health", config.api_base_url);
    let deadline = Instant::now() + Duration::from_secs(10);

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("Failed checking provider runtime status: {}", err))?
        {
            return Err(format!(
                "Provider runtime exited before becoming ready: {}",
                status
            ));
        }

        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                // Also check that the runtime reports itself as ready
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        return Ok(());
                    }
                }
            }
        }

        if Instant::now() >= deadline {
            return Err("Timed out waiting for provider runtime readiness.".to_string());
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Watches for provider runtime process death and attempts bounded auto-restart.
fn spawn_process_monitor(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut restart_attempts: u32 = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let state = app.state::<ProviderRuntimeState>();
            let exited = {
                let mut guard = state.process.lock().await;
                match guard.as_mut() {
                    None => break, // Process was intentionally stopped
                    Some(proc) => match proc.child.try_wait() {
                        Ok(None) => false,     // Still running
                        Ok(Some(status)) => {
                            log::warn!("[ProviderRuntime] Process exited unexpectedly: {}", status);
                            *guard = None;
                            true
                        }
                        Err(err) => {
                            log::warn!("[ProviderRuntime] Failed to check process status: {}", err);
                            false
                        }
                    },
                }
            };

            if exited {
                restart_attempts += 1;
                if restart_attempts > MAX_RESTART_ATTEMPTS {
                    log::error!(
                        "[ProviderRuntime] Crashed {} times, giving up",
                        restart_attempts - 1
                    );
                    let _ = app.emit(
                        "provider-runtime://failed",
                        serde_json::json!({ "attempts": restart_attempts - 1 }),
                    );
                    return;
                }

                log::info!(
                    "[ProviderRuntime] Restarting (attempt {}/{})",
                    restart_attempts,
                    MAX_RESTART_ATTEMPTS
                );
                tokio::time::sleep(Duration::from_secs(2)).await;

                let state = app.state::<ProviderRuntimeState>();
                match state.ensure_started(&app).await {
                    Ok(_) => {
                        log::info!("[ProviderRuntime] Restarted successfully");
                        let _ = app.emit("provider-runtime://restarted", serde_json::json!({}));
                        restart_attempts = 0;
                        return; // ensure_started spawns a new monitor
                    }
                    Err(err) => {
                        log::error!("[ProviderRuntime] Restart failed: {}", err);
                    }
                }
            }
        }
    })
}

#[tauri::command]
pub async fn provider_runtime_get_config(
    app: AppHandle,
    state: State<'_, ProviderRuntimeState>,
) -> Result<ProviderRuntimeConfig, String> {
    state.ensure_started(&app).await
}

#[tauri::command]
pub async fn provider_runtime_stop(
    state: State<'_, ProviderRuntimeState>,
) -> Result<(), String> {
    if let Some(handle) = state.monitor_handle.lock().await.take() {
        handle.abort();
    }

    let mut guard = state.process.lock().await;
    let Some(mut process) = guard.take() else {
        return Ok(());
    };

    // Attempt graceful shutdown before force kill
    #[cfg(unix)]
    {
        if let Some(pid) = process.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }

    // Wait up to 5 seconds for graceful exit, then force kill
    match tokio::time::timeout(Duration::from_secs(5), process.child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => process
            .child
            .kill()
            .await
            .map_err(|err| format!("Failed to stop provider runtime: {}", err)),
    }
}
