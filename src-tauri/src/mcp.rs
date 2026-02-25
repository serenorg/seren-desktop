// ABOUTME: MCP (Model Context Protocol) server process management.
// ABOUTME: Handles spawning, communicating with, and terminating MCP server processes.

use crate::embedded_runtime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Manager, State};

/// Global request ID counter for JSON-RPC
static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// State for managing MCP server processes
pub struct McpState {
    processes: Mutex<HashMap<String, McpProcess>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
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

    for candidate in candidates {
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }

    // Last-resort fallback keeps backwards compatibility with existing settings.
    PLAYWRIGHT_MCP_SCRIPT_RELATIVE_PATH.to_string()
}

/// Connect to an MCP server
#[tauri::command]
pub fn mcp_connect(
    state: State<'_, McpState>,
    server_name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<McpInitializeResult, String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()); // Discard stderr to prevent blocking

    // Inject the embedded runtime PATH so child processes can find bundled node/git
    let embedded_path = embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        cmd.env("PATH", embedded_path);
    }

    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            cmd.env(key, value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    let mut process = McpProcess {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    };

    // Send initialize request
    let init_params = InitializeParams {
        protocol_version: "2024-11-05",
        capabilities: ClientCapabilities {},
        client_info: ClientInfo {
            name: "seren-desktop",
            version: env!("CARGO_PKG_VERSION"),
        },
    };

    let result = send_request(&mut process, "initialize", Some(init_params))?;

    let init_result: McpInitializeResult = serde_json::from_value(result)
        .map_err(|e| format!("Failed to parse init result: {}", e))?;

    // Send initialized notification (no response expected, but we need to send it)
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    writeln!(process.stdin, "{}", notification).map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())?;

    // Store the process
    state
        .processes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(server_name, process);

    Ok(init_result)
}

/// Disconnect from an MCP server
#[tauri::command]
pub fn mcp_disconnect(state: State<'_, McpState>, server_name: String) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    if let Some(mut process) = processes.remove(&server_name) {
        // Try to kill the process gracefully
        let _ = process.child.kill();
    }

    Ok(())
}

/// List available tools from an MCP server
#[tauri::command]
pub fn mcp_list_tools(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpTool>, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let process = processes
        .get_mut(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

    let result = send_request::<()>(process, "tools/list", None)?;

    let tools_response: ToolsListResponse =
        serde_json::from_value(result).map_err(|e| format!("Failed to parse tools: {}", e))?;

    Ok(tools_response.tools)
}

#[derive(Deserialize)]
struct ToolsListResponse {
    tools: Vec<McpTool>,
}

/// List available resources from an MCP server
#[tauri::command]
pub fn mcp_list_resources(
    state: State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpResource>, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let process = processes
        .get_mut(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

    let result = send_request::<()>(process, "resources/list", None)?;

    let resources_response: ResourcesListResponse =
        serde_json::from_value(result).map_err(|e| format!("Failed to parse resources: {}", e))?;

    Ok(resources_response.resources)
}

#[derive(Deserialize)]
struct ResourcesListResponse {
    resources: Vec<McpResource>,
}

/// Call a tool on an MCP server
#[tauri::command]
pub fn mcp_call_tool(
    state: State<'_, McpState>,
    server_name: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolResult, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let process = processes
        .get_mut(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

    let params = serde_json::json!({
        "name": tool_name,
        "arguments": arguments
    });

    let result = send_request(process, "tools/call", Some(params))?;

    let tool_result: McpToolResult = serde_json::from_value(result)
        .map_err(|e| format!("Failed to parse tool result: {}", e))?;

    Ok(tool_result)
}

/// Read a resource from an MCP server
#[tauri::command]
pub fn mcp_read_resource(
    state: State<'_, McpState>,
    server_name: String,
    uri: String,
) -> Result<serde_json::Value, String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;

    let process = processes
        .get_mut(&server_name)
        .ok_or_else(|| format!("Server '{}' not connected", server_name))?;

    let params = serde_json::json!({ "uri": uri });

    let result = send_request(process, "resources/read", Some(params))?;

    Ok(result)
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
use std::sync::Arc;
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
        .call_tool(rmcp::model::CallToolRequestParams {
            name: tool_name.into(),
            arguments: Some(serde_json::from_value(arguments).unwrap_or_default()),
            meta: None,
            task: None,
        })
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
