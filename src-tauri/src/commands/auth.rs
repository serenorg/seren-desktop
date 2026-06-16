// ABOUTME: Host-side authentication commands for native SerenDB sign-in.
// ABOUTME: Opens system-browser OAuth flows without exposing token material.

use std::collections::HashMap;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const CLIENT_ID: &str = "seren-desktop";
const REDIRECT_URI: &str = "http://127.0.0.1:8787/auth/callback";
const CONSOLE_HOST: &str = "console.serendb.com";
const CONSOLE_CLI_LOGIN_PATH: &str = "/login/cli";

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
    if url.host_str() == Some(CONSOLE_HOST) {
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

    Ok(Some(validate_provider_redirect(auth_url, location)?))
}

fn validate_provider_redirect(auth_url: &Url, location: &str) -> Result<String, String> {
    let location_url =
        Url::parse(location).map_err(|e| format!("Invalid social login redirect: {}", e))?;
    if location_url.scheme() != "https" {
        return Err("Unexpected social login redirect scheme".to_string());
    }

    if location_url.host_str() == Some(CONSOLE_HOST) {
        validate_console_cli_redirect(auth_url, &location_url)?;
    }

    Ok(location.to_string())
}

fn validate_console_cli_redirect(auth_url: &Url, location_url: &Url) -> Result<(), String> {
    if location_url.path() != CONSOLE_CLI_LOGIN_PATH {
        return Err("Social login unexpectedly routed through console.serendb.com".to_string());
    }

    require_matching_query_param(auth_url, location_url, "state")?;
    require_matching_query_param(auth_url, location_url, "redirect_uri")?;
    require_matching_query_param(auth_url, location_url, "code_challenge")?;
    require_matching_query_param(auth_url, location_url, "client_id")?;
    Ok(())
}

fn require_matching_query_param(
    source_url: &Url,
    redirect_url: &Url,
    key: &str,
) -> Result<(), String> {
    let source_value =
        query_param(source_url, key).ok_or_else(|| format!("Social login URL missing {}", key))?;
    let redirect_value = query_param(redirect_url, key)
        .ok_or_else(|| format!("Social login redirect missing {}", key))?;

    if redirect_value != source_value {
        return Err(format!("Social login redirect {} mismatch", key));
    }

    Ok(())
}

fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find_map(|(name, value)| (name == key).then(|| value.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_authorize_url() -> Url {
        validate_authorize_url(
            "https://api.serendb.com/oauth2/authorize?client_id=seren-desktop&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fcallback&state=audit-state&code_challenge=audit-challenge&code_challenge_method=S256&provider=google",
            "google",
        )
        .expect("valid authorize URL")
    }

    #[test]
    fn allows_trusted_console_cli_redirect_that_preserves_pkce_params() {
        let auth_url = valid_authorize_url();
        let redirect = "https://console.serendb.com/login/cli?state=audit-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fcallback&code_challenge=audit-challenge&client_id=seren-desktop";

        assert_eq!(
            validate_provider_redirect(&auth_url, redirect).expect("trusted redirect"),
            redirect
        );
    }

    #[test]
    fn rejects_console_redirects_outside_cli_login() {
        let auth_url = valid_authorize_url();

        let error = validate_provider_redirect(
            &auth_url,
            "https://console.serendb.com/login?state=audit-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fcallback&code_challenge=audit-challenge&client_id=seren-desktop",
        )
        .expect_err("unexpected console path must be rejected");

        assert_eq!(
            error,
            "Social login unexpectedly routed through console.serendb.com"
        );
    }

    #[test]
    fn rejects_console_cli_redirect_with_mismatched_state() {
        let auth_url = valid_authorize_url();

        let error = validate_provider_redirect(
            &auth_url,
            "https://console.serendb.com/login/cli?state=other-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fcallback&code_challenge=audit-challenge&client_id=seren-desktop",
        )
        .expect_err("state mismatch must be rejected");

        assert_eq!(error, "Social login redirect state mismatch");
    }
}
