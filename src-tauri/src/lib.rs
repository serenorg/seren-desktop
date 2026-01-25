// ABOUTME: Core library for the Seren Desktop Tauri application.
// ABOUTME: Contains Tauri commands and the application run function.

pub mod commands {
    pub mod chat;
}

pub mod services {
    pub mod database;
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::chat::save_message,
            commands::chat::get_messages,
            commands::chat::clear_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
