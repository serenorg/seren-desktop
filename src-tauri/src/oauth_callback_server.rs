// ABOUTME: OAuth callback HTTP server for localhost OAuth redirects.
// ABOUTME: Runs on all builds to support Windows (no deep links) and dev mode.

use serde::Serialize;
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use tiny_http::{Response, Server};
use url::form_urlencoded;

#[derive(Clone, Debug, Default, Serialize)]
struct SocialLoginCallbackPayload {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Handle to the running OAuth server. Unblocks the listener on drop
/// so the background thread exits cleanly when the app shuts down.
pub struct OAuthServerHandle {
    server: Arc<Server>,
}

impl Drop for OAuthServerHandle {
    fn drop(&mut self) {
        log::info!("[OAuth Server] Shutting down");
        self.server.unblock();
    }
}

/// Start the OAuth callback server.
/// Listens on http://localhost:8787/oauth/callback
/// Emits oauth-callback events to the frontend.
/// Returns a handle that stops the server when dropped.
pub fn start_oauth_callback_server(app_handle: AppHandle) -> Option<OAuthServerHandle> {
    let server = match Server::http("127.0.0.1:8787") {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log::error!("[OAuth Server] Failed to start: {}", e);
            return None;
        }
    };

    let thread_server = Arc::clone(&server);

    thread::spawn(move || {
        log::info!(
            "[OAuth Server] Listening on http://localhost:8787/oauth/callback and /auth/callback"
        );

        for request in thread_server.incoming_requests() {
            let url = request.url().to_string();

            if url.starts_with("/auth/callback") {
                log::info!("[OAuth Server] Received social login callback");

                let payload = parse_social_login_callback(&url);
                if let Err(e) = app_handle.emit("social-login-callback", payload) {
                    log::error!("[OAuth Server] Failed to emit social login event: {}", e);
                }

                let html = r#"
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Return to Seren Desktop</title>
                        <style>
                            body {
                                font-family: system-ui, -apple-system, sans-serif;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                height: 100vh;
                                margin: 0;
                                background: #f5f5f5;
                            }
                            .container {
                                text-align: center;
                                background: white;
                                padding: 2rem;
                                border-radius: 8px;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                            }
                            h1 { color: #111827; margin: 0 0 0.5rem; }
                            p { color: #666; margin: 0; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1>You can return to Seren Desktop</h1>
                            <p>Sign-in is complete.</p>
                        </div>
                        <script>
                            setTimeout(() => window.close(), 1000);
                        </script>
                    </body>
                    </html>
                "#;

                let response = Response::from_string(html).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .unwrap(),
                );

                if let Err(e) = request.respond(response) {
                    log::error!("[OAuth Server] Failed to send response: {}", e);
                }
            } else if url.starts_with("/oauth/callback") {
                log::info!("[OAuth Server] Received publisher OAuth callback: {}", url);

                // Build full callback URL (localhost:8787 + path + query)
                let callback_url = format!("http://localhost:8787{}", url);

                // Emit oauth-callback event to frontend
                if let Err(e) = app_handle.emit("oauth-callback", callback_url.clone()) {
                    log::error!("[OAuth Server] Failed to emit event: {}", e);
                }

                // Send success response to browser
                let html = r#"
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>OAuth Success</title>
                        <style>
                            body {
                                font-family: system-ui, -apple-system, sans-serif;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                height: 100vh;
                                margin: 0;
                                background: #f5f5f5;
                            }
                            .container {
                                text-align: center;
                                background: white;
                                padding: 2rem;
                                border-radius: 8px;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                            }
                            h1 { color: #22c55e; margin: 0 0 0.5rem; }
                            p { color: #666; margin: 0; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1>Authorization Successful</h1>
                            <p>You can close this window and return to Seren Desktop.</p>
                        </div>
                        <script>
                            // Auto-close after 2 seconds
                            setTimeout(() => window.close(), 2000);
                        </script>
                    </body>
                    </html>
                "#;

                let response = Response::from_string(html).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"text/html; charset=utf-8"[..],
                    )
                    .unwrap(),
                );

                if let Err(e) = request.respond(response) {
                    log::error!("[OAuth Server] Failed to send response: {}", e);
                }
            } else {
                // Return 404 for other paths
                let response = Response::from_string("Not Found").with_status_code(404);
                let _ = request.respond(response);
            }
        }

        log::info!("[OAuth Server] Stopped");
    });

    Some(OAuthServerHandle { server })
}

fn parse_social_login_callback(url: &str) -> SocialLoginCallbackPayload {
    let query = url.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut payload = SocialLoginCallbackPayload::default();

    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => payload.code = Some(value.into_owned()),
            "state" => payload.state = Some(value.into_owned()),
            "error" => payload.error = Some(value.into_owned()),
            "error_description" => payload.error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    payload
}
