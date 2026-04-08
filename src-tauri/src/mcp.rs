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

/// Global request ID counter for JSON-RPC
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Per-server slot. Each MCP server has its own inner Mutex so one stuck
/// server cannot block operations on any other — which was a second part of
/// the hang bug: the old code held a single top-level Mutex across every
/// blocking stdio read, so a slow child would freeze all MCP commands.
type McpSlot = Arc<Mutex<McpProcess>>;

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
            if let Ok(mut process) = slot.lock() {
                let _ = process.child.kill();
            }
        }
    }
}

impl Default for McpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Represents an active MCP server process
struct McpProcess {
    child: Child,
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

/// Send a JSON-RPC request and read the response
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

    // Read response
    let mut response_line = String::new();
    let bytes_read = process
        .stdout
        .read_line(&mut response_line)
        .map_err(|e| e.to_string())?;

    if bytes_read == 0 {
        return Err("MCP process closed unexpectedly".to_string());
    }

    let response: JsonRpcResponse = serde_json::from_str(&response_line)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(error) = response.error {
        return Err(format!("MCP error {}: {}", error.code, error.message));
    }

    response
        .result
        .ok_or_else(|| "No result in response".to_string())
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

/// Resolve the bundled/dev Playwright MCP server script to an absolute path.
#[tauri::command]
pub fn resolve_playwright_mcp_script_path(app: tauri::AppHandle) -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
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

    for candidate in &candidates {
        if candidate.exists() && has_working_node_modules(candidate) {
            return candidate.to_string_lossy().to_string();
        }
    }

    // Second pass: accept any candidate where the script exists, even without
    // verified node_modules (better to attempt and get a clear error than skip).
    for candidate in &candidates {
        if candidate.exists() {
            log::warn!(
                "[MCP] Resolved playwright script at {:?} but node_modules may be broken",
                candidate
            );
            return candidate.to_string_lossy().to_string();
        }
    }

    // Last-resort fallback keeps backwards compatibility with existing settings.
    PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH.to_string()
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
fn collect_process_diagnostics(process: &mut McpProcess, base_error: &str) -> String {
    let mut diagnostic = base_error.to_string();

    // Check if the process has exited and capture the exit code
    if let Ok(Some(status)) = process.child.try_wait() {
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
    state: State<'_, McpState>,
    server_name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<McpInitializeResult, String> {
    // Resolve bare command names (e.g. "node") to absolute paths using the embedded PATH.
    // The parent process PATH may be minimal when launched from Finder/Dock on macOS,
    // so we cannot rely on the OS to find commands that live in /opt/homebrew/bin etc.
    let resolved_command = resolve_command_in_embedded_path(&command);

    log::info!(
        "[MCP:{}] Connecting: command={:?} (resolved={:?}), args={:?}",
        server_name,
        command,
        resolved_command,
        args
    );

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
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr_buffer,
    };

    // Send initialize request on the blocking thread pool with a bounded
    // timeout. `send_request` does a sync `BufRead::read_line` on the child's
    // stdout — we MUST NOT run it on the main Tauri thread, or a slow /
    // broken child will freeze the whole app (this was #1501).
    let init_params = InitializeParams {
        protocol_version: "2024-11-05",
        capabilities: ClientCapabilities {},
        client_info: ClientInfo {
            name: "seren-desktop",
            version: env!("CARGO_PKG_VERSION"),
        },
    };

    let server_name_for_log = server_name.clone();
    let handshake = tokio::task::spawn_blocking(move || {
        let mut process = process;
        match send_request(&mut process, "initialize", Some(init_params)) {
            Ok(value) => Ok((process, value)),
            Err(e) => {
                let diagnostic = collect_process_diagnostics(&mut process, &e);
                // Kill the child so the background stderr-drain thread (and
                // any OS resources) can be released promptly.
                let _ = process.child.kill();
                Err(diagnostic)
            }
        }
    });

    let handshake_result = tokio::time::timeout(MCP_INITIALIZE_TIMEOUT, handshake).await;

    let (mut process, result) = match handshake_result {
        Ok(Ok(Ok(pair))) => pair,
        Ok(Ok(Err(e))) => {
            log::error!("[MCP:{}] Initialize failed: {}", server_name_for_log, e);
            return Err(e);
        }
        Ok(Err(join_err)) => {
            let msg = format!("MCP initialize task panicked: {join_err}");
            log::error!("[MCP:{}] {msg}", server_name_for_log);
            return Err(msg);
        }
        Err(_elapsed) => {
            // The blocking task is still running and still owns the child.
            // We can't cancel a sync `read_line` from here, but the spawn_blocking
            // thread is off the main Tauri thread, so the UI is NOT frozen.
            // The task will terminate on its own when the child exits or is
            // killed externally (e.g. next `mcp_disconnect` or app shutdown via
            // `kill_all`). The user gets a clear, bounded error.
            let msg = format!(
                "MCP initialize handshake timed out after {}s — check that the server command is correct and the server emits a valid JSON-RPC response on stdout",
                MCP_INITIALIZE_TIMEOUT.as_secs()
            );
            log::error!("[MCP:{}] {msg}", server_name_for_log);
            return Err(msg);
        }
    };

    let init_result: McpInitializeResult = serde_json::from_value(result)
        .map_err(|e| format!("Failed to parse init result: {}", e))?;

    // Send initialized notification (no response expected, but we need to send it)
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    writeln!(process.stdin, "{}", notification).map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())?;

    log::info!(
        "[MCP:{}] Connected successfully (server: {} v{})",
        server_name,
        init_result.server_info.name,
        init_result.server_info.version
    );

    // Store the process in its own per-server slot so subsequent commands
    // lock only this server's Mutex rather than a global one.
    state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server_name, Arc::new(Mutex::new(process)));

    Ok(init_result)
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
/// Tauri thread never parks on `BufRead::read_line`. Used by every command
/// that needs to exchange a JSON-RPC message with a local MCP child process.
async fn run_request_off_main<T, R>(
    slot: McpSlot,
    method: &'static str,
    params: Option<T>,
) -> Result<R, String>
where
    T: Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    tokio::task::spawn_blocking(move || -> Result<R, String> {
        let mut process = slot
            .lock()
            .map_err(|e| format!("MCP process mutex poisoned: {e}"))?;
        let value = send_request(&mut *process, method, params)?;
        serde_json::from_value::<R>(value)
            .map_err(|e| format!("Failed to parse {method} response: {e}"))
    })
    .await
    .map_err(|e| format!("MCP {method} task panicked: {e}"))?
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
        tokio::task::spawn_blocking(move || {
            if let Ok(mut process) = slot.lock() {
                let _ = process.child.kill();
            }
        })
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
    let slot = lookup_slot(&state, &server_name)?;
    let response: ToolsListResponse = run_request_off_main(slot, "tools/list", None::<()>).await?;
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
    let slot = lookup_slot(&state, &server_name)?;
    let response: ResourcesListResponse =
        run_request_off_main(slot, "resources/list", None::<()>).await?;
    Ok(response.resources)
}

#[derive(Deserialize)]
struct ResourcesListResponse {
    resources: Vec<McpResource>,
}

/// Call a tool on an MCP server
#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolResult, String> {
    let slot = lookup_slot(&state, &server_name)?;
    let params = serde_json::json!({
        "name": tool_name,
        "arguments": arguments
    });
    run_request_off_main(slot, "tools/call", Some(params)).await
}

/// Read a resource from an MCP server
#[tauri::command]
pub async fn mcp_read_resource(
    state: State<'_, McpState>,
    server_name: String,
    uri: String,
) -> Result<serde_json::Value, String> {
    let slot = lookup_slot(&state, &server_name)?;
    let params = serde_json::json!({ "uri": uri });
    run_request_off_main(slot, "resources/read", Some(params)).await
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

/// State for HTTP MCP connections
pub struct HttpMcpState {
    clients: RwLock<HashMap<String, Arc<HttpMcpClient>>>,
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
    clients.insert(server_name, Arc::new(client));

    Ok(init_result)
}

/// Disconnect from an HTTP MCP server
#[tauri::command]
pub async fn mcp_disconnect_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
) -> Result<(), String> {
    let mut clients = state.clients.write().await;
    if let Some(client) = clients.remove(&server_name) {
        // Client will be dropped and connection closed
        drop(client);
    }
    Ok(())
}

/// List tools from an HTTP MCP server
#[tauri::command]
pub async fn mcp_list_tools_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
) -> Result<Vec<McpTool>, String> {
    let clients = state.clients.read().await;
    let client = clients
        .get(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

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

/// Call a tool on an HTTP MCP server
#[tauri::command]
pub async fn mcp_call_tool_http(
    state: State<'_, HttpMcpState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolResult, String> {
    let clients = state.clients.read().await;
    let client = clients
        .get(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

    let result = client
        .call_tool(
            rmcp::model::CallToolRequestParams::new(tool_name)
                .with_arguments(serde_json::from_value(arguments).unwrap_or_default()),
        )
        .await
        .map_err(|e| format!("Failed to call tool: {}", e))?;

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
// ============================================================================

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Spawn a child that reads stdin forever but never writes to stdout.
    /// Returns both the constructed `McpProcess` and the OS pid so the test
    /// can SIGKILL the child after asserting the timeout fired — without
    /// killing the child the inner spawn_blocking task would never return,
    /// leaking a thread and blocking tokio runtime shutdown.
    fn spawn_hung_child() -> (McpProcess, u32) {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("cat > /dev/null")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn hung-child test process");

        let pid = child.id();
        let stdin = child.stdin.take().expect("test child stdin");
        let stdout = child.stdout.take().expect("test child stdout");
        let stderr_buffer = match child.stderr.take() {
            Some(stderr) => spawn_stderr_drain(stderr, "hung-child-test".to_string()),
            None => Arc::new(Mutex::new(String::new())),
        };

        let process = McpProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            stderr_buffer,
        };
        (process, pid)
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
}
