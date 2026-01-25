// ABOUTME: Entry point for the Seren Desktop Tauri application.
// ABOUTME: Initializes the Rust backend and launches the desktop window.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    seren_desktop_lib::run()
}
