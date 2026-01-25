// ABOUTME: File sync service using the notify crate for file watching.
// ABOUTME: Watches project directories and emits events to the frontend.

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

/// Sync status for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Idle,
    Syncing,
    Synced,
    Error,
}

/// File change event emitted to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub paths: Vec<String>,
    pub kind: String,
}

/// Sync state response.
#[derive(Debug, Clone, Serialize)]
pub struct SyncState {
    pub status: SyncStatus,
    pub message: Option<String>,
    pub watching_path: Option<String>,
}

/// Global watcher state.
struct WatcherState {
    watcher: Option<RecommendedWatcher>,
    watching_path: Option<String>,
    status: SyncStatus,
    message: Option<String>,
    stop_sender: Option<Sender<()>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: None,
            watching_path: None,
            status: SyncStatus::Idle,
            message: None,
            stop_sender: None,
        }
    }
}

lazy_static::lazy_static! {
    static ref WATCHER_STATE: Arc<Mutex<WatcherState>> = Arc::new(Mutex::new(WatcherState::default()));
}

/// Start watching a directory for file changes.
#[tauri::command]
pub fn start_watching(app: AppHandle, path: String) -> Result<(), String> {
    let mut state = WATCHER_STATE
        .lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;

    // Stop existing watcher if any
    if state.watcher.is_some() {
        if let Some(sender) = state.stop_sender.take() {
            let _ = sender.send(());
        }
        state.watcher = None;
    }

    // Create channel for stop signal
    let (stop_tx, stop_rx) = channel::<()>();

    // Create channel for file events
    let (event_tx, event_rx) = channel::<Result<Event, notify::Error>>();

    // Create watcher
    let watcher = RecommendedWatcher::new(
        move |res| {
            let _ = event_tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Start watching
    let mut watcher = watcher;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    // Update state
    state.watcher = Some(watcher);
    state.watching_path = Some(path.clone());
    state.status = SyncStatus::Synced;
    state.message = Some(format!("Watching: {}", path));
    state.stop_sender = Some(stop_tx);

    // Spawn thread to handle events
    let app_clone = app.clone();
    thread::spawn(move || {
        handle_file_events(app_clone, event_rx, stop_rx);
    });

    // Emit initial status
    let _ = app.emit("sync-status", SyncState {
        status: SyncStatus::Synced,
        message: Some(format!("Watching: {}", path)),
        watching_path: Some(path),
    });

    Ok(())
}

/// Handle file events and emit to frontend.
fn handle_file_events(
    app: AppHandle,
    event_rx: Receiver<Result<Event, notify::Error>>,
    stop_rx: Receiver<()>,
) {
    loop {
        // Check for stop signal (non-blocking)
        if stop_rx.try_recv().is_ok() {
            break;
        }

        // Check for file events (with timeout)
        match event_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(Ok(event)) => {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .filter_map(|p| p.to_str().map(String::from))
                    .collect();

                let kind = format!("{:?}", event.kind);

                // Emit syncing status
                let _ = app.emit("sync-status", SyncState {
                    status: SyncStatus::Syncing,
                    message: Some(format!("File changed: {:?}", paths)),
                    watching_path: None,
                });

                // Emit file change event
                let _ = app.emit("file-changed", FileChangeEvent { paths, kind });

                // Emit synced status after a short delay
                let app_clone = app.clone();
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_millis(500));
                    let _ = app_clone.emit("sync-status", SyncState {
                        status: SyncStatus::Synced,
                        message: None,
                        watching_path: None,
                    });
                });
            }
            Ok(Err(e)) => {
                // Emit error status
                let _ = app.emit("sync-status", SyncState {
                    status: SyncStatus::Error,
                    message: Some(format!("Watch error: {}", e)),
                    watching_path: None,
                });
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // No event, continue loop
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // Channel closed, exit loop
                break;
            }
        }
    }
}

/// Stop watching for file changes.
#[tauri::command]
pub fn stop_watching(app: AppHandle) -> Result<(), String> {
    let mut state = WATCHER_STATE
        .lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;

    if let Some(sender) = state.stop_sender.take() {
        let _ = sender.send(());
    }

    state.watcher = None;
    state.watching_path = None;
    state.status = SyncStatus::Idle;
    state.message = None;

    let _ = app.emit("sync-status", SyncState {
        status: SyncStatus::Idle,
        message: None,
        watching_path: None,
    });

    Ok(())
}

/// Get current sync status.
#[tauri::command]
pub fn get_sync_status() -> Result<SyncState, String> {
    let state = WATCHER_STATE
        .lock()
        .map_err(|e| format!("Failed to lock state: {}", e))?;

    Ok(SyncState {
        status: state.status.clone(),
        message: state.message.clone(),
        watching_path: state.watching_path.clone(),
    })
}
