// ABOUTME: Rust-backed HTTP bridge for Seren Gateway API requests from the webview.
// ABOUTME: Streams reqwest response bytes back to the frontend to avoid webview CORS limits.

use std::collections::HashMap;

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

#[derive(Default)]
pub struct GatewayHttpState {
    active: Mutex<HashMap<String, oneshot::Sender<()>>>,
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

fn should_skip_stored_auth(path: &str) -> bool {
    matches!(
        normalize_path(path).as_str(),
        "/auth/login" | "/auth/refresh" | "/auth/signup"
    )
}

fn should_use_stored_auth(url: &Url, headers: &HeaderMap) -> bool {
    !headers.contains_key(AUTHORIZATION) && !should_skip_stored_auth(url.path())
}

fn build_header_map(raw_headers: &HashMap<String, String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    for (name, value) in raw_headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host" | "origin" | "content-length" | "connection"
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
    let headers = build_header_map(&request.headers)?;
    let body = request.body.clone();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Failed to create gateway HTTP client: {}", e))?;

    let response = if should_use_stored_auth(&url, &headers) {
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
}
