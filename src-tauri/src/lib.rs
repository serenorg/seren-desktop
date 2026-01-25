// ABOUTME: Core library for the Seren Desktop Tauri application.
// ABOUTME: Contains Tauri commands and the application run function.

use tauri_plugin_store::StoreExt;

mod files;

const AUTH_STORE: &str = "auth.json";
const TOKEN_KEY: &str = "token";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn store_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let store = app.store(AUTH_STORE).map_err(|e| e.to_string())?;
    store
        .set(TOKEN_KEY, serde_json::json!(token));
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            store_token,
            get_token,
            clear_token,
            files::read_file,
            files::write_file,
            files::list_directory,
            files::path_exists,
            files::is_directory,
            files::create_file,
            files::create_directory,
            files::delete_path,
            files::rename_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
