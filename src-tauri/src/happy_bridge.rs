// ABOUTME: Supervises the local Happy bridge process and exposes lifecycle status.
// ABOUTME: Builds its provider-runtime config in Rust so secrets never enter argv.

use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

pub const HAPPY_RELAY_URL: &str = "https://api.cluster-fluster.com";
const MAX_RESTART_ATTEMPTS: u32 = 3;
const MAX_BACKOFF_SECONDS: u64 = 30;
const STOP_GRACE_PERIOD: Duration = Duration::from_secs(5);
const SUPERVISOR_NOTIFY_TIMEOUT: Duration = Duration::from_millis(500);
// Identity retirement first waits for any in-flight provider spawn/session
// creation, then may need one final relay lookup and deactivation. Keep the
// Rust deadline above that combined worst case so a completed reset is not
// mistaken for a failure and followed by revival of the old identity.
const IDENTITY_RESET_TIMEOUT: Duration = Duration::from_secs(180);
const BRIDGE_READY_TIMEOUT: Duration = Duration::from_secs(15);
const KILL_LOCK_ATTEMPTS: u32 = 20;
const KILL_LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);
const STATUS_EVENT: &str = "happy-bridge://status";
const PAIRING_EVENT: &str = "happy-bridge://pairing";
const CREDENTIAL_ACCOUNT: &str = "happy-bridge-pairing-credential";
const SESSION_KEY_STORE_FILENAME: &str = "happy-session-keys.v1.json";
const SESSION_KEY_STORE_RESET_FILENAME: &str = "happy-session-keys.v1.reset-pending";

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
    generation: u64,
    spawned_at: Instant,
    restart_budget_rearmed: bool,
}

pub struct HappyBridgeManager {
    lifecycle: Mutex<()>,
    process: Arc<Mutex<Option<HappyBridgeProcess>>>,
    monitor_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    status: Arc<Mutex<HappyBridgeStatus>>,
    // Restart accounting is independent of the output/credential gates below.
    // Credential mutation is always acquired before the output gate.
    restart_attempts: Arc<Mutex<u32>>,
    stopping: Arc<AtomicBool>,
    pairing_payload: Arc<Mutex<Option<String>>>,
    identity_reset_result: Mutex<Option<(String, bool)>>,
    process_generation: AtomicU64,
    output_gate: Mutex<()>,
    credential_mutation: Mutex<()>,
}

impl HappyBridgeManager {
    pub fn new() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            process: Arc::new(Mutex::new(None)),
            monitor_handle: Mutex::new(None),
            status: Arc::new(Mutex::new(HappyBridgeStatus {
                state: HappyBridgeState::Stopped,
                detail: None,
            })),
            restart_attempts: Arc::new(Mutex::new(0)),
            stopping: Arc::new(AtomicBool::new(false)),
            pairing_payload: Arc::new(Mutex::new(None)),
            identity_reset_result: Mutex::new(None),
            process_generation: AtomicU64::new(0),
            output_gate: Mutex::new(()),
            credential_mutation: Mutex::new(()),
        }
    }

    fn is_process_generation_current(&self, generation: u64) -> bool {
        self.process_generation.load(Ordering::Acquire) == generation
    }

    fn require_current_process_generation(&self, generation: u64) -> Result<(), String> {
        self.is_process_generation_current(generation)
            .then_some(())
            .ok_or_else(|| "stale Happy bridge process".to_string())
    }

    fn require_process_write_allowed(&self, generation: u64) -> Result<(), String> {
        if self.stopping.load(Ordering::Acquire) {
            return Err("Happy bridge is stopping".to_string());
        }
        self.require_current_process_generation(generation)
    }

    async fn advance_process_generation(&self) -> u64 {
        // Notification handlers hold this gate while checking their generation
        // and updating Rust state, so advancing here is a hard boundary: no
        // notification from the previous child can commit after this returns.
        let _output = self.output_gate.lock().await;
        self.process_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
    }

    async fn invalidate_process_generation_if_current(&self, generation: u64) {
        let _output = self.output_gate.lock().await;
        if self.is_process_generation_current(generation) {
            self.process_generation.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.start_inner(app).await
    }

    async fn start_inner(&self, app: &AppHandle) -> Result<(), String> {
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
        self.stopping.store(false, Ordering::Release);
        *self.restart_attempts.lock().await = 0;
        if let Err(error) = self.start_process(app).await {
            self.set_status(app, HappyBridgeState::Error, Some(error.clone()))
                .await;
            return Err(error);
        }

        self.ensure_monitor(app.clone()).await;
        Ok(())
    }

    async fn restart_from_monitor(&self, app: &AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        if self.stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        {
            let mut guard = self.process.lock().await;
            if let Some(process) = guard.as_mut()
                && process
                    .child
                    .try_wait()
                    .map_err(|error| format!("Failed checking Happy bridge: {error}"))?
                    .is_none()
            {
                return Ok(());
            }
            *guard = None;
        }
        self.start_process(app).await
    }

    async fn start_process(&self, app: &AppHandle) -> Result<(), String> {
        let generation = self.advance_process_generation().await;
        let provider_runtime = app
            .state::<crate::provider_runtime::ProviderRuntimeState>()
            .ensure_started(app)
            .await?;
        let node_binary = resolve_node_binary(app);
        let bridge_entry = find_happy_bridge_mjs()?;
        let pairing_credential = self.load_pairing_credential(app)?;
        if let Some(directory) = happy_home_dir(app) {
            reconcile_session_key_store_reset(&directory, pairing_credential.is_some())?;
        }
        let machine_identity = pairing_credential.map(|credential| {
            serde_json::from_str(&credential).unwrap_or_else(|_| Value::String(credential))
        });
        // Reuse the existing conversation reader as the source of recent project roots.
        // There is no separate Rust recent-project registry in this repository.
        // Agent conversations only, matching the set HappyRemoteSettings renders
        // checkboxes for. Including chat conversations advertised roots the user
        // was never shown and could not withdraw. #3144
        let discovered_roots = discovered_project_roots(
            crate::commands::chat::list_conversations(
                app.clone(),
                Some("agent".to_string()),
                None,
                None,
            )
            .await,
        )?;
        let advertised_roots =
            crate::commands::happy_bridge::effective_advertised_roots(app, discovered_roots);
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

        let mut command = Command::new(&node_binary);
        command
            .arg(&bridge_entry)
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let embedded_path = crate::embedded_runtime::get_embedded_path();
        if !embedded_path.is_empty() {
            command.env("PATH", embedded_path);
        }
        command.env("SEREN_EMBEDDED_NODE_BIN", &node_binary);
        // Left unset, the vendored Happy configuration roots itself at
        // `~/.happy` and appends to a per-start log file there unconditionally.
        // That sits outside app data, outside log retention, and outside
        // support-report redaction, so the whole tree is relocated under the
        // app's own directory.
        if let Some(happy_home) = happy_home_dir(app) {
            match std::fs::create_dir_all(&happy_home) {
                Ok(()) => {
                    command.env("HAPPY_HOME_DIR", &happy_home);
                }
                Err(error) => {
                    log::warn!("[HappyBridge] Failed to create Happy home dir: {error}");
                }
            }
        }
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
        notify_supervisor(
            &stdin,
            json!({
                "jsonrpc": "2.0",
                "method": "roots_update",
                "params": { "roots": advertised_roots },
            }),
        )
        .await
        .map_err(|error| format!("Failed to advertise Happy project folders: {error}"))?;
        pipe_bridge_output(&mut child, Arc::clone(&stdin), app.clone(), generation);
        let mut guard = self.process.lock().await;
        // `stop()` can take the process slot while a start is still in flight.
        // Storing the child now would leave a live bridge accepting inbound
        // requests behind a "Stopped" status, so discard it instead.
        if self.stopping.load(Ordering::Acquire) {
            drop(guard);
            let _ = child.kill().await;
            return Ok(());
        }
        *guard = Some(HappyBridgeProcess {
            child,
            _stdin: stdin,
            generation,
            spawned_at: Instant::now(),
            restart_budget_rearmed: false,
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
        let restart_attempts = Arc::clone(&self.restart_attempts);
        let stopping = Arc::clone(&self.stopping);
        *guard = Some(tokio::spawn(async move {
            monitor_process(app, process, status, restart_attempts, stopping).await;
        }));
    }

    pub async fn stop<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        self.stop_inner(app).await
    }

    async fn stop_inner<R: tauri::Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        self.stopping.store(true, Ordering::Release);
        if let Some(handle) = self.monitor_handle.lock().await.take() {
            handle.abort();
        }

        let process = self.process.lock().await.take();
        let terminate_result = if let Some(mut process) = process {
            let stdin = Arc::clone(&process._stdin);
            terminate_child(&mut process.child, Some(&stdin)).await
        } else {
            Ok(())
        };
        // Keep this exact child generation current while its graceful close
        // drains correlated cleanup RPCs. The lifecycle lock prevents a
        // replacement child from starting until termination completes.
        self.advance_process_generation().await;
        terminate_result?;
        // A pairing payload is only usable while the process that minted it is
        // alive, because the matching secret key lives in that process. Drop it
        // so a restart cannot hand back a code whose secret half is gone.
        *self.pairing_payload.lock().await = None;
        self.set_status(app, HappyBridgeState::Stopped, None).await;
        Ok(())
    }

    pub async fn status(&self) -> HappyBridgeStatus {
        self.status.lock().await.clone()
    }

    pub async fn process_exists(&self) -> bool {
        self.process
            .lock()
            .await
            .as_ref()
            .and_then(|process| process.child.id())
            .is_some()
    }

    async fn wait_until_running(&self) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + BRIDGE_READY_TIMEOUT;
        loop {
            let status = self.status().await;
            match status.state {
                HappyBridgeState::Running => return Ok(()),
                HappyBridgeState::Error => {
                    return Err(status
                        .detail
                        .unwrap_or_else(|| "Happy bridge failed to start".to_string()));
                }
                HappyBridgeState::Stopped | HappyBridgeState::Starting => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Happy bridge did not become ready for identity reset".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn request_identity_retirement(&self) -> Result<(), String> {
        let stdin = {
            let guard = self.process.lock().await;
            let Some(process) = guard.as_ref() else {
                return Err("Happy bridge is not running".to_string());
            };
            Arc::clone(&process._stdin)
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        *self.identity_reset_result.lock().await = None;
        notify_supervisor(
            &stdin,
            json!({
                "jsonrpc": "2.0",
                "method": "identity_reset",
                "params": { "requestId": request_id },
            }),
        )
        .await?;

        let deadline = tokio::time::Instant::now() + IDENTITY_RESET_TIMEOUT;
        loop {
            if let Some(success) = matching_identity_reset_result(
                self.identity_reset_result.lock().await.take(),
                &request_id,
            ) {
                return if success {
                    Ok(())
                } else {
                    Err(
                        "Happy could not retire every remote session; check the network and retry"
                            .to_string(),
                    )
                };
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Happy session retirement timed out; check the network and retry".to_string(),
                );
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn record_identity_reset_result(
        &self,
        generation: u64,
        request_id: String,
        success: bool,
    ) {
        let _output = self.output_gate.lock().await;
        if !self.is_process_generation_current(generation) {
            return;
        }
        *self.identity_reset_result.lock().await = Some((request_id, success));
    }

    async fn restore_after_failed_reset(
        &self,
        app: &AppHandle,
        was_running: bool,
        reset_error: String,
    ) -> Result<(), String> {
        let stop_error = self.stop_inner(app).await.err();
        let restart_error = if was_running {
            self.start_inner(app).await.err()
        } else {
            None
        };
        let failures = [stop_error, restart_error]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if failures.is_empty() {
            Err(reset_error)
        } else {
            Err(format!(
                "{reset_error}; bridge recovery failed: {}",
                failures.join("; ")
            ))
        }
    }

    pub async fn reset_identity(&self, app: &AppHandle) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().await;
        // Keep the credential check, remote retirement, child stop and keychain
        // deletion in one mutation transaction. A store already in progress
        // finishes before this check; a later store is rejected until stop has
        // invalidated its child generation.
        let _credential_mutation = self.credential_mutation.lock().await;
        if self.load_pairing_credential(app)?.is_none() {
            self.stop_inner(app).await?;
            return self.delete_pairing_identity_transaction(app);
        }
        let was_running = self.process_exists().await;
        if !was_running {
            self.start_inner(app).await?;
        }
        if let Err(error) = self.wait_until_running().await {
            return self
                .restore_after_failed_reset(app, was_running, error)
                .await;
        }

        // Prevent the monitor from replacing the old-identity process while its
        // sessions are being retired and the credential transaction is pending.
        self.stopping.store(true, Ordering::Release);
        if let Err(error) = self.request_identity_retirement().await {
            return self
                .restore_after_failed_reset(app, was_running, error)
                .await;
        }
        if let Err(error) = self.stop_inner(app).await {
            return self
                .restore_after_failed_reset(app, was_running, error)
                .await;
        }
        if let Err(error) = self.delete_pairing_identity_transaction(app) {
            if was_running {
                let _ = self.start_inner(app).await;
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn update_roots(&self, roots: Vec<String>) -> Result<(), String> {
        // The stdin handle is cloned out and the process lock released before
        // writing. A bridge that is alive but not draining stdin blocks the
        // write once the pipe buffer fills, and holding the lock across that
        // would wedge `stop`, `process_exists` and the monitor loop with it.
        let stdin = {
            let guard = self.process.lock().await;
            let Some(process) = guard.as_ref() else {
                return Err("Happy bridge is not running".to_string());
            };
            Arc::clone(&process._stdin)
        };
        notify_supervisor(
            &stdin,
            json!({
                "jsonrpc": "2.0",
                "method": "roots_update",
                "params": { "roots": roots },
            }),
        )
        .await
    }

    pub async fn retire_provider_session(&self, provider_session_id: &str) -> Result<(), String> {
        let stdin = {
            let guard = self.process.lock().await;
            let Some(process) = guard.as_ref() else {
                return Err("Happy bridge is not running".to_string());
            };
            Arc::clone(&process._stdin)
        };
        notify_supervisor(
            &stdin,
            json!({
                "jsonrpc": "2.0",
                "method": "provider_session_retire",
                "params": { "providerSessionId": provider_session_id },
            }),
        )
        .await
    }

    /// Tells a running bridge to abandon an in-flight pairing wait, and drops any
    /// payload already minted so it cannot be handed out afterwards.
    pub async fn cancel_pairing(&self) -> Result<(), String> {
        let stdin = {
            let guard = self.process.lock().await;
            guard.as_ref().map(|process| Arc::clone(&process._stdin))
        };
        *self.pairing_payload.lock().await = None;
        // A bridge that never received the cancellation is still willing to
        // authorize whoever scanned the code, so the caller has to hear about a
        // failed write rather than see the dialog close on a lie.
        let Some(stdin) = stdin else { return Ok(()) };
        notify_supervisor(
            &stdin,
            json!({ "jsonrpc": "2.0", "method": "cancel_pairing" }),
        )
        .await
    }

    pub async fn wait_for_pairing_payload(&self) -> Result<String, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(payload) = self.pairing_payload.lock().await.take() {
                return Ok(payload);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("Happy pairing payload was not produced".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn record_status_report<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        generation: u64,
        state: Option<String>,
        detail: Option<String>,
    ) {
        let _output = self.output_gate.lock().await;
        if !self.is_process_generation_current(generation) {
            return;
        }
        // The restart budget is refunded only by sustained uptime (see
        // `should_rearm`). A connection report says startup succeeded once, not
        // that the process is durable, so refunding here would let a bridge that
        // connects and immediately dies respawn forever.
        let mut status = self.status.lock().await;
        if let Some(next_state) = report_state(state.as_deref()) {
            status.state = next_state;
        } else if detail.as_deref() == Some("Connected") {
            status.state = HappyBridgeState::Running;
        }
        status.detail = detail;
        let _ = app.emit(STATUS_EVENT, status.clone());
    }

    async fn record_pairing_payload<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        generation: u64,
        payload: String,
    ) {
        let _output = self.output_gate.lock().await;
        if !self.is_process_generation_current(generation) {
            return;
        }
        *self.pairing_payload.lock().await = Some(payload.clone());
        let _ = app.emit(PAIRING_EVENT, payload);
    }

    async fn store_pairing_credential_for_generation(
        &self,
        app: &AppHandle,
        generation: u64,
        credential: &str,
    ) -> Result<(), String> {
        self.require_process_write_allowed(generation)?;
        // Do not await this lock from the stdout dispatcher. During reset the
        // same dispatcher must remain free to consume identity_reset_result.
        let _credential_mutation = self
            .credential_mutation
            .try_lock()
            .map_err(|_| "pairing credential reset is in progress".to_string())?;
        let _output = self.output_gate.lock().await;
        self.require_process_write_allowed(generation)?;
        self.store_pairing_credential(app, credential)
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

    fn delete_pairing_identity_transaction(&self, app: &AppHandle) -> Result<(), String> {
        let directory = happy_home_dir(app)
            .ok_or_else(|| "failed to resolve Happy session key store directory".to_string())?;
        let credential_present = self.load_pairing_credential(app)?.is_some();
        reconcile_session_key_store_reset(&directory, credential_present)?;
        reset_session_key_store_transaction(&directory, || self.delete_pairing_credential(app))
    }

    async fn set_status<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        state: HappyBridgeState,
        detail: Option<String>,
    ) {
        let status = HappyBridgeStatus { state, detail };
        *self.status.lock().await = status.clone();
        let _ = app.emit(STATUS_EVENT, status);
    }

    pub fn kill_sync(&self) {
        self.process_generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut guard) = self.monitor_handle.try_lock() {
            if let Some(handle) = guard.take() {
                handle.abort();
            }
        }
        // The monitor loop takes this same lock every 2s, so a single `try_lock`
        // can lose the race. Tauri exits via `process::exit`, which skips
        // `Drop`/`kill_on_drop`, and a missed kill leaves an orphaned bridge
        // holding the relay connection after the app is gone.
        let mut process_guard = None;
        for _ in 0..KILL_LOCK_ATTEMPTS {
            if let Ok(guard) = self.process.try_lock() {
                process_guard = Some(guard);
                break;
            }
            std::thread::sleep(KILL_LOCK_RETRY_DELAY);
        }
        let Some(mut guard) = process_guard else {
            log::warn!("[HappyBridge] Could not acquire process lock; bridge may be orphaned");
            return;
        };
        {
            if let Some(process) = guard.as_ref() {
                if let Some(pid) = process.child.id() {
                    log::info!("[HappyBridge] Killing bridge pid {pid}");
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
    restart_attempts: Arc<Mutex<u32>>,
    stopping: Arc<AtomicBool>,
) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let (exited, should_rearm, exited_generation) = {
            let mut guard = process.lock().await;
            match guard.as_mut() {
                None => {
                    if stopping.load(Ordering::Acquire) {
                        return;
                    }
                    (true, false, None)
                }
                Some(process) => match process.child.try_wait() {
                    Ok(None) => {
                        let rearm = should_rearm(
                            process.spawned_at,
                            process.restart_budget_rearmed,
                            Instant::now(),
                        );
                        if rearm {
                            process.restart_budget_rearmed = true;
                        }
                        (false, rearm, None)
                    }
                    Ok(Some(_)) => {
                        let generation = process.generation;
                        *guard = None;
                        (true, false, Some(generation))
                    }
                    Err(error) => {
                        log::warn!("[HappyBridge] Failed checking process status: {error}");
                        (false, false, None)
                    }
                },
            }
        };
        if let Some(generation) = exited_generation {
            app.state::<HappyBridgeManager>()
                .invalidate_process_generation_if_current(generation)
                .await;
        }
        if should_rearm {
            *restart_attempts.lock().await = 0;
        }
        let exited = exited;
        if !exited {
            continue;
        }

        let (attempt, exhausted) = {
            let mut attempts = restart_attempts.lock().await;
            match next_restart_attempt(*attempts) {
                Some(next) => {
                    *attempts = next;
                    (next, false)
                }
                None => (0, true),
            }
        };
        if exhausted {
            let failed = HappyBridgeStatus {
                state: HappyBridgeState::Error,
                detail: Some("restart budget exhausted".to_string()),
            };
            {
                let mut current = status.lock().await;
                *current = failed.clone();
            };
            let _ = app.emit(STATUS_EVENT, failed);
            return;
        }
        let delay = restart_delay(attempt - 1);
        {
            let mut current = status.lock().await;
            current.state = HappyBridgeState::Starting;
            current.detail = Some(format!("restart attempt {attempt}/{MAX_RESTART_ATTEMPTS}"));
            let _ = app.emit(STATUS_EVENT, current.clone());
        }
        tokio::time::sleep(delay).await;

        let manager = app.state::<HappyBridgeManager>();
        if let Err(error) = manager.restart_from_monitor(&app).await {
            if attempt >= MAX_RESTART_ATTEMPTS {
                let failed = HappyBridgeStatus {
                    state: HappyBridgeState::Error,
                    detail: Some(error),
                };
                *status.lock().await = failed.clone();
                let _ = app.emit(STATUS_EVENT, failed);
            } else {
                log::warn!("[HappyBridge] Restart failed: {error}");
            }
        }
    }
}

/// Asks the bridge to shut down over the supervisor channel, then falls back to
/// signals only when that notification cannot be delivered. Windows has no
/// SIGTERM, so before this the child was never told to exit: every stop burned
/// the full grace period and was then hard-killed, skipping the relay disconnect
/// so the machine was left to time out. On unix, immediately signaling after a
/// successful notification is also unsafe: the signal handler could win the
/// race and lose the explicit-disable retirement flag carried by the request.
async fn terminate_child(
    child: &mut Child,
    stdin: Option<&Arc<Mutex<ChildStdin>>>,
) -> Result<(), String> {
    let shutdown_notified = if let Some(stdin) = stdin {
        // Bounded: a wedged bridge that is not draining stdin must not stall the
        // stop path, which is exactly the deadlock the grace period exists for.
        // The signal and kill fallbacks below cover a failed write.
        notify_supervisor(stdin, shutdown_notification())
            .await
            .is_ok()
    } else {
        false
    };

    #[cfg(unix)]
    if !shutdown_notified {
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
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

fn shutdown_notification() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "shutdown",
    })
}

fn restart_delay(attempt: u32) -> Duration {
    let seconds = 2u64.saturating_pow(attempt).min(MAX_BACKOFF_SECONDS);
    Duration::from_secs(seconds)
}

fn restart_allowed(attempts: u32) -> bool {
    attempts < MAX_RESTART_ATTEMPTS
}

fn next_restart_attempt(attempts: u32) -> Option<u32> {
    restart_allowed(attempts).then_some(attempts + 1)
}

fn report_state(state: Option<&str>) -> Option<HappyBridgeState> {
    match state {
        Some("connected") => Some(HappyBridgeState::Running),
        Some("error") => Some(HappyBridgeState::Error),
        _ => None,
    }
}

fn matching_identity_reset_result(
    result: Option<(String, bool)>,
    expected_request_id: &str,
) -> Option<bool> {
    result.and_then(|(request_id, success)| (request_id == expected_request_id).then_some(success))
}

fn should_rearm(spawned_at: Instant, already_rearmed: bool, now: Instant) -> bool {
    !already_rearmed && now.duration_since(spawned_at) >= Duration::from_secs(60)
}

/// Keeps the vendored Happy client's state and logs inside the app's own data
/// directory rather than `~/.happy`.
fn happy_home_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("happy-bridge"))
}

#[cfg(unix)]
fn sync_directory(directory: &std::path::Path) -> Result<(), String> {
    std::fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to sync Happy session-key directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn stage_session_key_store_reset(directory: &std::path::Path) -> Result<bool, String> {
    let store = directory.join(SESSION_KEY_STORE_FILENAME);
    let staged = directory.join(SESSION_KEY_STORE_RESET_FILENAME);
    if staged.exists() {
        return Err("Happy session-key reset is already pending".to_string());
    }
    if !store.exists() {
        return Ok(false);
    }
    std::fs::rename(&store, &staged)
        .map_err(|error| format!("failed to stage Happy session keys for reset: {error}"))?;
    sync_directory(directory)?;
    Ok(true)
}

fn restore_staged_session_key_store(directory: &std::path::Path) -> Result<(), String> {
    let store = directory.join(SESSION_KEY_STORE_FILENAME);
    let staged = directory.join(SESSION_KEY_STORE_RESET_FILENAME);
    if store.exists() {
        return Err("Happy session-key store already exists while restoring reset".to_string());
    }
    std::fs::rename(&staged, &store)
        .map_err(|error| format!("failed to restore Happy session keys: {error}"))?;
    sync_directory(directory)
}

fn finish_session_key_store_reset(directory: &std::path::Path) -> Result<(), String> {
    let staged = directory.join(SESSION_KEY_STORE_RESET_FILENAME);
    match std::fs::remove_file(&staged) {
        Ok(()) => sync_directory(directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove reset Happy session keys: {error}"
        )),
    }
}

fn reconcile_session_key_store_reset(
    directory: &std::path::Path,
    credential_present: bool,
) -> Result<(), String> {
    let staged = directory.join(SESSION_KEY_STORE_RESET_FILENAME);
    if !staged.exists() {
        return Ok(());
    }
    if credential_present {
        restore_staged_session_key_store(directory)
    } else {
        finish_session_key_store_reset(directory)
    }
}

fn reset_session_key_store_transaction<F>(
    directory: &std::path::Path,
    delete_credential: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let staged = stage_session_key_store_reset(directory)?;
    if let Err(error) = delete_credential() {
        if staged {
            restore_staged_session_key_store(directory).map_err(|restore_error| {
                format!("{error}; failed to restore Happy session keys: {restore_error}")
            })?;
        }
        return Err(error);
    }
    if staged && let Err(error) = finish_session_key_store_reset(directory) {
        // The credential is already gone and every relay row was confirmed
        // inactive. Leaving the encrypted tombstone is safe; startup sees
        // there is no old credential and retries this unlink.
        log::warn!("[HappyBridge] Failed to remove reset session-key tombstone: {error}");
    }
    Ok(())
}

fn resolve_node_binary(app: &AppHandle) -> PathBuf {
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);
    if let Some(node) = crate::embedded_runtime::embedded_node_binary(&paths) {
        return node;
    }

    log::warn!(
        "[HappyBridge] Bundled node not found under {:?}; falling back to the user's system \
         node. The bridge will run on an unmanaged node version, or fail to spawn at all if \
         the machine has none. Fix: run `pnpm prepare:runtime:{}`.",
        paths.node_dir,
        crate::embedded_runtime::platform_subdir()
    );
    crate::embedded_runtime::system_node_fallback()
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

/// Mirrors `validate.mjs`: an advertised root must match after canonicalization,
/// so symlink escapes and `..` traversal are both rejected. Fails closed when no
/// roots are advertised or a path cannot be resolved.
fn is_advertised_root<R: tauri::Runtime>(app: &AppHandle<R>, cwd: &str) -> bool {
    let Ok(candidate) = std::fs::canonicalize(cwd) else {
        return false;
    };
    crate::commands::happy_bridge::saved_advertised_roots(app)
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| root == candidate)
}

/// Serialize an already-canonical path in the same form Node's `realpath`
/// returns. Windows' Rust canonicalizer uses verbatim paths (`\\?\C:\...` or
/// `\\?\UNC\...`), while Node returns ordinary DOS/UNC paths. This conversion
/// also applies the NFC normalization used by `canonicalAbsolutePath` in
/// `validate.mjs`. It is intentionally wire-only: authorization and symlink
/// checks continue to compare canonical `PathBuf`s before reaching this
/// function.
fn canonical_path_for_wire(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
    };
    Some(path.nfc().collect())
}

/// Resolve the two root columns written for a Happy-originated conversation to
/// one exact, currently authorized canonical directory. Requiring both columns
/// prevents a partially overwritten desktop row from choosing whichever path
/// happens to remain usable.
fn canonical_happy_restoration_root<R: tauri::Runtime>(
    app: &AppHandle<R>,
    agent_cwd: &str,
    project_root: &str,
) -> Option<String> {
    let agent_cwd = std::fs::canonicalize(agent_cwd).ok()?;
    let project_root = std::fs::canonicalize(project_root).ok()?;
    if agent_cwd != project_root {
        return None;
    }
    let authorized = crate::commands::happy_bridge::saved_advertised_roots(app)
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| root == agent_cwd);
    if !authorized {
        return None;
    }
    canonical_path_for_wire(&agent_cwd)
}

/// The distinct project folders behind the user's agent conversations, in the
/// order they were seen. A failed lookup is reported rather than absorbed: an
/// empty set is also what a user with no projects has, so absorbing it started a
/// bridge that reported connected and then refused every remote spawn.
fn discovered_project_roots(
    conversations: Result<Vec<crate::commands::chat::UnifiedConversationRow>, String>,
) -> Result<Vec<String>, String> {
    let conversations =
        conversations.map_err(|error| format!("Failed to read Happy project folders: {error}"))?;
    Ok(conversations
        .into_iter()
        .filter_map(|conversation| conversation.project_root.or(conversation.agent_cwd))
        .fold(Vec::<String>::new(), |mut roots, root| {
            if !roots.iter().any(|existing| existing == &root) {
                roots.push(root);
            }
            roots
        }))
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
        "conversation_create"
            | "conversation_archive"
            | "conversation_delete"
            | "conversation_happy_session_lookup"
            | "conversation_lookup"
            | "conversation_restore_candidates"
            | "conversation_migrate_happy_session"
            | "conversation_claim"
            | "conversation_owner_lookup"
            | "provider_session_archive"
            | "provider_session_archive_lookup"
            | "identity_store"
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

fn required_uuid(params: &Value, key: &str) -> Result<String, String> {
    let value = required_string(params, key)?;
    uuid::Uuid::parse_str(&value).map_err(|_| format!("{key} must be a UUID"))?;
    Ok(value)
}

fn required_nullable_string(params: &Value, key: &str) -> Result<Option<String>, String> {
    match params.get(key) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        _ => Err(format!("{key} must be a non-empty string or null")),
    }
}

async fn dispatch_supervisor_request(
    app: &AppHandle,
    request: SupervisorRequest,
    generation: u64,
) -> Result<Value, String> {
    match request.method.as_str() {
        "conversation_create" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            let agent_type = required_string(&request.params, "agentType")?;
            let cwd = required_string(&request.params, "cwd")?;
            let title = required_string(&request.params, "title")?;
            // The bridge is the process parsing attacker-controlled relay
            // traffic, so its advertised-root check is re-run here rather than
            // trusted. Defense in depth for remote session spawn.
            if !is_advertised_root(app, &cwd) {
                return Err("cwd is not an advertised root".to_string());
            }
            let happy_session_id = required_string(&request.params, "happySessionId")?;
            let metadata = serde_json::to_string(&json!({
                "happy_session_id": happy_session_id,
            }))
            .map_err(|error| error.to_string())?;
            let conversation = crate::commands::chat::create_agent_conversation_record(
                app.clone(),
                conversation_id,
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
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            let happy_session_id = required_string(&request.params, "happySessionId")?;
            let lookup = crate::commands::chat::lookup_happy_restoration_candidate(
                app.clone(),
                provider_session_id,
                happy_session_id,
            )
            .await?;
            Ok(match lookup {
                crate::commands::chat::HappyRestorationLookup::NotHappyOrigin => json!({
                    "restorable": false,
                    "happyOrigin": false,
                    "retire": false,
                }),
                crate::commands::chat::HappyRestorationLookup::InvalidHappyOrigin {
                    is_archived,
                } => json!({
                    "restorable": false,
                    "happyOrigin": true,
                    "retire": true,
                    "archived": is_archived,
                }),
                crate::commands::chat::HappyRestorationLookup::Candidate(conversation)
                    if conversation.is_archived =>
                {
                    json!({
                        "restorable": false,
                        "happyOrigin": true,
                        "retire": true,
                        "archived": true,
                    })
                }
                crate::commands::chat::HappyRestorationLookup::Candidate(conversation) => {
                    match canonical_happy_restoration_root(
                        app,
                        &conversation.agent_cwd,
                        &conversation.project_root,
                    ) {
                        Some(cwd) => json!({
                            "restorable": true,
                            "happyOrigin": true,
                            "retire": false,
                            "conversationId": conversation.conversation_id,
                            "agentSessionId": conversation.agent_session_id,
                            "agentModelId": conversation.agent_model_id,
                            "agentPermissionMode": conversation.agent_permission_mode,
                            "cwd": cwd,
                            "agentType": conversation.agent_type,
                            "title": conversation.title,
                            "archived": false,
                        }),
                        None => json!({
                            "restorable": false,
                            "happyOrigin": true,
                            "retire": true,
                            "archived": false,
                        }),
                    }
                }
            })
        }
        "conversation_restore_candidates" => {
            let candidates =
                crate::commands::chat::list_legacy_happy_restoration_candidates(app.clone())
                    .await?;
            let candidates = candidates
                .into_iter()
                .filter_map(|candidate| {
                    let conversation = candidate.conversation;
                    let cwd = canonical_happy_restoration_root(
                        app,
                        &conversation.agent_cwd,
                        &conversation.project_root,
                    )?;
                    Some(json!({
                        "conversationId": conversation.conversation_id,
                        "happySessionId": candidate.happy_session_id,
                        "agentSessionId": conversation.agent_session_id,
                        "agentModelId": conversation.agent_model_id,
                        "agentPermissionMode": conversation.agent_permission_mode,
                        "cwd": cwd,
                        "agentType": conversation.agent_type,
                        "title": conversation.title,
                    }))
                })
                .collect::<Vec<_>>();
            Ok(json!({ "candidates": candidates }))
        }
        "conversation_migrate_happy_session" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            let expected_happy_session_id =
                required_string(&request.params, "expectedHappySessionId")?;
            let replacement_happy_session_id =
                required_string(&request.params, "replacementHappySessionId")?;
            let migrated = crate::commands::chat::migrate_happy_restoration_relay(
                app.clone(),
                conversation_id,
                expected_happy_session_id,
                replacement_happy_session_id,
            )
            .await?;
            if !migrated {
                return Err("Happy relay migration was rejected".to_string());
            }
            Ok(json!({ "migrated": true }))
        }
        "conversation_claim" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            if conversation_id != provider_session_id {
                return Err("Happy restoration claim was rejected".to_string());
            }
            let happy_session_id = required_string(&request.params, "happySessionId")?;
            let cwd = required_string(&request.params, "cwd")?;
            let expected_agent_type = required_string(&request.params, "expectedAgentType")?;
            let expected_agent_session_id =
                required_nullable_string(&request.params, "expectedAgentSessionId")?;
            let expected_agent_permission_mode =
                required_nullable_string(&request.params, "expectedAgentPermissionMode")?;
            let agent_session_id = request
                .params
                .get("agentSessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned);
            let lookup = crate::commands::chat::lookup_happy_restoration_candidate(
                app.clone(),
                provider_session_id.clone(),
                happy_session_id.clone(),
            )
            .await?;
            let crate::commands::chat::HappyRestorationLookup::Candidate(conversation) = lookup
            else {
                return Err("Happy restoration claim was rejected".to_string());
            };
            if !conversation.is_archived {
                let canonical_root = canonical_happy_restoration_root(
                    app,
                    &conversation.agent_cwd,
                    &conversation.project_root,
                )
                .ok_or_else(|| "Happy restoration root is no longer authorized".to_string())?;
                if cwd != canonical_root {
                    return Err("Happy restoration root changed before claim".to_string());
                }
            }
            let claim = crate::commands::chat::claim_restored_happy_provider_session_owner(
                app.clone(),
                conversation_id,
                provider_session_id,
                happy_session_id,
                agent_session_id,
                expected_agent_type,
                expected_agent_session_id,
                expected_agent_permission_mode,
                conversation.agent_cwd,
                conversation.project_root,
            )
            .await?;
            Ok(json!({ "archived": claim.archived }))
        }
        "conversation_happy_session_lookup" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            let happy_session_id = crate::commands::chat::lookup_happy_session_id_by_conversation(
                app.clone(),
                conversation_id,
            )
            .await?;
            Ok(match happy_session_id {
                Some(happy_session_id) => json!({ "happySessionId": happy_session_id }),
                None => json!({}),
            })
        }
        "conversation_owner_lookup" => {
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            let agent_session_id = request
                .params
                .get("agentSessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned);
            let conversation_id = crate::commands::chat::lookup_agent_conversation_owner(
                app.clone(),
                provider_session_id,
                agent_session_id,
            )
            .await?;
            Ok(match conversation_id {
                Some(conversation_id) => json!({ "conversationId": conversation_id }),
                None => json!({}),
            })
        }
        "provider_session_archive" => {
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            crate::commands::chat::archive_happy_provider_session_from_happy(
                app.clone(),
                provider_session_id,
            )
            .await?;
            Ok(json!({ "archived": true }))
        }
        "provider_session_archive_lookup" => {
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            let archived = crate::commands::chat::is_happy_provider_session_archived(
                app.clone(),
                provider_session_id,
            )
            .await?;
            Ok(json!({ "archived": archived }))
        }
        "conversation_archive" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            let provider_session_id = required_uuid(&request.params, "providerSessionId")?;
            crate::commands::chat::archive_agent_conversation_from_happy(
                app.clone(),
                conversation_id,
                provider_session_id,
            )
            .await?;
            Ok(json!({ "archived": true }))
        }
        "conversation_delete" => {
            let conversation_id = required_uuid(&request.params, "conversationId")?;
            crate::commands::chat::delete_conversation(app.clone(), conversation_id).await?;
            Ok(json!({ "deleted": true }))
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
                .store_pairing_credential_for_generation(app, generation, &credential)
                .await?;
            Ok(json!({ "stored": true }))
        }
        _ => Err("unknown supervisor method".to_string()),
    }
}

async fn dispatch_supervisor_line(
    app: &AppHandle,
    line: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    generation: u64,
) {
    let manager = app.state::<HappyBridgeManager>();
    if !manager.is_process_generation_current(generation) {
        return;
    }
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        if let Some(object) = value.as_object()
            && object.get("id").is_none()
            && let Some(method) = object.get("method").and_then(Value::as_str)
        {
            let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
            match method {
                "status_report" => {
                    let state = params
                        .get("state")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    let detail = params
                        .get("detail")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned);
                    manager
                        .record_status_report(app, generation, state, detail)
                        .await;
                }
                "pairing_payload" => {
                    if let Some(payload) = params.get("payload").and_then(Value::as_str) {
                        manager
                            .record_pairing_payload(app, generation, payload.to_string())
                            .await;
                    }
                }
                "identity_reset_result" => {
                    if let (Some(request_id), Some(success)) = (
                        params.get("requestId").and_then(Value::as_str),
                        params.get("success").and_then(Value::as_bool),
                    ) {
                        manager
                            .record_identity_reset_result(
                                generation,
                                request_id.to_string(),
                                success,
                            )
                            .await;
                    }
                }
                _ => {}
            }
            return;
        }
    }

    let response = match parse_supervisor_line(line) {
        Err(response) => response,
        Ok(request) => {
            let id = request.id.clone();
            match dispatch_supervisor_request(app, request, generation).await {
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

/// Reports whether the notification actually reached the bridge. A caller that
/// changes shared state on the strength of a delivery — advertised folders,
/// an abandoned pairing — must not report success when the write failed.
async fn write_supervisor_notification<W>(
    writer: &Arc<Mutex<W>>,
    notification: Value,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let Ok(mut encoded) = serde_json::to_vec(&notification) else {
        log::warn!("[HappyBridge] Failed to encode supervisor notification");
        return Err("Failed to encode supervisor notification".to_string());
    };
    encoded.push(b'\n');
    let mut writer = writer.lock().await;
    if let Err(error) = writer.write_all(&encoded).await {
        log::warn!("[HappyBridge] Failed to write supervisor notification: {error}");
        return Err(format!("Failed to write supervisor notification: {error}"));
    }
    if let Err(error) = writer.flush().await {
        log::warn!("[HappyBridge] Failed to flush supervisor notification: {error}");
        return Err(format!("Failed to flush supervisor notification: {error}"));
    }
    Ok(())
}

/// Bounds a notification write. A bridge that is alive but not draining stdin
/// blocks the write once the pipe buffer fills, and the caller must fail rather
/// than hold its lock there forever.
async fn notify_supervisor<W>(writer: &Arc<Mutex<W>>, notification: Value) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    match tokio::time::timeout(
        SUPERVISOR_NOTIFY_TIMEOUT,
        write_supervisor_notification(writer, notification),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            log::warn!("[HappyBridge] Timed out writing supervisor notification");
            Err("Happy bridge did not accept the message".to_string())
        }
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

fn pipe_bridge_output(
    child: &mut Child,
    stdin: Arc<Mutex<ChildStdin>>,
    app: AppHandle,
    generation: u64,
) {
    if let Some(stdout) = child.stdout.take() {
        let stdout_stdin = Arc::clone(&stdin);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_bounded_line(&mut reader).await {
                    Ok(Some(BoundedLine::Complete(line))) => {
                        dispatch_supervisor_line(&app, &line, &stdout_stdin, generation).await;
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
                    // A single non-UTF-8 byte is a corrupt line, not a dead
                    // pipe. Breaking here left the child alive with its control
                    // channel silently dead while the UI still read Connected,
                    // so only a real read error ends the loop.
                    Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                        log::warn!("[HappyBridge] Discarded non-UTF-8 supervisor line");
                    }
                    Ok(None) => break,
                    Err(error) => {
                        log::warn!("[HappyBridge] Supervisor channel read failed: {error}");
                        app.state::<HappyBridgeManager>()
                            .record_status_report(
                                &app,
                                generation,
                                Some("error".to_string()),
                                Some("supervisor channel closed".to_string()),
                            )
                            .await;
                        break;
                    }
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(BoundedLine::Complete(line))) = read_bounded_line(&mut reader).await {
                // The bridge holds the relay token, the NaCl secret, and the
                // provider-runtime token. Its stderr is not a vetted channel, so
                // it stays out of the default log; status flows through
                // `status_report` instead.
                log::debug!("[HappyBridge] {line}");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedLine, HappyBridgeState, MAX_RESTART_ATTEMPTS, MAX_SUPERVISOR_LINE_BYTES,
        SESSION_KEY_STORE_FILENAME, SESSION_KEY_STORE_RESET_FILENAME,
        canonical_happy_restoration_root, canonical_path_for_wire, discovered_project_roots,
        error_response, is_advertised_root, matching_identity_reset_result, next_restart_attempt,
        notify_supervisor, parse_supervisor_line, read_bounded_line,
        reconcile_session_key_store_reset, report_state, required_nullable_string, required_uuid,
        reset_session_key_store_transaction, restart_allowed, restart_delay, should_rearm,
        stage_session_key_store_reset,
    };
    use crate::commands::happy_bridge::{ADVERTISED_ROOTS_KEY, SETTINGS_STORE};
    use serde_json::Value;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tauri_plugin_store::StoreExt;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

    /// The store persists to the mock runtime's data dir, which sibling tests on
    /// the same host share, so the key is always reset rather than assumed absent.
    fn mock_app_with_roots(roots: Option<Vec<String>>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let store = app.store(SETTINGS_STORE).expect("settings store opens");
        store.delete(ADVERTISED_ROOTS_KEY);
        if let Some(roots) = roots {
            store.set(ADVERTISED_ROOTS_KEY, serde_json::json!(roots));
        }
        app
    }

    #[test]
    fn remote_conversation_ids_must_be_preallocated_uuids() {
        let valid = serde_json::json!({
            "conversationId": "00000000-0000-4000-8000-000000000123"
        });
        assert_eq!(
            required_uuid(&valid, "conversationId").unwrap(),
            "00000000-0000-4000-8000-000000000123"
        );
        assert_eq!(
            required_uuid(
                &serde_json::json!({ "conversationId": "not-a-uuid" }),
                "conversationId"
            )
            .unwrap_err(),
            "conversationId must be a UUID"
        );
    }

    #[test]
    fn identity_reset_ack_must_match_the_pending_request() {
        assert_eq!(
            matching_identity_reset_result(Some(("expected".to_string(), true)), "expected"),
            Some(true)
        );
        assert_eq!(
            matching_identity_reset_result(Some(("stale".to_string(), true)), "expected"),
            None
        );
    }

    #[test]
    fn identity_reset_stages_and_restores_session_keys_transactionally() {
        let directory = tempfile::tempdir().unwrap();
        let binding_store = directory.path().join(SESSION_KEY_STORE_FILENAME);
        let staged = directory.path().join(SESSION_KEY_STORE_RESET_FILENAME);
        let unrelated = directory.path().join("unrelated.json");
        std::fs::write(&binding_store, "synthetic encrypted payload").unwrap();
        std::fs::write(&unrelated, "keep").unwrap();

        let error = reset_session_key_store_transaction(directory.path(), || {
            Err("synthetic credential deletion failure".to_string())
        })
        .unwrap_err();
        assert_eq!(error, "synthetic credential deletion failure");
        // A keychain-deletion failure leaves the old credential installed, so
        // the transaction must restore its only decryptable session-key store.
        assert!(binding_store.exists());
        assert!(!staged.exists());

        reset_session_key_store_transaction(directory.path(), || Ok(())).unwrap();
        assert!(!binding_store.exists());
        assert!(!staged.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn startup_reconciles_an_interrupted_identity_reset_from_credential_state() {
        let with_credential = tempfile::tempdir().unwrap();
        let store = with_credential.path().join(SESSION_KEY_STORE_FILENAME);
        std::fs::write(&store, "synthetic encrypted payload").unwrap();
        stage_session_key_store_reset(with_credential.path()).unwrap();
        reconcile_session_key_store_reset(with_credential.path(), true).unwrap();
        assert!(store.exists());

        let without_credential = tempfile::tempdir().unwrap();
        let store = without_credential.path().join(SESSION_KEY_STORE_FILENAME);
        std::fs::write(&store, "synthetic encrypted payload").unwrap();
        stage_session_key_store_reset(without_credential.path()).unwrap();
        reconcile_session_key_store_reset(without_credential.path(), false).unwrap();
        assert!(!store.exists());
    }

    #[tokio::test]
    async fn stopping_discards_the_pairing_payload_of_the_dead_process() {
        // Regression: the payload outlived the process that minted it, so
        // `happy_bridge_start_pairing`'s stop/start handed back a QR code whose
        // secret key had died with the previous bridge and pairing never completed.
        let app = mock_app_with_roots(None);
        let manager = super::HappyBridgeManager::new();
        let generation = manager.advance_process_generation().await;

        manager
            .record_pairing_payload(
                app.handle(),
                generation,
                "payload-from-bridge-a".to_string(),
            )
            .await;
        assert!(
            manager.pairing_payload.lock().await.is_some(),
            "the live bridge's payload is available before the stop"
        );

        manager.stop(app.handle()).await.expect("stop succeeds");

        // Asserted on the stored value rather than through
        // `wait_for_pairing_payload`, which would burn its full 10s deadline.
        assert!(
            manager.pairing_payload.lock().await.is_none(),
            "a payload minted by a stopped bridge must not be handed out"
        );
    }

    #[tokio::test]
    async fn stale_child_output_cannot_mutate_bridge_or_credentials() {
        let app = mock_app_with_roots(None);
        let manager = super::HappyBridgeManager::new();
        let stale_generation = manager.advance_process_generation().await;
        let current_generation = manager.advance_process_generation().await;

        manager
            .record_status_report(
                app.handle(),
                current_generation,
                Some("connected".to_string()),
                Some("Connected".to_string()),
            )
            .await;
        manager
            .record_status_report(
                app.handle(),
                stale_generation,
                Some("error".to_string()),
                Some("stale child".to_string()),
            )
            .await;
        assert!(matches!(
            manager.status().await.state,
            HappyBridgeState::Running
        ));

        manager
            .record_pairing_payload(
                app.handle(),
                current_generation,
                "current-payload".to_string(),
            )
            .await;
        manager
            .record_pairing_payload(app.handle(), stale_generation, "stale-payload".to_string())
            .await;
        assert_eq!(
            manager.pairing_payload.lock().await.as_deref(),
            Some("current-payload")
        );

        manager
            .record_identity_reset_result(current_generation, "current".to_string(), true)
            .await;
        manager
            .record_identity_reset_result(stale_generation, "stale".to_string(), false)
            .await;
        assert_eq!(
            manager.identity_reset_result.lock().await.as_ref(),
            Some(&("current".to_string(), true))
        );

        assert_eq!(
            manager
                .require_current_process_generation(stale_generation)
                .unwrap_err(),
            "stale Happy bridge process"
        );
    }

    #[tokio::test]
    async fn process_writes_are_rejected_while_stopping_and_after_generation_advance() {
        let manager = super::HappyBridgeManager::new();
        let generation = manager.advance_process_generation().await;
        assert!(manager.require_process_write_allowed(generation).is_ok());

        manager.stopping.store(true, Ordering::Release);
        assert_eq!(
            manager
                .require_process_write_allowed(generation)
                .expect_err("stopping rejects identity writes"),
            "Happy bridge is stopping",
        );

        manager.stopping.store(false, Ordering::Release);
        manager.advance_process_generation().await;
        assert_eq!(
            manager
                .require_process_write_allowed(generation)
                .expect_err("stale generations stay rejected"),
            "stale Happy bridge process",
        );
    }

    #[test]
    fn advertised_root_accepts_a_consented_root() {
        // Regression: the re-check intersected the saved roots against an empty
        // `discovered` set, so it returned false for every path and remote
        // session spawn failed unconditionally.
        let consented = tempfile::tempdir().expect("temp dir");
        let consented_path = consented.path().to_string_lossy().to_string();
        let app = mock_app_with_roots(Some(vec![consented_path.clone()]));

        assert!(
            is_advertised_root(app.handle(), &consented_path),
            "a root the user consented to must pass the spawn re-check"
        );
    }

    #[test]
    fn advertised_root_rejects_paths_outside_the_consented_set() {
        let consented = tempfile::tempdir().expect("temp dir");
        let sibling = tempfile::tempdir().expect("temp dir");
        let nested = consented.path().join("nested");
        std::fs::create_dir(&nested).expect("nested dir");

        let app = mock_app_with_roots(Some(vec![consented.path().to_string_lossy().to_string()]));

        let sibling_path = sibling.path().to_string_lossy().to_string();
        assert!(
            !is_advertised_root(app.handle(), &sibling_path),
            "an unrelated directory must be rejected"
        );

        // Membership is canonical equality, not prefix containment, so a
        // subdirectory of a consented root is still not itself a root.
        assert!(
            !is_advertised_root(app.handle(), &nested.to_string_lossy()),
            "a nested directory must not inherit its parent's consent"
        );

        // `..` traversal out of a consented root canonicalizes to the sibling.
        let escape = consented.path().join("..").join(
            sibling
                .path()
                .file_name()
                .expect("sibling has a final component"),
        );
        assert!(
            !is_advertised_root(app.handle(), &escape.to_string_lossy()),
            "traversal out of a consented root must be rejected"
        );
    }

    #[test]
    fn advertised_root_fails_closed_when_nothing_is_consented() {
        let candidate = tempfile::tempdir().expect("temp dir");
        let candidate_path = candidate.path().to_string_lossy().to_string();

        let unset = mock_app_with_roots(None);
        assert!(
            !is_advertised_root(unset.handle(), &candidate_path),
            "no saved roots must reject every path"
        );

        let empty = mock_app_with_roots(Some(Vec::new()));
        assert!(
            !is_advertised_root(empty.handle(), &candidate_path),
            "an empty consent list must reject every path"
        );
    }

    #[test]
    fn happy_restoration_requires_matching_canonical_advertised_root_columns() {
        let consented = tempfile::tempdir().expect("consented dir");
        let other = tempfile::tempdir().expect("other dir");
        let consented_path = consented.path().to_string_lossy().to_string();
        let other_path = other.path().to_string_lossy().to_string();
        let canonical =
            canonical_path_for_wire(&std::fs::canonicalize(consented.path()).unwrap()).unwrap();
        let app = mock_app_with_roots(Some(vec![consented_path.clone()]));

        assert_eq!(
            canonical_happy_restoration_root(app.handle(), &consented_path, &consented_path,),
            Some(canonical),
        );
        assert_eq!(
            canonical_happy_restoration_root(app.handle(), &consented_path, &other_path),
            None,
            "stored cwd and project root must resolve to the same exact consented directory",
        );
    }

    #[test]
    fn canonical_root_wire_format_matches_node_on_windows() {
        assert_eq!(
            canonical_path_for_wire(std::path::Path::new(r"\\?\C:\Users\Example\Project")),
            Some(r"C:\Users\Example\Project".to_string()),
        );
        assert_eq!(
            canonical_path_for_wire(std::path::Path::new(
                r"\\?\UNC\server.example\share\Project",
            )),
            Some(r"\\server.example\share\Project".to_string()),
        );
        assert_eq!(
            canonical_path_for_wire(std::path::Path::new(r"C:\Users\Example\Project")),
            Some(r"C:\Users\Example\Project".to_string()),
            "an ordinary Node-shaped path remains unchanged",
        );
    }

    #[test]
    fn canonical_root_wire_format_normalizes_decomposed_macos_paths() {
        assert_eq!(
            canonical_path_for_wire(std::path::Path::new("/tmp/Cafe\u{301}/A\u{30a}")),
            Some("/tmp/Caf\u{e9}/\u{c5}".to_string()),
            "decomposed filesystem paths must match JavaScript's NFC identity",
        );
    }

    #[cfg(unix)]
    #[test]
    fn happy_restoration_root_recheck_detects_symlink_retarget() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temp dir");
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        let alias = directory.path().join("consented-alias");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        symlink(&first, &alias).unwrap();
        let alias_path = alias.to_string_lossy().to_string();
        let app = mock_app_with_roots(Some(vec![alias_path.clone()]));

        let before =
            canonical_happy_restoration_root(app.handle(), &alias_path, &alias_path).unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();
        let after =
            canonical_happy_restoration_root(app.handle(), &alias_path, &alias_path).unwrap();

        assert_ne!(
            before, after,
            "the post-spawn canonical comparison must reject a retargeted root alias",
        );
    }

    #[test]
    fn effective_advertised_roots_keeps_only_discovered_projects() {
        let consented = tempfile::tempdir().expect("temp dir");
        let consented_path = consented.path().to_string_lossy().to_string();
        let app = mock_app_with_roots(Some(vec![consented_path.clone()]));

        assert_eq!(
            crate::commands::happy_bridge::effective_advertised_roots(
                app.handle(),
                vec![consented_path.clone()],
            ),
            vec![consented_path.clone()],
        );
        assert!(
            crate::commands::happy_bridge::effective_advertised_roots(app.handle(), Vec::new())
                .is_empty(),
            "a root with no matching project is not advertised at startup"
        );
    }

    #[test]
    fn restart_backoff_is_capped() {
        assert_eq!(restart_delay(0), Duration::from_secs(1));
        assert_eq!(restart_delay(1), Duration::from_secs(2));
        assert_eq!(restart_delay(2), Duration::from_secs(4));
        assert_eq!(restart_delay(10), Duration::from_secs(30));
    }

    #[test]
    fn restart_budget_is_global_and_exhausts() {
        assert!(restart_allowed(0));
        assert!(restart_allowed(MAX_RESTART_ATTEMPTS - 1));
        assert!(!restart_allowed(MAX_RESTART_ATTEMPTS));
    }

    #[test]
    fn failed_restart_retries_until_budget_then_errors_and_stop_is_distinct() {
        let mut attempts = 0;
        let mut failed_starts = 0;
        while let Some(next) = next_restart_attempt(attempts) {
            attempts = next;
            failed_starts += 1;
        }
        assert_eq!(failed_starts, MAX_RESTART_ATTEMPTS);
        assert_eq!(next_restart_attempt(attempts), None);
        assert!(
            restart_allowed(0),
            "an intentional stop does not consume restart budget"
        );
    }

    #[test]
    fn bridge_error_status_is_preserved_as_error() {
        assert!(matches!(
            report_state(Some("error")),
            Some(HappyBridgeState::Error)
        ));
        assert!(matches!(
            report_state(Some("connected")),
            Some(HappyBridgeState::Running)
        ));
        assert!(report_state(Some("starting")).is_none());
    }

    #[test]
    fn restart_budget_rearms_once_after_sustained_uptime() {
        let spawned = std::time::Instant::now() - Duration::from_secs(60);
        assert!(should_rearm(spawned, false, std::time::Instant::now()));
        assert!(!should_rearm(spawned, true, std::time::Instant::now()));
        assert!(!should_rearm(
            std::time::Instant::now(),
            false,
            std::time::Instant::now()
        ));
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
    fn supervisor_channel_accepts_happy_session_lookup() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"conversation_happy_session_lookup","params":{"conversationId":"00000000-0000-4000-8000-000000000123"}}"#,
        )
        .expect("lookup method is allowlisted");
        assert_eq!(request.method, "conversation_happy_session_lookup");
    }

    #[test]
    fn supervisor_channel_accepts_conversation_claim() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":12,"method":"conversation_claim","params":{"conversationId":"00000000-0000-4000-8000-000000000123","providerSessionId":"00000000-0000-4000-8000-000000000123","happySessionId":"relay-id","cwd":"/synthetic/consented","expectedAgentType":"codex","expectedAgentSessionId":null,"expectedAgentPermissionMode":null}}"#,
        )
        .expect("restoration claim method is allowlisted");
        assert_eq!(request.method, "conversation_claim");
        assert_eq!(
            required_nullable_string(&request.params, "expectedAgentSessionId").unwrap(),
            None,
            "JSON null is an explicit expected-absence assertion",
        );
        assert!(
            required_nullable_string(&request.params, "missingExpectedAgentSessionId").is_err(),
            "a missing expectation must not be treated as expected absence",
        );
        assert_eq!(
            required_nullable_string(&request.params, "expectedAgentPermissionMode").unwrap(),
            None,
            "JSON null is an explicit expected permission-mode absence assertion",
        );
        assert!(
            required_nullable_string(&request.params, "missingExpectedAgentPermissionMode")
                .is_err(),
            "a missing permission expectation must not be treated as expected absence",
        );
    }

    #[test]
    fn supervisor_channel_accepts_conversation_owner_lookup() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"conversation_owner_lookup","params":{"providerSessionId":"00000000-0000-4000-8000-000000000123"}}"#,
        )
        .expect("owner lookup method is allowlisted");
        assert_eq!(request.method, "conversation_owner_lookup");
    }

    #[test]
    fn supervisor_channel_accepts_conversation_archive() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":8,"method":"conversation_archive","params":{"conversationId":"00000000-0000-4000-8000-000000000123","providerSessionId":"00000000-0000-4000-8000-000000000124"}}"#,
        )
        .expect("archive method is allowlisted");
        assert_eq!(request.method, "conversation_archive");
    }

    #[test]
    fn supervisor_channel_accepts_provider_session_archive() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":10,"method":"provider_session_archive","params":{"providerSessionId":"00000000-0000-4000-8000-000000000123"}}"#,
        )
        .expect("provider-only archive method is allowlisted");
        assert_eq!(request.method, "provider_session_archive");
    }

    #[test]
    fn supervisor_channel_accepts_provider_session_archive_lookup() {
        let request = parse_supervisor_line(
            r#"{"jsonrpc":"2.0","id":11,"method":"provider_session_archive_lookup","params":{"providerSessionId":"00000000-0000-4000-8000-000000000123"}}"#,
        )
        .expect("provider archive lookup method is allowlisted");
        assert_eq!(request.method, "provider_session_archive_lookup");
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

    #[tokio::test]
    async fn non_utf8_line_is_discarded_without_ending_the_channel() {
        // The stdout loop treats InvalidData as a corrupt line rather than a
        // dead pipe. That is only safe because the bad line is consumed before
        // the UTF-8 check fails, so the very next read must still succeed —
        // otherwise the loop would spin on the same bytes forever.
        let (reader, mut writer) = duplex(1024);
        let writer_task = tokio::spawn(async move {
            writer.write_all(&[0xff, 0xfe]).await.unwrap();
            writer
                .write_all(b"\n{\"jsonrpc\":\"2.0\"}\n")
                .await
                .unwrap();
        });
        let mut reader = BufReader::new(reader);

        let corrupt = read_bounded_line(&mut reader).await;
        assert!(
            matches!(&corrupt, Err(error) if error.kind() == std::io::ErrorKind::InvalidData),
            "a non-UTF-8 line surfaces as InvalidData"
        );
        assert!(
            matches!(
                read_bounded_line(&mut reader).await.unwrap(),
                Some(BoundedLine::Complete(line)) if line == "{\"jsonrpc\":\"2.0\"}"
            ),
            "the channel stays usable for the next supervisor line"
        );
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

    fn conversation(project_root: Option<&str>, agent_cwd: Option<&str>) -> Value {
        serde_json::json!({
            "id": "conversation-1",
            "title": "Agent",
            "created_at": 0,
            "kind": "agent",
            "project_root": project_root,
            "is_archived": false,
            "selected_provider": null,
            "selected_model": null,
            "employee_id": null,
            "agent_type": "claude-code",
            "agent_session_id": null,
            "agent_cwd": agent_cwd,
            "agent_model_id": null,
            "agent_permission_mode": null,
            "agent_metadata": null,
            "project_id": null,
        })
    }

    fn conversations(rows: Vec<Value>) -> Vec<crate::commands::chat::UnifiedConversationRow> {
        rows.into_iter()
            .map(|row| serde_json::from_value(row).expect("conversation row deserializes"))
            .collect()
    }

    #[test]
    fn project_root_discovery_reports_a_failed_lookup() {
        // Regression: the lookup was absorbed with `unwrap_or_default()`. On a
        // busy database the bridge started, advertised zero folders, reported
        // itself connected, and then refused every remote spawn silently.
        let failure = discovered_project_roots(Err("database is locked".to_string()));

        assert!(
            failure.is_err_and(|error| error.contains("database is locked")),
            "a failed folder lookup must not be reported as an empty project list"
        );
    }

    #[test]
    fn project_root_discovery_keeps_first_seen_distinct_roots() {
        let roots = discovered_project_roots(Ok(conversations(vec![
            conversation(Some("/workspace/alpha"), None),
            // A conversation with no project falls back to where the agent ran.
            conversation(None, Some("/workspace/beta")),
            conversation(Some("/workspace/alpha"), Some("/workspace/gamma")),
            conversation(None, None),
        ])));

        assert_eq!(
            roots.expect("a successful lookup yields roots"),
            vec![
                "/workspace/alpha".to_string(),
                "/workspace/beta".to_string()
            ],
        );
    }

    #[tokio::test]
    async fn supervisor_notification_delivers_a_line() {
        let (writer, mut reader) = duplex(1024);
        let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

        notify_supervisor(&writer, serde_json::json!({ "method": "cancel_pairing" }))
            .await
            .expect("a drained pipe accepts the notification");

        let mut line = String::new();
        BufReader::new(&mut reader)
            .read_line(&mut line)
            .await
            .expect("the notification is readable");
        assert_eq!(line.trim_end(), r#"{"method":"cancel_pairing"}"#);
    }

    #[tokio::test]
    async fn supervisor_notification_reports_a_closed_pipe() {
        // Regression: `update_roots` returned `Ok(())` and `cancel_pairing`
        // returned `()` no matter what the write did, so the checkbox kept a
        // change the bridge never saw and a dismissed pairing dialog reported
        // success while the code stayed authorizable.
        let (writer, reader) = duplex(1024);
        drop(reader);
        let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

        let result =
            notify_supervisor(&writer, serde_json::json!({ "method": "roots_update" })).await;

        assert!(
            result.is_err(),
            "a notification that never reached the bridge must not report success"
        );
    }

    #[tokio::test]
    async fn supervisor_notification_gives_up_on_a_pipe_nobody_drains() {
        // A bridge that is alive but not reading stdin blocks the write once the
        // pipe buffer fills. `_reader` stays bound so the pipe is open but idle,
        // which is exactly that state.
        let (writer, _reader) = duplex(8);
        let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer));

        let result =
            notify_supervisor(&writer, serde_json::json!({ "method": "roots_update" })).await;

        assert!(
            result.is_err(),
            "a wedged bridge must fail the caller rather than block it forever"
        );
    }
}
