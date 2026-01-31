// ABOUTME: OAuth callback HTTP server for localhost OAuth redirects.
// ABOUTME: Runs on all builds to support Windows (no deep links) and dev mode.

use std::thread;
use tauri::{AppHandle, Emitter};
use tiny_http::{Response, Server};

/// Start the OAuth callback server.
/// Listens on http://localhost:8787/oauth/callback
/// Emits oauth-callback events to the frontend.
pub fn start_oauth_callback_server(app_handle: AppHandle) {
    thread::spawn(move || {
        let server = match Server::http("127.0.0.1:8787") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[OAuth Server] Failed to start: {}", e);
                return;
            }
        };

        log::info!("[OAuth Server] Listening on http://localhost:8787/oauth/callback");

        for request in server.incoming_requests() {
            let url = request.url();

            // Only handle /oauth/callback path
            if url.starts_with("/oauth/callback") {
                log::info!("[OAuth Server] Received callback: {}", url);

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

                let response = Response::from_string(html)
                    .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());

                if let Err(e) = request.respond(response) {
                    log::error!("[OAuth Server] Failed to send response: {}", e);
                }
            } else {
                // Return 404 for other paths
                let response = Response::from_string("Not Found").with_status_code(404);
                let _ = request.respond(response);
            }
        }
    });
}
