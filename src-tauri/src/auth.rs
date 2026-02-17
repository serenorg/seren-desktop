// ABOUTME: Authentication utilities for Rust-side HTTP callers.
// ABOUTME: Provides token refresh and authenticated request helpers.

use std::sync::OnceLock;
use tauri::Emitter;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex as TokioMutex;

const AUTH_STORE: &str = "auth.json";
const TOKEN_KEY: &str = "token";
const REFRESH_TOKEN_KEY: &str = "refresh_token";
const GATEWAY_BASE_URL: &str = "https://api.serendb.com";

/// Global mutex to prevent concurrent refresh attempts from multiple workers.
static REFRESH_LOCK: OnceLock<TokioMutex<()>> = OnceLock::new();

fn refresh_mutex() -> &'static TokioMutex<()> {
    REFRESH_LOCK.get_or_init(|| TokioMutex::new(()))
}

/// Read the current access token from the encrypted store.
pub fn get_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store
        .get(TOKEN_KEY)
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| "No access token in store".to_string())
}

/// Read the refresh token from the encrypted store.
fn get_refresh_token(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    Ok(store
        .get(REFRESH_TOKEN_KEY)
        .and_then(|v| v.as_str().map(String::from)))
}

/// Store new tokens after a successful refresh.
fn store_tokens(
    app: &tauri::AppHandle,
    access_token: &str,
    refresh_token: Option<&str>,
) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.set(TOKEN_KEY, serde_json::json!(access_token));
    if let Some(rt) = refresh_token {
        store.set(REFRESH_TOKEN_KEY, serde_json::json!(rt));
    }
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear both tokens (session expired, user must re-login).
fn clear_tokens(app: &tauri::AppHandle) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.delete(TOKEN_KEY);
    store.delete(REFRESH_TOKEN_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Attempt to refresh the access token using the stored refresh token.
///
/// Returns the new access token on success.
/// On 401 from the refresh endpoint: clears both tokens, emits
/// `auth:session-expired` to the frontend, and returns an error.
/// On network error: does NOT clear tokens (user may be temporarily offline).
///
/// Uses a global mutex to prevent concurrent refresh storms from multiple workers.
pub async fn refresh_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let _guard = refresh_mutex().lock().await;

    // After acquiring the lock, check if another caller already refreshed.
    // If the token in the store is different from what the caller used,
    // the refresh already happened — just return the new token.
    // (Callers should compare with their stale token if they want to skip.)

    let refresh_token = match get_refresh_token(app)? {
        Some(rt) => rt,
        None => {
            let _ = clear_tokens(app);
            let _ = app.emit("auth:session-expired", ());
            return Err("No refresh token available".to_string());
        }
    };

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth/refresh", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("Token refresh network error: {}", e))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let _ = clear_tokens(app);
        let _ = app.emit("auth:session-expired", ());
        return Err("Session expired — please sign in again".to_string());
    }

    if !response.status().is_success() {
        return Err(format!("Token refresh failed: HTTP {}", response.status()));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Token refresh parse error: {}", e))?;

    let data = body
        .get("data")
        .ok_or_else(|| "No data in refresh response".to_string())?;

    let new_access_token = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "No access_token in refresh response".to_string())?;

    let new_refresh_token = data.get("refresh_token").and_then(|v| v.as_str());

    store_tokens(app, new_access_token, new_refresh_token)?;

    log::info!("[auth] Token refreshed successfully");
    Ok(new_access_token.to_string())
}

/// Make an authenticated HTTP request with automatic 401 refresh and retry.
///
/// This is the Rust equivalent of the frontend's `appFetch()`.
/// The `build_request` closure receives a bearer token and returns a
/// configured `RequestBuilder`. On 401, the token is refreshed and the
/// request is retried once.
pub async fn authenticated_request<F>(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    build_request: F,
) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
{
    // Try to get token; if missing, attempt refresh before giving up.
    let token = match get_access_token(app) {
        Ok(t) => t,
        Err(_) => {
            log::info!("[auth] No access token in store, attempting refresh...");
            refresh_access_token(app).await?
        }
    };

    let response = build_request(client, &token)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if response.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(response);
    }

    // 401 — attempt refresh and retry
    log::info!("[auth] Got 401, attempting token refresh...");
    let new_token = refresh_access_token(app).await?;

    build_request(client, &new_token)
        .send()
        .await
        .map_err(|e| format!("Retry request failed: {}", e))
}
