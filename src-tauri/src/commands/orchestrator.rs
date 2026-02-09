// ABOUTME: Tauri command wrappers for the orchestrator service.
// ABOUTME: Thin layer that delegates to orchestrator::eval, orchestrator::service.

use tauri::{AppHandle, Manager, State};

use crate::orchestrator::eval::EvalState;
use crate::orchestrator::service::OrchestratorState;
use crate::orchestrator::types::{ImageAttachment, UserCapabilities};
use crate::services::database::init_db;

/// Send a prompt through the orchestrator pipeline.
///
/// Classifies the task, routes to the appropriate worker, and streams
/// events back to the frontend via `orchestrator://event` emissions.
#[tauri::command]
pub async fn orchestrate(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    conversation_id: String,
    prompt: String,
    history: Vec<serde_json::Value>,
    capabilities: UserCapabilities,
    images: Vec<ImageAttachment>,
) -> Result<(), String> {
    crate::orchestrator::service::orchestrate(
        app,
        &state,
        conversation_id,
        prompt,
        history,
        capabilities,
        images,
    )
    .await
}

/// Cancel an active orchestration session.
#[tauri::command]
pub async fn cancel_orchestration(
    state: State<'_, OrchestratorState>,
    conversation_id: String,
) -> Result<(), String> {
    crate::orchestrator::service::cancel(&state, &conversation_id).await
}

/// Submit an eval satisfaction signal for a message.
#[tauri::command]
pub async fn submit_eval_signal(
    app: AppHandle,
    _eval_state: State<'_, EvalState>,
    message_id: String,
    satisfaction: i32,
    auth_token: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|e| e.to_string())?;
        let eval = app.state::<EvalState>();
        crate::orchestrator::eval::submit(&conn, &eval, &message_id, satisfaction, &auth_token)
    })
    .await
    .map_err(|e| e.to_string())?
}
