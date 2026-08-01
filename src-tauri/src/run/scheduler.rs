// ABOUTME: Serial run-engine scheduler and its lazily started Tauri state.
// ABOUTME: Owns the only scheduler write connection and emits durable run events in order.

use super::checks::{self, CheckGate};
use super::status::derive_run_status;
use super::store::{self, AppendOutcome};
use super::types::{
    AgentAssignment, CheckDeclaration, CheckResult, CoverageGap, Finding, LeaseMode, NewLease,
    NewRunEvent, Run, RunCheck, RunEvent, RunEventType, RunStatus, Task, TaskState, WorkspaceLease,
};
use super::workspace::{self, ProvisionRequest, ProvisionedWorkspace};
use crate::embedded_runtime;
use crate::services::database::{init_db, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
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
    DeclareChecks {
        run_id: String,
        checks: Vec<CheckDeclaration>,
        reply: oneshot::Sender<Result<Vec<RunCheck>, String>>,
    },
    ApproveCheck {
        check_id: String,
        reply: oneshot::Sender<Result<RunCheck, String>>,
    },
    RunBaseline {
        run_id: String,
        reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
    },
    FinishBaseline {
        run_id: String,
        results: Vec<CheckResult>,
        reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
    },
    VerifyTask {
        run_id: String,
        task_id: String,
        reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
    },
    FinishVerify {
        run_id: String,
        task_id: String,
        results: Vec<CheckResult>,
        reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
    },
    CompleteTask {
        run_id: String,
        task_id: String,
        reply: oneshot::Sender<Result<Vec<String>, String>>,
    },
    RecordFinding {
        finding: Finding,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RecordCoverageGap {
        gap: CoverageGap,
        reply: oneshot::Sender<Result<(), String>>,
    },
    UpdateFindingStatus {
        run_id: String,
        finding_id: String,
        status: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    StartAttempt {
        run_id: String,
        task_id: String,
        agent_assignment_id: Option<String>,
        agent_session_id: Option<String>,
        reply: oneshot::Sender<Result<String, String>>,
    },
    FinishAttempt {
        run_id: String,
        attempt_id: String,
        outcome: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Relaunch {
        run_id: String,
        reply: oneshot::Sender<Result<Run, String>>,
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

    pub async fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        self.sender(app).await.map(|_| ())
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

    pub async fn declare_checks(
        &self,
        app: &AppHandle,
        run_id: String,
        checks: Vec<CheckDeclaration>,
    ) -> Result<Vec<RunCheck>, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::DeclareChecks {
                run_id,
                checks,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped declare-checks response".to_string())?
    }

    pub async fn approve_check(
        &self,
        app: &AppHandle,
        check_id: String,
    ) -> Result<RunCheck, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::ApproveCheck { check_id, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped approve-check response".to_string())?
    }

    pub async fn run_baseline(
        &self,
        app: &AppHandle,
        run_id: String,
    ) -> Result<Vec<CheckResult>, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::RunBaseline { run_id, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped baseline response".to_string())?
    }

    pub async fn verify_task(
        &self,
        app: &AppHandle,
        run_id: String,
        task_id: String,
    ) -> Result<Vec<CheckResult>, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::VerifyTask {
                run_id,
                task_id,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped verify response".to_string())?
    }

    pub async fn complete_task(
        &self,
        app: &AppHandle,
        run_id: String,
        task_id: String,
    ) -> Result<Vec<String>, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::CompleteTask {
                run_id,
                task_id,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped completion response".to_string())?
    }

    pub async fn record_finding(
        &self,
        app: &AppHandle,
        finding: Finding,
    ) -> Result<(), String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::RecordFinding { finding, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped finding response".to_string())?
    }

    pub async fn record_coverage_gap(
        &self,
        app: &AppHandle,
        gap: CoverageGap,
    ) -> Result<(), String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::RecordCoverageGap { gap, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped coverage-gap response".to_string())?
    }

    pub async fn update_finding_status(
        &self,
        app: &AppHandle,
        run_id: String,
        finding_id: String,
        status: String,
    ) -> Result<(), String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::UpdateFindingStatus {
                run_id,
                finding_id,
                status,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped finding-status response".to_string())?
    }

    pub async fn start_attempt(
        &self,
        app: &AppHandle,
        run_id: String,
        task_id: String,
        agent_assignment_id: Option<String>,
        agent_session_id: Option<String>,
    ) -> Result<String, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::StartAttempt {
                run_id,
                task_id,
                agent_assignment_id,
                agent_session_id,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped start-attempt response".to_string())?
    }

    pub async fn finish_attempt(
        &self,
        app: &AppHandle,
        run_id: String,
        attempt_id: String,
        outcome: String,
    ) -> Result<(), String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::FinishAttempt {
                run_id,
                attempt_id,
                outcome,
                reply,
            })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped finish-attempt response".to_string())?
    }

    pub async fn relaunch(&self, app: &AppHandle, run_id: String) -> Result<Run, String> {
        let sender = self.sender(app).await?;
        let (reply, response) = oneshot::channel();
        sender
            .send(SchedulerCommand::Relaunch { run_id, reply })
            .await
            .map_err(|_| "run scheduler stopped".to_string())?;
        response
            .await
            .map_err(|_| "run scheduler dropped relaunch response".to_string())?
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
    match reconcile_interrupted(&connection) {
        Ok(events) => {
            for event in events {
                if let Err(error) = append_and_emit(&app, &connection, event) {
                    log::error!("[run-engine] startup reconciliation event failed: {error}");
                }
            }
        }
        Err(error) => log::error!("[run-engine] startup reconciliation failed: {error}"),
    }
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
        SchedulerCommand::DeclareChecks {
            run_id,
            checks,
            reply,
        } => {
            let _ = reply.send(declare_checks(app, conn, run_id, checks));
        }
        SchedulerCommand::ApproveCheck { check_id, reply } => {
            let _ = reply.send(approve_check(app, conn, check_id));
        }
        SchedulerCommand::RunBaseline { run_id, reply } => {
            if let Err(error) = start_baseline(app, conn, sender, run_id, reply) {
                log::error!("[run-engine] baseline dispatch failed: {error}");
            }
        }
        SchedulerCommand::FinishBaseline {
            run_id,
            results,
            reply,
        } => {
            let _ = reply.send(finish_baseline(app, conn, run_id, results));
        }
        SchedulerCommand::VerifyTask {
            run_id,
            task_id,
            reply,
        } => {
            if let Err(error) = start_verify(app, conn, sender, run_id, task_id, reply) {
                log::error!("[run-engine] verify dispatch failed: {error}");
            }
        }
        SchedulerCommand::FinishVerify {
            run_id,
            task_id,
            results,
            reply,
        } => {
            let _ = reply.send(finish_verify(app, conn, run_id, task_id, results));
        }
        SchedulerCommand::CompleteTask {
            run_id,
            task_id,
            reply,
        } => {
            let _ = reply.send(complete_task(app, conn, run_id, task_id));
        }
        SchedulerCommand::RecordFinding { finding, reply } => {
            let _ = reply.send(record_finding(app, conn, finding));
        }
        SchedulerCommand::RecordCoverageGap { gap, reply } => {
            let _ = reply.send(record_coverage_gap(app, conn, gap));
        }
        SchedulerCommand::UpdateFindingStatus {
            run_id,
            finding_id,
            status,
            reply,
        } => {
            let _ = reply.send(update_finding_status(
                app,
                conn,
                run_id,
                finding_id,
                status,
            ));
        }
        SchedulerCommand::StartAttempt {
            run_id,
            task_id,
            agent_assignment_id,
            agent_session_id,
            reply,
        } => {
            let _ = reply.send(start_attempt(
                app,
                conn,
                run_id,
                task_id,
                agent_assignment_id,
                agent_session_id,
            ));
        }
        SchedulerCommand::FinishAttempt {
            run_id,
            attempt_id,
            outcome,
            reply,
        } => {
            let _ = reply.send(finish_attempt(app, conn, run_id, attempt_id, outcome));
        }
        SchedulerCommand::Relaunch { run_id, reply } => {
            let _ = reply.send(relaunch(app, conn, run_id));
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

fn declare_checks(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    declarations: Vec<CheckDeclaration>,
) -> Result<Vec<RunCheck>, String> {
    if store::load_run_snapshot(conn, &run_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("run not found".to_string());
    }
    let mut checks = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        if declaration.name.trim().is_empty() {
            return Err("check name must not be empty".to_string());
        }
        if declaration.command.trim().is_empty() {
            return Err(format!("check {} command must not be empty", declaration.name));
        }
        let check = RunCheck {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            name: declaration.name,
            command: declaration.command,
            approved: false,
            created_at: now_ms(),
        };
        store::insert_check(conn, &check).map_err(|error| error.to_string())?;
        append_and_emit(
            app,
            conn,
            NewRunEvent {
                id: Uuid::new_v4().to_string(),
                run_id: run_id.clone(),
                task_id: None,
                attempt_id: None,
                agent_id: None,
                event_type: RunEventType::CheckDeclared,
                payload: json!({
                    "check_id": check.id,
                    "name": check.name,
                    "command": check.command,
                    "approved": false,
                }),
                provider_event_id: None,
                created_at: check.created_at,
            },
        )?;
        checks.push(check);
    }
    Ok(checks)
}

fn approve_check(
    app: &AppHandle,
    conn: &Connection,
    check_id: String,
) -> Result<RunCheck, String> {
    let check = store::approve_check(conn, &check_id).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        NewRunEvent {
            id: Uuid::new_v4().to_string(),
            run_id: check.run_id.clone(),
            task_id: None,
            attempt_id: None,
            agent_id: None,
            event_type: RunEventType::CheckApproved,
            payload: json!({"check_id": check.id, "name": check.name}),
            provider_event_id: None,
            created_at: now_ms(),
        },
    )?;
    Ok(check)
}

fn approved_check_root(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT root_path FROM runs WHERE id = ?1",
        params![run_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn check_env_path() -> Option<String> {
    let embedded_path = embedded_runtime::get_embedded_path();
    (!embedded_path.is_empty()).then(|| embedded_path.to_string())
}

fn run_check_commands(
    root: &Path,
    checks: &[RunCheck],
    kind: &str,
    task_id: Option<String>,
) -> Vec<CheckResult> {
    let env_path = check_env_path();
    checks
        .iter()
        .map(|check| {
            let setup = checks::execute_check(
                root,
                &check.command,
                env_path.clone(),
                Duration::from_secs(300),
            );
            checks::check_result_from_setup(check.id.clone(), task_id.clone(), kind, setup)
        })
        .collect()
}

fn start_baseline(
    app: &AppHandle,
    conn: &Connection,
    sender: &mpsc::Sender<SchedulerCommand>,
    run_id: String,
    reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
) -> Result<(), String> {
    let checks = store::list_checks(conn, &run_id).map_err(|error| error.to_string())?;
    let root_path = approved_check_root(conn, &run_id)?;
    let approved: Vec<RunCheck> = checks.iter().filter(|check| check.approved).cloned().collect();
    for check in checks.iter().filter(|check| !check.approved) {
        let gap = CoverageGap {
            id: Uuid::new_v4().to_string(),
            run_id: run_id.clone(),
            task_id: None,
            kind: "check_unapproved".to_string(),
            subject: check.name.clone(),
            detail: Some("check was declared but not approved for baseline execution".to_string()),
            created_at: now_ms(),
        };
        record_coverage_gap(app, conn, gap)?;
    }
    if approved.is_empty() || root_path.is_none() {
        if root_path.is_none() {
            for check in &approved {
                record_coverage_gap(
                    app,
                    conn,
                    CoverageGap {
                        id: Uuid::new_v4().to_string(),
                        run_id: run_id.clone(),
                        task_id: None,
                        kind: "not_provisioned".to_string(),
                        subject: check.name.clone(),
                        detail: Some("run has no root path for check execution".to_string()),
                        created_at: now_ms(),
                    },
                )?;
            }
        }
        let result = finish_baseline(app, conn, run_id, Vec::new());
        let _ = reply.send(result);
        return Ok(());
    }

    let root_path = PathBuf::from(root_path.expect("checked above"));
    let finish_sender = sender.clone();
    tauri::async_runtime::spawn(async move {
        let worker = tauri::async_runtime::spawn_blocking(move || {
            run_check_commands(&root_path, &approved, "baseline", None)
        })
        .await
        .map_err(|error| format!("baseline worker join failed: {error}"));
        match worker {
            Ok(results) => {
                let _ = finish_sender
                    .send(SchedulerCommand::FinishBaseline {
                        run_id,
                        results,
                        reply,
                    })
                    .await;
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
    });
    Ok(())
}

fn finish_baseline(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    results: Vec<CheckResult>,
) -> Result<Vec<CheckResult>, String> {
    for result in &results {
        store::insert_check_result(conn, result).map_err(|error| error.to_string())?;
        append_and_emit(app, conn, check_result_event(&run_id, result, "baseline"))?;
    }
    recompute_ready_and_status(app, conn, &run_id)?;
    Ok(results)
}

fn task_root_path(conn: &Connection, run_id: &str, task_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT COALESCE(
            (SELECT root_path FROM run_workspace_leases
             WHERE run_id = ?1 AND task_id = ?2 AND state = 'active'
             ORDER BY created_at DESC LIMIT 1),
            (SELECT root_path FROM runs WHERE id = ?1)
         )",
        params![run_id, task_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn start_verify(
    app: &AppHandle,
    conn: &Connection,
    sender: &mpsc::Sender<SchedulerCommand>,
    run_id: String,
    task_id: String,
    reply: oneshot::Sender<Result<Vec<CheckResult>, String>>,
) -> Result<(), String> {
    let state: String = conn
        .query_row(
            "SELECT state FROM run_tasks WHERE id = ?1 AND run_id = ?2",
            params![task_id, run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let task_state = TaskState::parse(&state).ok_or_else(|| format!("invalid task state: {state}"))?;
    if task_state == TaskState::Running {
        store::transition_task(conn, &task_id, TaskState::Verifying, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Verifying))?;
    } else if task_state != TaskState::Verifying {
        return Err(format!("task must be running or verifying; current state is {state}"));
    }

    let checks = store::list_checks(conn, &run_id).map_err(|error| error.to_string())?;
    let approved: Vec<RunCheck> = checks.into_iter().filter(|check| check.approved).collect();
    let root_path = task_root_path(conn, &run_id, &task_id)?;
    if approved.is_empty() || root_path.is_none() {
        if root_path.is_none() {
            for check in &approved {
                record_coverage_gap(
                    app,
                    conn,
                    CoverageGap {
                        id: Uuid::new_v4().to_string(),
                        run_id: run_id.clone(),
                        task_id: Some(task_id.clone()),
                        kind: "not_provisioned".to_string(),
                        subject: check.name.clone(),
                        detail: Some("task has no active workspace or run root".to_string()),
                        created_at: now_ms(),
                    },
                )?;
            }
        }
        let result = finish_verify(app, conn, run_id, task_id, Vec::new());
        let _ = reply.send(result);
        return Ok(());
    }

    let root_path = PathBuf::from(root_path.expect("checked above"));
    let finish_sender = sender.clone();
    let finish_run_id = run_id.clone();
    let finish_task_id = task_id.clone();
    let worker_task_id = finish_task_id.clone();
    tauri::async_runtime::spawn(async move {
        let worker = tauri::async_runtime::spawn_blocking(move || {
            run_check_commands(
                &root_path,
                &approved,
                "verify",
                Some(worker_task_id),
            )
        })
        .await
        .map_err(|error| format!("verify worker join failed: {error}"));
        match worker {
            Ok(results) => {
                let _ = finish_sender
                    .send(SchedulerCommand::FinishVerify {
                        run_id: finish_run_id,
                        task_id: finish_task_id,
                        results,
                        reply,
                    })
                    .await;
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
    });
    Ok(())
}

fn finish_verify(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    task_id: String,
    results: Vec<CheckResult>,
) -> Result<Vec<CheckResult>, String> {
    for result in &results {
        store::insert_check_result(conn, result).map_err(|error| error.to_string())?;
        append_and_emit(app, conn, check_result_event(&run_id, result, "verify"))?;
    }
    let current_state: String = conn
        .query_row(
            "SELECT state FROM run_tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if TaskState::parse(&current_state) == Some(TaskState::Verifying) {
        store::transition_task(conn, &task_id, TaskState::Review, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Review))?;
    }
    recompute_ready_and_status(app, conn, &run_id)?;
    Ok(results)
}

fn completion_gates(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
) -> Result<Vec<CheckGate>, String> {
    let checks = store::list_checks(conn, run_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|check| check.approved)
        .collect::<Vec<_>>();
    checks
        .into_iter()
        .map(|check| {
            let baseline_failed: bool = conn
                .query_row(
                    "SELECT pre_existing_failure FROM run_check_results
                     WHERE check_id = ?1 AND kind = 'baseline'
                     ORDER BY created_at DESC, id DESC LIMIT 1",
                    params![check.id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .unwrap_or(false);
            let verify_exit: Option<i32> = conn
                .query_row(
                    "SELECT exit_code FROM run_check_results
                     WHERE check_id = ?1 AND task_id = ?2 AND kind = 'verify'
                     ORDER BY created_at DESC, id DESC LIMIT 1",
                    params![check.id, task_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .flatten();
            Ok(CheckGate {
                name: check.name,
                baseline_failed,
                verify_exit,
            })
        })
        .collect()
}

fn complete_task(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    task_id: String,
) -> Result<Vec<String>, String> {
    let state: String = conn
        .query_row(
            "SELECT state FROM run_tasks WHERE id = ?1 AND run_id = ?2",
            params![task_id, run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if TaskState::parse(&state) != Some(TaskState::Review) {
        return Err(format!("task must be in review; current state is {state}"));
    }
    let has_evidence = store::task_has_evidence(conn, &task_id).map_err(|error| error.to_string())?;
    let blockers = checks::completion_blockers(
        has_evidence,
        &completion_gates(conn, &run_id, &task_id)?,
    );
    if !blockers.is_empty() {
        append_and_emit(
            app,
            conn,
            event_for_task_or_run(
                &run_id,
                Some(&task_id),
                RunEventType::TaskCompletionRejected,
                json!({"blockers": blockers.clone()}),
            ),
        )?;
        return Ok(blockers);
    }
    store::transition_task(conn, &task_id, TaskState::Done, None)
        .map_err(|error| error.to_string())?;
    append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Done))?;
    recompute_ready_and_status(app, conn, &run_id)?;
    Ok(Vec::new())
}

fn record_finding(app: &AppHandle, conn: &Connection, finding: Finding) -> Result<(), String> {
    store::insert_finding(conn, &finding).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        event_for_task_or_run(
            &finding.run_id,
            finding.task_id.as_deref(),
            RunEventType::FindingRecorded,
            json!({"finding_id": finding.id, "claim": finding.claim}),
        ),
    )?;
    Ok(())
}

fn record_coverage_gap(
    app: &AppHandle,
    conn: &Connection,
    gap: CoverageGap,
) -> Result<(), String> {
    store::insert_coverage_gap(conn, &gap).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        event_for_task_or_run(
            &gap.run_id,
            gap.task_id.as_deref(),
            RunEventType::CoverageGapRecorded,
            json!({
                "gap_id": gap.id,
                "kind": gap.kind,
                "subject": gap.subject,
                "detail": gap.detail,
            }),
        ),
    )?;
    Ok(())
}

fn update_finding_status(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    finding_id: String,
    status: String,
) -> Result<(), String> {
    let finding_run_id: String = conn
        .query_row(
            "SELECT run_id FROM run_findings WHERE id = ?1",
            params![finding_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if finding_run_id != run_id {
        return Err("finding does not belong to run".to_string());
    }
    store::update_finding_status(conn, &finding_id, &status)
        .map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        event_for_task_or_run(
            &run_id,
            None,
            RunEventType::FindingStatusChanged,
            json!({"finding_id": finding_id, "status": status}),
        ),
    )?;
    Ok(())
}

fn start_attempt(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    task_id: String,
    agent_assignment_id: Option<String>,
    agent_session_id: Option<String>,
) -> Result<String, String> {
    let state: String = conn
        .query_row(
            "SELECT state FROM run_tasks WHERE id = ?1 AND run_id = ?2",
            params![task_id, run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if TaskState::parse(&state) != Some(TaskState::Ready) {
        return Err(format!("task must be ready before starting an attempt; current state is {state}"));
    }
    let has_active_lease: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM run_workspace_leases
                 WHERE run_id = ?1 AND task_id = ?2 AND state = 'active'
             )",
            params![run_id, task_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        != 0;

    if has_active_lease {
        store::transition_task(conn, &task_id, TaskState::Provisioning, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Provisioning))?;
    }
    store::transition_task(conn, &task_id, TaskState::Running, None)
        .map_err(|error| error.to_string())?;
    append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Running))?;

    let attempt = super::types::Attempt {
        id: Uuid::new_v4().to_string(),
        task_id: task_id.clone(),
        agent_assignment_id,
        agent_session_id,
        attempt_number: store::max_attempt_number(conn, &task_id)
            .map_err(|error| error.to_string())?
            + 1,
        outcome: None,
        started_at: now_ms(),
        ended_at: None,
    };
    store::insert_attempt(conn, &attempt).map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        attempt_event(
            &run_id,
            &task_id,
            &attempt.id,
            RunEventType::AttemptStarted,
            json!({"attempt_number": attempt.attempt_number, "agent_session_id": attempt.agent_session_id}),
        ),
    )?;
    recompute_ready_and_status(app, conn, &run_id)?;
    Ok(attempt.id)
}

fn finish_attempt(
    app: &AppHandle,
    conn: &Connection,
    run_id: String,
    attempt_id: String,
    outcome: String,
) -> Result<(), String> {
    let (task_id, task_state): (String, String) = conn
        .query_row(
            "SELECT a.task_id, t.state
             FROM run_attempts a
             JOIN run_tasks t ON t.id = a.task_id
             WHERE a.id = ?1 AND t.run_id = ?2",
            params![attempt_id, run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    store::finish_attempt(conn, &attempt_id, &outcome, now_ms())
        .map_err(|error| error.to_string())?;
    append_and_emit(
        app,
        conn,
        attempt_event(
            &run_id,
            &task_id,
            &attempt_id,
            RunEventType::AttemptFinished,
            json!({"outcome": outcome}),
        ),
    )?;
    if outcome == "failed" && TaskState::parse(&task_state) == Some(TaskState::Running) {
        store::transition_task(conn, &task_id, TaskState::Failed, None)
            .map_err(|error| error.to_string())?;
        append_and_emit(app, conn, task_state_event(&run_id, &task_id, TaskState::Failed))?;
    }
    recompute_ready_and_status(app, conn, &run_id)
}

fn reconcile_interrupted(conn: &Connection) -> Result<Vec<NewRunEvent>, String> {
    let run_ids = {
        let mut statement = conn
            .prepare("SELECT id FROM runs WHERE status = 'running' ORDER BY created_at, id")
            .map_err(|error| error.to_string())?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?
    };
    let mut events = Vec::with_capacity(run_ids.len());
    for run_id in run_ids {
        let interrupted_at = now_ms();
        conn.execute(
            "UPDATE runs
             SET status = 'interrupted', interrupted_at = ?1, updated_at = ?1,
                 completed_at = NULL
             WHERE id = ?2 AND status = 'running'",
            params![interrupted_at, run_id],
        )
        .map_err(|error| error.to_string())?;
        events.push(event_for_task_or_run(
            &run_id,
            None,
            RunEventType::RunInterrupted,
            json!({"interrupted_at": interrupted_at}),
        ));
    }
    Ok(events)
}

fn prepare_relaunch(conn: &Connection, run_id: &str) -> Result<Vec<NewRunEvent>, String> {
    let status: String = conn
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if RunStatus::parse(&status) != Some(RunStatus::Interrupted) {
        return Err(format!("run must be interrupted before relaunch; current status is {status}"));
    }
    let timestamp = now_ms();
    conn.execute(
        "UPDATE runs
         SET status = 'running', interrupted_at = NULL, completed_at = NULL, updated_at = ?1
         WHERE id = ?2",
        params![timestamp, run_id],
    )
    .map_err(|error| error.to_string())?;

    let tasks = {
        let mut statement = conn
            .prepare("SELECT id, state FROM run_tasks WHERE run_id = ?1 ORDER BY created_at, id")
            .map_err(|error| error.to_string())?;
        statement
            .query_map(params![run_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?
    };
    let mut events = Vec::new();
    for (task_id, state) in tasks {
        let state = TaskState::parse(&state).ok_or_else(|| format!("invalid task state: {state}"))?;
        if state.is_terminal() || state == TaskState::Ready {
            continue;
        }
        store::transition_task(conn, &task_id, TaskState::Ready, None)
            .map_err(|error| error.to_string())?;
        events.push(task_state_event(run_id, &task_id, TaskState::Ready));
    }
    events.push(event_for_task_or_run(
        run_id,
        None,
        RunEventType::RunRelaunched,
        json!({"relaunched_at": timestamp}),
    ));
    Ok(events)
}

fn relaunch(app: &AppHandle, conn: &Connection, run_id: String) -> Result<Run, String> {
    for event in prepare_relaunch(conn, &run_id)? {
        append_and_emit(app, conn, event)?;
    }
    recompute_ready_and_status(app, conn, &run_id)?;
    load_run(conn, &run_id)
}

fn attempt_event(
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    event_type: RunEventType,
    payload: serde_json::Value,
) -> NewRunEvent {
    NewRunEvent {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        task_id: Some(task_id.to_string()),
        attempt_id: Some(attempt_id.to_string()),
        agent_id: None,
        event_type,
        payload,
        provider_event_id: None,
        created_at: now_ms(),
    }
}

fn event_for_task_or_run(
    run_id: &str,
    task_id: Option<&str>,
    event_type: RunEventType,
    payload: serde_json::Value,
) -> NewRunEvent {
    NewRunEvent {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        task_id: task_id.map(str::to_string),
        attempt_id: None,
        agent_id: None,
        event_type,
        payload,
        provider_event_id: None,
        created_at: now_ms(),
    }
}

fn check_result_event(run_id: &str, result: &CheckResult, kind: &str) -> NewRunEvent {
    event_for_task_or_run(
        run_id,
        result.task_id.as_deref(),
        RunEventType::CheckResultRecorded,
        json!({
            "check_result_id": result.id,
            "check_id": result.check_id,
            "kind": kind,
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
            "pre_existing_failure": result.pre_existing_failure,
            "output_tail": result.output_tail,
        }),
    )
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
        interrupted_at: None,
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

    let (cancel_requested, interrupted, task_states) = load_status_inputs(conn, run_id)?;
    let status = derive_run_status(&task_states, cancel_requested, interrupted);
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

fn load_status_inputs(
    conn: &Connection,
    run_id: &str,
) -> Result<(bool, bool, Vec<TaskState>), String> {
    let (cancel_requested, interrupted): (i64, bool) = conn
        .query_row(
            "SELECT cancel_requested, interrupted_at IS NOT NULL FROM runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
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
    Ok((cancel_requested != 0, interrupted, states))
}

fn load_run(conn: &Connection, run_id: &str) -> Result<Run, String> {
    let snapshot = store::load_run_snapshot(conn, run_id).map_err(|error| error.to_string())?;
    snapshot
        .map(|snapshot| snapshot.run)
        .ok_or_else(|| "run not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::types::{
        Evidence, EvidenceKind, FindingConfidence, FindingStatus, RunCheck, RunStatus,
    };
    use crate::services::database::{configure_connection, setup_schema};

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn startup_reconcile_marks_running_runs_interrupted() {
        let conn = connection();
        store::create_run(
            &conn,
            &Run {
                id: "run-reconcile".to_string(),
                objective: "recover after restart".to_string(),
                root_path: None,
                status: RunStatus::Running,
                cancel_requested: false,
                interrupted_at: None,
                created_at: 1,
                updated_at: 1,
                completed_at: None,
            },
        )
        .unwrap();

        let events = reconcile_interrupted(&conn).unwrap();
        assert_eq!(events.len(), 1);
        for event in events {
            store::append_event(&conn, &event).unwrap();
        }
        let snapshot = store::load_run_snapshot(&conn, "run-reconcile")
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.run.status, RunStatus::Interrupted);
        assert!(snapshot.run.interrupted_at.is_some());
        assert_eq!(
            store::list_events(&conn, "run-reconcile", 0).unwrap()[0].event_type,
            RunEventType::RunInterrupted
        );
    }

    #[test]
    fn relaunch_resets_non_terminal_tasks_and_clears_interrupted() {
        let conn = connection();
        store::create_run(
            &conn,
            &Run {
                id: "run-relaunch".to_string(),
                objective: "relaunch after restart".to_string(),
                root_path: None,
                status: RunStatus::Interrupted,
                cancel_requested: false,
                interrupted_at: Some(10),
                created_at: 1,
                updated_at: 10,
                completed_at: None,
            },
        )
        .unwrap();
        for (task_id, state) in [
            ("task-running", "running"),
            ("task-blocked", "blocked"),
            ("task-review", "review"),
        ] {
            store::add_task(
                &conn,
                &Task {
                    id: task_id.to_string(),
                    run_id: "run-relaunch".to_string(),
                    title: task_id.to_string(),
                    brief: "restart me".to_string(),
                    state: TaskState::Ready,
                    blocked_reason: None,
                    created_at: 1,
                    updated_at: 1,
                },
                &[],
            )
            .unwrap();
            conn.execute(
                "UPDATE run_tasks SET state = ?1 WHERE id = ?2",
                params![state, task_id],
            )
            .unwrap();
        }

        for event in prepare_relaunch(&conn, "run-relaunch").unwrap() {
            store::append_event(&conn, &event).unwrap();
        }
        let snapshot = store::load_run_snapshot(&conn, "run-relaunch")
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.run.status, RunStatus::Running);
        assert_eq!(snapshot.run.interrupted_at, None);
        assert!(snapshot.tasks.iter().all(|task| task.state == TaskState::Ready));
        assert!(store::list_events(&conn, "run-relaunch", 0)
            .unwrap()
            .iter()
            .any(|event| event.event_type == RunEventType::RunRelaunched));
    }

    #[test]
    fn unapproved_check_does_not_block_completion() {
        let conn = connection();
        store::create_run(
            &conn,
            &Run {
                id: "run-unapproved".to_string(),
                objective: "completion gating".to_string(),
                root_path: None,
                status: RunStatus::Running,
                cancel_requested: false,
                interrupted_at: None,
                created_at: 1,
                updated_at: 1,
                completed_at: None,
            },
        )
        .unwrap();
        store::add_task(
            &conn,
            &Task {
                id: "task-unapproved".to_string(),
                run_id: "run-unapproved".to_string(),
                title: "Completion task".to_string(),
                brief: "Verify completion gates".to_string(),
                state: TaskState::Review,
                blocked_reason: None,
                created_at: 1,
                updated_at: 1,
            },
            &[],
        )
        .unwrap();
        store::insert_check(
            &conn,
            &RunCheck {
                id: "check-approved".to_string(),
                run_id: "run-unapproved".to_string(),
                name: "approved check".to_string(),
                command: "echo ok".to_string(),
                approved: true,
                created_at: 1,
            },
        )
        .unwrap();
        store::insert_check(
            &conn,
            &RunCheck {
                id: "check-unapproved".to_string(),
                run_id: "run-unapproved".to_string(),
                name: "unapproved check".to_string(),
                command: "exit 9".to_string(),
                approved: false,
                created_at: 2,
            },
        )
        .unwrap();
        store::insert_check_result(
            &conn,
            &CheckResult {
                id: "baseline-approved".to_string(),
                check_id: "check-approved".to_string(),
                task_id: None,
                attempt_id: None,
                kind: "baseline".to_string(),
                exit_code: Some(0),
                duration_ms: 1,
                output_tail: "ok".to_string(),
                pre_existing_failure: false,
                created_at: 3,
            },
        )
        .unwrap();
        store::insert_check_result(
            &conn,
            &CheckResult {
                id: "verify-approved".to_string(),
                check_id: "check-approved".to_string(),
                task_id: Some("task-unapproved".to_string()),
                attempt_id: None,
                kind: "verify".to_string(),
                exit_code: Some(0),
                duration_ms: 1,
                output_tail: "ok".to_string(),
                pre_existing_failure: false,
                created_at: 4,
            },
        )
        .unwrap();
        store::insert_finding(
            &conn,
            &Finding {
                id: "finding-completion".to_string(),
                run_id: "run-unapproved".to_string(),
                task_id: Some("task-unapproved".to_string()),
                attempt_id: None,
                claim: "The task has evidence".to_string(),
                confidence: FindingConfidence::Asserted,
                evidence: vec![Evidence {
                    kind: EvidenceKind::CommandResult,
                    reference: "echo ok".to_string(),
                    excerpt: Some("ok".to_string()),
                }],
                proposed_artifact: None,
                needs_approval: false,
                status: FindingStatus::Open,
                created_at: 5,
                updated_at: 5,
            },
        )
        .unwrap();

        let gates = completion_gates(&conn, "run-unapproved", "task-unapproved").unwrap();
        assert_eq!(gates.len(), 1);
        assert_eq!(gates[0].name, "approved check");
        let has_evidence = store::task_has_evidence(&conn, "task-unapproved").unwrap();
        assert!(checks::completion_blockers(has_evidence, &gates).is_empty());
    }
}
