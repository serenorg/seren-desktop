// ABOUTME: Tauri commands for SerenDB chat and meeting history sync.
// ABOUTME: Thin command layer over services::history_sync.

use crate::services::history_sync::{
    HistorySyncConfig, HistorySyncSummary, run_history_sync_once, wipe_remote_history,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn history_sync_run_now(
    app: AppHandle,
    project_id: String,
    branch_id: String,
    database_name: String,
) -> Result<HistorySyncSummary, String> {
    run_history_sync_once(
        app,
        HistorySyncConfig {
            project_id,
            branch_id,
            database_name,
        },
    )
    .await
}

#[tauri::command]
pub async fn history_sync_wipe_remote(
    app: AppHandle,
    project_id: String,
    branch_id: String,
    database_name: String,
    confirmation: String,
) -> Result<(), String> {
    wipe_remote_history(
        app,
        HistorySyncConfig {
            project_id,
            branch_id,
            database_name,
        },
        confirmation,
    )
    .await
}
