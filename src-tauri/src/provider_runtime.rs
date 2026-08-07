// ABOUTME: Supervises the local Node-based provider runtime used by desktop-native mode.
// ABOUTME: Starts the bundled runtime on localhost and returns connection config to the frontend.

use serde::Serialize;
use std::borrow::Cow;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, BufReader};
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

/// Exit-time kill: attempts × delay bounds how long `kill_sync` may block the
/// RunEvent::Exit handler while waiting out a transient hold on the process
/// lock (the monitor loop takes it every 5s).
const KILL_LOCK_ATTEMPTS: u32 = 20;
const KILL_LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);

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
    output_health: Arc<ChildOutputHealth>,
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
        let runtime_entry = find_provider_runtime_mjs(app)?;

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

            let output_health = pipe_child_output(&mut child, &config.token);

            match wait_for_provider_runtime_with_deadline(&config, &mut child, *deadline).await {
                Ok(()) => {
                    *guard = Some(ProviderRuntimeProcess {
                        child,
                        config: config.clone(),
                        spawned_at: Instant::now(),
                        restart_budget_rearmed: false,
                        output_health,
                    });
                    drop(guard);
                    *self.last_config.lock().await = Some(config.clone());

                    // Ordering constraint (#3698): the old monitor can be THIS
                    // task (self-restart via spawn_process_monitor →
                    // ensure_started). Abort cancels the current task at its
                    // next yield point, so nothing after the abort is
                    // guaranteed to run — the new handle must be stored and
                    // readiness emitted first. The abort itself must still
                    // happen, or the replaced monitor keeps polling alongside
                    // the new one.
                    let monitor = spawn_process_monitor(app.clone());
                    let old_monitor = self.monitor_handle.lock().await.replace(monitor);

                    // Notify the frontend that the runtime is up. The
                    // agent store subscribes to this event and re-runs
                    // `getAvailableAgents` — this unblocks the Codex /
                    // Gemini buttons even when first-attempt readiness
                    // exceeds the store's initial-query backoff budget.
                    let _ = app.emit("provider-runtime://ready", &config);

                    if let Some(old_monitor) = old_monitor {
                        old_monitor.abort();
                    }

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

        // A single `try_lock` can lose the race against the monitor loop,
        // which takes this lock every 5s. Tauri exits via `process::exit`,
        // skipping `Drop`/`kill_on_drop`, so a silently missed kill orphans
        // the runtime and every agent child under it (#3699). Bounded retries
        // keep RunEvent::Exit from hanging while closing the window.
        let mut process_guard = None;
        for _ in 0..KILL_LOCK_ATTEMPTS {
            if let Ok(guard) = self.process.try_lock() {
                process_guard = Some(guard);
                break;
            }
            std::thread::sleep(KILL_LOCK_RETRY_DELAY);
        }
        let Some(mut guard) = process_guard else {
            log::warn!(
                "[ProviderRuntime] Could not acquire process lock on exit; runtime process (pid unknown — lock held) may be orphaned"
            );
            return;
        };
        if let Some(ref process) = *guard {
            if let Some(pid) = process.child.id() {
                log::info!("[ProviderRuntime] Killing process on exit: pid={}", pid);
                #[cfg(unix)]
                unsafe {
                    // The child was spawned with process_group(0), so pid ==
                    // pgid: killpg reaps the runtime's agent grandchildren
                    // (claude/codex CLIs) that a single kill(pid) would
                    // orphan past app exit (#3700). Fall back to the lone
                    // pid when killpg fails (e.g. the group is already gone).
                    if libc::killpg(pid as libc::pid_t, libc::SIGKILL) != 0 {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
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

/// Candidate locations for provider-runtime.mjs, in probe order.
///
/// The resource-dir candidates come first: Tauri's resource resolver is the
/// only source that knows the Linux install layout (`exe_dir/../lib/<app>`
/// for deb/rpm, `$APPDIR/usr/lib/<app>` for AppImage, `/usr/lib/<app>` for a
/// system install — #3434). On macOS it resolves to `exe_dir/../Resources`,
/// on Windows and in dev to `exe_dir` itself — directories the exe-relative
/// candidates below already probe, so their behavior is unchanged. The
/// exe-relative and dev candidates remain as fallback for when the resolver
/// errors.
fn provider_runtime_mjs_candidates(
    exe_dir: &Path,
    resource_dir: Option<&Path>,
    platform_subdir: &str,
) -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(7);
    if let Some(resource_dir) = resource_dir {
        candidates.push(
            resource_dir
                .join("embedded-runtime")
                .join(platform_subdir)
                .join("provider-runtime")
                .join("provider-runtime.mjs"),
        );
        candidates.push(
            resource_dir
                .join("embedded-runtime")
                .join("provider-runtime")
                .join("provider-runtime.mjs"),
        );
    }
    candidates.extend([
        exe_dir
            .join("../Resources/embedded-runtime")
            .join(platform_subdir)
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        exe_dir
            .join("../Resources/embedded-runtime")
            .join("provider-runtime")
            .join("provider-runtime.mjs"),
        exe_dir
            .join("embedded-runtime")
            .join(platform_subdir)
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
    ]);
    candidates
}

fn find_provider_runtime_mjs(app: &AppHandle) -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|err| format!("Failed to get current exe path: {}", err))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get exe directory".to_string())?;
    let platform_subdir = crate::embedded_runtime::platform_subdir();
    let resource_dir = app.path().resource_dir().ok();

    let candidates =
        provider_runtime_mjs_candidates(exe_dir, resource_dir.as_deref(), &platform_subdir);

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

/// Node 24 cannot execute a script whose argv entrypoint uses Windows'
/// verbatim `\\?\` prefix: it collapses `\\?\D:\...` to `D:` and exits with
/// EISDIR before loading the runtime. Rust and Tauri may return that prefix
/// from `current_exe`/resource resolution, so remove it only at the Node
/// process boundary. Preserve ordinary paths and device/volume namespaces;
/// translate verbatim UNC paths to their equivalent ordinary UNC form.
fn node_compatible_path(path: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    if let Some(raw_path) = path.to_str() {
        if let Some(normalized) = strip_node_unsupported_windows_verbatim_prefix(raw_path) {
            return Cow::Owned(PathBuf::from(normalized));
        }
    }

    Cow::Borrowed(path)
}

#[cfg(any(windows, test))]
fn strip_node_unsupported_windows_verbatim_prefix(path: &str) -> Option<String> {
    const VERBATIM_PREFIX: &str = r"\\?\";
    const VERBATIM_UNC_PREFIX: &str = r"\\?\UNC\";

    if path
        .get(..VERBATIM_UNC_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(VERBATIM_UNC_PREFIX))
    {
        let network_path = path.get(VERBATIM_UNC_PREFIX.len()..)?;
        return Some(format!(r"\\{network_path}"));
    }

    let local_path = path.strip_prefix(VERBATIM_PREFIX)?;
    let bytes = local_path.as_bytes();
    let is_drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    is_drive_absolute.then(|| local_path.to_string())
}

fn spawn_node_process(
    node_bin: &std::path::Path,
    runtime_entry: &std::path::Path,
    host: &str,
    port: u16,
    token: &str,
) -> Result<Child, String> {
    let runtime_entry_for_node = node_compatible_path(runtime_entry);
    let mut command = Command::new(node_bin);
    command
        .arg(&*runtime_entry_for_node)
        .arg("--host")
        .arg(host)
        .arg("--port")
        .arg(port.to_string())
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // serenorg/seren-desktop#3442 — the WS auth token rides an env var, never
    // argv: argv is readable via `ps` by every local user, which defeats the
    // point of authenticating the localhost socket.
    command.env("SEREN_PROVIDER_RUNTIME_TOKEN", token);

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    #[cfg(unix)]
    {
        // Own process group so the exit-time `kill_sync` can killpg the whole
        // agent tree (#3700): the runtime spawns CLI grandchildren that a
        // single SIGKILL to the runtime pid would orphan past app quit.
        command.process_group(0);
    }

    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        command.env("PATH", embedded_path);
    }

    // Validation may need the operator's installed CLI credentials and model
    // catalogs, but the Tauri process itself must retain its scratch HOME so
    // app data and Keychain access stay hermetic. Scope the override to the
    // provider runtime process, whose agent subprocesses inherit it.
    if let Some(cli_home) = validation_cli_home_override(
        std::env::var_os("SEREN_VALIDATION_INSTANCE"),
        std::env::var_os("SEREN_VALIDATION_CLI_HOME"),
    ) {
        command.env("HOME", &cli_home);
        #[cfg(windows)]
        command.env("USERPROFILE", &cli_home);
    }

    // serenorg/seren-desktop#1883 — local stdio MCP servers (playwright,
    // future bundled tools) are emitted by the provider runtime with
    // `command: "node"`. The Claude / Codex CLIs are compiled binaries that
    // resolve stdio MCP commands via libc execvp against their own minimal
    // PATH, so a bare "node" silently fails to spawn and the agent never
    // sees the tools. Expose the absolute embedded node binary so
    // `mcp-config.mjs` can rewrite `node` → absolute path before emitting
    // the per-CLI config JSON / TOML.
    let node_bin_for_runtime = node_compatible_path(node_bin);
    command.env("SEREN_EMBEDDED_NODE_BIN", &*node_bin_for_runtime);

    // serenorg/seren-desktop#3230 — a bounded agent's launch spec is produced by
    // this binary's `__seren-sandbox-spec` subcommand, not by whichever caller
    // issued provider_spawn. Without this path the runtime has no trusted source
    // for the spec and every bounded launch fails closed.
    match std::env::current_exe() {
        Ok(app_binary) => {
            let app_binary_for_runtime = node_compatible_path(&app_binary);
            command.env("SEREN_SANDBOX_SPEC_BIN", &*app_binary_for_runtime);
        }
        Err(err) => {
            log::error!(
                "[ProviderRuntime] Could not resolve the app binary for sandbox specs: {}",
                err
            );
        }
    }

    crate::embedded_runtime::sanitize_spawn_env(&mut command);

    command
        .spawn()
        .map_err(|err| format!("Failed to spawn provider runtime: {err}"))
}

fn validation_cli_home_override(
    validation_instance: Option<OsString>,
    configured_home: Option<OsString>,
) -> Option<PathBuf> {
    if validation_instance.as_deref() != Some(std::ffi::OsStr::new("1")) {
        return None;
    }
    configured_home
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// Which of the child's two output pipes a reader task is draining.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildChannel {
    Stdout,
    Stderr,
}

impl ChildChannel {
    fn label(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

/// Per-channel liveness counters, written by the reader task and read by the
/// runtime monitor. A child must never be able to silence its own diagnostic
/// channel without that showing up somewhere (#3728).
#[derive(Debug, Default)]
struct ChannelActivity {
    lines: AtomicU64,
    /// Bytes currently held in an unterminated line. A channel parked here for
    /// a long stretch is the exact signature of the framing bug this replaced.
    pending_bytes: AtomicU64,
    pending_since_ms: AtomicU64,
    truncated_lines: AtomicU64,
    closed: AtomicBool,
    /// EOF or I/O error, recorded once so the monitor can report it against
    /// child liveness (which only the monitor knows).
    close_reason: std::sync::Mutex<Option<String>>,
    stall_reported: AtomicBool,
}

/// Shared handle to both channels' liveness, held by the runtime process record
/// so the monitor loop can supervise the readers.
#[derive(Debug)]
struct ChildOutputHealth {
    started: Instant,
    stdout: ChannelActivity,
    stderr: ChannelActivity,
}

impl ChildOutputHealth {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            stdout: ChannelActivity::default(),
            stderr: ChannelActivity::default(),
        }
    }

    fn channel(&self, channel: ChildChannel) -> &ChannelActivity {
        match channel {
            ChildChannel::Stdout => &self.stdout,
            ChildChannel::Stderr => &self.stderr,
        }
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// A single child output line is capped here. Past the cap the reader emits
/// what it has with an explicit truncation marker and resynchronises at the
/// next newline.
///
/// `BufReader::lines()` had no such cap: one newline-free write parked the
/// reader in an ever-growing internal buffer and every following line was
/// absorbed into that pending line and never logged — no EOF, no error, no log
/// entry, and unbounded parent memory growth. #3728.
const MAX_CHILD_LINE_BYTES: usize = 64 * 1024;

/// Read size for draining a child pipe.
const CHILD_READ_CHUNK_BYTES: usize = 16 * 1024;

/// How long a channel may hold an unterminated line before the monitor calls it
/// out. Real lines complete in microseconds, so this only fires on a genuinely
/// pathological child — no false positives from a legitimately quiet channel.
const CHILD_LINE_STALL_THRESHOLD: Duration = Duration::from_secs(60);

/// Splits a byte stream into log lines with a hard per-line ceiling.
///
/// Holds only raw bytes between chunks, so a read boundary falling inside a
/// multi-byte character is harmless; decoding happens once per completed line
/// and is lossy, so one bad byte degrades a single line instead of killing the
/// channel.
#[derive(Debug, Default)]
struct LineFramer {
    pending: Vec<u8>,
    dropped: usize,
    dropped_reported: usize,
    overflowed: bool,
    truncated_lines: u64,
}

impl LineFramer {
    /// Feeds a chunk, appending every emitted line to `out`.
    fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        let mut rest = chunk;
        while let Some(idx) = rest.iter().position(|byte| *byte == b'\n') {
            let (head, tail) = rest.split_at(idx);
            self.absorb(head, out);
            self.end_line(out);
            rest = &tail[1..];
        }
        self.absorb(rest, out);
    }

    /// Flushes a trailing unterminated line at EOF.
    fn finish(&mut self, out: &mut Vec<String>) {
        if !self.pending.is_empty() || self.overflowed {
            self.end_line(out);
        }
    }

    fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Buffers up to the cap, then emits **immediately**.
    ///
    /// Emitting here rather than at the next newline is the whole fix: a child
    /// that writes without ever terminating a line can no longer keep the
    /// channel dark, because output stops depending on the child's cooperation.
    fn absorb(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        if bytes.is_empty() {
            return;
        }
        if self.overflowed {
            self.dropped += bytes.len();
            // Report progress while discarding, so a child that never writes
            // another newline still cannot leave the channel silent. One line
            // per cap's worth of dropped bytes bounds the log volume.
            if self.dropped - self.dropped_reported >= MAX_CHILD_LINE_BYTES {
                self.dropped_reported = self.dropped;
                out.push(format!(
                    "…[still discarding an oversized line: {} bytes dropped]",
                    self.dropped
                ));
            }
            return;
        }
        let room = MAX_CHILD_LINE_BYTES - self.pending.len();
        if bytes.len() < room {
            self.pending.extend_from_slice(bytes);
            return;
        }
        self.pending.extend_from_slice(&bytes[..room]);
        let mut text = self.take_pending();
        text.push_str(&format!(
            " …[truncated at {MAX_CHILD_LINE_BYTES} bytes, resynchronising]"
        ));
        out.push(text);
        self.truncated_lines += 1;
        self.overflowed = true;
        self.dropped = bytes.len() - room;
    }

    /// Closes the current line at a newline (or at EOF).
    fn end_line(&mut self, out: &mut Vec<String>) {
        if self.overflowed {
            out.push(format!(
                "…[dropped {} bytes before the next line break]",
                self.dropped
            ));
            self.pending.clear();
            self.dropped = 0;
            self.dropped_reported = 0;
            self.overflowed = false;
            return;
        }
        out.push(self.take_pending());
    }

    fn take_pending(&mut self) -> String {
        let mut text = String::from_utf8_lossy(&self.pending).into_owned();
        // Children on Windows terminate with CRLF; keep the log free of stray CR.
        if text.ends_with('\r') {
            text.pop();
        }
        self.pending.clear();
        text
    }
}

fn pipe_child_output(child: &mut Child, ws_token: &str) -> Arc<ChildOutputHealth> {
    let health = Arc::new(ChildOutputHealth::new());

    if let Some(stdout) = child.stdout.take() {
        spawn_channel_reader(
            stdout,
            ChildChannel::Stdout,
            ws_token.to_string(),
            Arc::clone(&health),
        );
    }

    if let Some(stderr) = child.stderr.take() {
        spawn_channel_reader(
            stderr,
            ChildChannel::Stderr,
            ws_token.to_string(),
            Arc::clone(&health),
        );
    }

    health
}

fn spawn_channel_reader<R>(
    source: R,
    channel: ChildChannel,
    ws_token: String,
    health: Arc<ChildOutputHealth>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let close_reason = drain_child_channel(source, channel, &health, |line| {
            let redacted = redact_provider_child_output(&line, &ws_token);
            match channel {
                ChildChannel::Stdout => log::info!("[ProviderRuntime stdout] {}", redacted),
                ChildChannel::Stderr => log::warn!("[ProviderRuntime stderr] {}", redacted),
            }
        })
        .await;

        let activity = health.channel(channel);
        activity.closed.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = activity.close_reason.lock() {
            *slot = Some(close_reason.clone());
        }
        // The reader task cannot tell whether the child is still alive; the
        // monitor can, and escalates from there. Log loudly either way — a
        // channel ending is never routine while the app is running.
        log::error!(
            "[ProviderRuntime {}] Output capture ended ({}) after {} lines",
            channel.label(),
            close_reason,
            activity.lines.load(Ordering::Relaxed),
        );
    });
}

/// Drains one child pipe through the framer, handing every completed line to
/// `on_line`, and returns why the channel ended.
///
/// Only genuine EOF or a real I/O error can end this loop — an oversized or
/// non-UTF-8 line degrades a single line and the channel keeps delivering.
async fn drain_child_channel<R, F>(
    source: R,
    channel: ChildChannel,
    health: &ChildOutputHealth,
    mut on_line: F,
) -> String
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(String),
{
    let mut reader = BufReader::new(source);
    let mut framer = LineFramer::default();
    let mut chunk = vec![0_u8; CHILD_READ_CHUNK_BYTES];
    let mut lines: Vec<String> = Vec::new();

    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => {
                framer.finish(&mut lines);
                emit_channel_lines(channel, &mut lines, &framer, health, &mut on_line);
                record_pending(health, channel, 0);
                return "EOF".to_string();
            }
            Ok(read) => {
                framer.push(&chunk[..read], &mut lines);
                emit_channel_lines(channel, &mut lines, &framer, health, &mut on_line);
                record_pending(health, channel, framer.pending_len());
            }
            Err(err) => {
                framer.finish(&mut lines);
                emit_channel_lines(channel, &mut lines, &framer, health, &mut on_line);
                record_pending(health, channel, 0);
                return format!("read error: {err}");
            }
        }
    }
}

fn emit_channel_lines<F>(
    channel: ChildChannel,
    lines: &mut Vec<String>,
    framer: &LineFramer,
    health: &ChildOutputHealth,
    on_line: &mut F,
) where
    F: FnMut(String),
{
    if lines.is_empty() {
        return;
    }
    let activity = health.channel(channel);
    activity
        .truncated_lines
        .store(framer.truncated_lines, Ordering::Relaxed);
    for line in lines.drain(..) {
        on_line(line);
        activity.lines.fetch_add(1, Ordering::Relaxed);
    }
    activity.stall_reported.store(false, Ordering::Relaxed);
}

fn record_pending(health: &ChildOutputHealth, channel: ChildChannel, pending: usize) {
    let activity = health.channel(channel);
    let previous = activity.pending_bytes.swap(pending as u64, Ordering::Relaxed);
    if pending == 0 {
        activity.pending_since_ms.store(0, Ordering::Relaxed);
    } else if previous == 0 {
        activity
            .pending_since_ms
            .store(health.now_ms(), Ordering::Relaxed);
    }
}

/// Child-process output reaches the desktop log verbatim unless it is scrubbed
/// here. Resolve the current runtime environment at capture time so newly
/// issued session leases and future Seren secret variables are covered too.
/// The WS auth token is scrubbed by value (#3442): it lives only in the child
/// environment, so the parent-env scan below cannot see it, yet the runtime or
/// one of its children could still echo it into a logged line.
fn redact_provider_child_output(line: &str, ws_token: &str) -> String {
    let runtime_secret_values = provider_secret_env_snapshot();
    redact_provider_child_output_with_values(
        line,
        runtime_secret_values
            .iter()
            .cloned()
            .chain(std::iter::once(ws_token.to_string())),
    )
}

/// Rebuilding the secret list per line meant a full environment walk on the
/// hottest path in this file, and `std::env::vars()` panics on non-UTF-8
/// environment content — a panic there killed the capture task silently, which
/// is indistinguishable from the framing bug it sat next to (#3728).
///
/// Snapshot instead, and refresh on a short interval so a newly issued session
/// lease is still covered without paying for a scan per line. `vars_os` with
/// lossy conversion cannot panic.
fn provider_secret_env_snapshot() -> Arc<Vec<String>> {
    const SNAPSHOT_MAX_AGE: Duration = Duration::from_secs(1);
    static SNAPSHOT: OnceLock<std::sync::RwLock<(Instant, Arc<Vec<String>>)>> = OnceLock::new();

    let cell = SNAPSHOT.get_or_init(|| {
        std::sync::RwLock::new((
            Instant::now()
                .checked_sub(SNAPSHOT_MAX_AGE)
                .unwrap_or_else(Instant::now),
            Arc::new(Vec::new()),
        ))
    });

    if let Ok(guard) = cell.read()
        && guard.0.elapsed() < SNAPSHOT_MAX_AGE
    {
        return Arc::clone(&guard.1);
    }

    let values: Vec<String> = std::env::vars_os()
        .filter_map(|(name, value)| {
            is_seren_secret_env_name(&name.to_string_lossy())
                .then(|| value.to_string_lossy().into_owned())
        })
        .filter(|value| !value.is_empty())
        .collect();
    let snapshot = Arc::new(values);

    if let Ok(mut guard) = cell.write() {
        *guard = (Instant::now(), Arc::clone(&snapshot));
    }
    snapshot
}

fn is_seren_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("SEREN_")
        && (upper.ends_with("KEY") || upper.ends_with("TOKEN") || upper.ends_with("SECRET"))
}

fn redact_provider_child_output_with_values(
    line: &str,
    runtime_secret_values: impl IntoIterator<Item = String>,
) -> String {
    let mut redacted = line.to_string();
    for secret in runtime_secret_values {
        if !secret.is_empty() {
            redacted = redacted.replace(&secret, "[REDACTED]");
        }
    }
    // API-key values are only shown once by the Gateway but may still be
    // echoed by a misbehaving child. This format catches the active lease even
    // when it never appears in the provider-runtime parent environment.
    // Compiled once, not per log line (this runs for every child stdout/stderr
    // line): a per-line Regex::new was needless work on a hot path (#3350).
    SEREN_API_KEY_PATTERN
        .replace_all(&redacted, "[REDACTED]")
        .into_owned()
}

/// Shape of a leased Seren API key echoed by a misbehaving child. Deliberately
/// broad — over-redacting a benign identifier in a log is noise, never a leak.
static SEREN_API_KEY_PATTERN: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"seren_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+")
            .expect("static Seren API-key pattern compiles")
    });

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

/// Reports output-capture anomalies on a runtime child that is still alive.
///
/// A live child with a dead or parked diagnostic channel looks perfectly
/// healthy to `try_wait` and to the HTTP health endpoint, which is how #3728
/// stayed invisible for 8.5 hours. Each anomaly is reported once per channel
/// until that channel produces again, so a persistent condition cannot spam
/// the log it is trying to protect.
fn collect_output_channel_anomalies(health: &ChildOutputHealth) -> Vec<String> {
    let mut anomalies = Vec::new();
    for channel in [ChildChannel::Stdout, ChildChannel::Stderr] {
        let activity = health.channel(channel);
        if activity.stall_reported.load(Ordering::Relaxed) {
            continue;
        }

        if activity.closed.load(Ordering::Relaxed) {
            let reason = activity
                .close_reason
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .unwrap_or_else(|| "unknown".to_string());
            activity.stall_reported.store(true, Ordering::Relaxed);
            anomalies.push(format!(
                "{} capture ended ({}) while the runtime child is still alive; \
                 diagnostics from this channel are being lost",
                channel.label(),
                reason,
            ));
            continue;
        }

        let pending = activity.pending_bytes.load(Ordering::Relaxed);
        if pending == 0 {
            continue;
        }
        let since = activity.pending_since_ms.load(Ordering::Relaxed);
        let held = health.now_ms().saturating_sub(since);
        if Duration::from_millis(held) >= CHILD_LINE_STALL_THRESHOLD {
            activity.stall_reported.store(true, Ordering::Relaxed);
            anomalies.push(format!(
                "{} has held {} bytes of an unterminated line for {}s",
                channel.label(),
                pending,
                held / 1000,
            ));
        }
    }
    anomalies
}

/// Watches for provider runtime process death and attempts bounded auto-restart.
fn spawn_process_monitor(app: AppHandle) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let state = app.state::<ProviderRuntimeState>();
            let mut output_anomalies: Vec<String> = Vec::new();
            let (exited, should_rearm_budget) = {
                let mut guard = state.process.lock().await;
                match guard.as_mut() {
                    None => break, // Process was intentionally stopped
                    Some(proc) => match proc.child.try_wait() {
                        Ok(None) => {
                            // Still running.
                            output_anomalies =
                                collect_output_channel_anomalies(&proc.output_health);
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

            for anomaly in &output_anomalies {
                log::error!("[ProviderRuntime] {}", anomaly);
                crate::support::report_runtime_error(
                    &app,
                    "provider_runtime.output_channel_lost",
                    anomaly,
                );
            }

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
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command as TokioCommand;

    #[test]
    fn node_entrypoint_strips_local_windows_verbatim_prefix() {
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(
                r"\\?\D:\a\seren-desktop\provider-runtime.mjs",
            ),
            Some(r"D:\a\seren-desktop\provider-runtime.mjs".to_string()),
        );
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(
                r"D:\a\seren-desktop\provider-runtime.mjs",
            ),
            None,
        );
    }

    #[test]
    fn node_entrypoint_normalizes_unc_without_touching_device_namespaces() {
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(
                r"\\?\UNC\server\share\provider-runtime.mjs",
            ),
            Some(r"\\server\share\provider-runtime.mjs".to_string()),
        );
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(r"\\server\share\provider-runtime.mjs",),
            None,
        );
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(r"\\.\PIPE\seren"),
            None,
        );
        assert_eq!(
            strip_node_unsupported_windows_verbatim_prefix(
                r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\provider-runtime.mjs",
            ),
            None,
        );
    }

    #[test]
    fn validation_cli_home_is_scoped_to_validation_provider_runtime() {
        let host_home = OsString::from("/host-cli-home");

        assert_eq!(
            validation_cli_home_override(Some(OsString::from("1")), Some(host_home.clone()),),
            Some(PathBuf::from(host_home)),
        );
        assert_eq!(
            validation_cli_home_override(
                Some(OsString::from("0")),
                Some(OsString::from("/host-cli-home")),
            ),
            None,
        );
        assert_eq!(
            validation_cli_home_override(Some(OsString::from("1")), Some(OsString::new())),
            None,
        );
    }

    #[test]
    fn child_output_redacts_runtime_secret_values_and_lease_shape() {
        let lease_shape = ["seren", "shape", "value"].join("_");
        let redacted = redact_provider_child_output_with_values(
            &format!("env=canary-session-secret lease={lease_shape}"),
            vec!["canary-session-secret".to_string()],
        );
        assert!(!redacted.contains("canary-session-secret"));
        assert!(!redacted.contains(&lease_shape));
        assert_eq!(redacted.matches("[REDACTED]").count(), 2);
    }

    /// #3442: the WS auth token is random hex, so the `seren_*` lease pattern
    /// and the parent-env scan both miss it. It must be scrubbed by value
    /// wherever it appears in a child output line.
    #[test]
    fn child_output_redacts_ws_auth_token_value() {
        let token = "0f0e0d0c0b0a09080706050403020100aabbccdd";
        let redacted = redact_provider_child_output(
            &format!(r#"{{"ok":true,"host":"127.0.0.1","port":4317,"token":"{token}"}}"#),
            token,
        );
        assert!(!redacted.contains(token));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.contains("\"port\":4317"));
    }

    /// An empty secret value (e.g. an unset token) must not corrupt the line
    /// with zero-width replacements.
    #[test]
    fn child_output_with_empty_secret_value_is_untouched() {
        let line = "plain runtime chatter";
        assert_eq!(
            redact_provider_child_output_with_values(line, vec![String::new()]),
            line
        );
    }

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

    /// #3699: `kill_sync` runs in RunEvent::Exit, where a single failed
    /// `try_lock` used to skip the kill silently — the monitor loop takes the
    /// same lock every 5s, and a missed kill orphans the runtime past app
    /// exit. The bounded retry must wait out a transient hold and still kill.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_sync_waits_out_a_transient_process_lock_hold() {
        let state = std::sync::Arc::new(ProviderRuntimeState::new());
        let child = spawn_hanging_child().await;
        *state.process.lock().await = Some(ProviderRuntimeProcess {
            child,
            config: dummy_config(),
            spawned_at: Instant::now(),
            restart_budget_rearmed: false,
            output_health: Arc::new(ChildOutputHealth::new()),
        });

        // Hold the process lock as the monitor loop would, releasing it while
        // kill_sync is still inside its retry budget.
        let guard = state.process.lock().await;
        let killer = {
            let state = state.clone();
            std::thread::spawn(move || state.kill_sync())
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        drop(guard);
        killer.join().expect("kill_sync thread");

        assert!(
            state
                .process
                .try_lock()
                .expect("process lock free after kill_sync")
                .is_none(),
            "kill_sync must clear the process slot once the lock frees up"
        );
    }

    /// #3700: quitting the app must not orphan agent grandchildren. The
    /// runtime child owns its process group (`spawn_node_process` sets
    /// `process_group(0)`), so `kill_sync`'s killpg must take down processes
    /// the runtime spawned, not only the runtime pid itself.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_sync_kills_the_runtime_process_group() {
        let mut command = test_shell_command("sleep 30 & echo $!; wait");
        command
            .process_group(0)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn group leader");

        let stdout = child.stdout.take().expect("stdout piped");
        let mut lines = BufReader::new(stdout).lines();
        let grandchild_pid: libc::pid_t = lines
            .next_line()
            .await
            .expect("read grandchild pid")
            .expect("grandchild pid line")
            .trim()
            .parse()
            .expect("numeric grandchild pid");

        let state = ProviderRuntimeState::new();
        *state.process.lock().await = Some(ProviderRuntimeProcess {
            child,
            config: dummy_config(),
            spawned_at: Instant::now(),
            restart_budget_rearmed: false,
            output_health: Arc::new(ChildOutputHealth::new()),
        });

        state.kill_sync();

        // SIGKILL delivery is immediate; reaping of the re-parented
        // grandchild by init/launchd can lag a moment.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let alive = unsafe { libc::kill(grandchild_pid, 0) } == 0;
            if !alive {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild pid {grandchild_pid} survived kill_sync — process group not killed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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

    /// #3434: installed Linux builds resolve resources to `../lib/<app>`,
    /// `$APPDIR/usr/lib/<app>`, or `/usr/lib/<app>` — locations no
    /// exe-relative candidate ever reaches, so agent mode could not start.
    /// The resolver-backed candidates must be probed first (platform subdir
    /// before flat layout), and every pre-existing exe-relative/dev
    /// candidate must remain, in the same order, as the fallback tail.
    #[test]
    fn mjs_candidates_probe_resource_dir_before_exe_relative() {
        let exe_dir = Path::new("/usr/bin");
        let resource_dir = Path::new("/usr/lib/seren-desktop");
        let candidates = provider_runtime_mjs_candidates(exe_dir, Some(resource_dir), "linux-x64");

        assert_eq!(
            candidates[0],
            resource_dir
                .join("embedded-runtime")
                .join("linux-x64")
                .join("provider-runtime")
                .join("provider-runtime.mjs")
        );
        assert_eq!(
            candidates[1],
            resource_dir
                .join("embedded-runtime")
                .join("provider-runtime")
                .join("provider-runtime.mjs")
        );
        assert_eq!(
            candidates[2..],
            provider_runtime_mjs_candidates(exe_dir, None, "linux-x64")[..],
            "exe-relative and dev candidates must be unchanged after the resolver pair"
        );
    }

    /// A failed resolver must degrade to exactly the pre-#3434 candidate
    /// list — macOS/Windows/dev discovery is untouched.
    #[test]
    fn mjs_candidates_without_resource_dir_keep_prior_probe_set() {
        let exe_dir = Path::new("/Applications/Seren.app/Contents/MacOS");
        let candidates = provider_runtime_mjs_candidates(exe_dir, None, "darwin-arm64");

        assert_eq!(candidates.len(), 5);
        assert_eq!(
            candidates[0],
            exe_dir
                .join("../Resources/embedded-runtime")
                .join("darwin-arm64")
                .join("provider-runtime")
                .join("provider-runtime.mjs")
        );
        assert_eq!(
            candidates[4],
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("embedded-runtime")
                .join("provider-runtime")
                .join("provider-runtime.mjs")
        );
    }

    // ========================================================================
    // #3728 — child output capture
    // ========================================================================

    /// Drains a real child's stderr through the production reader and returns
    /// every line it delivered. The child, the pipe and the framing are all
    /// real; only the log sink is swapped for a collector so the test can
    /// assert on what would have been logged.
    async fn capture_child_stderr(script: &str) -> (Vec<String>, String, Arc<ChildOutputHealth>) {
        let mut child = test_shell_command(script)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn output-capture child");
        let stderr = child.stderr.take().expect("child stderr pipe");
        let health = Arc::new(ChildOutputHealth::new());

        let mut captured: Vec<String> = Vec::new();
        let reason = drain_child_channel(stderr, ChildChannel::Stderr, &health, |line| {
            captured.push(line)
        })
        .await;

        let _ = child.wait().await;
        (captured, reason, health)
    }

    #[cfg(windows)]
    fn oversized_stderr_script(blob_bytes: usize) -> String {
        format!(
            "[Console]::Error.Write('x' * {blob_bytes}); \
             [Console]::Error.Write(\"`nafter-blob-1`nafter-blob-2`n\")"
        )
    }

    #[cfg(not(windows))]
    fn oversized_stderr_script(blob_bytes: usize) -> String {
        format!(
            "{{ head -c {blob_bytes} /dev/zero | tr '\\0' 'x'; \
             printf '\\nafter-blob-1\\nafter-blob-2\\n'; }} 1>&2"
        )
    }

    /// The regression test for #3728.
    ///
    /// A newline-free blob larger than the cap used to park `next_line()`
    /// forever: the blob never arrived and every following line was absorbed
    /// into the same pending line and lost. Assert the blob is delivered
    /// truncated AND that the ordinary lines after it still arrive.
    #[tokio::test]
    async fn oversized_line_is_truncated_and_the_channel_keeps_delivering() {
        let overflow = 4096;
        let script = oversized_stderr_script(MAX_CHILD_LINE_BYTES + overflow);

        let (lines, reason, health) = capture_child_stderr(&script).await;

        assert_eq!(reason, "EOF", "channel must end on genuine EOF only");
        assert!(
            lines.iter().all(|line| line.len() < MAX_CHILD_LINE_BYTES * 2),
            "no delivered line may grow unbounded, got lengths {:?}",
            lines.iter().map(|l| l.len()).collect::<Vec<_>>(),
        );
        assert!(
            lines[0].ends_with("bytes, resynchronising]"),
            "the oversized line must be capped and marked: {:?}",
            &lines[0][lines[0].len().saturating_sub(60)..],
        );
        assert_eq!(
            lines[1],
            format!("…[dropped {overflow} bytes before the next line break]"),
        );
        // The whole point of #3728: everything after the oversized line still
        // reaches the log. On `main` these two lines never arrived at all.
        assert_eq!(lines[2], "after-blob-1");
        assert_eq!(lines[3], "after-blob-2");
        assert_eq!(
            health.stderr.truncated_lines.load(Ordering::Relaxed),
            1,
            "the truncation must be counted for the monitor",
        );
    }

    /// The 8.5-hour outage in #3728, reproduced in about a second.
    ///
    /// A child that writes without ever terminating a line used to park
    /// `next_line()` indefinitely: nothing reached the log, no EOF, no error,
    /// and the parent's buffer grew without bound. Capture must now deliver
    /// output from a child that never emits a newline at all.
    #[tokio::test]
    async fn a_child_that_never_writes_a_newline_cannot_silence_the_channel() {
        let blob_bytes = MAX_CHILD_LINE_BYTES * 3;
        #[cfg(windows)]
        let script = format!(
            "[Console]::Error.Write('x' * {blob_bytes}); Start-Sleep -Milliseconds 200"
        );
        #[cfg(not(windows))]
        let script = format!(
            "{{ head -c {blob_bytes} /dev/zero | tr '\\0' 'x'; sleep 0.2; }} 1>&2"
        );

        let (lines, _reason, health) = capture_child_stderr(&script).await;

        let lengths: Vec<usize> = lines.iter().map(|line| line.len()).collect();

        // On `main` this child produced NOTHING: `next_line()` never saw a
        // newline, so the reader sat parked exactly as it did for 8.5 hours.
        assert!(
            lines.len() >= 3,
            "a newline-free child must not be able to silence its own channel, got {lengths:?}",
        );
        assert_eq!(
            health.stderr.truncated_lines.load(Ordering::Relaxed),
            1,
            "the oversized line is counted once, not once per chunk",
        );
        assert!(
            lines[0].len() <= MAX_CHILD_LINE_BYTES + 128,
            "the first line must be capped, got {lengths:?}",
        );
        // Everything after the cap is a short progress/summary line, so the
        // channel stays demonstrably alive without flooding the log.
        assert!(
            lines[1..].iter().all(|line| line.len() < 256),
            "discard reporting must stay bounded, got {lengths:?}",
        );
        assert!(
            lines[1].contains("still discarding"),
            "the discard phase must report progress: {:?}",
            lines[1],
        );
        assert!(
            lines.last().is_some_and(|line| line.contains("dropped")),
            "EOF must summarise what was discarded: {:?}",
            lines.last(),
        );
    }

    /// A non-UTF-8 byte must degrade one line, not destroy the channel.
    #[cfg(not(windows))]
    #[tokio::test]
    async fn invalid_utf8_degrades_one_line_and_the_channel_survives() {
        let script = "{ printf 'bad-\\xff-byte\\n'; printf 'still-alive\\n'; } 1>&2";
        let (lines, reason, _health) = capture_child_stderr(script).await;

        assert_eq!(reason, "EOF");
        assert_eq!(lines.len(), 2, "got {lines:?}");
        assert!(
            lines[0].starts_with("bad-") && lines[0].ends_with("-byte"),
            "invalid byte must be replaced, not fatal: {:?}",
            lines[0],
        );
        assert_eq!(lines[1], "still-alive");
    }

    /// A line split across read boundaries — including mid-multibyte-character
    /// — must reassemble intact, because framing buffers bytes and decodes
    /// only at the newline.
    #[test]
    fn framer_reassembles_lines_split_mid_multibyte_character() {
        let mut framer = LineFramer::default();
        let mut out = Vec::new();
        let text = "héllo wörld";
        let bytes = text.as_bytes();

        for byte in bytes {
            framer.push(&[*byte], &mut out);
        }
        assert!(out.is_empty(), "no newline yet, nothing may be emitted");
        framer.push(b"\n", &mut out);

        assert_eq!(out, vec![text.to_string()]);
    }

    /// Overflow must resynchronise exactly at the next newline: the capped
    /// line reports what it dropped, and the line after it is intact.
    #[test]
    fn framer_resyncs_at_the_next_newline_after_overflow() {
        let mut framer = LineFramer::default();
        let mut out = Vec::new();
        let overflow = 100_usize;

        framer.push(&vec![b'a'; MAX_CHILD_LINE_BYTES + overflow], &mut out);
        assert_eq!(
            out.len(),
            1,
            "the cap must flush immediately, not wait for a newline",
        );
        assert!(out[0].starts_with(&"a".repeat(64)));
        assert!(out[0].ends_with("bytes, resynchronising]"));

        framer.push(b"\nnext-line\n", &mut out);

        assert_eq!(out.len(), 3);
        assert_eq!(
            out[1],
            format!("…[dropped {overflow} bytes before the next line break]"),
        );
        assert_eq!(out[2], "next-line");
        assert_eq!(framer.truncated_lines, 1);
    }

    /// CRLF children must not leave a stray CR in the log line.
    #[test]
    fn framer_strips_carriage_returns() {
        let mut framer = LineFramer::default();
        let mut out = Vec::new();
        framer.push(b"windows-line\r\nunix-line\n", &mut out);
        assert_eq!(out, vec!["windows-line", "unix-line"]);
    }

    /// A channel that ended while the child is still alive is the #3728
    /// signature and must be reported — once, not every monitor tick.
    #[test]
    fn monitor_reports_a_closed_channel_on_a_live_child_exactly_once() {
        let health = ChildOutputHealth::new();
        health.stderr.closed.store(true, Ordering::Relaxed);
        *health.stderr.close_reason.lock().unwrap() = Some("EOF".to_string());

        let first = collect_output_channel_anomalies(&health);
        assert_eq!(first.len(), 1, "got {first:?}");
        assert!(first[0].contains("stderr capture ended (EOF)"));

        assert!(
            collect_output_channel_anomalies(&health).is_empty(),
            "a persistent condition must not spam the log it protects",
        );
    }

    /// A channel parked mid-line past the threshold is reported; a channel
    /// that is merely quiet is not.
    #[test]
    fn monitor_reports_a_parked_line_but_not_a_quiet_channel() {
        let health = ChildOutputHealth::new();
        assert!(
            collect_output_channel_anomalies(&health).is_empty(),
            "a quiet channel with nothing pending is normal",
        );

        health.stdout.pending_bytes.store(4096, Ordering::Relaxed);
        health.stdout.pending_since_ms.store(0, Ordering::Relaxed);
        assert!(
            collect_output_channel_anomalies(&health).is_empty(),
            "a partial line younger than the threshold is normal",
        );

        // Backdate the partial line past the stall threshold.
        let stalled = ChildOutputHealth {
            started: Instant::now() - (CHILD_LINE_STALL_THRESHOLD + Duration::from_secs(5)),
            stdout: ChannelActivity::default(),
            stderr: ChannelActivity::default(),
        };
        stalled.stdout.pending_bytes.store(4096, Ordering::Relaxed);
        stalled.stdout.pending_since_ms.store(0, Ordering::Relaxed);

        let anomalies = collect_output_channel_anomalies(&stalled);
        assert_eq!(anomalies.len(), 1, "got {anomalies:?}");
        assert!(anomalies[0].contains("stdout has held 4096 bytes"));
    }

    /// Part 4 must not change what gets scrubbed. `vars_os` cannot panic on
    /// non-UTF-8 environment content the way `vars()` did.
    #[test]
    fn secret_env_snapshot_is_reusable_and_non_panicking() {
        let first = provider_secret_env_snapshot();
        let second = provider_secret_env_snapshot();
        assert_eq!(first, second);
        assert!(
            first.iter().all(|value| !value.is_empty()),
            "empty values would blanket-replace every character in a line",
        );
    }
}
