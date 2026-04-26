// ABOUTME: Native support-reporting helpers for desktop bug reports.
// ABOUTME: Generates anonymous IDs, submits reports, and persists panic sidecars.

use std::fs;
use std::panic::PanicHookInfo;
use std::path::PathBuf;
use std::sync::OnceLock;
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
    post_support_report(&app, bundle, true).await.map(|_| ())
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

        let body = fs::read_to_string(&path)
            .map_err(|err| format!("failed to read crash report {}: {err}", path.display()))?;
        let bundle: Value = serde_json::from_str(&body)
            .map_err(|err| format!("failed to parse crash report {}: {err}", path.display()))?;
        if !is_crash_recovery_sidecar(&bundle) {
            log::warn!(
                "[support-report] deleting non-crash sidecar {}",
                path.display()
            );
            if let Err(err) = fs::remove_file(&path) {
                log::warn!(
                    "[support-report] failed to delete non-crash sidecar {}: {err}",
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
                        "[support-report] failed to delete crash sidecar {}: {err}",
                        path.display()
                    );
                }
            }
            // Transient (network/5xx): leave on disk for the next launch.
            PostOutcome::TransientFailure(err) => {
                log::warn!(
                    "[support-report] crash sidecar {} kept for retry: {err}",
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

async fn post_support_report(app: &AppHandle, bundle: Value, retry: bool) -> Result<bool, String> {
    let client = build_http_client();
    if !retry {
        return match post_attempt(app, &client, &bundle).await {
            PostOutcome::Success => Ok(true),
            PostOutcome::PermanentFailure(err) | PostOutcome::TransientFailure(err) => Err(err),
        };
    }
    match post_with_client(app, &client, bundle).await {
        PostOutcome::Success => Ok(true),
        PostOutcome::PermanentFailure(err) | PostOutcome::TransientFailure(err) => Err(err),
    }
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

fn is_crash_recovery_sidecar(bundle: &Value) -> bool {
    bundle
        .get("crash_recovery")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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
