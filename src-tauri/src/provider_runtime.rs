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

/// A restart only re-arms the budget once the runtime has proved it can stay
/// up this long. Shorter than that and a crash loop just keeps buying itself
/// fresh attempts.
const RESTART_REARM_UPTIME: Duration = Duration::from_secs(60);

struct ProviderRuntimeProcess {
    child: Child,
    config: ProviderRuntimeConfig,
    spawned_at: Instant,
    restart_budget_rearmed: bool,
}

pub struct ProviderRuntimeState {
    process: Mutex<Option<ProviderRuntimeProcess>>,
    monitor_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    last_config: Mutex<Option<ProviderRuntimeConfig>>,
    /// Crash-restart budget. Owned by the state, not by the monitor task:
    /// a successful restart goes through `ensure_started`, which aborts the
    /// monitor and spawns a fresh one, so a task-local counter reset itself
    /// on every restart and the give-up check could never fire (#3156).
    restart_attempts: Mutex<u32>,
}

impl ProviderRuntimeState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            monitor_handle: Mutex::new(None),
            last_config: Mutex::new(None),
            restart_attempts: Mutex::new(0),
        }
    }

    /// Claims the next restart from the shared budget, or `None` once it is
    /// exhausted.
    async fn claim_restart_attempt(&self) -> Option<u32> {
        let mut attempts = self.restart_attempts.lock().await;
        let next = next_restart_attempt(*attempts)?;
        *attempts = next;
        Some(next)
    }

    async fn rearm_restart_budget(&self) {
        *self.restart_attempts.lock().await = 0;
    }

    pub(crate) async fn ensure_started(
        &self,
        app: &AppHandle,
    ) -> Result<ProviderRuntimeConfig, String> {
        // Refuse to spawn when an update is in flight. The check lives here,
        // not in the `provider_runtime_get_config` IPC command, so internal
        // Rust callers (orchestrator workers) cannot bypass the gate by
        // skipping IPC — #2240, caught in the #2230 functional walk-through.
        if is_update_in_progress(app) {
            return Err("Update in progress — provider runtime spawn refused".to_string());
        }

        let mut preferred_config = self.last_config.lock().await.clone();
        let mut guard = self.process.lock().await;

        if let Some(process) = guard.as_mut() {
            preferred_config = Some(process.config.clone());
            match process.child.try_wait() {
                Ok(None) => {
                    if check_provider_runtime_health_once(&process.config).await {
                        return Ok(process.config.clone());
                    }
                    log::warn!(
                        "[ProviderRuntime] Existing process pid={} failed cached health check; restarting on pinned port {}",
                        process.child.id().unwrap_or(0),
                        process.config.port
                    );
                    let _ = process.child.start_kill();
                }
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
        let mut config = startup_config_for_host(&host, preferred_config.as_ref())?;
        let node_bin = resolve_node_binary(app);
        let runtime_entry = find_provider_runtime_mjs()?;

        // Spawn up to STARTUP_ATTEMPT_BUDGETS.len() attempts. #1568 shipped
        // with 2 attempts at 20s each; field evidence in #1587 showed cases
        // where first-spawn SIGKILL consumes one attempt and the second
        // still times out under setup-hook contention. Widen the budget.
        let mut attempt_errors: Vec<String> = Vec::with_capacity(STARTUP_ATTEMPT_BUDGETS.len());
        for (attempt_idx, deadline) in STARTUP_ATTEMPT_BUDGETS.iter().enumerate() {
            let attempt_num = attempt_idx + 1;

            let mut child = spawn_node_process(
                &node_bin,
                &runtime_entry,
                &config.host,
                config.port,
                &config.token,
            )?;

            log::info!(
                "[ProviderRuntime] Attempt {}/{} — spawned node={} pid={} port={} deadline={}s",
                attempt_num,
                STARTUP_ATTEMPT_BUDGETS.len(),
                node_bin.display(),
                child.id().unwrap_or(0),
                config.port,
                deadline.as_secs(),
            );

            pipe_child_output(&mut child);

            match wait_for_provider_runtime_with_deadline(&config, &mut child, *deadline).await {
                Ok(()) => {
                    *guard = Some(ProviderRuntimeProcess {
                        child,
                        config: config.clone(),
                        spawned_at: Instant::now(),
                        restart_budget_rearmed: false,
                    });
                    drop(guard);
                    *self.last_config.lock().await = Some(config.clone());

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
                            "retrying on a fresh port"
                        } else {
                            "giving up"
                        },
                    );
                    // Non-blocking kill: `Child::kill().await` is *not*
                    // just a signal send — it sends SIGKILL *and then
                    // awaits* the child's wait status. On a hung node
                    // subprocess (the exact case this retry loop exists
                    // for) that await never returns, which traps the
                    // loop before attempt 2 can spawn.
                    //
                    // Observed after #1588 landed: attempt 1 timed out,
                    // warn logged, then the process silently hung — the
                    // "Attempt 2/3 — spawned" log line never appeared
                    // even though STARTUP_ATTEMPT_BUDGETS has three
                    // entries. Codex/Gemini never showed up.
                    //
                    // `start_kill()` sends SIGKILL synchronously without
                    // waiting. `kill_on_drop(true)` (set at spawn) takes
                    // care of reaping when `child` drops at end-of-scope.
                    let _ = child.start_kill();
                    drop(child);
                    attempt_errors.push(format!("attempt {}: {}", attempt_num, attempt_err));

                    // #2563: the pinned port can be transiently unbindable on
                    // restart (Windows TIME_WAIT, or the just-killed process
                    // has not released the socket). The node runtime exits
                    // immediately on a listen error, so reusing the same port
                    // just fails the same way. Rebind the remaining attempts on
                    // a fresh port, preserving the auth token so clients that
                    // cached the prior token re-authenticate against the new
                    // port. Attempt 1 still uses the pinned port, keeping the
                    // #2542 reconnect behavior for the common case.
                    if attempt_num < STARTUP_ATTEMPT_BUDGETS.len() {
                        match find_available_port() {
                            Ok(fresh_port) if fresh_port != config.port => {
                                log::warn!(
                                    "[ProviderRuntime] Rebinding from port {} to {} for next attempt",
                                    config.port,
                                    fresh_port
                                );
                                config = config_with_port(&config, fresh_port);
                            }
                            Ok(_) => {}
                            Err(port_err) => {
                                log::warn!(
                                    "[ProviderRuntime] Could not pick a fresh port after attempt {} ({}); reusing {}",
                                    attempt_num,
                                    port_err,
                                    config.port
                                );
                            }
                        }
                    }
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
                        // Spawn detached instead of .status(): this runs in the
                        // RunEvent::Exit handler on the UI thread, and waiting on
                        // taskkill there freezes "Quit Seren" until the whole tree
                        // dies (#2508). /F /T is fire-and-forget — taskkill keeps
                        // running and reaps the tree after we exit.
                        use std::os::windows::process::CommandExt;
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &pid.to_string()])
                            .creation_flags(0x08000000) // CREATE_NO_WINDOW
                            .spawn();
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

/// True when the in-app updater has engaged the shutdown guard. Generic over
/// the Tauri runtime so the same check works in both the production Wry app
/// and `tauri::test::MockRuntime` integration tests (#2240).
fn is_update_in_progress<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.try_state::<std::sync::Arc<crate::commands::updater::ShutdownGuard>>()
        .map(|g| g.is_engaged())
        .unwrap_or(false)
}

fn find_available_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to bind provider runtime port: {}", err))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("Failed to read provider runtime port: {}", err))
}

fn build_provider_runtime_config(host: String, port: u16, token: String) -> ProviderRuntimeConfig {
    ProviderRuntimeConfig {
        api_base_url: format!("http://{}:{}", host, port),
        ws_base_url: format!("ws://{}:{}", host, port),
        host,
        port,
        token,
    }
}

/// Rebuild a runtime config on a different port while preserving the auth
/// token and host. #2563: when the pinned port is transiently unbindable on
/// restart the runtime rebinds on a fresh port without rotating the token, so
/// clients holding the prior token re-authenticate against the new port.
fn config_with_port(prev: &ProviderRuntimeConfig, port: u16) -> ProviderRuntimeConfig {
    build_provider_runtime_config(prev.host.clone(), port, prev.token.clone())
}

fn startup_config_for_host(
    host: &str,
    preferred: Option<&ProviderRuntimeConfig>,
) -> Result<ProviderRuntimeConfig, String> {
    match preferred {
        Some(config) => Ok(build_provider_runtime_config(
            host.to_string(),
            config.port,
            config.token.clone(),
        )),
        None => Ok(build_provider_runtime_config(
            host.to_string(),
            find_available_port()?,
            generate_auth_token(),
        )),
    }
}

fn generate_auth_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

fn resolve_node_binary(app: &AppHandle) -> PathBuf {
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);
    if let Some(node) = crate::embedded_runtime::embedded_node_binary(&paths) {
        return node;
    }

    log::warn!(
        "[ProviderRuntime] Bundled node not found under {:?}; falling back to the user's \
         system node. The runtime will run on an unmanaged node version, or fail to spawn \
         at all if the machine has none. Fix: run `pnpm prepare:runtime:{}`.",
        paths.node_dir,
        crate::embedded_runtime::platform_subdir()
    );
    crate::embedded_runtime::system_node_fallback()
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
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        command.env("PATH", embedded_path);
    }

    // serenorg/seren-desktop#1883 — local stdio MCP servers (playwright,
    // future bundled tools) are emitted by the provider runtime with
    // `command: "node"`. The Claude / Codex CLIs are compiled binaries that
    // resolve stdio MCP commands via libc execvp against their own minimal
    // PATH, so a bare "node" silently fails to spawn and the agent never
    // sees the tools. Expose the absolute embedded node binary so
    // `mcp-config.mjs` can rewrite `node` → absolute path before emitting
    // the per-CLI config JSON / TOML.
    command.env("SEREN_EMBEDDED_NODE_BIN", node_bin);

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

async fn check_provider_runtime_health_once(config: &ProviderRuntimeConfig) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(750))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let health_url = format!("{}/__seren/health", config.api_base_url);
    match client.get(&health_url).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| body.get("ok").and_then(|value| value.as_bool()))
            .unwrap_or(false),
        _ => false,
    }
}

/// Whether another restart fits in the budget.
fn restart_allowed(attempts: u32) -> bool {
    attempts < MAX_RESTART_ATTEMPTS
}

fn next_restart_attempt(attempts: u32) -> Option<u32> {
    restart_allowed(attempts).then_some(attempts + 1)
}

/// Whether a run that has lasted `spawned_at..now` has earned a fresh restart
/// budget. Once per process, so a runtime that is up for hours cannot bank
/// re-arms.
fn should_rearm(spawned_at: Instant, already_rearmed: bool, now: Instant) -> bool {
    !already_rearmed && now.duration_since(spawned_at) >= RESTART_REARM_UPTIME
}

/// Watches for provider runtime process death and attempts bounded auto-restart.
fn spawn_process_monitor(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let state = app.state::<ProviderRuntimeState>();
            let (exited, should_rearm_budget) = {
                let mut guard = state.process.lock().await;
                match guard.as_mut() {
                    None => break, // Process was intentionally stopped
                    Some(proc) => match proc.child.try_wait() {
                        Ok(None) => {
                            // Still running.
                            let rearm = should_rearm(
                                proc.spawned_at,
                                proc.restart_budget_rearmed,
                                Instant::now(),
                            );
                            if rearm {
                                proc.restart_budget_rearmed = true;
                            }
                            (false, rearm)
                        }
                        Ok(Some(status)) => {
                            log::warn!("[ProviderRuntime] Process exited unexpectedly: {}", status);
                            *guard = None;
                            (true, false)
                        }
                        Err(err) => {
                            log::warn!("[ProviderRuntime] Failed to check process status: {}", err);
                            (false, false)
                        }
                    },
                }
            };

            if should_rearm_budget {
                log::info!(
                    "[ProviderRuntime] Stable for {}s; re-arming the restart budget",
                    RESTART_REARM_UPTIME.as_secs()
                );
                state.rearm_restart_budget().await;
            }

            if exited {
                let Some(attempt) = state.claim_restart_attempt().await else {
                    log::error!(
                        "[ProviderRuntime] Crashed {} times, giving up",
                        MAX_RESTART_ATTEMPTS
                    );
                    crate::support::report_runtime_error(
                        &app,
                        "provider_runtime.crash_loop",
                        &format!(
                            "provider runtime crashed {} times; giving up",
                            MAX_RESTART_ATTEMPTS
                        ),
                    );
                    let _ = app.emit(
                        "provider-runtime://failed",
                        serde_json::json!({ "attempts": MAX_RESTART_ATTEMPTS }),
                    );
                    return;
                };

                log::info!(
                    "[ProviderRuntime] Restarting (attempt {}/{})",
                    attempt,
                    MAX_RESTART_ATTEMPTS
                );
                tokio::time::sleep(Duration::from_secs(2)).await;

                let state = app.state::<ProviderRuntimeState>();
                match state.ensure_started(&app).await {
                    Ok(_) => {
                        log::info!("[ProviderRuntime] Restarted successfully");
                        let _ = app.emit("provider-runtime://restarted", serde_json::json!({}));
                        // `ensure_started` aborted this task and stored a fresh
                        // monitor; that one inherits the budget from the state.
                        return;
                    }
                    Err(err) => {
                        // #2563: `ensure_started` has already exhausted its
                        // spawn attempts (including the fresh-port fallback),
                        // so this is unrecoverable. Surface it instead of
                        // looping back to a silent `break` on the now-empty
                        // process slot — otherwise the frontend never learns
                        // the agent runtime died.
                        log::error!("[ProviderRuntime] Restart failed: {}", err);
                        crate::support::report_runtime_error(
                            &app,
                            "provider_runtime.restart_failed",
                            &format!("provider runtime restart failed: {err}"),
                        );
                        let _ = app.emit(
                            "provider-runtime://failed",
                            serde_json::json!({ "attempts": attempt, "error": err }),
                        );
                        return;
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
    // The shutdown-guard check lives inside `ensure_started` so internal
    // Rust callers (orchestrator workers) cannot bypass it by skipping the
    // IPC layer. See #2240.
    state.ensure_started(&app).await
}

#[tauri::command]
pub async fn provider_runtime_stop(state: State<'_, ProviderRuntimeState>) -> Result<(), String> {
    if let Some(handle) = state.monitor_handle.lock().await.take() {
        handle.abort();
    }

    // An intentional stop is not a crash — the next start begins with a full
    // budget rather than inheriting whatever the last session spent.
    state.rearm_restart_budget().await;

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

/// Look up the parent PID of `pid` via the OS, or `None` if it can't be
/// determined (the process is gone or the query failed). Implemented with a
/// subprocess on every platform so the same code compiles and is testable
/// everywhere — this only runs on the rare force-kill escalation path.
fn parent_pid(pid: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        // `ps -o ppid= -p <pid>` prints just the parent PID (macOS + Linux).
        let output = match std::process::Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
        {
            Ok(output) => output,
            // A failure to run `ps` (not merely empty output for a dead PID)
            // means the ancestry guard can't verify and will refuse the kill —
            // log it so a silently-unstoppable agent is diagnosable. #2316
            Err(err) => {
                log::warn!("[ProviderRuntime] parent_pid: `ps` failed for pid={pid}: {err}");
                return None;
            }
        };
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .ok()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Win32_Process.ParentProcessId is the reliable parent-PID source.
        let script = format!(
            "(Get-CimInstance Win32_Process -Filter 'ProcessId={}').ParentProcessId",
            pid
        );
        let output = match std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
        {
            Ok(output) => output,
            Err(err) => {
                log::warn!(
                    "[ProviderRuntime] parent_pid: `powershell` failed for pid={pid}: {err}"
                );
                return None;
            }
        };
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        None
    }
}

/// True if `target` is a (proper) descendant of `ancestor`, found by walking
/// `target`'s parent chain. The walk is bounded to defend against PID-reuse
/// cycles, and stops at the kernel/init roots (PID 0/1).
fn is_descendant_of(target: u32, ancestor: u32) -> bool {
    let mut current = target;
    for _ in 0..64 {
        match parent_pid(current) {
            Some(parent) => {
                if parent == ancestor {
                    return true;
                }
                if parent == 0 || parent == 1 || parent == current {
                    return false;
                }
                current = parent;
            }
            None => return false,
        }
    }
    false
}

/// Force-kill the process tree rooted at `pid`. On Windows `taskkill /T` reaps
/// the whole tree; on unix we SIGKILL the agent process (its stdio children
/// exit on the closed pipes), matching `kill_sync`'s behavior.
fn force_kill_pid_tree(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
    }
}

/// Force-kill a single agent session's child process by PID, as the last-resort
/// escalation when the runtime's cooperative cancel/terminate RPCs are
/// unreachable. Returns `true` if the process was killed, `false` if the kill
/// was refused by the PID-reuse guard.
///
/// PID-reuse guard: the target must be a descendant of the managed provider
/// runtime. If the agent already exited and the OS reused its PID for an
/// unrelated process, that process is not under our runtime and is left
/// untouched. The runtime process itself is never a valid target.
#[tauri::command]
pub async fn provider_force_kill_session(
    state: State<'_, ProviderRuntimeState>,
    pid: u32,
) -> Result<bool, String> {
    let runtime_pid = {
        let guard = state.process.lock().await;
        guard.as_ref().and_then(|process| process.child.id())
    };
    let Some(runtime_pid) = runtime_pid else {
        log::warn!("[ProviderRuntime] force-kill refused for pid={pid}: runtime not running");
        return Ok(false);
    };

    if pid == runtime_pid {
        log::warn!(
            "[ProviderRuntime] force-kill refused: pid={pid} is the provider runtime itself"
        );
        return Ok(false);
    }

    if !is_descendant_of(pid, runtime_pid) {
        log::warn!(
            "[ProviderRuntime] force-kill refused: pid={pid} is not a descendant of provider runtime pid={runtime_pid} (possible PID reuse)"
        );
        return Ok(false);
    }

    log::info!(
        "[ProviderRuntime] force-killing agent session pid={pid} (runtime pid={runtime_pid})"
    );
    force_kill_pid_tree(pid);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command as TokioCommand;

    /// Regression guard for #3156.
    ///
    /// Every successful restart goes through `ensure_started`, which aborts
    /// the current monitor and spawns a fresh one. While the counter lived in
    /// the monitor task, each new monitor started from zero, so the give-up
    /// check could never fire and a runtime that died every few seconds
    /// respawned node forever with nothing logged and no `failed` event.
    ///
    /// Drive the budget the way successive monitor generations do — one claim
    /// per generation — and assert it runs out.
    #[tokio::test]
    async fn restart_budget_survives_monitor_respawn() {
        let state = ProviderRuntimeState::new();

        let mut restarts = 0_u32;
        while state.claim_restart_attempt().await.is_some() {
            restarts += 1;
            assert!(
                restarts <= MAX_RESTART_ATTEMPTS,
                "restart budget is unbounded: granted {restarts} restarts across monitor \
                 generations with MAX_RESTART_ATTEMPTS={MAX_RESTART_ATTEMPTS} (#3156)"
            );
        }

        assert_eq!(restarts, MAX_RESTART_ATTEMPTS);
        assert!(state.claim_restart_attempt().await.is_none());
    }

    /// A runtime that proves it can stay up earns its budget back, so a
    /// crash weeks into a session is not judged against restarts from
    /// startup. Once per process — a long-lived runtime cannot bank re-arms.
    #[tokio::test]
    async fn stable_uptime_rearms_the_restart_budget() {
        let state = ProviderRuntimeState::new();
        assert!(state.claim_restart_attempt().await.is_some());
        assert!(state.claim_restart_attempt().await.is_some());

        state.rearm_restart_budget().await;

        let mut restarts = 0_u32;
        while state.claim_restart_attempt().await.is_some() {
            restarts += 1;
            assert!(
                restarts <= MAX_RESTART_ATTEMPTS,
                "re-arming must restore the budget, not remove it: granted {restarts} \
                 restarts with MAX_RESTART_ATTEMPTS={MAX_RESTART_ATTEMPTS}"
            );
        }
        assert_eq!(restarts, MAX_RESTART_ATTEMPTS);
    }

    #[test]
    fn rearm_needs_sustained_uptime_and_happens_once() {
        let spawned_at = Instant::now();

        assert!(!should_rearm(
            spawned_at,
            false,
            spawned_at + Duration::from_secs(59)
        ));
        assert!(should_rearm(
            spawned_at,
            false,
            spawned_at + RESTART_REARM_UPTIME
        ));
        assert!(!should_rearm(
            spawned_at,
            true,
            spawned_at + Duration::from_secs(3600)
        ));
    }

    #[test]
    fn config_with_port_rebinds_without_rotating_token() {
        let prev =
            build_provider_runtime_config("127.0.0.1".to_string(), 50401, "tok-abc".to_string());
        let next = config_with_port(&prev, 51999);
        // The port and its derived URLs move to the fresh port...
        assert_eq!(next.port, 51999);
        assert_eq!(next.api_base_url, "http://127.0.0.1:51999");
        assert_eq!(next.ws_base_url, "ws://127.0.0.1:51999");
        // ...but the host and auth token are preserved so a client holding the
        // prior token can re-authenticate against the rebound port (#2563).
        assert_eq!(next.host, "127.0.0.1");
        assert_eq!(next.token, "tok-abc");
    }

    #[test]
    fn force_kill_guard_only_matches_descendants() {
        let me = std::process::id();
        // Spawn a real, short-lived child of this test process.
        #[cfg(unix)]
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn child");
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1"])
            .spawn()
            .expect("spawn child");
        let child_pid = child.id();

        // The spawned child's parent is this test process, so it is a
        // descendant of it — the guard would permit killing it.
        assert_eq!(parent_pid(child_pid), Some(me));
        assert!(
            is_descendant_of(child_pid, me),
            "spawned child must be a descendant of this process"
        );
        // An unrelated root process (init/launchd, PID 1) is NOT our
        // descendant — the guard must refuse it.
        assert!(
            !is_descendant_of(1, me),
            "PID 1 must not be a descendant of the test process"
        );
        // A process is not a descendant of itself, so the runtime PID can
        // never be force-killed as if it were one of its own sessions.
        assert!(!is_descendant_of(me, me));

        let _ = child.kill();
        let _ = child.wait();
    }

    /// Build a stub child process that exits instantly with the requested
    /// code/signal so `wait_for_provider_runtime_with_deadline` can exercise
    /// its child-exit path without a real node runtime. Used by the retry
    /// tests below.
    async fn spawn_exiting_child(exit_code: u8) -> Child {
        let mut command = test_shell_command(&format!("exit {}", exit_code));
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn exiting child")
    }

    /// Build a child that runs for longer than the readiness deadline, so
    /// the wait loop exits via the timeout branch. We use `sleep 10` which
    /// outlives our 200ms test deadline without tying up system resources.
    async fn spawn_hanging_child() -> Child {
        let mut command = test_shell_command(test_sleep_command());
        command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleeping child")
    }

    #[cfg(windows)]
    fn test_shell_command(script: &str) -> TokioCommand {
        let mut command = TokioCommand::new("powershell");
        command.arg("-NoProfile").arg("-Command").arg(script);
        command
    }

    #[cfg(not(windows))]
    fn test_shell_command(script: &str) -> TokioCommand {
        let mut command = TokioCommand::new("sh");
        command.arg("-c").arg(script);
        command
    }

    #[cfg(windows)]
    fn test_sleep_command() -> &'static str {
        "Start-Sleep -Seconds 10"
    }

    #[cfg(not(windows))]
    fn test_sleep_command() -> &'static str {
        "sleep 10"
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

    #[test]
    fn startup_config_reuses_existing_port_and_token() {
        let existing = build_provider_runtime_config(
            "127.0.0.1".to_string(),
            51908,
            "existing-token".to_string(),
        );

        let reused = startup_config_for_host("127.0.0.1", Some(&existing)).expect("reused config");

        assert_eq!(reused.port, existing.port);
        assert_eq!(reused.token, existing.token);
        assert_eq!(reused.api_base_url, "http://127.0.0.1:51908");
        assert_eq!(reused.ws_base_url, "ws://127.0.0.1:51908");
    }

    #[tokio::test]
    async fn cached_health_check_rejects_dead_port() {
        let config = dummy_config();
        assert!(
            !check_provider_runtime_health_once(&config).await,
            "a cached config for a dead port must not be reused"
        );
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
        let err =
            wait_for_provider_runtime_with_deadline(&config, &mut child, Duration::from_secs(2))
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
        assert!(
            err.contains("0s") || err.contains("after"),
            "err should mention budget: {err}"
        );
        // Use start_kill here too — see test below for why.
        let _ = child.start_kill();
        drop(child);
    }

    /// Regression guard (GH #1587 post-merge field-observed hang):
    /// `Child::kill().await` sends SIGKILL *and awaits the child's wait
    /// status*. On a hung subprocess that await never returns, which in
    /// the retry loop blocks attempt 2 from ever spawning.
    ///
    /// `start_kill()` is the non-blocking variant and is what the retry
    /// loop uses. This test proves it completes in <100ms even on a
    /// long-running child so the loop can advance deterministically.
    #[tokio::test]
    async fn start_kill_does_not_block_on_long_running_child() {
        let mut child = spawn_hanging_child().await;
        let t0 = std::time::Instant::now();
        tokio::time::timeout(Duration::from_millis(100), async { child.start_kill() })
            .await
            .expect("start_kill must not block")
            .expect("start_kill returned err");
        drop(child);
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "start_kill should be near-instant, took {:?}",
            t0.elapsed()
        );
    }

    /// #2240: the shutdown-guard check must live inside `ensure_started`,
    /// not at the IPC layer, so internal Rust callers (orchestrator workers
    /// that call `ensure_started` directly without going through the
    /// `provider_runtime_get_config` command) cannot bypass it during the
    /// updater's install window. We test the guard predicate against a
    /// mock-runtime AppHandle here — the same predicate is the gate that
    /// `ensure_started` calls in production.
    #[test]
    fn is_update_in_progress_is_true_when_managed_guard_engaged() {
        use std::sync::Arc;

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");

        assert!(
            !super::is_update_in_progress(app.handle()),
            "no guard managed yet"
        );

        let shutdown_guard = Arc::new(crate::commands::updater::ShutdownGuard::default());
        app.manage(shutdown_guard.clone());
        assert!(
            !super::is_update_in_progress(app.handle()),
            "guard present but not engaged"
        );

        shutdown_guard.engage();
        assert!(
            super::is_update_in_progress(app.handle()),
            "guard engaged must surface as in-progress"
        );

        shutdown_guard.release();
        assert!(
            !super::is_update_in_progress(app.handle()),
            "released guard must surface as not-in-progress so the user can keep using the app"
        );
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
