// ABOUTME: Tauri commands for SerenDB chat and meeting history sync.
// ABOUTME: Thin command layer over services::history_sync.

use crate::services::history_sync::{
    run_history_sync_once, wipe_remote_history, HistorySyncConfig, HistorySyncSummary,
};
use tauri::AppHandle;

#[tauri::command]
pub async fn history_sync_run_now(
    app: AppHandle,
    project_id: String,
    branch_id: String,
    database_name: String,
    excluded_conversation_ids: Option<Vec<String>>,
) -> Result<HistorySyncSummary, String> {
    run_history_sync_once(
        app,
        HistorySyncConfig {
            project_id,
            branch_id,
            database_name,
            excluded_conversation_ids: excluded_conversation_ids.unwrap_or_default(),
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
            excluded_conversation_ids: Vec::new(),
        },
        confirmation,
    )
    .await
}
