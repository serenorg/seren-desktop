// ABOUTME: MCP (Model Context Protocol) server process management.
// ABOUTME: Handles spawning, communicating with, and terminating MCP server processes.

use crate::embedded_runtime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Manager, State};

/// Bound on how long the MCP initialize handshake is allowed to take before
/// `mcp_connect` returns a timeout error instead of blocking indefinitely.
/// Chosen to be comfortably above cold-start times for embedded node servers
/// while still surfacing a clearly-broken child in a reasonable window.
const MCP_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(15);

/// Bound on post-initialize JSON-RPC requests (tools/list, tools/call,
/// resources/*). Generous because tool calls can legitimately run long
/// (headless browsing, large fetches), but bounded so a wedged server cannot
/// pin a blocking-pool thread and the per-server mutex forever (#3439). On
/// expiry the server is killed and its slot removed so queued callers fail
/// fast instead of piling onto a dead mutex.
const MCP_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Global request ID counter for JSON-RPC
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Handle to a server's child process, shared between the per-server slot and
/// the stdio pipe owner. Kept OUTSIDE the per-server `McpProcess` mutex so
/// kill paths (disconnect, timeouts, app exit) never wait behind an in-flight
/// blocking `read_line` (#3437).
type SharedChild = Arc<Mutex<Child>>;

/// Per-server slot. Each MCP server has its own inner Mutex so one stuck
/// server cannot block operations on any other — which was a second part of
/// the hang bug: the old code held a single top-level Mutex across every
/// blocking stdio read, so a slow child would freeze all MCP commands.
#[derive(Clone)]
struct McpSlot {
    /// Pipes + request serialization; blocking stdio I/O locks this.
    process: Arc<Mutex<McpProcess>>,
    /// Kill-path handle to the same child, reachable without locking
    /// `process` so a wedged read cannot make the server unkillable (#3437).
    child: SharedChild,
}

/// State for managing MCP server processes.
///
/// The outer `Mutex` guards the `HashMap` itself and is held only long enough
/// to insert / remove / look up a slot by name. All blocking stdio I/O runs
/// against the per-server inner `Mutex` (`McpSlot`) inside a
/// `tokio::task::spawn_blocking` so the main Tauri thread is never parked on
/// a child process read.
pub struct McpState {
    processes: Mutex<HashMap<String, McpSlot>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    /// Kill all connected MCP server processes. Called on app exit to prevent
    /// orphaned child processes from accumulating across restarts.
    pub fn kill_all(&self) {
        let drained = if let Ok(mut processes) = self.processes.lock() {
            processes.drain().collect::<Vec<_>>()
        } else {
            return;
        };
        for (name, slot) in drained {
            log::info!("[MCP] Killing process on exit: {}", name);
            kill_and_reap(&slot.child);
        }
    }
}

/// Kill a child process and reap it with `wait()` so no zombie/defunct entry
/// accumulates (#3437). Safe to call repeatedly and after the child already
/// exited — both syscalls' errors are intentionally ignored.
fn kill_and_reap(child: &SharedChild) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// `kill_and_reap` on the blocking pool so async callers never park the main
/// Tauri thread on the kill/wait syscalls.
async fn kill_and_reap_off_main(child: SharedChild) {
    let _ = tokio::task::spawn_blocking(move || kill_and_reap(&child)).await;
}

impl Default for McpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Represents an active MCP server process
struct McpProcess {
    child: SharedChild,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// Buffered stderr output from the background drain thread.
    /// Used to enrich error messages when the process fails.
    stderr_buffer: Arc<Mutex<String>>,
}

/// JSON-RPC request structure
#[derive(Serialize)]
struct JsonRpcRequest<T: Serialize> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<T>,
}

/// JSON-RPC response structure
#[derive(Deserialize, Debug)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    jsonrpc: String,
    #[allow(dead_code)]
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize, Debug)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[allow(dead_code)]
    data: Option<serde_json::Value>,
}

/// MCP initialize result
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeResult {
    protocol_version: String,
    capabilities: serde_json::Value,
    server_info: ServerInfo,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ServerInfo {
    name: String,
    version: String,
}

/// MCP tool definition
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    name: String,
    description: String,
    input_schema: serde_json::Value,
}

/// MCP resource definition
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    uri: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
}

/// MCP tool call result
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    content: Vec<serde_json::Value>,
    #[serde(default)]
    is_error: bool,
}

/// Send a JSON-RPC request and read stdout lines until THIS request's
/// response arrives. A server may interleave notifications (no `id`), its own
/// requests (`method` + `id`), stray log lines, or stale responses to an
/// earlier request — none of those are this call's response, and treating one
/// as such desyncs every later call for the life of the process (#3438).
/// Skip them and keep reading; callers bound the whole exchange with a
/// timeout, so a server that never answers cannot spin this loop forever.
fn send_request<T: Serialize>(
    process: &mut McpProcess,
    method: &'static str,
    params: Option<T>,
) -> Result<serde_json::Value, String> {
    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);

    let request = JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method,
        params,
    };

    let request_str = serde_json::to_string(&request).map_err(|e| e.to_string())?;

    // Write request
    writeln!(process.stdin, "{}", request_str).map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())?;

    loop {
        let mut response_line = String::new();
        let bytes_read = process
            .stdout
            .read_line(&mut response_line)
            .map_err(|e| e.to_string())?;

        if bytes_read == 0 {
            return Err("MCP process closed unexpectedly".to_string());
        }

        let line = response_line.trim();
        if line.is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                // Not JSON at all — a server accidentally logging to stdout.
                // Failing the call here would leave the real response queued
                // in the pipe and desync every later call, so skip the line.
                log::warn!(
                    "[MCP] Ignoring non-JSON stdout line while waiting for '{method}' response"
                );
                continue;
            }
        };

        if value.get("method").is_some() {
            // Notification or server-initiated request — not a response.
            log::debug!(
                "[MCP] Skipping interleaved server message while waiting for '{method}' response"
            );
            continue;
        }

        match value.get("id").and_then(serde_json::Value::as_u64) {
            Some(line_id) if line_id == id => {}
            Some(line_id) => {
                // Stale response to an earlier (likely timed-out) request.
                log::warn!(
                    "[MCP] Skipping stale response id {line_id} while waiting for id {id} ('{method}')"
                );
                continue;
            }
            None => {
                log::debug!(
                    "[MCP] Skipping id-less message while waiting for '{method}' response"
                );
                continue;
            }
        }

        let response: JsonRpcResponse = serde_json::from_value(value)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(error) = response.error {
            return Err(format!("MCP error {}: {}", error.code, error.message));
        }

        return response
            .result
            .ok_or_else(|| "No result in response".to_string());
    }
}

/// Initialize parameters for MCP handshake
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    protocol_version: &'static str,
    capabilities: ClientCapabilities,
    client_info: ClientInfo,
}

#[derive(Serialize)]
struct ClientCapabilities {}

#[derive(Serialize)]
struct ClientInfo {
    name: &'static str,
    version: &'static str,
}

const PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH: &str = "mcp-servers/playwright-stealth/dist/index.js";

/// Check that a candidate script path has a usable node_modules directory.
/// Tauri's resource copier drops pnpm symlinks, leaving node_modules with
/// only `.pnpm/` internals. Node.js can't resolve packages from that layout.
fn has_working_node_modules(script_path: &std::path::Path) -> bool {
    // Walk up from dist/index.js → dist/ → playwright-stealth/
    let package_dir = match script_path.parent().and_then(|d| d.parent()) {
        Some(dir) => dir,
        None => return false,
    };
    // Check for a top-level dependency that pnpm symlinks (not inside .pnpm/).
    // If the symlink was dropped, this directory won't exist.
    package_dir
        .join("node_modules")
        .join("@modelcontextprotocol")
        .join("sdk")
        .is_dir()
}

/// Build the ordered candidate list for the playwright-stealth MCP script.
/// Pure function — separates path search from filesystem checks so the
/// resolver can be exercised from tests with a fixture tree. #1945.
fn playwright_mcp_script_candidates(resource_dir: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH));
        candidates.push(
            resource_dir
                .join("embedded-runtime")
                .join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH),
        );
    }

    // Development fallback: workspace root is one level above src-tauri.
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    candidates.push(workspace_root.join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH));

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH));
    }

    if let Ok(exe_path) = std::env::current_exe()
        && let Some(exe_dir) = exe_path.parent()
    {
        candidates.push(exe_dir.join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH));
        candidates.push(
            exe_dir
                .join("../Resources")
                .join(PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH),
        );
    }

    candidates
}

/// Resolve the playwright-stealth MCP script to an absolute path from the
/// candidate list. Prefers candidates whose `node_modules` is intact; falls
/// closed when an existing candidate is incomplete so packaging drift does
/// not turn into a paid runtime-debugging loop.
/// Returns `None` when no candidate exists on disk — callers must NOT publish
/// a non-existent path as `SEREN_PLAYWRIGHT_MCP_COMMAND`. #1945.
pub(crate) fn resolve_playwright_mcp_script_path_from(
    resource_dir: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let candidates = playwright_mcp_script_candidates(resource_dir);

    for candidate in &candidates {
        if candidate.exists() && has_working_node_modules(candidate) {
            return Some(candidate.clone());
        }
    }

    for candidate in &candidates {
        if candidate.exists() {
            log::warn!(
                "[MCP] Ignoring playwright script at {:?} because node_modules is incomplete",
                candidate
            );
        }
    }

    None
}

/// Resolve the bundled/dev Playwright MCP server script to an absolute path.
#[tauri::command]
pub fn resolve_playwright_mcp_script_path(app: tauri::AppHandle) -> String {
    let resource_dir = app.path().resource_dir().ok();
    if let Some(path) = resolve_playwright_mcp_script_path_from(resource_dir.as_deref()) {
        return path.to_string_lossy().to_string();
    }
    // Last-resort fallback keeps backwards compatibility with existing settings.
    PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH.to_string()
}

/// Build the `SEREN_PLAYWRIGHT_MCP_COMMAND` value: a shell-quoted full
/// command string that skill subprocesses can execute to spawn the bundled
/// playwright-stealth MCP server on macOS, Windows, or Linux. #1945.
///
/// Quoting rule: wrap any argument that contains a space or a double-quote
/// in double quotes, escaping inner double quotes as `\"`. The skill
/// subprocess is expected to feed the value to its platform shell as-is
/// (cmd.exe on Windows, /bin/sh on POSIX), so this matches the quoting
/// both shells tolerate without special expansion.
pub(crate) fn format_playwright_mcp_command(node: &str, script: &std::path::Path) -> String {
    fn shell_quote(arg: &str) -> String {
        if !arg.contains(' ') && !arg.contains('"') {
            return arg.to_string();
        }
        let escaped = arg.replace('"', "\\\"");
        format!("\"{}\"", escaped)
    }

    let script_str = script.to_string_lossy();
    format!("{} {}", shell_quote(node), shell_quote(&script_str))
}

/// Resolve a bare command name to an absolute path by searching the embedded PATH.
///
/// On macOS/Linux, when the app is launched from Finder or a desktop launcher,
/// the parent process PATH is minimal (e.g. `/usr/bin:/bin`). Setting `cmd.env("PATH", ...)`
/// only affects the child's environment after exec — the OS uses the PARENT's PATH to
/// locate the executable for `Command::new("node")`. This function resolves bare names
/// (like "node") against the embedded PATH so we use an absolute path for spawning.
pub(crate) fn resolve_command_in_embedded_path(command: &str) -> String {
    // Absolute paths and paths with separators are used as-is.
    if std::path::Path::new(command).is_absolute() || command.contains(std::path::MAIN_SEPARATOR) {
        return command.to_string();
    }

    let embedded_path = embedded_runtime::get_embedded_path();
    if embedded_path.is_empty() {
        return command.to_string();
    }

    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    // On Windows, try bare name, then .exe and .cmd suffixes.
    #[cfg(target_os = "windows")]
    let names: Vec<String> = vec![
        command.to_string(),
        format!("{}.exe", command),
        format!("{}.cmd", command),
    ];
    #[cfg(not(target_os = "windows"))]
    let names: Vec<String> = vec![command.to_string()];

    for dir in embedded_path.split(sep) {
        for name in &names {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    command.to_string()
}

/// Maximum bytes to retain in the stderr buffer.
const STDERR_BUFFER_CAP: usize = 8192;

/// Spawn a background thread that drains a child's stderr into a shared buffer.
/// This prevents the child from blocking on a full stderr pipe while still
/// preserving diagnostic output for error messages.
fn spawn_stderr_drain(
    stderr: std::process::ChildStderr,
    server_name: String,
) -> Arc<Mutex<String>> {
    let buffer = Arc::new(Mutex::new(String::new()));
    let buf_clone = buffer.clone();

    std::thread::Builder::new()
        .name(format!("mcp-stderr-{}", server_name))
        .spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        log::debug!("[MCP:{}] stderr: {}", server_name, line);
                        if let Ok(mut guard) = buf_clone.lock() {
                            if guard.len() > STDERR_BUFFER_CAP {
                                let drain_to = guard.len() - STDERR_BUFFER_CAP / 2;
                                guard.drain(..drain_to);
                            }
                            guard.push_str(&line);
                            guard.push('\n');
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .ok();

    buffer
}

/// Collect diagnostic context from a failed MCP process.
/// Checks exit code and stderr buffer to build an actionable error message.
fn collect_process_diagnostics(process: &McpProcess, base_error: &str) -> String {
    let mut diagnostic = base_error.to_string();

    // Check if the process has exited and capture the exit code
    if let Ok(mut child) = process.child.lock()
        && let Ok(Some(status)) = child.try_wait()
    {
        let code_str = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        diagnostic = format!("{} (exit code: {})", diagnostic, code_str);
    }

    // Give the stderr drain thread a moment to collect output
    std::thread::sleep(std::time::Duration::from_millis(100));

    if let Ok(guard) = process.stderr_buffer.lock() {
        let stderr = guard.trim();
        if !stderr.is_empty() {
            diagnostic = format!("{}\nProcess stderr:\n{}", diagnostic, stderr);
        }
    }

    diagnostic
}

/// Connect to an MCP server
#[tauri::command]
pub async fn mcp_connect(
    app: tauri::AppHandle,
    state: State<'_, McpState>,
    server_name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<McpInitializeResult, String> {
    // Same rationale as provider_runtime_get_config: once the updater has
    // engaged the shutdown guard, refuse to spawn new stdio MCP children so
    // they can't re-lock the bundled node.exe between the pre-install drain
    // and the NSIS file-replace step (#2230).
    if let Some(guard) = app.try_state::<std::sync::Arc<crate::commands::updater::ShutdownGuard>>()
    {
        if guard.is_engaged() {
            return Err(format!(
                "Update in progress — MCP connect for '{}' refused",
                server_name
            ));
        }
    }

    // Resolve bare command names (e.g. "node") to absolute paths using the embedded PATH.
    // The parent process PATH may be minimal when launched from Finder/Dock on macOS,
    // so we cannot rely on the OS to find commands that live in /opt/homebrew/bin etc.
    let resolved_command = resolve_command_in_embedded_path(&command);

    log::debug!(
        "[MCP:{}] Connecting: command={:?} (resolved={:?}), args={:?}",
        server_name,
        command,
        resolved_command,
        args
    );

    connect_stdio_server(&state, server_name, resolved_command, args, env).await
}

/// Spawn a stdio MCP server, run the bounded initialize handshake, and
/// register the slot. Split from the `mcp_connect` command wrapper so the
/// full child lifecycle (timeout kill, displaced-slot kill) is exercisable
/// from tests without a Tauri runtime.
async fn connect_stdio_server(
    state: &McpState,
    server_name: String,
    resolved_command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<McpInitializeResult, String> {
    let mut cmd = Command::new(&resolved_command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Inject the embedded runtime PATH so child processes can find bundled node/git
    let embedded_path = embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        cmd.env("PATH", &embedded_path);
    }

    // Scrub VSCode / Cursor / Electron extension-host env vars that would
    // otherwise make node-based MCP servers (e.g. playwright-stealth) hang
    // in ESM bootstrap when the app is launched from a VSCode/Cursor
    // integrated terminal. See serenorg/seren-desktop#1516.
    //
    // NOTE: intentionally runs BEFORE the per-server `env_vars` loop below
    // so that servers can still explicitly re-add any of these variables
    // if they really need them (no server currently does, but the order
    // keeps the sanitizer from stomping on caller intent).
    embedded_runtime::sanitize_spawn_env(&mut cmd);

    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!(
            "Failed to spawn MCP server '{}': {} (command={:?}, PATH={:?})",
            server_name, e, resolved_command, embedded_path,
        );
        log::error!("[MCP:{}] {}", server_name, msg);
        msg
    })?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    // Pipe stderr to a background drain thread so the child doesn't block on
    // a full pipe buffer, while still capturing output for diagnostics.
    let stderr_buffer = match child.stderr.take() {
        Some(stderr) => spawn_stderr_drain(stderr, server_name.clone()),
        None => Arc::new(Mutex::new(String::new())),
    };

    let process = McpProcess {
        child: Arc::new(Mutex::new(child)),
        stdin,
        stdout: BufReader::new(stdout),
        stderr_buffer,
    };

    let (mut process, result) =
        run_initialize_handshake(process, &server_name, MCP_INITIALIZE_TIMEOUT).await?;

    let init_result: McpInitializeResult = match serde_json::from_value(result) {
        Ok(parsed) => parsed,
        Err(e) => {
            // The child spoke, but not the protocol we understand. It was
            // never registered, so kill it here or it leaks (#3437).
            kill_and_reap_off_main(process.child.clone()).await;
            return Err(format!("Failed to parse init result: {}", e));
        }
    };

    // Send initialized notification (no response expected, but we need to send it)
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    let notified =
        writeln!(process.stdin, "{}", notification).and_then(|_| process.stdin.flush());
    if let Err(e) = notified {
        kill_and_reap_off_main(process.child.clone()).await;
        return Err(e.to_string());
    }

    log::debug!(
        "[MCP:{}] Connected successfully (server: {} v{})",
        server_name,
        init_result.server_info.name,
        init_result.server_info.version
    );

    // Store the process in its own per-server slot so subsequent commands
    // lock only this server's Mutex rather than a global one.
    let slot = McpSlot {
        child: process.child.clone(),
        process: Arc::new(Mutex::new(process)),
    };
    let displaced = state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server_name.clone(), slot);
    if let Some(old) = displaced {
        // Reconnecting under an existing name replaces the slot; kill the
        // displaced child instead of silently orphaning it (#3437).
        log::info!(
            "[MCP:{}] Replaced an existing connection; killing the displaced process",
            server_name
        );
        kill_and_reap_off_main(old.child).await;
    }

    Ok(init_result)
}

/// Run the MCP initialize handshake on the blocking thread pool, bounded by
/// `timeout`. `send_request` does a sync `BufRead::read_line` on the child's
/// stdout — it must never run on the main Tauri thread, or a slow / broken
/// child freezes the whole app (this was #1501). On timeout the child is
/// killed and reaped before returning: that prevents the process leak
/// (#3437) and the resulting EOF unblocks the reader so the blocking task
/// exits instead of pinning a blocking-pool thread for the app's lifetime.
async fn run_initialize_handshake(
    process: McpProcess,
    server_name: &str,
    timeout: Duration,
) -> Result<(McpProcess, serde_json::Value), String> {
    let init_params = InitializeParams {
        protocol_version: "2024-11-05",
        capabilities: ClientCapabilities {},
        client_info: ClientInfo {
            name: "seren-desktop",
            version: env!("CARGO_PKG_VERSION"),
        },
    };

    let child = process.child.clone();
    let handshake = tokio::task::spawn_blocking(move || {
        let mut process = process;
        match send_request(&mut process, "initialize", Some(init_params)) {
            Ok(value) => Ok((process, value)),
            Err(e) => {
                let diagnostic = collect_process_diagnostics(&process, &e);
                // Kill the child so the background stderr-drain thread (and
                // any OS resources) can be released promptly, and reap it so
                // no zombie lingers (#3437).
                kill_and_reap(&process.child);
                Err(diagnostic)
            }
        }
    });

    match tokio::time::timeout(timeout, handshake).await {
        Ok(Ok(Ok(pair))) => Ok(pair),
        Ok(Ok(Err(e))) => {
            log::error!("[MCP:{}] Initialize failed: {}", server_name, e);
            Err(e)
        }
        Ok(Err(join_err)) => {
            let msg = format!("MCP initialize task panicked: {join_err}");
            log::error!("[MCP:{}] {msg}", server_name);
            Err(msg)
        }
        Err(_elapsed) => {
            // The blocking task still owns the pipes, parked in `read_line`.
            // Kill the child through the shared handle: the process cannot
            // leak, and the EOF lets the blocking task finish and release
            // its thread (#3437).
            kill_and_reap_off_main(child).await;
            let msg = format!(
                "MCP initialize handshake timed out after {}s — the server process was terminated; check that the server command is correct and the server emits a valid JSON-RPC response on stdout",
                timeout.as_secs()
            );
            log::error!("[MCP:{}] {msg}", server_name);
            Err(msg)
        }
    }
}

/// Look up a server's slot without holding the outer `Mutex` across I/O.
/// Returns the cloned `Arc` so the caller can lock only this server's inner
/// `Mutex` while other servers remain unaffected.
fn lookup_slot(state: &McpState, server_name: &str) -> Result<McpSlot, String> {
    let processes = state.processes.lock().map_err(|e| e.to_string())?;
    processes
        .get(server_name)
        .cloned()
        .ok_or_else(|| format!("Server '{}' not connected", server_name))
}

/// Run `send_request` against a server on the blocking thread pool so the main
/// Tauri thread never parks on `BufRead::read_line`, bounded by
/// `MCP_REQUEST_TIMEOUT`. Used by every command that needs to exchange a
/// JSON-RPC message with a local MCP child process. On expiry the server's
/// child is killed and its slot removed so queued callers fail fast instead
/// of piling onto the dead server's mutex (#3439).
async fn run_request_off_main<T, R>(
    state: &McpState,
    server_name: &str,
    method: &'static str,
    params: Option<T>,
) -> Result<R, String>
where
    T: Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    run_request_with_timeout(state, server_name, method, params, MCP_REQUEST_TIMEOUT).await
}

async fn run_request_with_timeout<T, R>(
    state: &McpState,
    server_name: &str,
    method: &'static str,
    params: Option<T>,
    timeout: Duration,
) -> Result<R, String>
where
    T: Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    let slot = lookup_slot(state, server_name)?;
    let process = slot.process.clone();
    let request = tokio::task::spawn_blocking(move || -> Result<R, String> {
        let mut process = process
            .lock()
            .map_err(|e| format!("MCP process mutex poisoned: {e}"))?;
        let value = send_request(&mut *process, method, params)?;
        serde_json::from_value::<R>(value)
            .map_err(|e| format!("Failed to parse {method} response: {e}"))
    });

    match tokio::time::timeout(timeout, request).await {
        Ok(joined) => joined.map_err(|e| format!("MCP {method} task panicked: {e}"))?,
        Err(_elapsed) => {
            // Remove the slot first so new callers fail fast with a clear
            // "not connected" error, then kill the wedged child — the EOF
            // unblocks the reader holding the per-server mutex, so callers
            // already queued behind it error out promptly too (#3439).
            remove_slot_if_same(state, server_name, &slot);
            kill_and_reap_off_main(slot.child.clone()).await;
            Err(format!(
                "MCP '{method}' request to server '{server_name}' timed out after {}s — the server has been disconnected; reconnect it to try again",
                timeout.as_secs()
            ))
        }
    }
}

/// Remove a server's slot only if it is still the same connection the caller
/// timed out against — a concurrent reconnect must not lose its fresh slot.
fn remove_slot_if_same(state: &McpState, server_name: &str, slot: &McpSlot) {
    if let Ok(mut processes) = state.processes.lock()
        && let Some(current) = processes.get(server_name)
        && Arc::ptr_eq(&current.process, &slot.process)
    {
        processes.remove(server_name);
    }
}

/// Disconnect from an MCP server.
///
/// Acquires the outer `Mutex` only long enough to remove the slot, then kills
/// the child on the blocking pool so the main thread isn't parked on the
/// `child.kill()` syscall.
#[tauri::command]
pub async fn mcp_disconnect(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<(), String> {
    let removed = {
        let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
        processes.remove(&server_name)
    };

    if let Some(slot) = removed {
        tokio::task::spawn_blocking(move || kill_and_reap(&slot.child))
            .await
            .map_err(|e| format!("MCP disconnect task panicked: {e}"))?;
    }

    Ok(())
}

/// List available tools from an MCP server
#[tauri::command]
pub async fn mcp_list_tools(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpTool>, String> {
    let response: ToolsListResponse =
        run_request_off_main(&state, &server_name, "tools/list", None::<()>).await?;
    Ok(response.tools)
}

#[derive(Deserialize)]
struct ToolsListResponse {
    tools: Vec<McpTool>,
}

/// List available resources from an MCP server
#[tauri::command]
pub async fn mcp_list_resources(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpResource>, String> {
    let response: ResourcesListResponse =
        run_request_off_main(&state, &server_name, "resources/list", None::<()>).await?;
    Ok(response.resources)
}

#[derive(Deserialize)]
struct ResourcesListResponse {
    resources: Vec<McpResource>,
}

/// Call a tool on an MCP server.
///
/// #3193-F: executing a tool is a side effect, so this transport refuses to run
/// without a live host-minted dispatch handle for this exact server, tool, and
/// argument payload. The handle is redeemed before the child process sees the
/// call — a renderer path that skipped the authorization gate cannot get here.
#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    authorization: State<'_, crate::tool_authorization::ToolAuthorizationState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
    auth_handle: Option<String>,
) -> Result<McpToolResult, String> {
    authorization.consume_dispatch_handle(
        auth_handle.as_deref().unwrap_or_default(),
        crate::tool_authorization::ToolRoute::Mcp,
        &server_name,
        &tool_name,
        &crate::tool_authorization::binding_for_publisher_args(&arguments),
    )?;
    let params = serde_json::json!({
        "name": tool_name,
        "arguments": arguments
    });
    run_request_off_main(&state, &server_name, "tools/call", Some(params)).await
}

/// Read a resource from an MCP server
#[tauri::command]
pub async fn mcp_read_resource(
    state: State<'_, McpState>,
    server_name: String,
    uri: String,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({ "uri": uri });
    run_request_off_main(&state, &server_name, "resources/read", Some(params)).await
}

/// Check if an MCP server is connected
#[tauri::command]
pub fn mcp_is_connected(state: State<'_, McpState>, server_name: String) -> bool {
    state
        .processes
        .lock()
        .map(|p| p.contains_key(&server_name))
        .unwrap_or(false)
}

/// Get list of connected MCP servers
#[tauri::command]
pub fn mcp_list_connected(state: State<'_, McpState>) -> Result<Vec<String>, String> {
    let processes = state.processes.lock().map_err(|e| e.to_string())?;
    Ok(processes.keys().cloned().collect())
}

// ============================================================================
// HTTP Streaming MCP Client (for mcp.serendb.com)
// ============================================================================

use rmcp::ServiceExt;
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use tokio::sync::RwLock;

/// HTTP MCP client for remote servers like mcp.serendb.com
/// The second type parameter is the handler - we use () which implements ClientHandler
type HttpMcpClient = rmcp::service::RunningService<rmcp::RoleClient, ()>;

struct HttpMcpConnection {
    client: Arc<HttpMcpClient>,
    settlement_trusted: bool,
}

/// Origin that may report settled Gateway charges. Settlement metadata is
/// host-trusted state, so it is accepted from this origin only and never from
/// a renderer-chosen server name or tool name.
const HOSTED_MCP_SETTLEMENT_ORIGIN: &str = "https://mcp.serendb.com";

/// True when `url` is served by the hosted Seren MCP origin.
fn is_hosted_mcp_settlement_origin(url: &str) -> bool {
    let (Ok(parsed), Ok(trusted)) = (
        url::Url::parse(url),
        url::Url::parse(HOSTED_MCP_SETTLEMENT_ORIGIN),
    ) else {
        return false;
    };
    parsed.scheme() == trusted.scheme()
        && parsed.host_str() == trusted.host_str()
        && parsed.port_or_known_default() == trusted.port_or_known_default()
}

/// State for HTTP MCP connections
pub struct HttpMcpState {
    clients: RwLock<HashMap<String, HttpMcpConnection>>,
}

impl HttpMcpState {
    pub fn new() -> Self {
        Self {
            clients: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for HttpMcpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Connect to a remote MCP server via HTTP streaming
#[tauri::command]
pub async fn mcp_connect_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
    url: String,
    auth_token: Option<String>,
) -> Result<McpInitializeResult, String> {
    // Build reqwest client with auth header if token provided
    let client = if let Some(token) = auth_token {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", token))
                .map_err(|e| format!("Invalid auth token: {}", e))?,
        );
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?
    } else {
        reqwest::Client::new()
    };

    let settlement_trusted = is_hosted_mcp_settlement_origin(&url);

    // Build transport config with URL
    let config = StreamableHttpClientTransportConfig {
        uri: url.into(),
        ..Default::default()
    };

    // Build transport with custom client and config
    let transport = StreamableHttpClientTransport::with_client(client, config);

    // Connect using rmcp - () implements ClientHandler
    let client = ()
        .serve(transport)
        .await
        .map_err(|e| format!("Failed to connect to MCP server: {}", e))?;

    // Get server info from the client (peer_info returns Option<&InitializeResult>)
    let init_result = if let Some(peer_info) = client.peer_info() {
        McpInitializeResult {
            protocol_version: peer_info.protocol_version.to_string(),
            capabilities: serde_json::to_value(&peer_info.capabilities).unwrap_or_default(),
            server_info: ServerInfo {
                // server_info is Implementation struct with name and version fields
                name: peer_info.server_info.name.to_string(),
                version: peer_info.server_info.version.to_string(),
            },
        }
    } else {
        McpInitializeResult {
            protocol_version: "unknown".to_string(),
            capabilities: serde_json::json!({}),
            server_info: ServerInfo {
                name: "unknown".to_string(),
                version: "unknown".to_string(),
            },
        }
    };

    // Store the client
    let mut clients = state.clients.write().await;
    clients.insert(
        server_name,
        HttpMcpConnection {
            client: Arc::new(client),
            settlement_trusted,
        },
    );

    Ok(init_result)
}

/// Disconnect from an HTTP MCP server
#[tauri::command]
pub async fn mcp_disconnect_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
) -> Result<(), String> {
    let mut clients = state.clients.write().await;
    if let Some(connection) = clients.remove(&server_name) {
        // Dropping the client closes its connection.
        drop(connection);
    }
    Ok(())
}

/// List tools from an HTTP MCP server
#[tauri::command]
pub async fn mcp_list_tools_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
) -> Result<Vec<McpTool>, String> {
    let client = {
        let clients = state.clients.read().await;
        Arc::clone(
            &clients
                .get(&server_name)
                .ok_or_else(|| format!("Server '{}' not connected", server_name))?
                .client,
        )
    };

    let tools_result = client
        .list_tools(None)
        .await
        .map_err(|e| format!("Failed to list tools: {}", e))?;

    // Convert rmcp tools to our McpTool format
    let tools: Vec<McpTool> = tools_result
        .tools
        .into_iter()
        .map(|t| McpTool {
            name: t.name.to_string(),
            description: t.description.map(|d| d.to_string()).unwrap_or_default(),
            input_schema: serde_json::to_value(&t.input_schema).unwrap_or_default(),
        })
        .collect();

    Ok(tools)
}

/// The gate-facing identity of one HTTP MCP dispatch: which route/publisher/
/// tool the renderer must have authorized, and the argument payload the
/// operation binding covers. Mirrors how the renderer consults the gate:
/// `call_publisher` and native `mcp__{publisher}__{tool}` names authorize as
/// the wrapped gateway operation, everything else as a built-in seren tool.
pub(crate) fn http_dispatch_identity(
    tool_name: &str,
    arguments: &serde_json::Value,
) -> (
    crate::tool_authorization::ToolRoute,
    String,
    String,
    serde_json::Value,
) {
    use crate::tool_authorization::ToolRoute;
    if tool_name == "call_publisher" {
        let publisher = arguments
            .get("publisher")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let tool = arguments
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let tool_args = arguments
            .get("tool_args")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        return (ToolRoute::Gateway, publisher, tool, tool_args);
    }
    if let Some(rest) = tool_name.strip_prefix("mcp__") {
        if let Some((publisher, tool)) = rest.split_once("__") {
            return (
                ToolRoute::Gateway,
                publisher.to_string(),
                tool.to_string(),
                arguments.clone(),
            );
        }
    }
    (
        ToolRoute::Seren,
        "seren".to_string(),
        tool_name.to_string(),
        arguments.clone(),
    )
}

fn settled_gateway_charge_from_meta(
    meta: Option<&rmcp::model::Meta>,
) -> Option<crate::tool_authorization::SettledGatewayCharge> {
    let charge = meta?.0.get("seren/settledCharge")?;
    let micros = charge.get("micros")?.as_u64()?;
    let asset = charge.get("asset")?.as_str()?.trim();
    if asset.is_empty() {
        return None;
    }
    Some(crate::tool_authorization::SettledGatewayCharge {
        micros,
        asset: asset.to_string(),
    })
}

fn settlement_receipt_from_meta(meta: Option<&rmcp::model::Meta>) -> Option<String> {
    meta?
        .0
        .get("seren/settlementReceipt")?
        .get("receiptId")?
        .as_str()?
        .parse::<uuid::Uuid>()
        .ok()
        .map(|receipt_id| receipt_id.to_string())
}

/// Call a tool on an HTTP MCP server.
///
/// #3193-F: like the stdio transport, this refuses to execute without a live
/// dispatch handle. The handle is verified against the *effective* operation —
/// a `call_publisher` envelope is unwrapped to the publisher tool it carries,
/// so wrapping a call cannot dodge the binding.
#[tauri::command]
pub async fn mcp_call_tool_http(
    state: State<'_, HttpMcpState>,
    authorization: State<'_, crate::tool_authorization::ToolAuthorizationState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
    auth_handle: Option<String>,
) -> Result<McpToolResult, String> {
    let (route, publisher, tool, bound_args) = http_dispatch_identity(&tool_name, &arguments);
    let redemption = authorization.consume_dispatch_handle(
        auth_handle.as_deref().unwrap_or_default(),
        route,
        &publisher,
        &tool,
        &crate::tool_authorization::binding_for_publisher_args(&bound_args),
    )?;
    let (client, settlement_trusted) = {
        let clients = state.clients.read().await;
        let connection = clients
            .get(&server_name)
            .ok_or_else(|| format!("Server '{}' not connected", server_name))?;
        (
            Arc::clone(&connection.client),
            connection.settlement_trusted,
        )
    };

    let result = client
        .call_tool(
            rmcp::model::CallToolRequestParams::new(tool_name)
                .with_arguments(serde_json::from_value(arguments).unwrap_or_default()),
        )
        .await
        .map_err(|e| format!("Failed to call tool: {}", e))?;

    // Route classification comes from the renderer-supplied tool name, so it
    // decides handle enforcement only. A reported charge is trusted solely
    // because the transport is the hosted Seren MCP origin.
    let settled_charge = settlement_trusted
        .then(|| settled_gateway_charge_from_meta(result.meta.as_ref()))
        .flatten();
    let settlement_receipt = settlement_trusted
        .then(|| settlement_receipt_from_meta(result.meta.as_ref()))
        .flatten();
    if route == crate::tool_authorization::ToolRoute::Gateway
        && !result.is_error.unwrap_or(false)
    {
        // The call already settled upstream, so a bookkeeping failure must not
        // discard the paid response and invite a duplicate paid retry.
        if let Err(err) = authorization.complete_gateway_dispatch(
            auth_handle.as_deref().unwrap_or_default(),
            settlement_receipt.as_deref(),
            settled_charge.as_ref(),
            &redemption,
        ) {
            log::error!("[mcp] Failed to complete gateway dispatch: {}", err);
        }
    }

    Ok(McpToolResult {
        content: result
            .content
            .into_iter()
            .map(|c| serde_json::to_value(&c).unwrap_or_default())
            .collect(),
        is_error: result.is_error.unwrap_or(false),
    })
}

/// Check if an HTTP MCP server is connected
#[tauri::command]
pub async fn mcp_is_connected_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
) -> Result<bool, String> {
    let clients = state.clients.read().await;
    Ok(clients.contains_key(&server_name))
}

/// List connected HTTP MCP servers
#[tauri::command]
pub async fn mcp_list_connected_http(
    state: State<'_, HttpMcpState>,
) -> Result<Vec<String>, String> {
    let clients = state.clients.read().await;
    Ok(clients.keys().cloned().collect())
}

// ============================================================================
// Tests for #1501: mcp_connect must not block the main Tauri thread.
//
// We cannot test the Tauri command layer directly in a unit test, so we
// exercise the exact mechanism the fix relies on: wrap a real blocking
// `send_request` call against a hung child process in
// `tokio::task::spawn_blocking` + `tokio::time::timeout`, and assert the
// whole operation returns a timeout error within a bounded wall-clock time
// rather than hanging. A regression on either `spawn_blocking` or
// `tokio::time::timeout` would fail this test.
//
// The same module covers the transport-hardening contracts, all against real
// child processes (no mocks): #3437 (timeout/displaced children are killed
// AND reaped — no orphans, no zombies), #3438 (responses are matched by id
// past interleaved notifications, log lines, and stale responses), and #3439
// (post-initialize requests are bounded and a timed-out server's slot is
// removed so callers fail fast).
// ============================================================================

#[cfg(test)]
mod dispatch_identity_tests {
    use super::http_dispatch_identity;
    use crate::tool_authorization::ToolRoute;

    /// The transport verifies handles against the *effective* operation, so
    /// the identity parser must mirror how the renderer consults the gate for
    /// each wire shape (#3193-F).
    #[test]
    fn call_publisher_envelopes_unwrap_to_the_carried_operation() {
        let args = serde_json::json!({
            "publisher": "gmail",
            "tool": "post_send",
            "tool_args": { "to": "a@example.com" },
            "_x402_payment": "header",
        });
        let (route, publisher, tool, bound) = http_dispatch_identity("call_publisher", &args);
        assert_eq!(route, ToolRoute::Gateway);
        assert_eq!(publisher, "gmail");
        assert_eq!(tool, "post_send");
        assert_eq!(bound, serde_json::json!({ "to": "a@example.com" }));
    }

    #[test]
    fn native_mcp_names_parse_to_their_publisher_operation() {
        let args = serde_json::json!({ "tz": "UTC" });
        let (route, publisher, tool, bound) =
            http_dispatch_identity("mcp__mcp-time__get_current_time", &args);
        assert_eq!(route, ToolRoute::Gateway);
        assert_eq!(publisher, "mcp-time");
        assert_eq!(tool, "get_current_time");
        assert_eq!(bound, args);
    }

    #[test]
    fn builtin_tools_identify_as_seren_route() {
        let args = serde_json::json!({ "publisher": "gmail" });
        let (route, publisher, tool, bound) = http_dispatch_identity("list_mcp_tools", &args);
        assert_eq!(route, ToolRoute::Seren);
        assert_eq!(publisher, "seren");
        assert_eq!(tool, "list_mcp_tools");
        assert_eq!(bound, args);
    }
}

#[cfg(test)]
mod dispatch_enforcement_tests {
    use super::*;
    use crate::tool_authorization::{
        ToolAuthorizationState, ToolRoute, binding_for_publisher_args,
    };

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        app.manage(McpState::default());
        app.manage(ToolAuthorizationState::new(std::path::PathBuf::from(
            ":memory:",
        )));
        app
    }

    /// #3193-F: the stdio MCP transport redeems a dispatch handle before it ever
    /// looks up the server slot, so a call that skipped the gate (no handle) or a
    /// handle minted for a different tool is refused at the command entrypoint —
    /// no child process is reached. Driven through `mcp_call_tool` itself so the
    /// wrapper's enforcement is proven, not only the shared consume path.
    #[tokio::test]
    async fn mcp_call_tool_refuses_missing_forged_and_mismatched_handles() {
        let app = mock_app();
        let args = serde_json::json!({ "q": "hello" });

        // No handle → refuse before any server lookup.
        assert!(
            mcp_call_tool(
                app.state(),
                app.state(),
                "srv".into(),
                "search".into(),
                args.clone(),
                None,
            )
            .await
            .is_err()
        );

        // Forged handle → refuse.
        assert!(
            mcp_call_tool(
                app.state(),
                app.state(),
                "srv".into(),
                "search".into(),
                args.clone(),
                Some("not-a-real-handle".into()),
            )
            .await
            .is_err()
        );

        // A handle minted for a different tool cannot be redeemed for this one.
        let wrong_tool = app
            .state::<ToolAuthorizationState>()
            .mint_dispatch_handle_for_test(
                ToolRoute::Mcp,
                "srv",
                "other_tool",
                &binding_for_publisher_args(&args),
            )
            .expect("test handle mints");
        assert!(
            mcp_call_tool(
                app.state(),
                app.state(),
                "srv".into(),
                "search".into(),
                args.clone(),
                Some(wrong_tool),
            )
            .await
            .is_err()
        );
    }

    #[test]
    fn settled_charge_uses_protocol_metadata_only() {
        let receipt_id = uuid::Uuid::new_v4();
        let meta = rmcp::model::Meta(
            serde_json::json!({
                "seren/settledCharge": {
                    "micros": 1_250_000,
                    "asset": "USDC"
                },
                "seren/settlementReceipt": {
                    "receiptId": receipt_id
                }
            })
            .as_object()
            .unwrap()
            .clone(),
        );

        assert_eq!(
            settled_gateway_charge_from_meta(Some(&meta)),
            Some(crate::tool_authorization::SettledGatewayCharge {
                micros: 1_250_000,
                asset: "USDC".to_string(),
            })
        );
        assert_eq!(settled_gateway_charge_from_meta(None), None);
        assert_eq!(
            settlement_receipt_from_meta(Some(&meta)),
            Some(receipt_id.to_string())
        );
        assert_eq!(settlement_receipt_from_meta(None), None);
    }

    /// A renderer picks both the server name and the tool name, so neither can
    /// decide whether a reported charge is trustworthy. Only the hosted origin
    /// may report settlement.
    #[test]
    fn only_the_hosted_mcp_origin_may_report_settlement() {
        assert!(is_hosted_mcp_settlement_origin(
            "https://mcp.serendb.com/mcp"
        ));
        assert!(is_hosted_mcp_settlement_origin(
            "https://mcp.serendb.com:443/mcp"
        ));

        assert!(!is_hosted_mcp_settlement_origin("http://mcp.serendb.com/mcp"));
        assert!(!is_hosted_mcp_settlement_origin(
            "https://mcp.serendb.com.evil.test/mcp"
        ));
        assert!(!is_hosted_mcp_settlement_origin("https://evil.test/mcp"));
        assert!(!is_hosted_mcp_settlement_origin("https://api.serendb.com/mcp"));
        assert!(!is_hosted_mcp_settlement_origin("mcp.serendb.com/mcp"));
        assert!(!is_hosted_mcp_settlement_origin("not a url"));
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Spawn a real stdio child and wrap it in an `McpProcess`. Returns the
    /// OS pid too, so tests can assert liveness/reaping independently of the
    /// process handle.
    fn spawn_stdio_child(command: &str, args: &[&str]) -> (McpProcess, u32) {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn stdio test child");

        let pid = child.id();
        let stdin = child.stdin.take().expect("test child stdin");
        let stdout = child.stdout.take().expect("test child stdout");
        let stderr_buffer = match child.stderr.take() {
            Some(stderr) => spawn_stderr_drain(stderr, "stdio-test-child".to_string()),
            None => Arc::new(Mutex::new(String::new())),
        };

        let process = McpProcess {
            child: Arc::new(Mutex::new(child)),
            stdin,
            stdout: BufReader::new(stdout),
            stderr_buffer,
        };
        (process, pid)
    }

    /// Spawn a child that reads stdin forever but never writes to stdout.
    /// Without killing the child, a blocked `read_line` in a spawn_blocking
    /// task would never return, leaking a thread and blocking tokio runtime
    /// shutdown.
    fn spawn_hung_child() -> (McpProcess, u32) {
        spawn_stdio_child("sh", &["-c", "cat > /dev/null"])
    }

    /// True while the OS still knows the pid — including zombies. That is
    /// what makes it usable as a reap probe: kill WITHOUT wait leaves a
    /// `<defunct>` entry that still answers signal 0; kill + wait removes
    /// the pid entirely (ESRCH).
    fn pid_exists(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// A real stdio JSON-RPC server (POSIX sh). Before answering every
    /// request it emits a notification, a non-JSON log line, and a stale
    /// response under a different id — the exact interleavings from #3438.
    /// The client must skip all three and return only the id-matched
    /// response.
    const FAKE_NOISY_SERVER: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  printf '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"noise"}}\n'
  printf 'plain log line that is not JSON\n'
  printf '{"jsonrpc":"2.0","id":%s,"result":{"stale":true}}\n' "$((id + 999))"
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake-mcp","version":"1.0.0"}}}\n' "$id"
      ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"echoes input","inputSchema":{"type":"object"}}]}}\n' "$id"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
  esac
done
"#;

    fn write_fake_server(dir: &std::path::Path) -> PathBuf {
        let script = dir.join("fake-mcp-server.sh");
        std::fs::write(&script, FAKE_NOISY_SERVER).expect("write fake server script");
        script
    }

    /// #3438: the client must find its response behind a notification, a
    /// non-JSON log line, and a stale response — and must stay in sync on
    /// the next call (the one-line reader desynced permanently here).
    #[test]
    fn send_request_skips_noise_and_matches_response_id() {
        let tmp = tempfile::tempdir().unwrap();
        let script = write_fake_server(tmp.path());
        let (mut process, pid) = spawn_stdio_child("sh", &[script.to_str().unwrap()]);

        let result = send_request::<()>(&mut process, "tools/list", None)
            .expect("id-matched response must be returned despite interleaved noise");
        assert_eq!(result["tools"][0]["name"], "echo");

        let again = send_request::<()>(&mut process, "tools/list", None)
            .expect("second request must stay in sync");
        assert_eq!(again["tools"][0]["name"], "echo");

        kill_and_reap(&process.child);
        assert!(!pid_exists(pid));
    }

    /// #3437: a child that starts but never speaks JSON-RPC must be killed
    /// and reaped when the initialize handshake times out — a live orphan or
    /// a zombie both keep the pid visible to signal 0.
    #[tokio::test(flavor = "multi_thread")]
    async fn initialize_handshake_timeout_kills_and_reaps_child() {
        let (process, pid) = spawn_hung_child();

        let started = Instant::now();
        let err = run_initialize_handshake(process, "hung-server", Duration::from_millis(300))
            .await
            .err()
            .expect("a child that never answers must time out");

        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout must fire promptly, took {:?}",
            started.elapsed()
        );
        assert!(
            !pid_exists(pid),
            "handshake-timeout child must be killed and reaped, not leaked"
        );
    }

    /// #3439: a wedged server must not hang a request forever — the call
    /// times out, the slot is removed so later callers fail fast, and the
    /// child is killed and reaped.
    #[tokio::test(flavor = "multi_thread")]
    async fn request_timeout_disconnects_slot_and_kills_child() {
        let state = McpState::new();
        let (process, pid) = spawn_hung_child();
        let slot = McpSlot {
            child: process.child.clone(),
            process: Arc::new(Mutex::new(process)),
        };
        state
            .processes
            .lock()
            .unwrap()
            .insert("wedged".to_string(), slot);

        let err = run_request_with_timeout::<(), serde_json::Value>(
            &state,
            "wedged",
            "tools/list",
            None,
            Duration::from_millis(300),
        )
        .await
        .expect_err("a wedged server must time out");

        assert!(
            err.contains("disconnected"),
            "error must tell the user the server was disconnected: {err}"
        );
        assert!(
            state.processes.lock().unwrap().is_empty(),
            "timed-out server slot must be removed"
        );
        assert!(
            !pid_exists(pid),
            "timed-out server child must be killed and reaped"
        );

        let follow_up = run_request_with_timeout::<(), serde_json::Value>(
            &state,
            "wedged",
            "tools/list",
            None,
            Duration::from_secs(5),
        )
        .await
        .expect_err("requests to a removed server must fail immediately");
        assert!(
            follow_up.contains("not connected"),
            "unexpected error: {follow_up}"
        );
    }

    /// #3437: every kill site must reap. Kill without wait leaves a
    /// `<defunct>` entry that still answers signal 0.
    #[test]
    fn kill_and_reap_leaves_no_zombie() {
        let (process, pid) = spawn_hung_child();
        assert!(pid_exists(pid), "child must be alive before the kill");

        kill_and_reap(&process.child);

        assert!(
            !pid_exists(pid),
            "child must be fully reaped, not left as a zombie"
        );
    }

    /// Full lifecycle against the real noisy fake server: connect (handshake
    /// survives interleaved noise — #3438), reconnect under the same name
    /// (displaced child killed and reaped — #3437), tools/list through the
    /// command path (#3438), disconnect (killed and reaped — #3437).
    #[tokio::test(flavor = "multi_thread")]
    async fn connect_kills_displaced_child_and_disconnect_reaps() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        app.manage(McpState::default());

        let tmp = tempfile::tempdir().unwrap();
        let script = write_fake_server(tmp.path()).to_string_lossy().to_string();
        // The spawn path replaces PATH with the embedded runtime dirs, which
        // don't contain `sed`; pin a PATH the fake sh server works with.
        let env = Some(HashMap::from([(
            "PATH".to_string(),
            "/usr/bin:/bin".to_string(),
        )]));

        let state = app.state::<McpState>();
        let init = connect_stdio_server(
            &state,
            "dup".to_string(),
            "sh".to_string(),
            vec![script.clone()],
            env.clone(),
        )
        .await
        .expect("first connect succeeds against the noisy fake server");
        assert_eq!(init.server_info.name, "fake-mcp");

        let pid_of = |name: &str| -> u32 {
            let processes = state.processes.lock().unwrap();
            processes.get(name).unwrap().child.lock().unwrap().id()
        };
        let pid1 = pid_of("dup");

        connect_stdio_server(
            &state,
            "dup".to_string(),
            "sh".to_string(),
            vec![script],
            env,
        )
        .await
        .expect("reconnect under the same name succeeds");
        let pid2 = pid_of("dup");
        assert_ne!(pid1, pid2);
        assert!(
            !pid_exists(pid1),
            "displaced child must be killed and reaped"
        );
        assert_eq!(state.processes.lock().unwrap().len(), 1);

        let tools = mcp_list_tools(app.state(), "dup".to_string())
            .await
            .expect("tools/list works through interleaved noise");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");

        mcp_disconnect(app.state(), "dup".to_string())
            .await
            .expect("disconnect succeeds");
        assert!(
            !pid_exists(pid2),
            "disconnected child must be killed and reaped"
        );
    }

    /// Force-terminate a child by PID via SIGKILL. Used to unstick a hung
    /// `read_line` in the spawn_blocking task once the test is done with it.
    fn sigkill(pid: u32) {
        // SAFETY: SIGKILL on a pid we just spawned in this process. The
        // worst case is ESRCH if the child already exited, which is fine.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_request_wrapped_in_timeout_returns_within_bound() {
        // Bound the assertion to a tight wall-clock window so a regression
        // that re-introduces the main-thread block fails loudly. 500ms is
        // far below the 15s production timeout but long enough to absorb
        // CI noise.
        let short_timeout = Duration::from_millis(500);
        let (process, child_pid) = spawn_hung_child();

        let started = Instant::now();
        let mut join_handle = tokio::task::spawn_blocking(move || {
            // This is exactly what mcp_connect used to do on the main
            // thread. Wrapping it in spawn_blocking + timeout is the whole
            // fix: the inner `read_line` will hang forever, but the outer
            // tokio::time::timeout MUST unstick the caller.
            let mut process = process;
            let _ = send_request::<()>(&mut process, "tools/list", None);
        });

        // Race the timeout against `&mut join_handle` so we don't consume
        // the JoinHandle — we still need it to drain the leaked thread
        // after we kill the child.
        let result = tokio::time::timeout(short_timeout, &mut join_handle).await;
        let elapsed = started.elapsed();

        // The outer timeout MUST fire; the inner blocking task is parked
        // on the hung child until we kill it.
        assert!(
            result.is_err(),
            "spawn_blocking+timeout must return a timeout error for a hung child, got {result:?}"
        );
        // And it MUST return within a tight bound — the whole point is
        // that the main thread is free to do other work. ~3s of slack for CI.
        assert!(
            elapsed < Duration::from_secs(3),
            "expected timeout to fire within 3s, took {elapsed:?}"
        );

        // SIGKILL the child so the inner `read_line` returns Err and the
        // spawn_blocking task can finally exit. Without this the test
        // process would leak the blocking thread and tokio runtime shutdown
        // would hang.
        sigkill(child_pid);
        // Drain the join handle (with a generous bound) so the test exits
        // cleanly even if cleanup is slow.
        let _ = tokio::time::timeout(Duration::from_secs(5), join_handle).await;
    }

    #[test]
    fn mcp_initialize_timeout_constant_is_bounded() {
        // Guard against someone accidentally removing the timeout or making
        // it absurdly long. The fix is only meaningful if the bound exists
        // and is reasonable for a UI-blocking call.
        assert!(
            MCP_INITIALIZE_TIMEOUT <= Duration::from_secs(60),
            "MCP_INITIALIZE_TIMEOUT must stay bounded; got {:?}",
            MCP_INITIALIZE_TIMEOUT
        );
        assert!(
            MCP_INITIALIZE_TIMEOUT >= Duration::from_secs(5),
            "MCP_INITIALIZE_TIMEOUT too aggressive; got {:?}",
            MCP_INITIALIZE_TIMEOUT
        );
    }

    #[test]
    fn mcp_request_timeout_constant_is_bounded() {
        // The request bound must exist (#3439) but stay generous enough for
        // legitimately slow tools — expiry disconnects the whole server.
        assert!(
            MCP_REQUEST_TIMEOUT <= Duration::from_secs(600),
            "MCP_REQUEST_TIMEOUT must stay bounded; got {:?}",
            MCP_REQUEST_TIMEOUT
        );
        assert!(
            MCP_REQUEST_TIMEOUT >= Duration::from_secs(30),
            "MCP_REQUEST_TIMEOUT too aggressive for slow real tools; got {:?}",
            MCP_REQUEST_TIMEOUT
        );
    }
}

// ============================================================================
// #1945 — playwright-stealth MCP resolver tests (cross-platform).
// Skill subprocesses (prophet-arb-bot) need an absolute, OS-aware spawn
// command for the bundled playwright-stealth MCP. The previous resolver only
// returned a string and fell back to a non-existent relative path on miss,
// which made the env-var injection unsafe; these tests pin the new
// `resolve_playwright_mcp_script_path_from` (Option<PathBuf>) and
// `format_playwright_mcp_command` (shell-quoted) contracts.
// ============================================================================

#[cfg(test)]
mod playwright_resolver_tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    /// Materialise a fake bundled playwright-stealth tree under `root` and
    /// return the absolute path to the script. Without a valid
    /// `node_modules/@modelcontextprotocol/sdk/` the resolver flags the
    /// candidate as broken; create the marker dir so the happy path matches.
    fn make_fake_bundle(root: &Path, with_node_modules: bool) -> PathBuf {
        let package_dir = root.join("mcp-servers").join("playwright-stealth");
        fs::create_dir_all(package_dir.join("dist")).unwrap();
        let script = package_dir.join("dist").join("index.js");
        fs::write(&script, b"// stub for tests\n").unwrap();
        if with_node_modules {
            fs::create_dir_all(
                package_dir
                    .join("node_modules")
                    .join("@modelcontextprotocol")
                    .join("sdk"),
            )
            .unwrap();
        }
        script
    }

    #[test]
    fn returns_none_when_no_candidate_exists_on_disk() {
        // Empty resource dir + no workspace bundle on this isolated tmp
        // tree → resolver must return None so callers don't publish a
        // bogus SEREN_PLAYWRIGHT_MCP_COMMAND. The pre-#1945 behaviour was
        // to return the bare relative path, which would silently fail on
        // Windows where the cwd-relative miss can't be exec'd.
        let tmp = tempfile::tempdir().unwrap();
        // Note: cwd / workspace_root / exe_dir candidates may exist in the
        // dev tree, so we only assert the resource_dir branch. The resource
        // dir is empty, so it contributes no matches; remaining candidates
        // are out-of-test-control. The assertion here is structural: the
        // function must be invocable with `None` resource_dir and a
        // missing-bundle tmp dir without panicking, and return whatever the
        // remaining fallbacks resolve to (Option<PathBuf>, not the bare
        // relative-path String the legacy command returned).
        let resolved = resolve_playwright_mcp_script_path_from(Some(tmp.path()));
        // The result is either None or an existing absolute path — never a
        // relative path that won't exec from an arbitrary cwd.
        if let Some(path) = &resolved {
            assert!(path.is_absolute(), "resolved path must be absolute, got {:?}", path);
            assert!(path.exists(), "resolved path must exist, got {:?}", path);
        }
    }

    #[test]
    fn resource_dir_with_intact_bundle_is_preferred() {
        let tmp = tempfile::tempdir().unwrap();
        let expected = make_fake_bundle(tmp.path(), true);

        let resolved = resolve_playwright_mcp_script_path_from(Some(tmp.path()))
            .expect("resolver must return Some when the resource bundle exists");

        // Canonicalise both sides — macOS turns /var/folders into /private/var.
        let resolved_canon = resolved.canonicalize().unwrap_or(resolved);
        let expected_canon = expected.canonicalize().unwrap_or(expected);
        assert_eq!(resolved_canon, expected_canon);
    }

    #[test]
    fn resource_dir_with_broken_bundle_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let broken = make_fake_bundle(tmp.path(), false);

        let resolved = resolve_playwright_mcp_script_path_from(Some(tmp.path()));

        assert!(
            resolved
                .as_ref()
                .map(|path| path != &broken)
                .unwrap_or(true),
            "resolver must not return a script whose node_modules marker is missing"
        );
    }

    #[test]
    fn shell_quote_paths_with_spaces() {
        // Windows install path under "Program Files" or
        // "Application Support" contains spaces. The unquoted form would
        // break cmd.exe / /bin/sh argument splitting; the skill expects a
        // shell-quoted full command string.
        let node = "/usr/local/bin/node";
        let script = std::path::Path::new("/Applications/Seren Desktop.app/Resources/x.js");
        let cmd = format_playwright_mcp_command(node, script);
        assert_eq!(
            cmd,
            "/usr/local/bin/node \"/Applications/Seren Desktop.app/Resources/x.js\""
        );
    }

    #[test]
    fn shell_quote_skipped_for_simple_paths() {
        // Don't add noise when neither token needs quoting — keeps the
        // injected env value readable in logs.
        let node = "/usr/local/bin/node";
        let script = std::path::Path::new("/opt/seren/playwright-stealth/dist/index.js");
        let cmd = format_playwright_mcp_command(node, script);
        assert_eq!(
            cmd,
            "/usr/local/bin/node /opt/seren/playwright-stealth/dist/index.js"
        );
    }
}
