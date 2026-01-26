// ABOUTME: Core library for the Seren Desktop Tauri application.
// ABOUTME: Contains Tauri commands and the application run function.

use tauri::Emitter;
use tauri_plugin_store::StoreExt;

pub mod commands {
    pub mod chat;
}

pub mod services {
    pub mod database;
}

mod embedded_runtime;
mod files;
mod mcp;
mod sync;
mod wallet;

const AUTH_STORE: &str = "auth.json";
const TOKEN_KEY: &str = "token";
const PROVIDERS_STORE: &str = "providers.json";
const OAUTH_STORE: &str = "oauth.json";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
fn get_setting(app: tauri::AppHandle, store: String, key: String) -> Result<Option<String>, String> {
    let store_handle = app.store(&store).map_err(|e| e.to_string())?;
    let value = store_handle
        .get(&key)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    Ok(value)
}

#[tauri::command]
fn set_setting(app: tauri::AppHandle, store: String, key: String, value: String) -> Result<(), String> {
    let store_handle = app.store(&store).map_err(|e| e.to_string())?;
    store_handle.set(&key, serde_json::json!(value));
    store_handle.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn store_provider_key(app: tauri::AppHandle, provider: String, api_key: String) -> Result<(), String> {
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
        .filter(|k| {
            store.get(k)
                .map(|v| v.as_str().is_some())
                .unwrap_or(false)
        })
        .collect();
    Ok(providers)
}

// OAuth credential storage commands
#[tauri::command]
fn store_oauth_credentials(app: tauri::AppHandle, provider: String, credentials: String) -> Result<(), String> {
    let store = app.store(OAUTH_STORE).map_err(|e| e.to_string())?;
    store.set(&provider, serde_json::json!(credentials));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_oauth_credentials(app: tauri::AppHandle, provider: String) -> Result<Option<String>, String> {
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
        .filter(|k| {
            store.get(k)
                .map(|v| v.as_str().is_some())
                .unwrap_or(false)
        })
        .collect();
    Ok(providers)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(mcp::McpState::new())
        .setup(|app| {
            // Configure embedded runtime early in startup
            // This prepends bundled Node.js and Git to PATH
            let paths = embedded_runtime::configure_embedded_runtime(&app.handle());
            if paths.node_dir.is_some() || paths.git_dir.is_some() {
                println!("[Seren] Embedded runtime configured: node={:?}, git={:?}",
                    paths.node_dir.is_some(), paths.git_dir.is_some());
            }

            // Register deep link handler for OAuth callbacks
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    for url in urls {
                        if url.scheme() == "seren" && url.path() == "/oauth/callback" {
                            // Emit event to frontend with OAuth callback data
                            let _ = handle.emit("oauth-callback", url.to_string());
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            store_token,
            get_token,
            clear_token,
            get_setting,
            set_setting,
            store_provider_key,
            get_provider_key,
            clear_provider_key,
            get_configured_providers,
            files::read_file,
            files::write_file,
            files::list_directory,
            files::path_exists,
            files::is_directory,
            files::create_file,
            files::create_directory,
            files::delete_path,
            files::rename_path,
            files::reveal_in_file_manager,
            commands::chat::save_message,
            commands::chat::get_messages,
            commands::chat::clear_history,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
