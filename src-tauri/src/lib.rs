// ABOUTME: Core library for the Seren Desktop Tauri application.
// ABOUTME: Contains Tauri commands and the application run function.

use tauri::Emitter;
use tauri_plugin_store::StoreExt;

pub mod commands {
    pub mod chat;
    pub mod indexing;
    pub mod web;
}

pub mod services {
    pub mod chunker;
    pub mod database;
    pub mod indexer;
    pub mod vector_store;
}

#[cfg(feature = "acp")]
mod acp;
mod embedded_runtime;
mod files;
mod mcp;
mod oauth;
mod oauth_callback_server;
#[cfg(feature = "openclaw")]
mod openclaw;
mod sandbox;
mod sync;
mod terminal;
mod wallet;

const AUTH_STORE: &str = "auth.json";
const TOKEN_KEY: &str = "token";
const REFRESH_TOKEN_KEY: &str = "refresh_token";
const PROVIDERS_STORE: &str = "providers.json";
const OAUTH_STORE: &str = "oauth.json";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Fetch a URL with Bearer auth and return the redirect Location header.
/// Used for OAuth authorize endpoints that return 302 redirects.
#[tauri::command]
async fn get_oauth_redirect_url(url: String, bearer_token: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", bearer_token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if response.status().is_redirection() {
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or("Redirect response missing Location header")?;
        return Ok(location.to_string());
    }

    let status = response.status();

    // If not a redirect, try to parse JSON with authorize_url
    if status.is_success() {
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        if let Some(url) = body.get("authorize_url").or(body.get("url")) {
            if let Some(url_str) = url.as_str() {
                return Ok(url_str.to_string());
            }
        }
    }

    Err(format!("Unexpected response status: {}", status))
}

#[tauri::command]
fn store_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.set(TOKEN_KEY, serde_json::json!(token));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    let token = store
        .get(TOKEN_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(token)
}

#[tauri::command]
fn clear_token(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.delete(TOKEN_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn store_refresh_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.set(REFRESH_TOKEN_KEY, serde_json::json!(token));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_refresh_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    let token = store
        .get(REFRESH_TOKEN_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(token)
}

#[tauri::command]
fn clear_refresh_token(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store.delete(REFRESH_TOKEN_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_setting(
    app: tauri::AppHandle,
    store: String,
    key: String,
) -> Result<Option<String>, String> {
    let store_handle = app.store(&store).map_err(|e| e.to_string())?;
    let value = store_handle
        .get(&key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(value)
}

#[tauri::command]
fn set_setting(
    app: tauri::AppHandle,
    store: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let store_handle = app.store(&store).map_err(|e| e.to_string())?;
    store_handle.set(&key, serde_json::json!(value));
    store_handle.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn store_provider_key(
    app: tauri::AppHandle,
    provider: String,
    api_key: String,
) -> Result<(), String> {
    let store = app.store(PROVIDERS_STORE).map_err(|e| e.to_string())?;
    store.set(&provider, serde_json::json!(api_key));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_provider_key(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String> {
    let store = app.store(PROVIDERS_STORE).map_err(|e| e.to_string())?;
    let key = store
        .get(&provider)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(key)
}

#[tauri::command]
fn clear_provider_key(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let store = app.store(PROVIDERS_STORE).map_err(|e| e.to_string())?;
    store.delete(&provider);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_configured_providers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let store = app.store(PROVIDERS_STORE).map_err(|e| e.to_string())?;
    let providers: Vec<String> = store
        .keys()
        .into_iter()
        .filter(|k| store.get(k).map(|v| v.as_str().is_some()).unwrap_or(false))
        .collect();
    Ok(providers)
}

// OAuth credential storage commands
#[tauri::command]
fn store_oauth_credentials(
    app: tauri::AppHandle,
    provider: String,
    credentials: String,
) -> Result<(), String> {
    let store = app.store(OAUTH_STORE).map_err(|e| e.to_string())?;
    store.set(&provider, serde_json::json!(credentials));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_oauth_credentials(
    app: tauri::AppHandle,
    provider: String,
) -> Result<Option<String>, String> {
    let store = app.store(OAUTH_STORE).map_err(|e| e.to_string())?;
    let creds = store
        .get(&provider)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(creds)
}

#[tauri::command]
fn clear_oauth_credentials(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let store = app.store(OAUTH_STORE).map_err(|e| e.to_string())?;
    store.delete(&provider);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_oauth_providers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let store = app.store(OAUTH_STORE).map_err(|e| e.to_string())?;
    let providers: Vec<String> = store
        .keys()
        .into_iter()
        .filter(|k| store.get(k).map(|v| v.as_str().is_some()).unwrap_or(false))
        .collect();
    Ok(providers)
}

/// Start OAuth flow with browser and loopback server.
/// Opens the auth URL in the default browser and starts a local server to receive the callback.
/// The auth_url must already contain a redirect_uri with the port to listen on.
/// Returns the authorization code and state from the callback.
#[tauri::command]
async fn start_oauth_browser_flow(
    app: tauri::AppHandle,
    auth_url: String,
    timeout_secs: Option<u64>,
) -> Result<oauth::OAuthCallbackResult, String> {
    use tauri_plugin_opener::OpenerExt;

    let timeout = timeout_secs.unwrap_or(300); // 5 minute default timeout

    // Extract the port from the redirect_uri in the auth URL
    // The frontend already registered the client with this redirect_uri, so we must use the same port
    let port = extract_port_from_redirect_uri(&auth_url)?;

    println!("[OAuth] Starting browser flow on port: {}", port);
    println!("[OAuth] Auth URL: {}", auth_url);

    // Open the browser with the original auth URL (don't modify it)
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // Wait for the callback on the specified port
    let result =
        tokio::task::spawn_blocking(move || oauth::wait_for_oauth_callback_on_port(port, timeout))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;

    match result {
        Ok(callback) => Ok(callback),
        Err(oauth_error) => Err(format!(
            "OAuth error: {} - {}",
            oauth_error.error,
            oauth_error.error_description.unwrap_or_default()
        )),
    }
}

/// Extract the port number from the redirect_uri parameter in an OAuth URL.
fn extract_port_from_redirect_uri(auth_url: &str) -> Result<u16, String> {
    // Find redirect_uri parameter
    let re = regex::Regex::new(r"redirect_uri=([^&]+)").map_err(|e| e.to_string())?;

    let captures = re
        .captures(auth_url)
        .ok_or("No redirect_uri found in auth URL")?;

    let encoded_uri = captures.get(1).ok_or("No redirect_uri value")?.as_str();
    let decoded_uri = urlencoding::decode(encoded_uri).map_err(|e| e.to_string())?;

    // Extract port from URI like http://127.0.0.1:58688/oauth/callback
    let port_re =
        regex::Regex::new(r"127\.0\.0\.1:(\d+)").map_err(|e| format!("Regex error: {}", e))?;

    let port_captures = port_re
        .captures(&decoded_uri)
        .ok_or("No port found in redirect_uri")?;

    let port_str = port_captures.get(1).ok_or("No port value")?.as_str();
    port_str
        .parse::<u16>()
        .map_err(|e| format!("Invalid port: {}", e))
}

/// Get an available port for OAuth callback server.
#[tauri::command]
fn get_oauth_callback_port() -> Result<u16, String> {
    oauth::get_available_port()
}

#[derive(serde::Serialize)]
struct BuildInfo {
    app_version: String,
    release_tag: String,
    commit: String,
    build_date: String,
    build_type: String,
    tauri_version: String,
    webview: String,
    rust_version: String,
    os: String,
}

#[tauri::command]
fn get_build_info(app: tauri::AppHandle) -> BuildInfo {
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "unknown".into());

    let webview = if cfg!(target_os = "macos") {
        "WebKit (macOS)".to_string()
    } else if cfg!(target_os = "windows") {
        "WebView2 (Windows)".to_string()
    } else {
        "WebKitGTK (Linux)".to_string()
    };

    let os = format!(
        "{} {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        os_version()
    );

    BuildInfo {
        app_version: version,
        release_tag: env!("BUILT_RELEASE_TAG").to_string(),
        commit: env!("BUILT_COMMIT").to_string(),
        build_date: env!("BUILT_DATE").to_string(),
        build_type: "Alpha".to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview,
        rust_version: env!("BUILT_RUST_VERSION").to_string(),
        os,
    }
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        String::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init());

    // Note: deep-link plugin disabled on Windows due to WiX bundler ICE03 registry errors
    // See: https://github.com/tauri-apps/tauri/issues/10453
    #[cfg(not(target_os = "windows"))]
    {
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }

    builder = builder
        .manage(mcp::McpState::new())
        .manage(mcp::HttpMcpState::new());

    #[cfg(feature = "acp")]
    {
        builder = builder.manage(acp::AcpState::new());
    }

    #[cfg(feature = "openclaw")]
    {
        builder = builder.manage(openclaw::OpenClawState::new());
    }

    builder
        .on_menu_event(|app, event| {
            if event.id().0 == "about" {
                let _ = app.emit("open-about", ());
            }
        })
        .setup(|app| {
            // Build custom menu with About item that emits to frontend
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

                let about = MenuItem::with_id(app, "about", "About Seren", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let quit = PredefinedMenuItem::quit(app, Some("Quit Seren"))?;
                let hide = PredefinedMenuItem::hide(app, Some("Hide Seren"))?;
                let hide_others = PredefinedMenuItem::hide_others(app, None)?;
                let show_all = PredefinedMenuItem::show_all(app, None)?;

                let app_menu = Submenu::with_items(
                    app,
                    "Seren",
                    true,
                    &[
                        &about,
                        &separator,
                        &hide,
                        &hide_others,
                        &show_all,
                        &separator,
                        &quit,
                    ],
                )?;

                let edit_menu = {
                    let undo = PredefinedMenuItem::undo(app, None)?;
                    let redo = PredefinedMenuItem::redo(app, None)?;
                    let cut = PredefinedMenuItem::cut(app, None)?;
                    let copy = PredefinedMenuItem::copy(app, None)?;
                    let paste = PredefinedMenuItem::paste(app, None)?;
                    let select_all = PredefinedMenuItem::select_all(app, None)?;
                    Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[
                            &undo,
                            &redo,
                            &separator,
                            &cut,
                            &copy,
                            &paste,
                            &separator,
                            &select_all,
                        ],
                    )?
                };

                let window_menu = {
                    let minimize = PredefinedMenuItem::minimize(app, None)?;
                    let zoom = PredefinedMenuItem::maximize(app, Some("Zoom"))?;
                    let close = PredefinedMenuItem::close_window(app, None)?;
                    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
                    Submenu::with_items(
                        app,
                        "Window",
                        true,
                        &[&minimize, &zoom, &fullscreen, &separator, &close],
                    )?
                };

                let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
                app.set_menu(menu)?;
            }
            // Configure embedded runtime early in startup
            // This prepends bundled Node.js and Git to PATH
            let paths = embedded_runtime::configure_embedded_runtime(app.handle());
            if paths.node_dir.is_some() || paths.git_dir.is_some() {
                println!(
                    "[Seren] Embedded runtime configured: node={:?}, git={:?}",
                    paths.node_dir.is_some(),
                    paths.git_dir.is_some()
                );
            }

            // Start OAuth callback server in dev mode
            // Provides localhost:8787 redirect for OAuth without deep links
            oauth_callback_server::start_oauth_callback_server(app.handle().clone());

            // Register deep link handler for OAuth callbacks (production)
            // Note: Disabled on Windows due to WiX bundler ICE03 registry errors
            #[cfg(all(desktop, not(target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    println!("[Deep Link] Received open URL event with {} URLs: {:?}", urls.len(), urls);
                    for url in urls {
                        println!("[Deep Link] Processing URL: {}", url);
                        println!("[Deep Link] - scheme: {}", url.scheme());
                        println!("[Deep Link] - path: {}", url.path());
                        if url.scheme() == "seren" && url.path() == "/oauth/callback" {
                            println!("[Deep Link] Match! Emitting oauth-callback event with URL: {}", url.to_string());
                            // Emit event to frontend with OAuth callback data
                            if let Err(e) = handle.emit("oauth-callback", url.to_string()) {
                                eprintln!("[Deep Link] Failed to emit oauth-callback event: {}", e);
                            } else {
                                println!("[Deep Link] Successfully emitted oauth-callback event");
                            }
                        } else {
                            println!("[Deep Link] No match - scheme: {}, path: {}", url.scheme(), url.path());
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_oauth_redirect_url,
            store_token,
            get_token,
            clear_token,
            store_refresh_token,
            get_refresh_token,
            clear_refresh_token,
            get_setting,
            set_setting,
            store_provider_key,
            get_provider_key,
            clear_provider_key,
            get_configured_providers,
            files::read_file,
            files::read_file_base64,
            files::write_file,
            files::list_directory,
            files::path_exists,
            files::is_directory,
            files::create_file,
            files::create_directory,
            files::delete_path,
            files::rename_path,
            files::reveal_in_file_manager,
            // Web fetch command
            commands::web::web_fetch,
            // Conversation commands
            commands::chat::create_conversation,
            commands::chat::get_conversations,
            commands::chat::get_conversation,
            commands::chat::update_conversation,
            commands::chat::archive_conversation,
            commands::chat::delete_conversation,
            // Message commands
            commands::chat::save_message,
            commands::chat::get_messages,
            commands::chat::clear_conversation_history,
            commands::chat::clear_all_history,
            sync::start_watching,
            sync::stop_watching,
            sync::get_sync_status,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_list_tools,
            mcp::mcp_list_resources,
            mcp::mcp_call_tool,
            mcp::mcp_read_resource,
            mcp::mcp_is_connected,
            mcp::mcp_list_connected,
            // HTTP MCP commands (for mcp.serendb.com)
            mcp::mcp_connect_http,
            mcp::mcp_disconnect_http,
            mcp::mcp_list_tools_http,
            mcp::mcp_call_tool_http,
            mcp::mcp_is_connected_http,
            mcp::mcp_list_connected_http,
            wallet::commands::store_crypto_private_key,
            wallet::commands::get_crypto_wallet_address,
            wallet::commands::clear_crypto_wallet,
            wallet::commands::sign_x402_payment,
            wallet::commands::get_crypto_usdc_balance,
            embedded_runtime::get_embedded_runtime_info,
            store_oauth_credentials,
            get_oauth_credentials,
            clear_oauth_credentials,
            get_oauth_providers,
            // OAuth browser flow commands
            start_oauth_browser_flow,
            get_oauth_callback_port,
            // Build info
            get_build_info,
            // Semantic indexing commands
            commands::indexing::init_project_index,
            commands::indexing::get_index_status,
            commands::indexing::has_project_index,
            commands::indexing::index_chunk,
            commands::indexing::index_chunks,
            commands::indexing::delete_file_index,
            commands::indexing::file_needs_reindex,
            commands::indexing::search_codebase,
            commands::indexing::get_embedding_dimension,
            commands::indexing::discover_project_files,
            commands::indexing::chunk_file,
            commands::indexing::estimate_indexing,
            commands::indexing::compute_file_hash,
            // ACP commands (conditionally included when acp feature is enabled)
            #[cfg(feature = "acp")]
            acp::acp_spawn,
            #[cfg(feature = "acp")]
            acp::acp_prompt,
            #[cfg(feature = "acp")]
            acp::acp_cancel,
            #[cfg(feature = "acp")]
            acp::acp_terminate,
            #[cfg(feature = "acp")]
            acp::acp_list_sessions,
            #[cfg(feature = "acp")]
            acp::acp_set_permission_mode,
            #[cfg(feature = "acp")]
            acp::acp_respond_to_permission,
            #[cfg(feature = "acp")]
            acp::acp_get_available_agents,
            #[cfg(feature = "acp")]
            acp::acp_check_agent_available,
            #[cfg(feature = "acp")]
            acp::acp_ensure_claude_cli,
            // OpenClaw commands (conditionally included when openclaw feature is enabled)
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_start,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_stop,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_restart,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_status,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_send,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_list_channels,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_connect_channel,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_get_qr,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_disconnect_channel,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_set_trust,
            #[cfg(feature = "openclaw")]
            openclaw::openclaw_grant_approval,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
