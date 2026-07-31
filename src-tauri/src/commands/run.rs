// ABOUTME: Thin Tauri command wrappers for the durable run engine.
// ABOUTME: Mutations use the scheduler; snapshots and event replay read SQLite directly.

use crate::run::scheduler::RunEngineState;
use crate::run::store;
use crate::run::types::{AgentAssignment, Run, RunEvent, RunSnapshot, Task};
use crate::services::database::init_db;
use rusqlite::Connection;
use tauri::{AppHandle, State};

async fn read_db<T, F>(app: AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|error| error.to_string())?;
        operation(&conn).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn run_create(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    objective: String,
    root_path: Option<String>,
) -> Result<Run, String> {
    state.create_run(&app, objective, root_path).await
}

#[tauri::command]
pub async fn run_add_task(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    title: String,
    brief: String,
    depends_on: Vec<String>,
) -> Result<Task, String> {
    state
        .add_task(&app, run_id, title, brief, depends_on)
        .await
}

#[tauri::command]
pub async fn run_add_agent(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    agent_type: String,
    model_id: Option<String>,
    role_label: Option<String>,
) -> Result<AgentAssignment, String> {
    state
        .add_assignment(&app, run_id, agent_type, model_id, role_label)
        .await
}

#[tauri::command]
pub async fn run_cancel(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
) -> Result<Run, String> {
    state.request_cancel(&app, run_id).await
}

#[tauri::command]
pub async fn run_get_state(app: AppHandle, run_id: String) -> Result<RunSnapshot, String> {
    read_db(app, move |conn| store::load_run_snapshot(conn, &run_id))
        .await?
        .ok_or_else(|| "run not found".to_string())
}

#[tauri::command]
pub async fn run_list_events(
    app: AppHandle,
    run_id: String,
    after_sequence: i64,
) -> Result<Vec<RunEvent>, String> {
    read_db(app, move |conn| store::list_events(conn, &run_id, after_sequence)).await
}

#[tauri::command]
pub async fn run_list(app: AppHandle) -> Result<Vec<Run>, String> {
    read_db(app, store::list_runs).await
}
