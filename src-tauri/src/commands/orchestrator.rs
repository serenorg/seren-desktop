// ABOUTME: Tauri command wrappers for the orchestrator service.
// ABOUTME: Thin layer that delegates to orchestrator::service functions.

use tauri::{AppHandle, State};

use crate::orchestrator::service::OrchestratorState;
use crate::orchestrator::types::UserCapabilities;

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
    auth_token: String,
) -> Result<(), String> {
    crate::orchestrator::service::orchestrate(
        app,
        &state,
        conversation_id,
        prompt,
        history,
        capabilities,
        auth_token,
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
