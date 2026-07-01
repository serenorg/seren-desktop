// ABOUTME: Loopback HTTP control server for validation-only real-app walkthroughs.
// ABOUTME: Exposes a typed command allowlist and writes a tokenized discovery file.

use super::{ValidationControlReplyPayload, is_validation_identifier};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};

const DISCOVERY_FILE: &str = "validation-control.json";
const TOKEN_TTL_SECS: u64 = 2 * 60 * 60;
const COMMAND_TIMEOUT_SECS: u64 = 30;

#[derive(Default)]
pub struct ValidationControlState {
    pending: Mutex<HashMap<String, Sender<ValidationControlReplyPayload>>>,
    frontend_ready: AtomicBool,
}

impl ValidationControlState {
    pub fn insert(
        &self,
        id: String,
        sender: Sender<ValidationControlReplyPayload>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "validation control pending map poisoned".to_string())?;
        pending.insert(id, sender);
        Ok(())
    }

    pub fn remove(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }

    pub fn resolve(&self, reply: ValidationControlReplyPayload) -> Result<(), String> {
        let sender = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "validation control pending map poisoned".to_string())?;
            pending.remove(&reply.id)
        };

        let Some(sender) = sender else {
            return Err("validation control reply did not match an active command".to_string());
        };

        sender
            .send(reply)
            .map_err(|_| "validation control command receiver was dropped".to_string())
    }

    pub fn mark_frontend_ready(&self) {
        self.frontend_ready.store(true, Ordering::SeqCst);
    }

    pub fn frontend_ready(&self) -> bool {
        self.frontend_ready.load(Ordering::SeqCst)
    }
}

pub struct ValidationControlHandle {
    server: Arc<Server>,
    discovery_path: std::path::PathBuf,
}

impl Drop for ValidationControlHandle {
    fn drop(&mut self) {
        self.server.unblock();
        let _ = std::fs::remove_file(&self.discovery_path);
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ControlCommand {
    id: String,
    command: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    route: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    native: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingCommand {
    command: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    route: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    native: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFile {
    port: u16,
    token: String,
    control_url: String,
    app_identifier: String,
    pid: u32,
    created_at: u64,
    expires_at: u64,
}

pub fn start(app: AppHandle) -> Result<ValidationControlHandle, String> {
    let identifier = app.config().identifier.clone();
    if !is_validation_identifier(&identifier) {
        return Err("validation control requires the validation bundle identity".to_string());
    }

    let server = Server::http("127.0.0.1:0")
        .map_err(|err| format!("failed to bind validation control server: {err}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("validation control server did not bind to an IP socket")?
        .port();
    let server = Arc::new(server);
    let token = generate_token();
    let now = unix_timestamp();
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve validation app data dir: {err}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("failed to create validation app data dir: {err}"))?;
    let discovery_path = std::env::var_os("SEREN_VALIDATION_DISCOVERY_PATH")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| data_dir.join(DISCOVERY_FILE));
    if let Some(parent) = discovery_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create validation discovery dir: {err}"))?;
    }
    let discovery = DiscoveryFile {
        port,
        token: token.clone(),
        control_url: format!("http://127.0.0.1:{port}"),
        app_identifier: identifier,
        pid: std::process::id(),
        created_at: now,
        expires_at: now + TOKEN_TTL_SECS,
    };
    write_discovery_file(&discovery_path, &discovery)?;

    let thread_server = Arc::clone(&server);
    thread::spawn(move || {
        log::info!("[validation-control] Listening on 127.0.0.1:{port}");
        for mut request in thread_server.incoming_requests() {
            let response = handle_request(&app, &token, &mut request);
            let _ = request.respond(response);
        }
        log::info!("[validation-control] Stopped");
    });

    Ok(ValidationControlHandle {
        server,
        discovery_path,
    })
}

fn handle_request(
    app: &AppHandle,
    token: &str,
    request: &mut tiny_http::Request,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let url = request.url().to_string();
    if request.method() == &Method::Get && url == "/health" {
        let frontend_ready = app
            .try_state::<ValidationControlState>()
            .map(|state| state.frontend_ready())
            .unwrap_or(false);
        return json_response(
            StatusCode(200),
            serde_json::json!({ "ok": true, "frontendReady": frontend_ready }),
        );
    }

    if request.method() == &Method::Post && url == "/quit" {
        if !authorized(request, token) {
            return text_response(StatusCode(401), "unauthorized");
        }
        app.exit(0);
        return json_response(StatusCode(200), serde_json::json!({ "ok": true }));
    }

    if request.method() != &Method::Post || url != "/command" {
        return text_response(StatusCode(404), "not found");
    }

    if !authorized(request, token) {
        return text_response(StatusCode(401), "unauthorized");
    }

    let mut body = String::new();
    if let Err(err) = request.as_reader().read_to_string(&mut body) {
        return text_response(
            StatusCode(400),
            &format!("failed to read request body: {err}"),
        );
    }

    let incoming: IncomingCommand = match serde_json::from_str(&body) {
        Ok(command) => command,
        Err(err) => {
            return text_response(StatusCode(400), &format!("invalid command JSON: {err}"));
        }
    };

    if !is_allowed_command(&incoming.command) {
        return text_response(StatusCode(400), "unsupported validation command");
    }

    let id = generate_token();
    let command = ControlCommand {
        id: id.clone(),
        command: incoming.command,
        selector: incoming.selector,
        value: incoming.value,
        route: incoming.route,
        key: incoming.key,
        timeout_ms: incoming.timeout_ms,
        native: incoming.native,
    };
    let (tx, rx) = mpsc::channel();

    let Some(state) = app.try_state::<ValidationControlState>() else {
        return text_response(StatusCode(503), "validation control state is not available");
    };
    if let Err(err) = state.insert(id.clone(), tx) {
        return text_response(StatusCode(500), &err);
    }

    if let Err(err) = app.emit("validation-control-command", &command) {
        state.remove(&id);
        return text_response(
            StatusCode(500),
            &format!("failed to emit validation command: {err}"),
        );
    }

    match rx.recv_timeout(Duration::from_secs(COMMAND_TIMEOUT_SECS)) {
        Ok(reply) if reply.ok => json_response(
            StatusCode(200),
            reply.result.unwrap_or(serde_json::Value::Null),
        ),
        Ok(reply) => text_response(
            StatusCode(500),
            reply
                .error
                .as_deref()
                .unwrap_or("validation command failed"),
        ),
        Err(_) => {
            state.remove(&id);
            text_response(StatusCode(504), "validation command timed out")
        }
    }
}

fn is_allowed_command(command: &str) -> bool {
    matches!(
        command,
        "navigate" | "click" | "fill" | "press" | "waitFor" | "dumpText" | "screenshot"
    )
}

fn authorized(request: &tiny_http::Request, expected_token: &str) -> bool {
    request.headers().iter().any(|header| {
        header.field.equiv("x-seren-validation-token") && header.value.as_str() == expected_token
    })
}

fn json_response(
    status: StatusCode,
    value: serde_json::Value,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    Response::from_data(body)
        .with_status_code(status)
        .with_header(json_header())
}

fn text_response(status: StatusCode, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string()).with_status_code(status)
}

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("valid JSON header")
}

fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_discovery_file(path: &Path, discovery: &DiscoveryFile) -> Result<(), String> {
    let tmp_path = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(discovery)
        .map_err(|err| format!("failed to encode validation discovery file: {err}"))?;

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|err| format!("failed to open validation discovery file: {err}"))?;
        file.write_all(&body)
            .map_err(|err| format!("failed to write validation discovery file: {err}"))?;
        file.sync_all()
            .map_err(|err| format!("failed to sync validation discovery file: {err}"))?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(&tmp_path, body)
            .map_err(|err| format!("failed to write validation discovery file: {err}"))?;
    }

    std::fs::rename(&tmp_path, path)
        .map_err(|err| format!("failed to publish validation discovery file: {err}"))
}
