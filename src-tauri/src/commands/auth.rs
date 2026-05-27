// ABOUTME: Host-side authentication commands for native SerenDB sign-in.
// ABOUTME: Opens system-browser OAuth flows without exposing token material.

use std::collections::HashMap;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CLIENT_ID: &str = "seren-desktop";
const REDIRECT_URI: &str = "http://127.0.0.1:8787/auth/callback";

#[tauri::command]
pub async fn start_social_login(
    app: tauri::AppHandle,
    provider: String,
    auth_url: String,
) -> Result<(), String> {
    let auth_url = validate_authorize_url(&auth_url, &provider)?;
    let open_url = resolve_provider_redirect(&auth_url)
        .await?
        .unwrap_or_else(|| auth_url.to_string());

    app.opener()
        .open_url(open_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

fn validate_authorize_url(auth_url: &str, provider: &str) -> Result<Url, String> {
    if !matches!(provider, "github" | "google" | "microsoft") {
        return Err("Unsupported social login provider".to_string());
    }

    let url = Url::parse(auth_url).map_err(|e| format!("Invalid social login URL: {}", e))?;
    let is_secure = url.scheme() == "https" || is_local_http_url(&url);
    if !is_secure {
        return Err("Social login URL must use HTTPS".to_string());
    }
    if url.host_str() == Some("console.serendb.com") {
        return Err("Social login must not route through console.serendb.com".to_string());
    }

    if url.path() != "/oauth2/authorize" {
        return Err("Unexpected social login authorize path".to_string());
    }

    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if query.get("client_id").map(String::as_str) != Some(CLIENT_ID) {
        return Err("Unexpected social login client_id".to_string());
    }
    if query.get("response_type").map(String::as_str) != Some("code") {
        return Err("Unexpected social login response_type".to_string());
    }
    if query.get("redirect_uri").map(String::as_str) != Some(REDIRECT_URI) {
        return Err("Unexpected social login redirect_uri".to_string());
    }
    if query.get("provider").map(String::as_str) != Some(provider) {
        return Err("Social login provider mismatch".to_string());
    }
    if query.get("code_challenge_method").map(String::as_str) != Some("S256") {
        return Err("Social login must use S256 PKCE".to_string());
    }
    if !query.contains_key("code_challenge") || !query.contains_key("state") {
        return Err("Social login URL missing PKCE state".to_string());
    }

    Ok(url)
}

fn is_local_http_url(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("::1")
        )
}

async fn resolve_provider_redirect(auth_url: &Url) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(auth_url.as_str())
        .send()
        .await
        .map_err(|e| format!("Failed to start social login: {}", e))?;

    if !response.status().is_redirection() {
        return Ok(None);
    }

    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or("Social login redirect missing Location header")?;

    if location.contains("console.serendb.com") {
        return Err("Social login unexpectedly routed through console.serendb.com".to_string());
    }

    let location_url =
        Url::parse(location).map_err(|e| format!("Invalid social login redirect: {}", e))?;
    if location_url.scheme() != "https" {
        return Err("Unexpected social login redirect scheme".to_string());
    }

    Ok(Some(location.to_string()))
}
