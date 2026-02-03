// ABOUTME: OAuth loopback server for browser-based authentication.
// ABOUTME: Starts a local HTTP server to receive OAuth callbacks from the browser.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

/// Result of the OAuth callback
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCallbackResult {
    pub code: String,
    pub state: String,
}

/// Error from the OAuth callback
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthError {
    pub error: String,
    pub error_description: Option<String>,
}

/// HTML page shown after successful OAuth
const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Authorization Complete</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
            color: #e2e8f0;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        .icon {
            font-size: 4rem;
            margin-bottom: 1rem;
            color: #10b981;
        }
        h1 {
            margin-bottom: 0.5rem;
        }
        p {
            color: #94a3b8;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">&#10003;</div>
        <h1>Authorization Successful</h1>
        <p>You can close this window and return to Seren Desktop.</p>
    </div>
</body>
</html>"#;

/// HTML page shown after OAuth error
const ERROR_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Authorization Failed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
            color: #e2e8f0;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        .icon {
            font-size: 4rem;
            margin-bottom: 1rem;
            color: #f87171;
        }
        h1 {
            margin-bottom: 0.5rem;
        }
        p {
            color: #94a3b8;
        }
        .error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            border-radius: 0.5rem;
            padding: 1rem;
            margin-top: 1rem;
            color: #f87171;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon">&#10007;</div>
        <h1>Authorization Failed</h1>
        <p>Please close this window and try again in Seren Desktop.</p>
        <div class="error">{{ERROR}}</div>
    </div>
</body>
</html>"#;

/// Parse OAuth callback query parameters
fn parse_oauth_callback(query: &str) -> Result<OAuthCallbackResult, OAuthError> {
    let params: std::collections::HashMap<&str, &str> = query
        .split('&')
        .filter_map(|param| {
            let mut parts = param.splitn(2, '=');
            Some((parts.next()?, parts.next()?))
        })
        .collect();

    // Check for error response
    if let Some(error) = params.get("error") {
        return Err(OAuthError {
            error: urlencoding_decode(error),
            error_description: params
                .get("error_description")
                .map(|s| urlencoding_decode(s)),
        });
    }

    // Extract code and state
    let code = params
        .get("code")
        .ok_or_else(|| OAuthError {
            error: "missing_code".to_string(),
            error_description: Some("Authorization code not found in callback".to_string()),
        })?
        .to_string();

    let state = params
        .get("state")
        .ok_or_else(|| OAuthError {
            error: "missing_state".to_string(),
            error_description: Some("State parameter not found in callback".to_string()),
        })?
        .to_string();

    Ok(OAuthCallbackResult {
        code: urlencoding_decode(&code),
        state: urlencoding_decode(&state),
    })
}

/// Simple URL decoding
fn urlencoding_decode(s: &str) -> String {
    let mut result = String::new();
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

/// Get a random available port for the OAuth callback server
pub fn get_available_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Failed to bind: {}", e))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Failed to get port: {}", e))
}

/// Start a loopback server on a specific port and wait for the OAuth callback.
/// This is used when the port was already determined during client registration.
pub fn wait_for_oauth_callback_on_port(
    port: u16,
    timeout_secs: u64,
) -> Result<Result<OAuthCallbackResult, OAuthError>, String> {
    // Bind to the specific port
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    log::info!("[OAuth] Callback server listening on port {}", port);

    // Set blocking mode
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("Failed to set blocking: {}", e))?;

    // Use a channel to receive the result with timeout
    let (tx, rx) = mpsc::channel();

    // Accept one connection
    std::thread::spawn(move || {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buffer = [0; 4096];
                let bytes_read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..bytes_read]);

                // Parse the HTTP request to extract the path
                let first_line = request.lines().next().unwrap_or("");
                let path = first_line.split_whitespace().nth(1).unwrap_or("/");

                // Parse query parameters
                let result = if let Some(query_start) = path.find('?') {
                    let query = &path[query_start + 1..];
                    parse_oauth_callback(query)
                } else {
                    Err(OAuthError {
                        error: "invalid_request".to_string(),
                        error_description: Some("No query parameters in callback".to_string()),
                    })
                };

                // Send appropriate response
                let (status, body) = match &result {
                    Ok(_) => ("200 OK", SUCCESS_HTML.to_string()),
                    Err(e) => {
                        let error_msg = if let Some(desc) = &e.error_description {
                            format!("{}: {}", e.error, desc)
                        } else {
                            e.error.clone()
                        };
                        (
                            "400 Bad Request",
                            ERROR_HTML.replace("{{ERROR}}", &error_msg),
                        )
                    }
                };

                let response = format!(
                    "HTTP/1.1 {}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );

                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();

                let _ = tx.send(result);
            }
            Err(e) => {
                let _ = tx.send(Err(OAuthError {
                    error: "server_error".to_string(),
                    error_description: Some(format!("Failed to accept connection: {}", e)),
                }));
            }
        }
    });

    // Wait for result with timeout
    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(result) => Ok(result),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("OAuth callback timed out".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("OAuth callback server disconnected".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_oauth_callback_success() {
        let query = "code=abc123&state=xyz789";
        let result = parse_oauth_callback(query).unwrap();
        assert_eq!(result.code, "abc123");
        assert_eq!(result.state, "xyz789");
    }

    #[test]
    fn test_parse_oauth_callback_error() {
        let query = "error=access_denied&error_description=User%20denied%20access";
        let result = parse_oauth_callback(query).unwrap_err();
        assert_eq!(result.error, "access_denied");
        assert_eq!(
            result.error_description,
            Some("User denied access".to_string())
        );
    }

    #[test]
    fn test_urlencoding_decode() {
        assert_eq!(urlencoding_decode("hello%20world"), "hello world");
        assert_eq!(urlencoding_decode("hello+world"), "hello world");
        assert_eq!(urlencoding_decode("abc%3D123"), "abc=123");
    }
}
