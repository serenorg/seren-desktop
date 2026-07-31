// ABOUTME: Serial run-engine scheduler and its lazily started Tauri state.
// ABOUTME: Owns the only scheduler write connection and emits durable run events in order.

use super::status::derive_run_status;
use super::store::{self, AppendOutcome};
use super::types::{
    AgentAssignment, LeaseMode, NewLease, NewRunEvent, Run, RunEvent, RunEventType, RunStatus,
    Task, TaskState, WorkspaceLease,
};
use super::workspace::{self, ProvisionRequest, ProvisionedWorkspace};
use crate::embedded_runtime;
use crate::services::database::{init_db, now_ms};
use rusqlite::{Connection, params};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

enum SchedulerCommand {
    CreateRun {
        objective: String,
        root_path: Option<String>,
        reply: oneshot::Sender<Result<Run, String>>,
    },
    AddTask {
        run_id: String,
        title: String,
        brief: String,
        depends_on: Vec<String>,
        reply: oneshot::Sender<Result<Task, String>>,
    },
    AddAssignment {
        run_id: String,
        agent_type: String,
        model_id: Option<String>,
        role_label: Option<String>,
        reply: oneshot::Sender<Result<AgentAssignment, String>>,
    },
    RequestCancel {
        run_id: String,
        reply: oneshot::Sender<Result<Run, String>>,
    },
    RecordEvent {
        event: NewRunEvent,
        reply: oneshot::Sender<Result<AppendOutcome, String>>,
    },
    ProvisionWorkspace {
        run_id: String,
        task_id: String,
        mode: LeaseMode,
        source_path: Option<String>,
        setup_script: Option<String>,
        reply: oneshot::Sender<Result<WorkspaceLease, String>>,
    },
    FinishProvision {
        lease_id: String,
        run_id: String,
        task_id: String,
        outcome: Result<ProvisionedWorkspace, String>,
    },
    ReleaseLease {
        lease_id: String,
        reply: oneshot::Sender<Result<WorkspaceLease, String>>,
    },
}

pub struct RunEngineState {
    sender: Mutex<Option<mpsc::Sender<SchedulerCommand>>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl RunEngineState {
    pub fn new() -> Self {
        Self {
            sender: Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    async fn sender(&self, app: &AppHandle) -> Result<mpsc::Sender<SchedulerCommand>, String> {
        if let Some(sender) = self
            .sender
            .lock()
            .map_err(|_| "run scheduler sender lock poisoned".to_string())?
            .clone()
        {
            return Ok(sender);
        }

        let _start_guard = self.start_lock.lock().await;
        if let Some(sender) = self
            .sender
            .lock()
            .map_err(|_| "run scheduler sender lock poisoned".to_string())?
            .clone()
        {
            return Ok(sender);
        }

        let connection = init_db(app).map_err(|error| error.to_string())?;
        let workspaces_root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("run-workspaces");
        let (sender, receiver) = mpsc::channel(128);
        let scheduler_app = app.clone();
        let scheduler_sender = sender.clone();
        tauri::async_runtime::spawn(async move {
            scheduler_loop(
                scheduler_app,
                connection,
                receiver,
                scheduler_sender,
                workspaces_root,
            )
            .await;
        });
        *self
            .sender
            .lock()
            .map_err(|_| "run scheduler sender lock poisoned".to_string())? = Some(sender.clone());
        Ok(sender)
    }

    pub async fn create_run(
        &self,
        app: &AppHandle,
        objective: String,
        root_path: Option<String>,
    ) -> Result<Run, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::CreateRun {
                objective,
                root_path,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped create response".to_string())?
    }

    pub async fn add_task(
        &self,
        app: &AppHandle,
        run_id: String,
        title: String,
        brief: String,
        depends_on: Vec<String>,
    ) -> Result<Task, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::AddTask {
                run_id,
                title,
                brief,
                depends_on,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped add-task response".to_string())?
    }

    pub async fn add_assignment(
        &self,
        app: &AppHandle,
        run_id: String,
        agent_type: String,
        model_id: Option<String>,
        role_label: Option<String>,
    ) -> Result<AgentAssignment, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::AddAssignment {
                run_id,
                agent_type,
                model_id,
                role_label,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped add-assignment response".to_string())?
    }

    pub async fn request_cancel(
        &self,
        app: &AppHandle,
        run_id: String,
    ) -> Result<Run, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::RequestCancel { run_id, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped cancel response".to_string())?
    }

    pub async fn record_event(
        &self,
        app: &AppHandle,
        event: NewRunEvent,
    ) -> Result<AppendOutcome, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::RecordEvent { event, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped event response".to_string())?
    }

    pub async fn provision_workspace(
        &self,
        app: &AppHandle,
        run_id: String,
        task_id: String,
        mode: LeaseMode,
        source_path: Option<String>,
        setup_script: Option<String>,
    ) -> Result<WorkspaceLease, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::ProvisionWorkspace {
                run_id,
                task_id,
                mode,
                source_path,
                setup_script,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped provision response".to_string())?
    }

    pub async fn release_lease(
        &self,
        app: &AppHandle,
        lease_id: String,
    ) -> Result<WorkspaceLease, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::ReleaseLease { lease_id, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped release response".to_string())?
    }
}

impl Default for RunEngineState {
    fn default() -> Self {
        Self::new()
    }
}

async fn scheduler_loop(
    app: AppHandle,
    connection: Connection,
    mut receiver: mpsc::Receiver<SchedulerCommand>,
    sender: mpsc::Sender<SchedulerCommand>,
    workspaces_root: PathBuf,
) {
    while let Some(command) = receiver.recv().await {
        process_command(&app, &connection, &sender, &workspaces_root, command);
    }
}

fn process_command(
    app: &AppHandle,
    conn: &Connection,
    sender: &mpsc::Sender<SchedulerCommand>,
    workspaces_root: &Path,
    command: SchedulerCommand,
) {
    match command {
        SchedulerCommand::CreateRun {
            objective,
            root_path,
            reply,
        } => {
            let _ = reply.send(create_run(app, conn, objective, root_path));
        }
        SchedulerCommand::AddTask {
            run_id,
            title,
            brief,
            depends_on,
            reply,
        } => {
            let _ = reply.send(add_task(app, conn, run_id, title, brief, depends_on));
        }
        SchedulerCommand::AddAssignment {
            run_id,
            agent_type,
            model_id,
            role_label,
            reply,
        } => {
            let _ = reply.send(add_assignment(
                app,
                conn,
                run_id,
                agent_type,
                model_id,
                role_label,
            ));
        }
        SchedulerCommand::RequestCancel { run_id, reply } => {
            let _ = reply.send(request_cancel(app, conn, run_id));
        }
        SchedulerCommand::RecordEvent { event, reply } => {
            let _ = reply.send(record_event(app, conn, event));
        }
        SchedulerCommand::ProvisionWorkspace {
            run_id,
            task_id,
            mode,
            source_path,
            setup_script,
            reply,
        } => {
            let result = start_provision(
                app,
                conn,
                sender,
                workspaces_root,
                run_id,
                task_id,
                mode,
                source_path,
                setup_script,
            );
            let _ = reply.send(result);
        }
        SchedulerCommand::FinishProvision {
            lease_id,
            run_id,
            task_id,
            outcome,
        } => {
            if let Err(error) = finish_provision(app, conn, lease_id, run_id, task_id, outcome) {
                log::error!("[run-engine] workspace provision completion failed: {error}");
            }
        }
        SchedulerCommand::ReleaseLease { lease_id, reply } => {
            let _ = reply.send(release_lease(app, conn, lease_id));
        }
    }
}

fn start_provision(
    app: &AppHandle,
    conn: &Connection,
    sender: &mpsc::Sender<SchedulerCommand>,
    workspaces_root: &Path,
    run_id: String,
    task_id: String,
    mode: LeaseMode,
    source_path: Option<String>,
    setup_script: Option<String>,
) -> Result<WorkspaceLease, String> {
    let (title, state) = conn
        .query_row(
            "SELECT title, state FROM run_tasks WHERE id = ?1 AND run_id = ?2",
            params![task_id, run_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    if TaskState::parse(&state) != Some(TaskState::Ready) {
        return Err(format!(
            "task must be ready before provisioning; current state is {state}"
        ));
    }

    let lease_id = Uuid::new_v4().to_string();
    store::insert_lease(
        conn,
        NewLease {
            id: lease_id.clone(),
            run_id: run_id.clone(),
            task_id: task_id.clone(),
            mode,
        },
    )
    .map_err(|error| error.to_string())?;
    store::update_lease_state(conn, &lease_id, "provisioning", None, None)
        .map_err(|error| error.to_string())?;
    store::transition_task(conn, &task_id, TaskState::Provisioning, None)
        .map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        lease_state_event(
            &run_id,
            Some(&task_id),
            &lease_id,
            "provisioning",
            None,
            None,
            None,
            None,
        ),
    )?;
    append_and_emit(
        app,
        conn,
        task_state_event(&run_id, &task_id, TaskState::Provisioning),
    )?;
    recompute_ready_and_status(app, conn, &run_id)?;

    let lease = store::get_lease(conn, &lease_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workspace lease disappeared after insertion".to_string())?;
    let request = ProvisionRequest {
        run_id: run_id.clone(),
        task_id: task_id.clone(),
        task_slug: workspace::slugify(&title),
        mode,
        source_path: source_path.map(PathBuf::from),
        setup_script,
        workspaces_root: workspaces_root.to_path_buf(),
    };
    let finish_sender = sender.clone();
    let finish_lease_id = lease_id.clone();
    let finish_run_id = run_id.clone();
    let finish_task_id = task_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = tauri::async_runtime::spawn_blocking(move || provision_and_setup(request))
            .await
            .map_err(|error| format!("workspace worker join failed: {error}"))
            .and_then(|outcome| outcome);
        let _ = finish_sender
            .send(SchedulerCommand::FinishProvision {
                lease_id: finish_lease_id,
                run_id: finish_run_id,
                task_id: finish_task_id,
                outcome,
            })
            .await;
    });

    Ok(lease)
}

fn provision_and_setup(
    request: ProvisionRequest,
) -> Result<ProvisionedWorkspace, String> {
    let mut provisioned = workspace::provision(&request).map_err(|error| error.to_string())?;
    let setup_script = request.setup_script.clone().or_else(|| {
        matches!(request.mode, LeaseMode::Scratch | LeaseMode::Worktree)
            .then(|| workspace::default_setup_script(&provisioned.root_path))
            .flatten()
    });
    if let Some(script) = setup_script {
        let embedded_path = embedded_runtime::get_embedded_path();
        let env_path = (!embedded_path.is_empty()).then(|| embedded_path.to_string());
        provisioned.setup = Some(workspace::run_setup_script(
            &provisioned.root_path,
            &script,
            env_path,
            Duration::from_secs(300),
        ));
    }
    Ok(provisioned)
}

fn finish_provision(
    app: &AppHandle,
    conn: &Connection,
    lease_id: String,
    run_id: String,
    task_id: String,
    outcome: Result<ProvisionedWorkspace, String>,
) -> Result<(), String> {
    match outcome {
        Ok(provisioned) => {
            let root_path = provisioned.root_path.to_string_lossy().to_string();
            let base_revision = provisioned.base_revision.clone();
            let setup_exit_code = provisioned.setup.as_ref().map(|setup| setup.exit_code);
            let setup_failed = setup_exit_code.is_some_and(|exit_code| exit_code != 0);
            let lease_state = if setup_failed { "setup_failed" } else { "active" };
            store::update_lease_state(
                conn,
                &lease_id,
                lease_state,
                Some(&root_path),
                base_revision.as_deref(),
            )
            .map_err(|error| error.to_string())?;
            store::transition_task(conn, &task_id, TaskState::Ready, None)
                .map_err(|error| error.to_string())?;
            append_and_emit(
                app,
                conn,
                lease_state_event(
                    &run_id,
                    Some(&task_id),
                    &lease_id,
                    lease_state,
                    Some(&provisioned),
                    setup_exit_code,
                    None,
                    None,
                ),
            )?;
            append_and_emit(
                app,
                conn,
                task_state_event(&run_id, &task_id, TaskState::Ready),
            )?;
            recompute_ready_and_status(app, conn, &run_id)?;
        }
        Err(error) => {
            store::update_lease_state(conn, &lease_id, "failed", None, None)
                .map_err(|db_error| db_error.to_string())?;
            store::transition_task(conn, &task_id, TaskState::Failed, None)
                .map_err(|db_error| db_error.to_string())?;
            append_and_emit(
                app,
                conn,
                lease_state_event(
                    &run_id,
                    Some(&task_id),
                    &lease_id,
                    "failed",
                    None,
                    None,
                    None,
                    Some(&error),
                ),
            )?;
            append_and_emit(
                app,
                conn,
                task_state_event(&run_id, &task_id, TaskState::Failed),
            )?;
            recompute_ready_and_status(app, conn, &run_id)?;
        }
    }
    Ok(())
}

fn release_lease(
    app: &AppHandle,
    conn: &Connection,
    lease_id: String,
) -> Result<WorkspaceLease, String> {
    store::update_lease_state(conn, &lease_id, "released", None, None)
        .map_err(|error| error.to_string())?;
    let lease = store::get_lease(conn, &lease_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workspace lease not found after release".to_string())?;
    append_and_emit(
        app,
        conn,
        lease_state_event(
            &lease.run_id,
            lease.task_id.as_deref(),
            &lease.id,
            "released",
            None,
            None,
            None,
            None,
        ),
    )?;
    recompute_ready_and_status(app, conn, &lease.run_id)?;
    Ok(lease)
}

fn task_state_event(run_id: &str, task_id: &str, state: TaskState) -> NewRunEvent {
    NewRunEvent {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        task_id: Some(task_id.to_string()),
        attempt_id: None,
        agent_id: None,
        event_type: RunEventType::TaskStateChanged,
        payload: json!({"state": state}),
        provider_event_id: None,
        created_at: now_ms(),
    }
}

fn lease_state_event(
    run_id: &str,
    task_id: Option<&str>,
    lease_id: &str,
    state: &str,
    provisioned: Option<&ProvisionedWorkspace>,
    setup_exit_code: Option<i32>,
    uncommitted_warning: Option<&str>,
    error: Option<&str>,
) -> NewRunEvent {
    let (root_path, base_revision, branch_name, provisioned_warning) = provisioned
        .map(|workspace| {
            (
                Some(workspace.root_path.to_string_lossy().to_string()),
                workspace.base_revision.clone(),
                workspace.branch_name.clone(),
                workspace.uncommitted_warning.clone(),
            )
        })
        .unwrap_or((None, None, None, None));
    NewRunEvent {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        task_id: task_id.map(str::to_string),
        attempt_id: None,
        agent_id: None,
        event_type: RunEventType::LeaseStateChanged,
        payload: json!({
            "lease_id": lease_id,
            "state": state,
            "root_path": root_path,
            "base_revision": base_revision,
            "branch_name": branch_name,
            "uncommitted_warning": uncommitted_warning.or(provisioned_warning.as_deref()),
            "setup_exit_code": setup_exit_code,
            "error": error,
        }),
        provider_event_id: None,
        created_at: now_ms(),
    }
}

fn create_run(
    app: &AppHandle,
    conn: &Connection,
    objective: String,
    root_path: Option<String>,
) -> Result<Run, String> {
    if objective.trim().is_empty() {
        return Err("objective must not be empty".to_string());
    }
    let timestamp = now_ms();
    let run = Run {
        id: Uuid::new_v4().to_string(),
        objective,
        root_path,
        status: RunStatus::Running,
        cancel_requested: false,
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: None,
    };
    store::create_run(conn, &run).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        NewRunEvent {
            id: Uuid::new_v4().to_string(),
            run_id: run.id.clone(),
            task_id: None,
            attempt_id: None,
            agent_id: None,
            event_type: RunEventType::RunCreated,
            payload: json!({"objective": run.objective}),
            provider_event_id: None,
            created_at: timestamp,
        },
    )?;
    recompute_ready_and_status(app, conn, &run.id)?;
    Ok(run)
}

fn add_task(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    title: String,
    brief: String,
    depends_on: Vec<String>,
) -> Result<Task, String> {
    if title.trim().is_empty() {
        return Err("task title must not be empty".to_string());
    }
    let timestamp = now_ms();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.clone(),
        title,
        brief,
        state: TaskState::Pending,
        blocked_reason: None,
        created_at: timestamp,
        updated_at: timestamp,
    };
    store::add_task(conn, &task, &depends_on).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        event_for_task(&task, RunEventType::TaskAdded, json!({"title": task.title})),
    )?;
    for dependency in depends_on {
        append_and_emit(
            app,
            conn,
            NewRunEvent {
                id: Uuid::new_v4().to_string(),
                run_id: run_id.clone(),
                task_id: Some(task.id.clone()),
                attempt_id: None,
                agent_id: None,
                event_type: RunEventType::DependencyAdded,
                payload: json!({"depends_on_task_id": dependency}),
                provider_event_id: None,
                created_at: timestamp,
            },
        )?;
    }
    recompute_ready_and_status(app, conn, &run_id)?;
    store::load_run_snapshot(conn, &run_id)
        .map_err(|error| error.to_string())?
        .and_then(|snapshot| snapshot.tasks.into_iter().find(|candidate| candidate.id == task.id))
        .ok_or_else(|| "task disappeared after insertion".to_string())
}

fn add_assignment(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    agent_type: String,
    model_id: Option<String>,
    role_label: Option<String>,
) -> Result<AgentAssignment, String> {
    if agent_type.trim().is_empty() {
        return Err("agent_type must not be empty".to_string());
    }
    let assignment = AgentAssignment {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.clone(),
        agent_type,
        model_id,
        role_label,
        created_at: now_ms(),
    };
    store::add_assignment(conn, &assignment).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        NewRunEvent {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            task_id: None,
            attempt_id: None,
            agent_id: Some(assignment.id.clone()),
            event_type: RunEventType::AssignmentAdded,
            payload: json!({
                "agent_type": assignment.agent_type,
                "model_id": assignment.model_id,
                "role_label": assignment.role_label,
            }),
            provider_event_id: None,
            created_at: assignment.created_at,
        },
    )?;
    recompute_ready_and_status(app, conn, &run_id)?;
    Ok(assignment)
}

fn request_cancel(app: &AppHandle, conn: &Connection, run_id: String) -> Result<Run, String> {
    let updated = conn
        .execute(
            "UPDATE runs SET cancel_requested = 1, updated_at = ?1 WHERE id = ?2",
            params![now_ms(), run_id],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("run not found".to_string());
    }
    append_and_emit(
        app,
        conn,
        NewRunEvent {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            task_id: None,
            attempt_id: None,
            agent_id: None,
            event_type: RunEventType::RunCancelRequested,
            payload: json!({}),
            provider_event_id: None,
            created_at: now_ms(),
        },
    )?;

    let mut statement = conn
        .prepare("SELECT id, state FROM run_tasks WHERE run_id = ?1 ORDER BY created_at, id")
        .map_err(|error| error.to_string())?;
    let tasks = statement
        .query_map(params![run_id.clone()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    for (task_id, state) in tasks {
        let state = TaskState::parse(&state)
            .ok_or_else(|| format!("invalid task state in database: {state}"))?;
        if state.is_terminal() {
            continue;
        }
        store::transition_task(conn, &task_id, TaskState::Cancelled, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(
            app,
            conn,
            NewRunEvent {
                id: Uuid::new_v4().to_string(),
                run_id: run_id.clone(),
                task_id: Some(task_id),
                attempt_id: None,
                agent_id: None,
                event_type: RunEventType::TaskStateChanged,
                payload: json!({"state": TaskState::Cancelled}),
                provider_event_id: None,
                created_at: now_ms(),
            },
        )?;
    }
    recompute_ready_and_status(app, conn, &run_id)?;
    append_and_emit(
        app,
        conn,
        NewRunEvent {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            task_id: None,
            attempt_id: None,
            agent_id: None,
            event_type: RunEventType::RunFinalized,
            payload: json!({"status": RunStatus::Cancelled}),
            provider_event_id: None,
            created_at: now_ms(),
        },
    )?;
    load_run(conn, &run_id)
}

fn record_event(
    app: &AppHandle,
    conn: &Connection,
    event: NewRunEvent,
) -> Result<AppendOutcome, String> {
    let outcome = append_and_emit(app, conn, event.clone())?;
    recompute_ready_and_status(app, conn, &event.run_id)?;
    Ok(outcome)
}

fn append_and_emit(
    app: &AppHandle,
    conn: &Connection,
    event: NewRunEvent,
) -> Result<AppendOutcome, String> {
    let outcome = store::append_event(conn, &event).map_err(|error| error.to_string())?;
    if let AppendOutcome::Inserted(sequence) = outcome {
        let persisted = RunEvent {
            id: event.id,
            run_id: event.run_id,
            task_id: event.task_id,
            attempt_id: event.attempt_id,
            agent_id: event.agent_id,
            sequence,
            event_type: event.event_type,
            payload: event.payload,
            provider_event_id: event.provider_event_id,
            created_at: event.created_at,
        };
        if let Err(error) = app.emit("run://event", &persisted) {
            log::warn!("[run-engine] failed to emit run event: {error}");
        }
    }
    Ok(outcome)
}

fn event_for_task(task: &Task, event_type: RunEventType, payload: serde_json::Value) -> NewRunEvent {
    NewRunEvent {
        id: Uuid::new_v4().to_string(),
        run_id: task.run_id.clone(),
        task_id: Some(task.id.clone()),
        attempt_id: None,
        agent_id: None,
        event_type,
        payload,
        provider_event_id: None,
        created_at: now_ms(),
    }
}

fn recompute_ready_and_status(
    app: &AppHandle,
    conn: &Connection,
    run_id: &str,
) -> Result<(), String> {
    for task_id in store::ready_task_ids(conn, run_id).map_err(|error| error.to_string())? {
        store::transition_task(conn, &task_id, TaskState::Ready, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(
            app,
            conn,
            NewRunEvent {
                id: Uuid::new_v4().to_string(),
                run_id: run_id.to_string(),
                task_id: Some(task_id),
                attempt_id: None,
                agent_id: None,
                event_type: RunEventType::TaskStateChanged,
                payload: json!({"state": TaskState::Ready}),
                provider_event_id: None,
                created_at: now_ms(),
            },
        )?;
    }

    let (cancel_requested, task_states) = load_status_inputs(conn, run_id)?;
    let status = derive_run_status(&task_states, cancel_requested);
    let completed_at = status.is_terminal().then_some(now_ms());
    let updated = conn
        .execute(
            "UPDATE runs
             SET status = ?1, updated_at = ?2, completed_at = ?3
             WHERE id = ?4",
            params![status.as_str(), now_ms(), completed_at, run_id],
        )
        .map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("run not found".to_string());
    }
    Ok(())
}

fn load_status_inputs(conn: &Connection, run_id: &str) -> Result<(bool, Vec<TaskState>), String> {
    let cancel_requested: i64 = conn
        .query_row(
            "SELECT cancel_requested FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT state FROM run_tasks WHERE run_id = ?1 ORDER BY created_at, id")
        .map_err(|error| error.to_string())?;
    let states = statement
        .query_map(params![run_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .map(|state| {
            let value = state.map_err(|error| error.to_string())?;
            TaskState::parse(&value).ok_or_else(|| format!("invalid task state in database: {value}"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok((cancel_requested != 0, states))
}

fn load_run(conn: &Connection, run_id: &str) -> Result<Run, String> {
    let snapshot = store::load_run_snapshot(conn, run_id).map_err(|error| error.to_string())?;
    snapshot
        .map(|snapshot| snapshot.run)
        .ok_or_else(|| "run not found".to_string())
}
