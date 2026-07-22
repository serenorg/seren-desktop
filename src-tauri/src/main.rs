// ABOUTME: Entry point for the Seren Desktop Tauri application.
// ABOUTME: Initializes the Rust backend and launches the desktop window.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args
        .get(1)
        .is_some_and(|argument| argument == "__seren-sandbox-run")
    {
        seren_desktop_lib::sandbox::sandbox_run_main(args);
    }
    seren_desktop_lib::run()
}
