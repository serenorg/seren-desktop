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

/// Per-attempt readiness deadlines for the initial spawn sequence
/// (see GH #1587). Escalating windows absorb the worst observed cold-start
/// path: first attempt SIGKILL'd instantly (macOS first-touch on the
/// freshly extracted embedded-runtime node binary), then a slow second
/// cold start under Tauri setup-hook contention, then a third attempt
/// that finally runs on warm node. `#1568` landed 10s → 20s for the
/// first attempt + one retry; this extends to three attempts with room
/// for the tail.
const STARTUP_ATTEMPT_BUDGETS: &[Duration] = &[
    Duration::from_secs(20),
    Duration::from_secs(30),
    Duration::from_secs(45),
];

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

    pub(crate) async fn ensure_started(
        &self,
        app: &AppHandle,
    ) -> Result<ProviderRuntimeConfig, String> {
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
        let token = generate_auth_token();
        let node_bin = resolve_node_binary(app);
        let runtime_entry = find_provider_runtime_mjs()?;

        // Spawn up to STARTUP_ATTEMPT_BUDGETS.len() attempts. #1568 shipped
        // with 2 attempts at 20s each; field evidence in #1587 showed cases
        // where first-spawn SIGKILL consumes one attempt and the second
        // still times out under setup-hook contention. Widen the budget.
        let mut attempt_errors: Vec<String> = Vec::with_capacity(STARTUP_ATTEMPT_BUDGETS.len());
        for (attempt_idx, deadline) in STARTUP_ATTEMPT_BUDGETS.iter().enumerate() {
            let attempt_num = attempt_idx + 1;
            let port = find_available_port()?;
            let config = ProviderRuntimeConfig {
                api_base_url: format!("http://{}:{}", host, port),
                ws_base_url: format!("ws://{}:{}", host, port),
                host: host.clone(),
                port,
                token: token.clone(),
            };

            let mut child = spawn_node_process(
                &node_bin,
                &runtime_entry,
                &host,
                port,
                &token,
            )?;

            log::info!(
                "[ProviderRuntime] Attempt {}/{} — spawned node={} pid={} port={} deadline={}s",
                attempt_num,
                STARTUP_ATTEMPT_BUDGETS.len(),
                node_bin.display(),
                child.id().unwrap_or(0),
                port,
                deadline.as_secs(),
            );

            pipe_child_output(&mut child);

            match wait_for_provider_runtime_with_deadline(&config, &mut child, *deadline).await {
                Ok(()) => {
                    *guard = Some(ProviderRuntimeProcess {
                        child,
                        config: config.clone(),
                    });
                    drop(guard);

                    // Abort any previous crash monitor before starting a new one
                    if let Some(old_handle) = self.monitor_handle.lock().await.take() {
                        old_handle.abort();
                    }
                    let monitor = spawn_process_monitor(app.clone());
                    *self.monitor_handle.lock().await = Some(monitor);

                    // Notify the frontend that the runtime is up. The
                    // agent store subscribes to this event and re-runs
                    // `getAvailableAgents` — this unblocks the Codex /
                    // Gemini buttons even when first-attempt readiness
                    // exceeds the store's initial-query backoff budget.
                    let _ = app.emit("provider-runtime://ready", &config);

                    return Ok(config);
                }
                Err(attempt_err) => {
                    log::warn!(
                        "[ProviderRuntime] Attempt {}/{} failed ({}), {}",
                        attempt_num,
                        STARTUP_ATTEMPT_BUDGETS.len(),
                        attempt_err,
                        if attempt_num < STARTUP_ATTEMPT_BUDGETS.len() {
                            "retrying with fresh process"
                        } else {
                            "giving up"
                        },
                    );
                    let _ = child.kill().await;
                    attempt_errors.push(format!("attempt {}: {}", attempt_num, attempt_err));
                }
            }
        }

        Err(format!(
            "Provider runtime failed to become ready after {} attempts: {}",
            attempt_errors.len(),
            attempt_errors.join("; ")
        ))
    }
}

impl ProviderRuntimeState {
    /// Synchronously kill the provider runtime process. Called from the app
    /// exit handler where the async runtime may be shutting down.
    pub fn kill_sync(&self) {
        // Abort the monitor task if reachable via try_lock
        if let Ok(mut guard) = self.monitor_handle.try_lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }

        if let Ok(mut guard) = self.process.try_lock() {
            if let Some(ref process) = *guard {
                if let Some(pid) = process.child.id() {
                    log::info!("[ProviderRuntime] Killing process on exit: pid={}", pid);
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                    #[cfg(windows)]
                    {
                        // Use taskkill /T to kill the entire process tree.
                        // kill_on_drop only terminates the immediate child, leaving
                        // grandchild node.exe processes (claude CLI) orphaned and
                        // holding file locks that block the next NSIS install.
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &pid.to_string()])
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                            .status();
                    }
                }
            }
            *guard = None;
        }
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
    let exe_path = std::env::current_exe()
        .map_err(|err| format!("Failed to get current exe path: {}", err))?;
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

fn spawn_node_process(
    node_bin: &std::path::Path,
    runtime_entry: &std::path::Path,
    host: &str,
    port: u16,
    token: &str,
) -> Result<Child, String> {
    let mut command = Command::new(node_bin);
    command
        .arg(runtime_entry)
        .arg("--host")
        .arg(host)
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(token)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        command.env("PATH", embedded_path);
    }

    crate::embedded_runtime::sanitize_spawn_env(&mut command);

    command
        .spawn()
        .map_err(|err| format!("Failed to spawn provider runtime: {err}"))
}

fn pipe_child_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => log::info!("[ProviderRuntime stdout] {}", line),
                    Ok(None) => break,
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
                    Ok(None) => break,
                    Err(err) => {
                        log::warn!("[ProviderRuntime stderr] Read error: {}", err);
                        break;
                    }
                }
            }
        });
    }
}

async fn wait_for_provider_runtime_with_deadline(
    config: &ProviderRuntimeConfig,
    child: &mut Child,
    budget: Duration,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let health_url = format!("{}/__seren/health", config.api_base_url);
    let deadline = Instant::now() + budget;

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("Failed checking provider runtime status: {err}"))?
        {
            return Err(format!(
                "Provider runtime exited before becoming ready: {status}",
            ));
        }

        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                if let Ok(body) = response.json::<serde_json::Value>().await {
                    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                        return Ok(());
                    }
                }
            }
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "Timed out waiting for provider runtime readiness after {}s.",
                budget.as_secs()
            ));
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
                        Ok(None) => false, // Still running
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
pub async fn provider_runtime_stop(state: State<'_, ProviderRuntimeState>) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command as TokioCommand;

    /// Build a stub child process that exits instantly with the requested
    /// code/signal so `wait_for_provider_runtime_with_deadline` can exercise
    /// its child-exit path without a real node runtime. Used by the retry
    /// tests below.
    async fn spawn_exiting_child(exit_code: u8) -> Child {
        TokioCommand::new("sh")
            .arg("-c")
            .arg(format!("exit {}", exit_code))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh exit")
    }

    /// Build a child that runs for longer than the readiness deadline, so
    /// the wait loop exits via the timeout branch. We use `sleep 10` which
    /// outlives our 200ms test deadline without tying up system resources.
    async fn spawn_hanging_child() -> Child {
        TokioCommand::new("sh")
            .arg("-c")
            .arg("sleep 10")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sh sleep")
    }

    fn dummy_config() -> ProviderRuntimeConfig {
        // Port that definitely won't have a server behind it — health
        // check never succeeds, so the deadline is reached.
        ProviderRuntimeConfig {
            host: "127.0.0.1".to_string(),
            port: 1,
            token: "test".to_string(),
            api_base_url: "http://127.0.0.1:1".to_string(),
            ws_base_url: "ws://127.0.0.1:1".to_string(),
        }
    }

    /// GH #1587: a child that exits (e.g. SIGKILL, signal 9) before binding
    /// must surface as an Err that names the exit status so the retry loop
    /// in `ensure_started` can react. Before this PR the message was the
    /// same; what changed is that now a caller can chain three of these
    /// together without running out of attempts.
    #[tokio::test]
    async fn wait_reports_exit_for_signal_exited_child() {
        let mut child = spawn_exiting_child(1).await;
        let config = dummy_config();
        let err = wait_for_provider_runtime_with_deadline(
            &config,
            &mut child,
            Duration::from_secs(2),
        )
        .await
        .expect_err("must err on early exit");
        assert!(
            err.contains("exited before becoming ready"),
            "unexpected err: {err}"
        );
    }

    /// GH #1587: a child that runs but never serves health in time must
    /// surface as a timeout Err naming the budget, so operators reading
    /// logs can see which attempt's budget was exceeded.
    #[tokio::test]
    async fn wait_reports_timeout_with_budget_in_message() {
        let mut child = spawn_hanging_child().await;
        let config = dummy_config();
        let err = wait_for_provider_runtime_with_deadline(
            &config,
            &mut child,
            Duration::from_millis(300),
        )
        .await
        .expect_err("must err on timeout");
        assert!(err.contains("Timed out"), "unexpected err: {err}");
        assert!(err.contains("0s") || err.contains("after"), "err should mention budget: {err}");
        let _ = child.kill().await;
    }

    /// GH #1587: the attempt-budget table has three entries so the retry
    /// loop tolerates SIGKILL-first + slow-second without exhausting
    /// attempts. Guards against accidental future trimming of the slice.
    #[test]
    fn startup_budget_allows_three_attempts() {
        assert_eq!(
            STARTUP_ATTEMPT_BUDGETS.len(),
            3,
            "retry budget regression: #1587 requires at least three attempts"
        );
        // Budgets must be monotonically non-decreasing — second/third
        // attempts benefit from warmer caches and eased contention.
        let pairs: Vec<_> = STARTUP_ATTEMPT_BUDGETS
            .windows(2)
            .map(|w| (w[0], w[1]))
            .collect();
        for (prev, next) in pairs {
            assert!(
                next >= prev,
                "budgets should be non-decreasing: {prev:?} -> {next:?}"
            );
        }
    }
}
