// ABOUTME: Supervises the local Happy bridge process and exposes lifecycle status.
// ABOUTME: Builds its provider-runtime config in Rust so secrets never enter argv.

use serde::Serialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub const HAPPY_RELAY_URL: &str = "https://api.cluster-fluster.com";
const MAX_RESTART_ATTEMPTS: u32 = 3;
const MAX_BACKOFF_SECONDS: u64 = 30;
const STOP_GRACE_PERIOD: Duration = Duration::from_secs(5);
const STATUS_EVENT: &str = "happy-bridge://status";
const CREDENTIAL_ACCOUNT: &str = "happy-bridge-pairing-credential";

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
    _stdin: Arc<Mutex<ChildStdin>>,
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
        let machine_identity = self.load_pairing_credential(app)?.map(|credential| {
            serde_json::from_str(&credential).unwrap_or_else(|_| Value::String(credential))
        });
        let config = HappyBridgeConfig {
            provider_runtime: ProviderRuntimeConnection {
                host: provider_runtime.host,
                port: provider_runtime.port,
                token: provider_runtime.token,
            },
            relay_url: HAPPY_RELAY_URL.to_string(),
            machine_identity,
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

        let stdin = Arc::new(Mutex::new(stdin));
        pipe_bridge_output(&mut child, Arc::clone(&stdin), app.clone());
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

    /// Store the opaque credential received during pairing in the OS credential
    /// store. The value is never inspected, serialized into app data, or logged.
    pub fn store_pairing_credential(
        &self,
        app: &AppHandle,
        credential: &str,
    ) -> Result<(), String> {
        if credential.trim().is_empty() {
            return Err("pairing credential must not be empty".to_string());
        }
        let entry = credential_entry(app)?;
        entry
            .set_password(credential)
            .map_err(|err| format!("failed to store pairing credential: {err}"))?;
        remove_legacy_credential_store(app);
        Ok(())
    }

    pub fn load_pairing_credential(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let entry = credential_entry(app)?;
        let result = match entry.get_password() {
            Ok(credential) => Some(credential),
            Err(keyring::Error::NoEntry) => None,
            Err(err) => {
                return Err(format!("failed to load pairing credential: {err}"));
            }
        };
        remove_legacy_credential_store(app);
        Ok(result)
    }

    pub fn delete_pairing_credential(&self, app: &AppHandle) -> Result<(), String> {
        let entry = credential_entry(app)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(format!("failed to delete pairing credential: {err}")),
        }
        remove_legacy_credential_store(app);
        Ok(())
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

fn credential_entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, CREDENTIAL_ACCOUNT)
        .map_err(|err| format!("failed to open pairing credential store: {err}"))
}

fn remove_legacy_credential_store(app: &AppHandle) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::remove_file(app_data_dir.join("happy_bridge.json"));
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

const MAX_SUPERVISOR_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
struct SupervisorRequest {
    id: Value,
    method: String,
    params: Value,
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn parse_supervisor_line(line: &str) -> Result<SupervisorRequest, Value> {
    if line.len() > MAX_SUPERVISOR_LINE_BYTES {
        return Err(error_response(
            Value::Null,
            -32600,
            "supervisor request line is too large",
        ));
    }

    let value: Value = serde_json::from_str(line)
        .map_err(|_| error_response(Value::Null, -32700, "parse error"))?;
    let object = value
        .as_object()
        .ok_or_else(|| error_response(Value::Null, -32600, "invalid supervisor request"))?;
    let id = object.get("id").cloned().unwrap_or(Value::Null);
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| error_response(id.clone(), -32600, "method is required"))?;

    if !matches!(
        method,
        "conversation_create" | "conversation_lookup" | "identity_store"
    ) {
        return Err(error_response(id, -32601, "unknown supervisor method"));
    }

    Ok(SupervisorRequest {
        id,
        method: method.to_string(),
        params: object.get("params").cloned().unwrap_or_else(|| json!({})),
    })
}

fn required_string(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}

async fn dispatch_supervisor_request(
    app: &AppHandle,
    request: SupervisorRequest,
) -> Result<Value, String> {
    match request.method.as_str() {
        "conversation_create" => {
            let agent_type = required_string(&request.params, "agentType")?;
            let cwd = required_string(&request.params, "cwd")?;
            let title = required_string(&request.params, "title")?;
            let happy_session_id = required_string(&request.params, "happySessionId")?;
            let metadata = serde_json::to_string(&json!({
                "happy_session_id": happy_session_id,
            }))
            .map_err(|error| error.to_string())?;
            let conversation = crate::commands::chat::create_agent_conversation_record(
                app.clone(),
                uuid::Uuid::new_v4().to_string(),
                title,
                agent_type,
                Some(cwd.clone()),
                Some(cwd),
                None,
                Some(metadata),
            )
            .await?;
            Ok(json!({ "conversationId": conversation.id }))
        }
        "conversation_lookup" => {
            let happy_session_id = required_string(&request.params, "happySessionId")?;
            let conversation = crate::commands::chat::lookup_agent_conversation_by_happy_session(
                app.clone(),
                happy_session_id,
            )
            .await?;
            Ok(match conversation {
                Some(conversation) => json!({
                    "conversationId": conversation.id,
                    "agentSessionId": conversation.agent_session_id,
                    "cwd": conversation.agent_cwd,
                    "agentType": conversation.agent_type,
                }),
                None => json!({}),
            })
        }
        "identity_store" => {
            let identity = request
                .params
                .get("identity")
                .ok_or_else(|| "identity is required".to_string())?;
            let credential = identity
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| identity.to_string());
            app.state::<HappyBridgeManager>()
                .store_pairing_credential(app, &credential)?;
            Ok(json!({ "stored": true }))
        }
        _ => Err("unknown supervisor method".to_string()),
    }
}

async fn dispatch_supervisor_line(app: &AppHandle, line: &str, stdin: &Arc<Mutex<ChildStdin>>) {
    let response = match parse_supervisor_line(line) {
        Err(response) => response,
        Ok(request) => {
            let id = request.id.clone();
            match dispatch_supervisor_request(app, request).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(error) => error_response(id, -32000, &error),
            }
        }
    };

    write_supervisor_response(stdin, response).await;
}

async fn write_supervisor_response<W>(writer: &Arc<Mutex<W>>, response: Value)
where
    W: AsyncWrite + Unpin,
{
    let encoded = match serde_json::to_vec(&response) {
        Ok(encoded) => encoded,
        Err(error) => {
            log::warn!("[HappyBridge] Failed to encode supervisor response: {error}");
            return;
        }
    };
    let mut writer = writer.lock().await;
    if let Err(error) = writer.write_all(&encoded).await {
        log::warn!("[HappyBridge] Failed to write supervisor response: {error}");
        return;
    }
    if let Err(error) = writer.write_all(b"\n").await {
        log::warn!("[HappyBridge] Failed to finish supervisor response: {error}");
        return;
    }
    if let Err(error) = writer.flush().await {
        log::warn!("[HappyBridge] Failed to flush supervisor response: {error}");
    }
}

enum BoundedLine {
    Complete(String),
    Oversized,
}

async fn read_bounded_line<R>(reader: &mut R) -> std::io::Result<Option<BoundedLine>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    let mut oversized = false;

    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            if line.is_empty() && !oversized {
                return Ok(None);
            }
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Complete(String::from_utf8(line).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "supervisor line is not UTF-8",
                    )
                })?)
            }));
        }

        if let Some(newline_at) = buffer.iter().position(|byte| *byte == b'\n') {
            if line.len() + newline_at > MAX_SUPERVISOR_LINE_BYTES {
                oversized = true;
            } else if !oversized {
                line.extend_from_slice(&buffer[..newline_at]);
            }
            reader.consume(newline_at + 1);
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Complete(String::from_utf8(line).map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "supervisor line is not UTF-8",
                    )
                })?)
            }));
        }

        if !oversized && line.len() + buffer.len() <= MAX_SUPERVISOR_LINE_BYTES {
            line.extend_from_slice(buffer);
        } else {
            oversized = true;
        }
        let consumed = buffer.len();
        reader.consume(consumed);
    }
}

fn pipe_bridge_output(child: &mut Child, stdin: Arc<Mutex<ChildStdin>>, app: AppHandle) {
    if let Some(stdout) = child.stdout.take() {
        let stdout_stdin = Arc::clone(&stdin);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_bounded_line(&mut reader).await {
                    Ok(Some(BoundedLine::Complete(line))) => {
                        dispatch_supervisor_line(&app, &line, &stdout_stdin).await;
                    }
                    Ok(Some(BoundedLine::Oversized)) => {
                        write_supervisor_response(
                            &stdout_stdin,
                            error_response(
                                Value::Null,
                                -32600,
                                "supervisor request line is too large",
                            ),
                        )
                        .await;
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(BoundedLine::Complete(line))) = read_bounded_line(&mut reader).await {
                log::info!("[HappyBridge] {line}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedLine, MAX_SUPERVISOR_LINE_BYTES, error_response, parse_supervisor_line,
        read_bounded_line, restart_delay,
    };
    use serde_json::Value;
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader, duplex};

    #[test]
    fn restart_backoff_is_capped() {
        assert_eq!(restart_delay(0), Duration::from_secs(1));
        assert_eq!(restart_delay(1), Duration::from_secs(2));
        assert_eq!(restart_delay(2), Duration::from_secs(4));
        assert_eq!(restart_delay(10), Duration::from_secs(30));
    }

    #[test]
    fn supervisor_channel_dispatch_garbage_json_returns_error_response() {
        let response = parse_supervisor_line("not-json").expect_err("garbage must fail");
        assert_eq!(response["error"]["code"], -32700);
        assert_eq!(response["id"], Value::Null);
    }

    #[test]
    fn supervisor_channel_dispatch_unknown_method_returns_error_response() {
        let response = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"unknown_method","params":{}}"#,
        )
        .expect_err("unknown method must fail");
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(response["id"], 7);
    }

    #[test]
    fn supervisor_channel_dispatch_oversized_line_returns_error_response() {
        let line = "x".repeat(MAX_SUPERVISOR_LINE_BYTES + 1);
        let response = parse_supervisor_line(&line).expect_err("oversized line must fail");
        assert_eq!(response["error"]["code"], -32600);
        assert_eq!(response["id"], Value::Null);
    }

    #[test]
    fn supervisor_error_response_has_jsonrpc_shape() {
        let response = error_response(Value::Null, -32000, "test");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["error"]["message"], "test");
    }

    #[tokio::test]
    async fn bounded_stdout_reader_discards_over_cap_line_and_resynchronizes() {
        let (mut writer, reader) = duplex(64 * 1024);
        let writer_task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_SUPERVISOR_LINE_BYTES + 1])
                .await
                .unwrap();
            writer.write_all(b"\n{}\n").await.unwrap();
        });
        let mut reader = BufReader::new(reader);

        assert!(matches!(
            read_bounded_line(&mut reader).await.unwrap(),
            Some(BoundedLine::Oversized)
        ));
        assert!(matches!(
            read_bounded_line(&mut reader).await.unwrap(),
            Some(BoundedLine::Complete(line)) if line == "{}"
        ));
        writer_task.await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keyring_credential_round_trip_uses_macos_keychain() {
        let account = format!("happy-bridge-test-{}", std::process::id());
        let entry = keyring::Entry::new("com.serendb.desktop", &account).unwrap();
        let _ = entry.delete_credential();
        entry.set_password("phase5-round-trip-value").unwrap();
        assert!(
            std::process::Command::new("security")
                .args([
                    "find-generic-password",
                    "-s",
                    "com.serendb.desktop",
                    "-a",
                    &account
                ])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert_eq!(entry.get_password().unwrap(), "phase5-round-trip-value");
        entry.delete_credential().unwrap();
        assert!(
            !std::process::Command::new("security")
                .args([
                    "find-generic-password",
                    "-s",
                    "com.serendb.desktop",
                    "-a",
                    &account
                ])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }
}
