// ABOUTME: Thin Tauri command wrappers for the durable run engine.
// ABOUTME: Mutations use the scheduler; snapshots and event replay read SQLite directly.

use crate::run::scheduler::RunEngineState;
use crate::run::store;
use crate::run::types::{
    AgentAssignment, CheckDeclaration, CheckResult, CoverageGap, Finding, LeaseMode, Run, RunCheck,
    RunEvent, RunSnapshot, Task, WorkspaceLease,
};
use crate::run::workspace;
use crate::services::database::init_db;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
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
    max_attempts: Option<i64>,
) -> Result<Run, String> {
    state
        .create_run(&app, objective, root_path, max_attempts.unwrap_or(2))
        .await
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
    permission_mode: Option<String>,
    role_label: Option<String>,
) -> Result<AgentAssignment, String> {
    state
        .add_assignment(
            &app,
            run_id,
            agent_type,
            model_id,
            permission_mode,
            role_label,
        )
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

#[tauri::command]
pub async fn run_declare_checks(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    checks: Vec<CheckDeclaration>,
) -> Result<Vec<RunCheck>, String> {
    state.declare_checks(&app, run_id, checks).await
}

#[tauri::command]
pub async fn run_approve_check(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    check_id: String,
) -> Result<RunCheck, String> {
    state.approve_check(&app, check_id).await
}

#[tauri::command]
pub async fn run_baseline(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
) -> Result<Vec<CheckResult>, String> {
    state.run_baseline(&app, run_id).await
}

#[tauri::command]
pub async fn run_verify_task(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    task_id: String,
) -> Result<Vec<CheckResult>, String> {
    state.verify_task(&app, run_id, task_id).await
}

#[tauri::command]
pub async fn run_complete_task(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    task_id: String,
) -> Result<Vec<String>, String> {
    state.complete_task(&app, run_id, task_id).await
}

#[tauri::command]
pub async fn run_record_finding(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    finding: Finding,
) -> Result<(), String> {
    state.record_finding(&app, finding).await
}

#[tauri::command]
pub async fn run_add_coverage_gap(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    gap: CoverageGap,
) -> Result<(), String> {
    state.record_coverage_gap(&app, gap).await
}

#[tauri::command]
pub async fn run_update_finding_status(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    finding_id: String,
    status: String,
) -> Result<(), String> {
    state
        .update_finding_status(&app, run_id, finding_id, status)
        .await
}

#[tauri::command]
pub async fn run_start_attempt(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    task_id: String,
    agent_assignment_id: Option<String>,
    agent_session_id: Option<String>,
) -> Result<String, String> {
    state
        .start_attempt(
            &app,
            run_id,
            task_id,
            agent_assignment_id,
            agent_session_id,
        )
        .await
}

#[tauri::command]
pub async fn run_finish_attempt(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    attempt_id: String,
    outcome: String,
) -> Result<(), String> {
    state
        .finish_attempt(&app, run_id, attempt_id, outcome)
        .await
}

#[tauri::command]
pub async fn run_relaunch(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
) -> Result<Run, String> {
    state.relaunch(&app, run_id).await
}

#[tauri::command]
pub async fn run_provision_workspace(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    run_id: String,
    task_id: String,
    mode: LeaseMode,
    source_path: Option<String>,
    setup_script: Option<String>,
) -> Result<WorkspaceLease, String> {
    state
        .provision_workspace(
            &app,
            run_id,
            task_id,
            mode,
            source_path,
            setup_script,
        )
        .await
}

#[tauri::command]
pub async fn run_release_workspace(
    app: AppHandle,
    state: State<'_, RunEngineState>,
    lease_id: String,
) -> Result<WorkspaceLease, String> {
    let read_lease_id = lease_id.clone();
    let (lease, source_repo) = read_db(app.clone(), move |conn| {
        let lease = store::get_lease(conn, &read_lease_id)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let source_repo = store::load_run_snapshot(conn, &lease.run_id)?
            .and_then(|snapshot| snapshot.run.root_path)
            .map(PathBuf::from);
        Ok((lease, source_repo))
    })
    .await?;

    let mode = lease.mode;
    let root_path = match lease.root_path.clone() {
        Some(root_path) => root_path,
        None if mode == LeaseMode::Worktree => {
            return Err("worktree lease has no provisioned root path".to_string());
        }
        None => String::new(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        workspace::release(
            Path::new(&root_path),
            source_repo.as_deref(),
            mode,
        )
    })
    .await
    .map_err(|error| error.to_string())??;

    state.release_lease(&app, lease_id).await
}
