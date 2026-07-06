// ABOUTME: Native support-reporting helpers for desktop bug reports.
// ABOUTME: Generates anonymous IDs, submits reports, and persists panic sidecars.

use std::collections::HashSet;
use std::fs;
use std::panic::PanicHookInfo;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use hmac::{Hmac, Mac};
use regex::Regex;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

type HmacSha256 = Hmac<Sha256>;

const AUTH_STORE: &str = "auth.json";
const SEREN_API_KEY_KEY: &str = "seren_api_key";
const SUPPORT_SALT_KEY: &str = "support_report_salt";
const SUPPORT_REPORT_PATH: &str = "/support/report";
const DEFAULT_API_BASE: &str = "https://api.serendb.com";
const MAX_BUNDLE_BYTES: usize = 5 * 1024 * 1024;
// Cap how many crash sidecars we replay per launch so a crash storm cannot
// turn the next startup into a sustained burst against the ingest endpoint.
const MAX_SWEEP_PER_LAUNCH: usize = 5;
// Retry-After ceiling so a misconfigured server cannot hang us indefinitely.
const MAX_RETRY_AFTER_SECONDS: u64 = 60;
// Bound the native runtime-error dedup set so a long-running session with many
// distinct native failures cannot grow it unbounded. Native reports are rare
// (catastrophic events), so clearing on overflow is acceptable.
const MAX_SEEN_RUNTIME_SIGNATURES: usize = 256;

// Signatures of native runtime-error reports already submitted this process, so
// a crash-loop that fires the same failure repeatedly reports it only once.
static SEEN_RUNTIME_SIGNATURES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn remember_runtime_signature(signature: &str) -> bool {
    let set = SEEN_RUNTIME_SIGNATURES.get_or_init(|| Mutex::new(HashSet::new()));
    // Never panic on a poisoned lock — support reporting must not take down a
    // caller. Recover the inner set instead.
    let mut guard = set.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.contains(signature) {
        return false;
    }
    if guard.len() >= MAX_SEEN_RUNTIME_SIGNATURES {
        guard.clear();
    }
    guard.insert(signature.to_string());
    true
}

#[derive(Serialize)]
pub struct SupportReportIds {
    install_id: String,
    session_id_hash: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct SupportError {
    kind: String,
    message: String,
    stack: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct SupportPayload {
    schema_version: u8,
    signature: String,
    install_id: String,
    session_id_hash: String,
    app_version: String,
    tauri_version: String,
    os: String,
    arch: String,
    timestamp: String,
    crash_recovery: bool,
    truncated: bool,
    error: SupportError,
    log_slice: Vec<Value>,
}

pub fn init(app: &AppHandle) {
    install_panic_hook(app.clone());
}

#[tauri::command]
pub fn get_support_report_ids(
    app: AppHandle,
    session_id: String,
) -> Result<SupportReportIds, String> {
    let salt = support_salt(&app)?;
    Ok(SupportReportIds {
        install_id: hmac_hex_prefix(&salt, b"install", 16)?,
        session_id_hash: hmac_hex_prefix(&salt, session_id.as_bytes(), 16)?,
    })
}

#[tauri::command]
pub async fn submit_support_report(app: AppHandle, bundle: Value) -> Result<(), String> {
    let client = build_http_client();
    match post_with_client(&app, &client, bundle.clone()).await {
        PostOutcome::Success => Ok(()),
        // 4xx (schema drift, expired key, too large): the server will never
        // accept it, so drop rather than persist a bundle that can't succeed.
        PostOutcome::PermanentFailure(err) => Err(err),
        // Transient (offline, 5xx, 429, pre-auth): persist for the next-launch
        // sweep so the report is not lost, then report the failure to the caller.
        PostOutcome::TransientFailure(err) => {
            if let Err(persist_err) = persist_pending_report(&app, &bundle) {
                log::warn!("[support-report] failed to persist pending report: {persist_err}");
            }
            Err(err)
        }
    }
}

/// Report a genuine native/runtime defect (e.g. the provider runtime dying and
/// failing to restart) to the support pipeline. Fire-and-forget and safe to
/// call from any sync context; deduped per-process. On a transient submit
/// failure the bundle is persisted for the next-launch sweep so it is durable.
pub fn report_runtime_error(app: &AppHandle, kind: &str, message: &str) {
    let payload = match build_runtime_payload(app, kind, message) {
        Some(payload) => payload,
        None => return,
    };
    if !remember_runtime_signature(&payload.signature) {
        return;
    }
    let kind = kind.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bundle = match serde_json::to_value(&payload) {
            Ok(bundle) => bundle,
            Err(err) => {
                log::warn!("[support-report] runtime report serialize failed: {err}");
                return;
            }
        };
        let client = build_http_client();
        match post_with_client(&app, &client, bundle.clone()).await {
            PostOutcome::Success => {}
            PostOutcome::PermanentFailure(err) => {
                log::warn!("[support-report] runtime report '{kind}' dropped (permanent): {err}");
            }
            PostOutcome::TransientFailure(err) => {
                log::warn!("[support-report] runtime report '{kind}' deferred for retry: {err}");
                if let Err(persist_err) = persist_pending_report(&app, &bundle) {
                    log::warn!(
                        "[support-report] failed to persist pending runtime report: {persist_err}"
                    );
                }
            }
        }
    });
}

#[tauri::command]
pub async fn sweep_support_crash_reports(app: AppHandle) -> Result<(), String> {
    let crash_dir = crash_dir(&app)?;
    let entries = match fs::read_dir(&crash_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("failed to read crash reports: {err}")),
    };

    let client = build_http_client();
    let mut processed = 0usize;

    for entry in entries {
        if processed >= MAX_SWEEP_PER_LAUNCH {
            break;
        }
        let entry = entry.map_err(|err| format!("failed to read crash entry: {err}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let is_pending = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_pending_report_filename);

        let body = fs::read_to_string(&path)
            .map_err(|err| format!("failed to read crash report {}: {err}", path.display()))?;
        let bundle: Value = serde_json::from_str(&body)
            .map_err(|err| format!("failed to parse crash report {}: {err}", path.display()))?;

        // Replay both crash-recovery sidecars (from a panic) and pending-report
        // sidecars (a live report deferred after a transient submit failure).
        // Anything else is a stray file we delete rather than replay.
        if !is_pending && !is_crash_recovery_sidecar(&bundle) {
            log::warn!(
                "[support-report] deleting stray sidecar {}",
                path.display()
            );
            if let Err(err) = fs::remove_file(&path) {
                log::warn!(
                    "[support-report] failed to delete stray sidecar {}: {err}",
                    path.display()
                );
            }
            processed += 1;
            continue;
        }

        match post_with_client(&app, &client, bundle).await {
            // Success or terminal client error: drop the sidecar so we
            // don't replay it on every launch.
            PostOutcome::Success | PostOutcome::PermanentFailure(_) => {
                if let Err(err) = fs::remove_file(&path) {
                    log::warn!(
                        "[support-report] failed to delete sidecar {}: {err}",
                        path.display()
                    );
                }
            }
            // Transient (network/5xx): leave on disk for the next launch.
            PostOutcome::TransientFailure(err) => {
                log::warn!(
                    "[support-report] sidecar {} kept for retry: {err}",
                    path.display()
                );
            }
        }

        processed += 1;
    }

    Ok(())
}

fn install_panic_hook(app: AppHandle) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(payload) = build_panic_payload(&app, info) {
            if let Ok(path) = write_crash_payload(&app, &payload) {
                log::error!("[support-report] wrote panic sidecar {}", path.display());
            }
            let _ = app.emit("panic-report", payload);
        }
        previous(info);
    }));
}

fn support_salt(app: &AppHandle) -> Result<Vec<u8>, String> {
    let store = app.store(AUTH_STORE).map_err(|err| err.to_string())?;
    if let Some(existing) = store
        .get(SUPPORT_SALT_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
    {
        if let Ok(bytes) = hex::decode(existing) {
            if bytes.len() == 32 {
                return Ok(bytes);
            }
        }
    }

    let salt: [u8; 32] = rand::random();
    store.set(SUPPORT_SALT_KEY, json!(hex::encode(salt)));
    store.save().map_err(|err| err.to_string())?;
    Ok(salt.to_vec())
}

fn read_api_key(app: &AppHandle) -> Result<String, String> {
    let key = app
        .store(AUTH_STORE)
        .map_err(|err| err.to_string())?
        .get(SEREN_API_KEY_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();

    if key.is_empty() {
        return Err("seren api key not available".to_string());
    }

    Ok(key)
}

enum PostOutcome {
    Success,
    /// Terminal failure (4xx, malformed payload, etc.). Caller should NOT retry
    /// and should drop any persisted copy of the bundle.
    PermanentFailure(String),
    /// Transient failure (network error, 5xx). Caller may keep the bundle for
    /// a future attempt.
    TransientFailure(String),
}

async fn post_with_client(app: &AppHandle, client: &reqwest::Client, bundle: Value) -> PostOutcome {
    // Cap retries: only 5xx and network errors get a second/third try.
    // 4xx is treated as terminal so a malformed bundle (e.g. schema drift)
    // cannot loop forever.
    let backoffs = [Duration::from_secs(1), Duration::from_secs(4)];
    let mut last_outcome = PostOutcome::TransientFailure("no attempts made".to_string());

    for attempt in 0..=backoffs.len() {
        if attempt > 0 {
            tokio::time::sleep(backoffs[attempt - 1]).await;
        }

        last_outcome = post_attempt(app, client, &bundle).await;
        match &last_outcome {
            PostOutcome::Success => return PostOutcome::Success,
            // Stop immediately on terminal errors; further retries waste budget.
            PostOutcome::PermanentFailure(_) => return last_outcome,
            // Continue the loop on transient failures.
            PostOutcome::TransientFailure(_) => {}
        }
    }

    last_outcome
}

async fn post_attempt(app: &AppHandle, client: &reqwest::Client, bundle: &Value) -> PostOutcome {
    let api_key = match read_api_key(app) {
        Ok(key) => key,
        // Startup crash replay can run before auth state is hydrated. Keep
        // persisted crash sidecars so a later launch/session can upload them.
        Err(err) => return PostOutcome::TransientFailure(err),
    };

    let url = support_report_url(app);
    let result = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(bundle)
        .send()
        .await;

    let response = match result {
        Ok(response) => response,
        Err(err) => return PostOutcome::TransientFailure(format!("request failed: {err}")),
    };

    let status = response.status();
    if status.is_success() {
        return PostOutcome::Success;
    }

    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = parse_retry_after(response.headers()).unwrap_or(5);
        let sleep_for = retry_after.min(MAX_RETRY_AFTER_SECONDS);
        tokio::time::sleep(Duration::from_secs(sleep_for)).await;
        return PostOutcome::TransientFailure(format!("rate limited (retry-after {sleep_for}s)"));
    }

    if status.is_server_error() {
        return PostOutcome::TransientFailure(format!("HTTP {status}"));
    }

    // 4xx other than 429: schema mismatch, expired key, payload too large, etc.
    // Treat as terminal so we don't keep retrying a bundle the server will
    // never accept.
    PostOutcome::PermanentFailure(format!("HTTP {status}"))
}

fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn support_report_url(_app: &AppHandle) -> String {
    // Allow staging/dev builds to override the ingest base URL (the JS side
    // already uses `API_BASE`); falls back to production. Setting either
    // SEREN_API_BASE, VITE_SEREN_API_URL, or VITE_API_BASE works.
    let base = std::env::var("SEREN_API_BASE")
        .ok()
        .or_else(|| std::env::var("VITE_SEREN_API_URL").ok())
        .or_else(|| std::env::var("VITE_API_BASE").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_BASE.to_string());
    let trimmed = base.trim_end_matches('/');
    format!("{trimmed}{SUPPORT_REPORT_PATH}")
}

fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

fn hmac_hex_prefix(key: &[u8], message: &[u8], len: usize) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|err| err.to_string())?;
    mac.update(message);
    let hex = hex::encode(mac.finalize().into_bytes());
    Ok(hex[..len].to_string())
}

fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

fn build_panic_payload(app: &AppHandle, info: &PanicHookInfo<'_>) -> Option<SupportPayload> {
    let salt = support_salt(app).ok()?;
    let message = redact_string(&panic_message(info));
    let stack = info
        .location()
        .map(|location| {
            vec![redact_string(&format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            ))]
        })
        .unwrap_or_default();
    let signature = sha256_hex(&format!("panic\n{}\n{}", message, stack.join("\n")));

    Some(SupportPayload {
        schema_version: 1,
        signature,
        install_id: hmac_hex_prefix(&salt, b"install", 16).ok()?,
        session_id_hash: hmac_hex_prefix(&salt, b"panic-session", 16).ok()?,
        app_version: app
            .config()
            .version
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        tauri_version: tauri::VERSION.to_string(),
        os: target_os().to_string(),
        arch: target_arch().to_string(),
        timestamp: jiff::Timestamp::now().to_string(),
        crash_recovery: true,
        truncated: false,
        error: SupportError {
            kind: "panic".to_string(),
            message,
            stack,
        },
        log_slice: Vec::new(),
    })
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = info.payload().downcast_ref::<String>() {
        message.clone()
    } else {
        "Rust panic".to_string()
    }
}

// Build a non-crash support payload for a native runtime error. Unlike panics,
// these are not crash recoveries — they are live defects surfaced by the Rust
// core (e.g. the provider runtime dying), so `crash_recovery` is false.
fn runtime_signature(kind: &str, redacted_message: &str) -> String {
    sha256_hex(&format!("{kind}\n{redacted_message}"))
}

fn build_runtime_payload(app: &AppHandle, kind: &str, message: &str) -> Option<SupportPayload> {
    let salt = support_salt(app).ok()?;
    let message = redact_string(message);
    let signature = runtime_signature(kind, &message);

    Some(SupportPayload {
        schema_version: 1,
        signature,
        install_id: hmac_hex_prefix(&salt, b"install", 16).ok()?,
        session_id_hash: hmac_hex_prefix(&salt, b"runtime-session", 16).ok()?,
        app_version: app
            .config()
            .version
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        tauri_version: tauri::VERSION.to_string(),
        os: target_os().to_string(),
        arch: target_arch().to_string(),
        timestamp: jiff::Timestamp::now().to_string(),
        crash_recovery: false,
        truncated: false,
        error: SupportError {
            kind: kind.to_string(),
            message,
            stack: Vec::new(),
        },
        log_slice: Vec::new(),
    })
}

fn write_crash_payload(app: &AppHandle, payload: &SupportPayload) -> Result<PathBuf, String> {
    let crash_dir = crash_dir(app)?;
    fs::create_dir_all(&crash_dir).map_err(|err| err.to_string())?;
    let filename = format!(
        "crash-{}-{}.json",
        jiff::Timestamp::now().as_second(),
        &payload.signature[..12]
    );
    let path = crash_dir.join(filename);
    let bytes = capped_crash_payload_bytes(payload)?;
    fs::write(&path, bytes).map_err(|err| err.to_string())?;
    Ok(path)
}

/// Persist a report bundle that could not be submitted this run to a `pending-`
/// sidecar so the next-launch sweep can retry it. The raw bundle is stored
/// verbatim (preserving http/agent_context the typed struct drops) so the
/// retried report is identical to the original.
fn persist_pending_report(app: &AppHandle, bundle: &Value) -> Result<PathBuf, String> {
    let crash_dir = crash_dir(app)?;
    fs::create_dir_all(&crash_dir).map_err(|err| err.to_string())?;
    let bytes = serde_json::to_vec(bundle).map_err(|err| err.to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err(format!("pending report too large ({} bytes)", bytes.len()));
    }
    let signature = bundle
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let sig_prefix: String = signature.chars().take(12).collect();
    let filename = format!(
        "pending-{}-{}.json",
        jiff::Timestamp::now().as_second(),
        sig_prefix
    );
    let path = crash_dir.join(filename);
    fs::write(&path, &bytes).map_err(|err| err.to_string())?;
    Ok(path)
}

fn is_crash_recovery_sidecar(bundle: &Value) -> bool {
    bundle
        .get("crash_recovery")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn is_pending_report_filename(name: &str) -> bool {
    name.starts_with("pending-")
}

fn capped_crash_payload_bytes(payload: &SupportPayload) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(payload).map_err(|err| err.to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        let compact_message = payload.error.message.chars().take(4096).collect::<String>();
        bytes = serde_json::to_vec(&json!({
            "schema_version": payload.schema_version,
            "signature": payload.signature,
            "install_id": payload.install_id,
            "session_id_hash": payload.session_id_hash,
            "app_version": payload.app_version,
            "tauri_version": payload.tauri_version,
            "os": payload.os,
            "arch": payload.arch,
            "timestamp": payload.timestamp,
            "crash_recovery": true,
            "truncated": true,
            "error": {
                "kind": payload.error.kind,
                "message": compact_message,
                "stack": [],
            },
            "log_slice": [],
        }))
        .map_err(|err| err.to_string())?;
    }
    Ok(bytes)
}

fn crash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("crash"))
}

fn target_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn target_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "aarch64"
    }
}

fn redact_string(value: &str) -> String {
    let mut result = normalize_home_paths(value);
    for (regex, replacement) in redaction_patterns() {
        result = regex.replace_all(&result, *replacement).into_owned();
    }
    result
}

fn normalize_home_paths(value: &str) -> String {
    let unix_normalized = unix_home_pattern().replace_all(value, "$$HOME");
    windows_home_pattern()
        .replace_all(&unix_normalized, "$$HOME")
        .into_owned()
}

fn redaction_patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)Bearer\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]"),
            (r"seren_[A-Za-z0-9_-]{8,}", "[REDACTED_SEREN_KEY]"),
            (r"sk_(live|test)_[A-Za-z0-9]+", "[REDACTED_KEY]"),
            (r"pk_(live|test)_[A-Za-z0-9]+", "[REDACTED_KEY]"),
            (r"whsec_[A-Za-z0-9]+", "[REDACTED_KEY]"),
            (r"gh[pousr]_[A-Za-z0-9]{20,}", "[REDACTED_GITHUB_TOKEN]"),
            (r"AKIA[0-9A-Z]{16}", "[REDACTED_AWS_KEY]"),
            (r"AIza[A-Za-z0-9_-]{20,}", "[REDACTED_GOOGLE_KEY]"),
            (r"xox[abprs]-[A-Za-z0-9-]{8,}", "[REDACTED_SLACK_TOKEN]"),
            (r"0x[a-fA-F0-9]{40,}", "[REDACTED_WALLET]"),
            (
                r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                "[REDACTED_JWT]",
            ),
            (
                r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
                "[REDACTED_EMAIL]",
            ),
            (
                r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                "[REDACTED_UUID]",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid regex"), replacement))
        .collect()
    })
}

fn unix_home_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(/Users|/home)/[^/\s)]+").expect("valid regex"))
}

fn windows_home_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)[A-Z]:\\Users\\[^\\\s)]+").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_and_home_paths() {
        let input = "/Users/alice/project C:\\Users\\bob\\AppData Bearer abc.def seren_secretvalue test@example.com";
        let output = redact_string(input);
        assert_eq!(
            output,
            "$HOME/project $HOME\\AppData Bearer [REDACTED] [REDACTED_SEREN_KEY] [REDACTED_EMAIL]"
        );
    }

    #[test]
    fn redacts_jwt_aws_github_slack_stripe_google_uuid_and_wallet() {
        // Test fixtures are assembled at runtime so the literal token forms
        // never appear as a single unbroken substring in the source. GitHub's
        // push-protection scanner regexes the raw file bytes and will block
        // the push if it sees e.g. `xoxb-...` or `sk_live_...` as a literal.
        let jwt = format!("{}abc.{}def.signpart", "eyJ", "eyJ");
        let aws = format!("{}IOSFODNN7EXAMPLE", "AKIA");
        let pat = format!("{}_AAAAAAAAAAAAAAAAAAAA1234567890abcd", "ghp");
        let slack = format!("{}-1234567890-abcdefghijklmnop", "xoxb");
        let stripe = format!("{}_live_abcdefghijklmnopqrstuvwxyz", "sk");
        let webhook = format!("{}_abcdefghijklmnopqrstuvwxyz", "whsec");
        let google = format!("{}abcdefghijklmnopqrstuvwxyz1234", "AIza");
        let uuid = "11111111-2222-3333-4444-555555555555";
        let wallet = format!("0x{}", "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
        let input = format!(
            "jwt {jwt} aws {aws} pat {pat} slack {slack} stripe {stripe} webhook {webhook} google {google} uuid {uuid} wallet {wallet}"
        );
        let out = redact_string(&input);
        assert!(out.contains("[REDACTED_JWT]"), "JWT not redacted: {out}");
        assert!(
            out.contains("[REDACTED_AWS_KEY]"),
            "AWS not redacted: {out}"
        );
        assert!(
            out.contains("[REDACTED_GITHUB_TOKEN]"),
            "PAT not redacted: {out}"
        );
        assert!(
            out.contains("[REDACTED_SLACK_TOKEN]"),
            "Slack not redacted: {out}"
        );
        assert!(out.contains("[REDACTED_KEY]"), "Stripe not redacted: {out}");
        assert!(
            out.contains("[REDACTED_GOOGLE_KEY]"),
            "Google not redacted: {out}"
        );
        assert!(out.contains("[REDACTED_UUID]"), "UUID not redacted: {out}");
        assert!(
            out.contains("[REDACTED_WALLET]"),
            "wallet not redacted: {out}"
        );
    }

    #[test]
    fn only_replays_marked_crash_recovery_sidecars() {
        assert!(is_crash_recovery_sidecar(&json!({
            "crash_recovery": true,
        })));
        assert!(!is_crash_recovery_sidecar(&json!({
            "crash_recovery": false,
        })));
        assert!(!is_crash_recovery_sidecar(&json!({})));
    }

    #[test]
    fn sweep_replays_pending_and_crash_but_not_stray_sidecars() {
        // The sweep replays a sidecar when it is a pending-report file OR a
        // crash-recovery bundle; everything else is a stray file it deletes.
        let non_crash = json!({ "crash_recovery": false });
        assert!(is_pending_report_filename("pending-123-abc.json"));
        assert!(!is_pending_report_filename("crash-123-abc.json"));
        // A pending sidecar replays even though its bundle is not crash_recovery.
        assert!(
            is_pending_report_filename("pending-1-a.json") || is_crash_recovery_sidecar(&non_crash)
        );
        // A stray non-crash file that is not a pending sidecar is not replayed.
        assert!(
            !is_pending_report_filename("stray.json") && !is_crash_recovery_sidecar(&non_crash)
        );
    }

    #[test]
    fn runtime_signature_is_stable_and_kind_scoped() {
        let a = runtime_signature("provider_runtime.restart_failed", "boom");
        let b = runtime_signature("provider_runtime.restart_failed", "boom");
        let c = runtime_signature("provider_runtime.crash_loop", "boom");
        assert_eq!(a, b, "same kind+message must dedupe to one signature");
        assert_ne!(a, c, "different kind must produce a different signature");
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn runtime_signature_folds_over_redacted_paths() {
        // Two users hitting the same failure with different $HOME paths must
        // dedupe to one signature after redaction.
        let left = runtime_signature(
            "provider_runtime.restart_failed",
            &redact_string("spawn failed at /Users/alice/app"),
        );
        let right = runtime_signature(
            "provider_runtime.restart_failed",
            &redact_string("spawn failed at /Users/bob/app"),
        );
        assert_eq!(left, right);
    }

    #[test]
    fn runtime_dedup_reports_each_signature_once_and_stays_bounded() {
        let sig = "a".repeat(64);
        assert!(remember_runtime_signature(&sig), "first sighting reports");
        assert!(
            !remember_runtime_signature(&sig),
            "repeat sighting is suppressed"
        );
        // Fill past the cap with distinct signatures; the set must stay bounded
        // and never panic.
        for i in 0..(MAX_SEEN_RUNTIME_SIGNATURES + 10) {
            let _ = remember_runtime_signature(&format!("{i:064x}"));
        }
        let set = SEEN_RUNTIME_SIGNATURES
            .get()
            .expect("initialized")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(set.len() <= MAX_SEEN_RUNTIME_SIGNATURES);
    }

    #[test]
    fn hmac_prefix_is_lowercase_hex() {
        let hash = hmac_hex_prefix(b"salt", b"session", 16).expect("hash");
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(hash, hash.to_lowercase());
    }

    #[test]
    fn target_values_match_server_schema() {
        assert!(matches!(target_os(), "darwin" | "linux" | "windows"));
        assert!(matches!(target_arch(), "aarch64" | "x86_64"));
    }

    #[test]
    fn crash_sidecar_stays_under_server_cap() {
        let payload = SupportPayload {
            schema_version: 1,
            signature: "a".repeat(64),
            install_id: "b".repeat(16),
            session_id_hash: "c".repeat(16),
            app_version: "test".to_string(),
            tauri_version: "test".to_string(),
            os: "darwin".to_string(),
            arch: "aarch64".to_string(),
            timestamp: jiff::Timestamp::now().to_string(),
            crash_recovery: true,
            truncated: false,
            error: SupportError {
                kind: "panic".to_string(),
                message: "m".repeat(MAX_BUNDLE_BYTES + 1),
                stack: vec![],
            },
            log_slice: vec![],
        };
        let bytes = capped_crash_payload_bytes(&payload).expect("json");
        assert!(bytes.len() <= MAX_BUNDLE_BYTES);
        let compact: Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(compact["truncated"], json!(true));
    }
}
