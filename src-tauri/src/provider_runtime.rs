// ABOUTME: Supervises the local Node-based provider runtime used by desktop-native mode.
// ABOUTME: Starts the bundled runtime on localhost and returns connection config to the frontend.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
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

struct ProviderRuntimeProcess {
    child: Child,
    config: ProviderRuntimeConfig,
}

pub struct ProviderRuntimeState {
    process: Mutex<Option<ProviderRuntimeProcess>>,
}

impl ProviderRuntimeState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
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
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[ProviderRuntime stdout] {}", line);
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::warn!("[ProviderRuntime stderr] {}", line);
                }
            });
        }

        wait_for_provider_runtime(&config, &mut child).await?;
        *guard = Some(ProviderRuntimeProcess {
            child,
            config: config.clone(),
        });

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
                return Ok(());
            }
        }

        if Instant::now() >= deadline {
            return Err("Timed out waiting for provider runtime readiness.".to_string());
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
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
    let mut guard = state.process.lock().await;
    let Some(mut process) = guard.take() else {
        return Ok(());
    };

    process
        .child
        .kill()
        .await
        .map_err(|err| format!("Failed to stop provider runtime: {}", err))
}
