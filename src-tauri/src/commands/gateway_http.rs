// ABOUTME: Rust-backed HTTP bridge for Seren Gateway API requests from the webview.
// ABOUTME: Streams reqwest response bytes back to the frontend to avoid webview CORS limits.

use std::{collections::HashMap, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use futures::StreamExt;
use reqwest::{
    Method,
    header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, oneshot};
use url::Url;

const GATEWAY_HTTP_EVENT: &str = "gateway-http://event";
const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const GATEWAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct GatewayHttpState {
    active: Mutex<HashMap<String, oneshot::Sender<()>>>,
    client: reqwest::Client,
}

impl Default for GatewayHttpState {
    fn default() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            client: reqwest::Client::builder()
                .connect_timeout(GATEWAY_CONNECT_TIMEOUT)
                .build()
                .expect("failed to build gateway HTTP client"),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHttpRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHttpResponseMeta {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayHttpEvent {
    request_id: String,
    event_type: String,
    chunk_base64: Option<String>,
    error: Option<String>,
}

fn validate_gateway_url(raw_url: &str) -> Result<Url, String> {
    let url = Url::parse(raw_url).map_err(|e| format!("Invalid gateway URL: {}", e))?;
    let allowed_origin =
        Url::parse(GATEWAY_BASE_URL).map_err(|e| format!("Invalid gateway base URL: {}", e))?;

    if url.scheme() != allowed_origin.scheme()
        || url.host_str() != allowed_origin.host_str()
        || url.port_or_known_default() != allowed_origin.port_or_known_default()
    {
        return Err(format!(
            "Gateway bridge only allows {} requests",
            allowed_origin.origin().ascii_serialization()
        ));
    }

    Ok(url)
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Renderer-supplied dispatch-handle header (#3193-F). Always stripped before
/// the request leaves the app; consumed only for publisher tool dispatch.
const AUTH_HANDLE_HEADER: &str = "x-seren-auth-handle";

/// Detect the publisher tool-dispatch surface:
/// `/publishers/{slug}/_mcp/tools/{tool}`. Returns the decoded publisher slug
/// and tool name. Every other Gateway path (auth, billing, chat, catalog) is
/// app-level API traffic, not model tool dispatch, and passes through.
fn publisher_dispatch_target(url: &Url) -> Option<(String, String)> {
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["publishers", slug, "_mcp", "tools", tool] => Some((
            urlencoding::decode(slug).ok()?.into_owned(),
            urlencoding::decode(tool).ok()?.into_owned(),
        )),
        _ => None,
    }
}

/// #3193-F: a publisher tool dispatch through the HTTP bridge must redeem a
/// live host-minted handle for the exact publisher, tool, and body payload —
/// the same rule the MCP transport enforces, so neither wire shape can be used
/// to skip the authorization gate.
fn enforce_publisher_dispatch(
    app: &AppHandle,
    url: &Url,
    body: Option<&str>,
    auth_handle: Option<&str>,
) -> Result<(), String> {
    let Some((publisher, tool)) = publisher_dispatch_target(url) else {
        return Ok(());
    };
    let body_args: serde_json::Value = match body {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(raw)
            .map_err(|_| "Dispatch refused: publisher tool body was not valid JSON.".to_string())?,
        _ => serde_json::json!({}),
    };
    app.state::<crate::tool_authorization::ToolAuthorizationState>()
        .consume_dispatch_handle(
            auth_handle.unwrap_or_default(),
            crate::tool_authorization::ToolRoute::Gateway,
            &publisher,
            &tool,
            &crate::tool_authorization::binding_for_publisher_args(&body_args),
        )
}

fn should_skip_stored_auth(path: &str) -> bool {
    matches!(
        normalize_path(path).as_str(),
        "/auth/login" | "/auth/refresh" | "/auth/signup"
    )
}

fn should_use_stored_auth(url: &Url, headers: &HeaderMap) -> bool {
    !headers.contains_key(AUTHORIZATION) && !should_skip_stored_auth(url.path())
}

/// Decide whether to attach stored auth to a Gateway request.
///
/// Returns true only when the caller did not pass their own Authorization
/// header, the path is not an auth-bootstrap endpoint, AND the desktop has
/// stored credentials. Without credentials the request goes unauthenticated
/// so public endpoints keep working while signed out instead of failing
/// through the refresh path. See #1860.
fn should_attach_stored_auth(
    url: &Url,
    headers: &HeaderMap,
    has_stored_credentials: bool,
) -> bool {
    should_use_stored_auth(url, headers) && has_stored_credentials
}

fn build_header_map(raw_headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    for (name, value) in raw_headers {
        let lower = name.to_ascii_lowercase();
        // The dispatch handle is app-internal proof for the Rust gate — it must
        // never leave the process on the wire.
        if matches!(
            lower.as_str(),
            "host" | "origin" | "content-length" | "connection" | AUTH_HANDLE_HEADER
        ) {
            continue;
        }

        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("Invalid request header name '{}': {}", name, e))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|e| format!("Invalid request header '{}' value: {}", name, e))?;
        headers.insert(header_name, header_value);
    }

    Ok(headers)
}

fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        builder = builder.header(name, value.clone());
    }
    builder
}

fn build_request(
    client: &reqwest::Client,
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    body: Option<&str>,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut builder = client.request(method.clone(), url.clone());
    builder = apply_headers(builder, headers);

    if let Some(token) = token {
        builder = builder.header(AUTHORIZATION, format!("Bearer {}", token));
    }

    if let Some(body) = body {
        builder = builder.body(body.to_owned());
    }

    builder
}

fn response_headers_to_map(headers: &HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.as_str().to_string(), v.to_string()))
        })
        .collect()
}

fn emit_gateway_event(app: &AppHandle, payload: GatewayHttpEvent) {
    if let Err(err) = app.emit(GATEWAY_HTTP_EVENT, payload) {
        log::warn!("[gateway-http] Failed to emit gateway event: {}", err);
    }
}

#[tauri::command]
pub async fn gateway_http_start(
    app: AppHandle,
    state: State<'_, GatewayHttpState>,
    request: GatewayHttpRequest,
) -> Result<GatewayHttpResponseMeta, String> {
    if request.request_id.trim().is_empty() {
        return Err("requestId is required".to_string());
    }

    let url = validate_gateway_url(&request.url)?;
    let method = request
        .method
        .parse::<Method>()
        .map_err(|e| format!("Invalid HTTP method '{}': {}", request.method, e))?;
    let auth_handle = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(AUTH_HANDLE_HEADER))
        .map(|(_, value)| value.clone());
    enforce_publisher_dispatch(&app, &url, request.body.as_deref(), auth_handle.as_deref())?;
    let headers = build_header_map(&request.headers)?;
    let body = request.body.clone();

    let client = state.client.clone();

    let has_credentials = crate::auth::has_stored_credentials(&app);
    let response = if should_attach_stored_auth(&url, &headers, has_credentials) {
        crate::auth::authenticated_request(&app, &client, |client, token| {
            build_request(
                client,
                &method,
                &url,
                &headers,
                body.as_deref(),
                Some(token),
            )
        })
        .await?
    } else {
        build_request(&client, &method, &url, &headers, body.as_deref(), None)
            .send()
            .await
            .map_err(|e| format!("Gateway request failed: {}", e))?
    };

    let meta = GatewayHttpResponseMeta {
        status: response.status().as_u16(),
        status_text: response
            .status()
            .canonical_reason()
            .unwrap_or_default()
            .to_string(),
        headers: response_headers_to_map(response.headers()),
    };

    let request_id = request.request_id;
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state
        .active
        .lock()
        .await
        .insert(request_id.clone(), cancel_tx);

    let app_for_stream = app.clone();
    let app_for_cleanup = app.clone();

    tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        let mut saw_error = false;

        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    break;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            emit_gateway_event(
                                &app_for_stream,
                                GatewayHttpEvent {
                                    request_id: request_id.clone(),
                                    event_type: "chunk".to_string(),
                                    chunk_base64: Some(STANDARD.encode(bytes)),
                                    error: None,
                                },
                            );
                        }
                        Some(Err(err)) => {
                            saw_error = true;
                            emit_gateway_event(
                                &app_for_stream,
                                GatewayHttpEvent {
                                    request_id: request_id.clone(),
                                    event_type: "error".to_string(),
                                    chunk_base64: None,
                                    error: Some(err.to_string()),
                                },
                            );
                            break;
                        }
                        None => break,
                    }
                }
            }
        }

        {
            let state = app_for_cleanup.state::<GatewayHttpState>();
            let mut active = state.active.lock().await;
            active.remove(&request_id);
        }

        if !saw_error {
            emit_gateway_event(
                &app_for_cleanup,
                GatewayHttpEvent {
                    request_id,
                    event_type: "end".to_string(),
                    chunk_base64: None,
                    error: None,
                },
            );
        }
    });

    Ok(meta)
}

#[tauri::command]
pub async fn gateway_http_cancel(
    state: State<'_, GatewayHttpState>,
    request_id: String,
) -> Result<(), String> {
    let cancel = state.active.lock().await.remove(&request_id);
    if let Some(cancel) = cancel {
        let _ = cancel.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_gateway_url_allows_api_origin_only() {
        assert!(validate_gateway_url("https://api.serendb.com/projects").is_ok());
        assert!(validate_gateway_url("https://mcp.serendb.com/mcp").is_err());
        assert!(validate_gateway_url("http://api.serendb.com/projects").is_err());
    }

    #[test]
    fn stored_auth_skips_login_refresh_and_signup() {
        let no_auth_headers = HeaderMap::new();

        let projects = Url::parse("https://api.serendb.com/projects").unwrap();
        assert!(should_use_stored_auth(&projects, &no_auth_headers));

        let login = Url::parse("https://api.serendb.com/auth/login").unwrap();
        assert!(!should_use_stored_auth(&login, &no_auth_headers));

        let refresh = Url::parse("https://api.serendb.com/auth/refresh").unwrap();
        assert!(!should_use_stored_auth(&refresh, &no_auth_headers));
    }

    /// The dispatch handle is app-internal proof — it must be stripped before
    /// the request goes on the wire, whatever its casing.
    #[test]
    fn auth_handle_header_never_reaches_the_wire() {
        let mut raw = HashMap::new();
        raw.insert("X-Seren-Auth-Handle".to_string(), "handle-1".to_string());
        raw.insert("accept".to_string(), "application/json".to_string());
        let headers = build_header_map(&raw).unwrap();
        assert!(!headers.contains_key(AUTH_HANDLE_HEADER));
        assert!(headers.contains_key("accept"));
    }

    /// #3193-F: only the publisher tool-dispatch surface demands a dispatch
    /// handle; every other Gateway path is app-level API traffic.
    #[test]
    fn publisher_dispatch_target_matches_only_the_tool_dispatch_surface() {
        let dispatch =
            Url::parse("https://api.serendb.com/publishers/gmail/_mcp/tools/post_send").unwrap();
        assert_eq!(
            publisher_dispatch_target(&dispatch),
            Some(("gmail".to_string(), "post_send".to_string()))
        );

        let encoded = Url::parse(
            "https://api.serendb.com/publishers/my%2Dpub/_mcp/tools/get%5Fmessages",
        )
        .unwrap();
        assert_eq!(
            publisher_dispatch_target(&encoded),
            Some(("my-pub".to_string(), "get_messages".to_string()))
        );

        for other in [
            "https://api.serendb.com/auth/login",
            "https://api.serendb.com/publishers/gmail",
            "https://api.serendb.com/publishers/seren-skills/skills",
            "https://api.serendb.com/publishers/gmail/_mcp/tools",
            "https://api.serendb.com/publishers/gmail/_mcp/tools/post_send/extra",
        ] {
            assert_eq!(publisher_dispatch_target(&Url::parse(other).unwrap()), None, "{other}");
        }
    }

    #[test]
    fn attach_stored_auth_requires_credentials_for_protected_paths() {
        let no_auth_headers = HeaderMap::new();
        let catalog =
            Url::parse("https://api.serendb.com/publishers/seren-skills/skills").unwrap();

        // Signed-out cold start: public catalog must go through unauthenticated
        // instead of failing through the refresh path. Regression guard for #1860.
        assert!(!should_attach_stored_auth(&catalog, &no_auth_headers, false));

        // Signed-in: same path attaches the bearer token via authenticated_request.
        assert!(should_attach_stored_auth(&catalog, &no_auth_headers, true));

        // Auth-bootstrap endpoints stay unauthenticated even when credentials exist,
        // so /auth/refresh does not loop into itself.
        let refresh = Url::parse("https://api.serendb.com/auth/refresh").unwrap();
        assert!(!should_attach_stored_auth(&refresh, &no_auth_headers, true));
    }
}
