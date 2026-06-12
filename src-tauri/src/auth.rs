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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefreshLockDecision {
    UseStoredAccessToken,
    RefreshWithToken,
    MissingRefreshToken,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefreshUnauthorizedDecision {
    UseStoredAccessToken,
    ExpireSession,
}

fn refresh_mutex() -> &'static TokioMutex<()> {
    REFRESH_LOCK.get_or_init(|| TokioMutex::new(()))
}

pub(crate) fn decide_after_refresh_lock(
    requested_refresh_token: Option<&str>,
    stored_refresh_token: Option<&str>,
    stored_access_token: Option<&str>,
) -> RefreshLockDecision {
    if requested_refresh_token != stored_refresh_token && stored_access_token.is_some() {
        return RefreshLockDecision::UseStoredAccessToken;
    }

    if stored_refresh_token.is_some() {
        return RefreshLockDecision::RefreshWithToken;
    }

    RefreshLockDecision::MissingRefreshToken
}

pub(crate) fn decide_after_refresh_unauthorized(
    posted_refresh_token: &str,
    stored_refresh_token: Option<&str>,
    stored_access_token: Option<&str>,
) -> RefreshUnauthorizedDecision {
    if stored_refresh_token != Some(posted_refresh_token) && stored_access_token.is_some() {
        return RefreshUnauthorizedDecision::UseStoredAccessToken;
    }

    RefreshUnauthorizedDecision::ExpireSession
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

/// True when either an access token or a refresh token is present.
///
/// Callers use this to decide whether a Gateway request should attach
/// stored auth at all. A signed-out cold start has neither token, so public
/// endpoints (catalog, provider list) must go through unauthenticated rather
/// than failing through the refresh path. See #1860.
pub fn has_stored_credentials(app: &tauri::AppHandle) -> bool {
    get_access_token(app).is_ok() || matches!(get_refresh_token(app), Ok(Some(_)))
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
/// On missing refresh token: clears tokens and returns an error WITHOUT
/// emitting `auth:session-expired` — that state is "never signed in", not
/// session expiry.
/// On 401 from the refresh endpoint: clears both tokens, emits
/// `auth:session-expired` to the frontend, and returns an error.
/// On network error: does NOT clear tokens (user may be temporarily offline).
///
/// Uses a global mutex to prevent concurrent refresh storms from multiple workers.
pub async fn refresh_access_token(app: &tauri::AppHandle) -> Result<String, String> {
    let requested_refresh_token = get_refresh_token(app)?;
    let _guard = refresh_mutex().lock().await;

    let stored_refresh_token = get_refresh_token(app)?;
    let stored_access_token = get_access_token(app).ok();
    match decide_after_refresh_lock(
        requested_refresh_token.as_deref(),
        stored_refresh_token.as_deref(),
        stored_access_token.as_deref(),
    ) {
        RefreshLockDecision::UseStoredAccessToken => {
            log::debug!("[auth] Refresh token already rotated; reusing stored access token");
            return Ok(stored_access_token.expect("decision requires stored access token"));
        }
        RefreshLockDecision::MissingRefreshToken => {
            // No refresh token means never-signed-in or already-logged-out,
            // not session expiry. Emitting auth:session-expired here turned
            // every signed-out Gateway call into a spurious sign-in-modal
            // request. See #1860.
            let _ = clear_tokens(app);
            return Err("No refresh token available".to_string());
        }
        RefreshLockDecision::RefreshWithToken => {}
    }

    let refresh_token = stored_refresh_token.expect("decision requires stored refresh token");

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/auth/refresh", GATEWAY_BASE_URL))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| format!("Token refresh network error: {}", e))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let latest_refresh_token = get_refresh_token(app)?;
        let latest_access_token = get_access_token(app).ok();
        if decide_after_refresh_unauthorized(
            &refresh_token,
            latest_refresh_token.as_deref(),
            latest_access_token.as_deref(),
        ) == RefreshUnauthorizedDecision::UseStoredAccessToken
        {
            log::debug!(
                "[auth] Refresh endpoint rejected stale refresh token after another refresh won"
            );
            return Ok(latest_access_token.expect("decision requires stored access token"));
        }

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
    let _ = app.emit("auth:token-refreshed", ());

    log::debug!("[auth] Token refreshed successfully");
    Ok(new_access_token.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        RefreshLockDecision, RefreshUnauthorizedDecision, decide_after_refresh_lock,
        decide_after_refresh_unauthorized,
    };

    #[test]
    fn lock_decision_reuses_access_token_after_refresh_token_rotation() {
        assert_eq!(
            decide_after_refresh_lock(
                Some("refresh-token-before-lock"),
                Some("refresh-token-after-lock"),
                Some("fresh-access-token"),
            ),
            RefreshLockDecision::UseStoredAccessToken,
        );
    }

    #[test]
    fn lock_decision_posts_when_refresh_token_is_unchanged() {
        assert_eq!(
            decide_after_refresh_lock(
                Some("refresh-token-before-lock"),
                Some("refresh-token-before-lock"),
                Some("stale-access-token"),
            ),
            RefreshLockDecision::RefreshWithToken,
        );
    }

    #[test]
    fn unauthorized_decision_preserves_session_after_losing_external_race() {
        assert_eq!(
            decide_after_refresh_unauthorized(
                "posted-refresh-token",
                Some("newer-refresh-token"),
                Some("fresh-access-token"),
            ),
            RefreshUnauthorizedDecision::UseStoredAccessToken,
        );
    }

    #[test]
    fn unauthorized_decision_expires_session_for_unchanged_refresh_token() {
        assert_eq!(
            decide_after_refresh_unauthorized(
                "posted-refresh-token",
                Some("posted-refresh-token"),
                Some("stale-access-token"),
            ),
            RefreshUnauthorizedDecision::ExpireSession,
        );
    }
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
            log::debug!("[auth] No access token in store, attempting refresh...");
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
    log::debug!("[auth] Got 401, attempting token refresh...");
    let new_token = refresh_access_token(app).await?;

    build_request(client, &new_token)
        .send()
        .await
        .map_err(|e| format!("Retry request failed: {}", e))
}
