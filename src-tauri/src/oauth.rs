// ABOUTME: OAuth 2.1 callback server for desktop authentication.
// ABOUTME: Handles localhost HTTP server for receiving OAuth authorization callbacks.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

/// State for managing OAuth callback server.
pub struct OAuthState {
    inner: Arc<Mutex<OAuthStateInner>>,
}

struct OAuthStateInner {
    callback_receiver: Option<oneshot::Receiver<OAuthCallback>>,
    shutdown_sender: Option<oneshot::Sender<()>>,
    port: Option<u16>,
}

impl OAuthState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(OAuthStateInner {
                callback_receiver: None,
                shutdown_sender: None,
                port: None,
            })),
        }
    }
}

impl Default for OAuthState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OAuthCallback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// Start the OAuth callback server on a random available port.
/// Returns the port number the server is listening on.
#[tauri::command]
pub async fn start_oauth_callback_server(
    state: tauri::State<'_, OAuthState>,
) -> Result<u16, String> {
    let mut inner = state.inner.lock().await;

    // Stop any existing server
    if let Some(shutdown) = inner.shutdown_sender.take() {
        let _ = shutdown.send(());
    }

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // Set non-blocking for polling
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    inner.port = Some(port);

    // Create channels
    let (callback_tx, callback_rx) = oneshot::channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    inner.callback_receiver = Some(callback_rx);
    inner.shutdown_sender = Some(shutdown_tx);

    // Spawn server in background thread
    std::thread::spawn(move || {
        run_callback_server(listener, callback_tx, shutdown_rx);
    });

    Ok(port)
}

/// Wait for the OAuth callback.
/// Returns the callback parameters or an error.
#[tauri::command]
pub async fn wait_oauth_callback(
    state: tauri::State<'_, OAuthState>,
) -> Result<OAuthCallback, String> {
    let callback_rx = {
        let mut inner = state.inner.lock().await;
        inner.callback_receiver.take()
    };

    let Some(rx) = callback_rx else {
        return Err("No OAuth callback server running".to_string());
    };

    // Wait with timeout
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(callback)) => Ok(callback),
        Ok(Err(_)) => Err("OAuth callback channel closed".to_string()),
        Err(_) => Err("OAuth callback timeout (5 minutes)".to_string()),
    }
}

/// Stop the OAuth callback server.
#[tauri::command]
pub async fn stop_oauth_callback_server(
    state: tauri::State<'_, OAuthState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;

    if let Some(shutdown) = inner.shutdown_sender.take() {
        let _ = shutdown.send(());
    }

    inner.port = None;
    inner.callback_receiver = None;

    Ok(())
}

fn run_callback_server(
    listener: TcpListener,
    callback_tx: oneshot::Sender<OAuthCallback>,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let callback_tx = std::sync::Mutex::new(Some(callback_tx));

    loop {
        // Check for shutdown signal
        match shutdown_rx.try_recv() {
            Ok(()) | Err(oneshot::error::TryRecvError::Closed) => break,
            Err(oneshot::error::TryRecvError::Empty) => {}
        }

        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(callback) = handle_callback_request(stream) {
                    // Send callback through channel
                    if let Some(tx) = callback_tx.lock().unwrap().take() {
                        let _ = tx.send(callback);
                    }
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No connection yet, sleep and retry
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => {
                break;
            }
        }
    }
}

fn handle_callback_request(mut stream: TcpStream) -> Option<OAuthCallback> {
    let buf_reader = BufReader::new(&stream);
    let request_line = buf_reader.lines().next()?.ok()?;

    // Parse the request line: GET /oauth/callback?code=xxx&state=yyy HTTP/1.1
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 || parts[0] != "GET" {
        send_error_response(&mut stream, "Invalid request");
        return None;
    }

    let path_and_query = parts[1];
    if !path_and_query.starts_with("/oauth/callback") {
        send_error_response(&mut stream, "Not found");
        return None;
    }

    // Parse query parameters
    let params = parse_query_params(path_and_query);

    let callback = OAuthCallback {
        code: params.get("code").cloned(),
        state: params.get("state").cloned(),
        error: params.get("error").cloned(),
        error_description: params.get("error_description").cloned(),
    };

    // Send response page
    if callback.error.is_some() {
        send_error_page(
            &mut stream,
            callback.error.as_deref().unwrap_or("Unknown error"),
        );
    } else if callback.code.is_some() {
        send_success_page(&mut stream);
    } else {
        send_error_response(&mut stream, "Missing authorization code");
        return None;
    }

    Some(callback)
}

fn parse_query_params(path_and_query: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();

    if let Some(query_start) = path_and_query.find('?') {
        let query = &path_and_query[query_start + 1..];
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                // URL decode the value
                let decoded_value = percent_decode(value);
                params.insert(key.to_string(), decoded_value);
            }
        }
    }

    params
}

fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }

    result
}

fn send_success_page(stream: &mut TcpStream) {
    let html = r#"<!DOCTYPE html>
<html>
<head>
    <title>Seren Desktop - Login Successful</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #0b0f19; color: #e6e8ee;
               display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #11182a; border: 1px solid #23304a; border-radius: 14px;
                padding: 40px; text-align: center; max-width: 400px; }
        h1 { color: #2d6cdf; margin: 0 0 16px; }
        p { color: #a7b0c2; margin: 0; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Login Successful!</h1>
        <p>You can close this window and return to Seren Desktop.</p>
    </div>
</body>
</html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn send_error_page(stream: &mut TcpStream, error: &str) {
    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
    <title>Seren Desktop - Login Failed</title>
    <style>
        body {{ font-family: system-ui, sans-serif; background: #0b0f19; color: #e6e8ee;
               display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }}
        .card {{ background: #11182a; border: 1px solid #23304a; border-radius: 14px;
                padding: 40px; text-align: center; max-width: 400px; }}
        h1 {{ color: #ef4444; margin: 0 0 16px; }}
        p {{ color: #a7b0c2; margin: 0; }}
        code {{ background: #1a2236; padding: 4px 8px; border-radius: 4px; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>Login Failed</h1>
        <p>Error: <code>{}</code></p>
        <p style="margin-top: 16px;">Please close this window and try again.</p>
    </div>
</body>
</html>"#,
        html_escape(error)
    );

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn send_error_response(stream: &mut TcpStream, message: &str) {
    let response = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        message.len(),
        message
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
