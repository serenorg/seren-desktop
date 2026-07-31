// ABOUTME: SQLite persistence for the durable run engine and its append-only event log.
// ABOUTME: All functions accept a borrowed connection so the scheduler remains the single writer.

use super::status::is_legal_transition;
use super::types::{
    AgentAssignment, Attempt, CheckResult, CoverageGap, Evidence, Finding, FindingConfidence,
    FindingStatus, LeaseMode, LeaseState, NewLease, NewRunEvent, ProposedArtifact, Run, RunCheck,
    RunEvent, RunEventType, RunSnapshot, RunStatus, Task, TaskDependency, TaskState,
    WorkspaceLease,
};
use crate::services::database::now_ms;
use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::de::DeserializeOwned;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    Inserted(i64),
    Duplicate,
}

fn invalid_value(kind: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(format!("invalid {kind}: {value}"))
}

fn parse_task_state(value: String) -> Result<TaskState> {
    TaskState::parse(&value).ok_or_else(|| invalid_value("task state", &value))
}

fn parse_run_status(value: String) -> Result<RunStatus> {
    RunStatus::parse(&value).ok_or_else(|| invalid_value("run status", &value))
}

fn parse_lease_mode(value: String) -> Result<LeaseMode> {
    LeaseMode::parse(&value).ok_or_else(|| invalid_value("lease mode", &value))
}

fn parse_finding_confidence(value: String) -> Result<FindingConfidence> {
    FindingConfidence::parse(&value).ok_or_else(|| invalid_value("finding confidence", &value))
}

fn parse_finding_status(value: String) -> Result<FindingStatus> {
    FindingStatus::parse(&value).ok_or_else(|| invalid_value("finding status", &value))
}

fn parse_event_type(value: String) -> Result<RunEventType> {
    RunEventType::parse(&value).ok_or_else(|| invalid_value("run event type", &value))
}

fn serialize_json<T: serde::Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn deserialize_json<T: DeserializeOwned>(value: String) -> Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub fn create_run(conn: &Connection, run: &Run) -> Result<()> {
    conn.execute(
        "INSERT INTO runs
            (id, objective, root_path, status, cancel_requested, created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.id,
            run.objective,
            run.root_path,
            run.status.as_str(),
            i64::from(run.cancel_requested),
            run.created_at,
            run.updated_at,
            run.completed_at,
        ],
    )?;
    Ok(())
}

pub fn add_task(conn: &Connection, task: &Task, depends_on: &[String]) -> Result<()> {
    conn.execute(
        "INSERT INTO run_tasks
            (id, run_id, title, brief, state, blocked_reason, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            task.id,
            task.run_id,
            task.title,
            task.brief,
            task.state.as_str(),
            task.blocked_reason,
            task.created_at,
            task.updated_at,
        ],
    )?;
    for depends_on_task_id in depends_on {
        add_dependency(
            conn,
            &TaskDependency {
                task_id: task.id.clone(),
                depends_on_task_id: depends_on_task_id.clone(),
            },
        )?;
    }
    Ok(())
}

pub fn add_dependency(conn: &Connection, dependency: &TaskDependency) -> Result<()> {
    conn.execute(
        "INSERT INTO run_task_dependencies (task_id, depends_on_task_id)
         VALUES (?1, ?2)",
        params![dependency.task_id, dependency.depends_on_task_id],
    )?;
    Ok(())
}

pub fn add_assignment(conn: &Connection, assignment: &AgentAssignment) -> Result<()> {
    conn.execute(
        "INSERT INTO run_agent_assignments
            (id, run_id, agent_type, model_id, role_label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            assignment.id,
            assignment.run_id,
            assignment.agent_type,
            assignment.model_id,
            assignment.role_label,
            assignment.created_at,
        ],
    )?;
    Ok(())
}

pub fn insert_attempt(conn: &Connection, attempt: &Attempt) -> Result<()> {
    conn.execute(
        "INSERT INTO run_attempts
            (id, task_id, agent_assignment_id, agent_session_id, attempt_number, outcome,
             started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            attempt.id,
            attempt.task_id,
            attempt.agent_assignment_id,
            attempt.agent_session_id,
            attempt.attempt_number,
            attempt.outcome,
            attempt.started_at,
            attempt.ended_at,
        ],
    )?;
    Ok(())
}

pub fn insert_workspace_lease(conn: &Connection, lease: &WorkspaceLease) -> Result<()> {
    conn.execute(
        "INSERT INTO run_workspace_leases
            (id, run_id, task_id, mode, root_path, base_revision, state, created_at, released_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            lease.id,
            lease.run_id,
            lease.task_id,
            lease.mode.as_str(),
            lease.root_path,
            lease.base_revision,
            lease.state,
            lease.created_at,
            lease.released_at,
        ],
    )?;
    Ok(())
}

impl From<&NewLease> for NewLease {
    fn from(lease: &NewLease) -> Self {
        lease.clone()
    }
}

pub fn insert_lease<L>(conn: &Connection, lease: L) -> Result<()>
where
    L: Into<NewLease>,
{
    let lease = lease.into();
    conn.execute(
        "INSERT INTO run_workspace_leases
            (id, run_id, task_id, mode, state, created_at)
         VALUES (?1, ?2, ?3, ?4, 'requested', ?5)",
        params![
            lease.id,
            lease.run_id,
            lease.task_id,
            lease.mode.as_str(),
            now_ms(),
        ],
    )?;
    Ok(())
}

fn lease_from_row(row: &rusqlite::Row<'_>) -> Result<WorkspaceLease> {
    Ok(WorkspaceLease {
        id: row.get(0)?,
        run_id: row.get(1)?,
        task_id: row.get(2)?,
        mode: parse_lease_mode(row.get(3)?)?,
        root_path: row.get(4)?,
        base_revision: row.get(5)?,
        state: row.get(6)?,
        created_at: row.get(7)?,
        released_at: row.get(8)?,
    })
}

pub fn update_lease_state(
    conn: &Connection,
    lease_id: &str,
    state: &str,
    root_path: Option<&str>,
    base_revision: Option<&str>,
) -> Result<()> {
    if LeaseState::parse(state).is_none() {
        return Err(invalid_value("lease state", state));
    }
    let released_at = (state == LeaseState::Released.as_str()).then_some(now_ms());
    let updated = conn.execute(
        "UPDATE run_workspace_leases
         SET state = ?1,
             root_path = COALESCE(?2, root_path),
             base_revision = COALESCE(?3, base_revision),
             released_at = ?4
         WHERE id = ?5",
        params![state, root_path, base_revision, released_at, lease_id],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

pub fn get_lease(conn: &Connection, lease_id: &str) -> Result<Option<WorkspaceLease>> {
    conn.query_row(
        "SELECT id, run_id, task_id, mode, root_path, base_revision, state,
                created_at, released_at
         FROM run_workspace_leases
         WHERE id = ?1",
        params![lease_id],
        lease_from_row,
    )
    .optional()
}

pub fn list_leases(conn: &Connection, run_id: &str) -> Result<Vec<WorkspaceLease>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, task_id, mode, root_path, base_revision, state,
                created_at, released_at
         FROM run_workspace_leases
         WHERE run_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    statement
        .query_map(params![run_id], lease_from_row)?
        .collect()
}

pub fn insert_finding(conn: &Connection, finding: &Finding) -> Result<()> {
    let evidence_json = serialize_json(&finding.evidence)?;
    let proposed_artifact_json = finding
        .proposed_artifact
        .as_ref()
        .map(serialize_json)
        .transpose()?;
    conn.execute(
        "INSERT INTO run_findings
            (id, run_id, task_id, attempt_id, claim, confidence, evidence_json,
             proposed_artifact_json, needs_approval, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            finding.id,
            finding.run_id,
            finding.task_id,
            finding.attempt_id,
            finding.claim,
            finding.confidence.as_str(),
            evidence_json,
            proposed_artifact_json,
            i64::from(finding.needs_approval),
            finding.status.as_str(),
            finding.created_at,
            finding.updated_at,
        ],
    )?;
    Ok(())
}

pub fn insert_check(conn: &Connection, check: &RunCheck) -> Result<()> {
    conn.execute(
        "INSERT INTO run_checks (id, run_id, name, command, approved, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            check.id,
            check.run_id,
            check.name,
            check.command,
            i64::from(check.approved),
            check.created_at,
        ],
    )?;
    Ok(())
}

fn check_from_row(row: &rusqlite::Row<'_>) -> Result<RunCheck> {
    Ok(RunCheck {
        id: row.get(0)?,
        run_id: row.get(1)?,
        name: row.get(2)?,
        command: row.get(3)?,
        approved: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
    })
}

pub fn get_check(conn: &Connection, check_id: &str) -> Result<Option<RunCheck>> {
    conn.query_row(
        "SELECT id, run_id, name, command, approved, created_at
         FROM run_checks WHERE id = ?1",
        params![check_id],
        check_from_row,
    )
    .optional()
}

pub fn approve_check(conn: &Connection, check_id: &str) -> Result<RunCheck> {
    let updated = conn.execute(
        "UPDATE run_checks SET approved = 1 WHERE id = ?1",
        params![check_id],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    get_check(conn, check_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn list_checks(conn: &Connection, run_id: &str) -> Result<Vec<RunCheck>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, name, command, approved, created_at
         FROM run_checks WHERE run_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    statement
        .query_map(params![run_id], check_from_row)?
        .collect()
}

pub fn insert_check_result(conn: &Connection, result: &CheckResult) -> Result<()> {
    conn.execute(
        "INSERT INTO run_check_results
            (id, check_id, task_id, attempt_id, kind, exit_code, duration_ms,
             output_tail, pre_existing_failure, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            result.id,
            result.check_id,
            result.task_id,
            result.attempt_id,
            result.kind,
            result.exit_code,
            result.duration_ms,
            result.output_tail,
            i64::from(result.pre_existing_failure),
            result.created_at,
        ],
    )?;
    Ok(())
}

fn check_result_from_row(row: &rusqlite::Row<'_>) -> Result<CheckResult> {
    Ok(CheckResult {
        id: row.get(0)?,
        check_id: row.get(1)?,
        task_id: row.get(2)?,
        attempt_id: row.get(3)?,
        kind: row.get(4)?,
        exit_code: row.get(5)?,
        duration_ms: row.get(6)?,
        output_tail: row.get(7)?,
        pre_existing_failure: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
    })
}

pub fn list_check_results(conn: &Connection, run_id: &str) -> Result<Vec<CheckResult>> {
    let mut statement = conn.prepare(
        "SELECT r.id, r.check_id, r.task_id, r.attempt_id, r.kind, r.exit_code,
                r.duration_ms, r.output_tail, r.pre_existing_failure, r.created_at
         FROM run_check_results r
         JOIN run_checks c ON c.id = r.check_id
         WHERE c.run_id = ?1
         ORDER BY r.created_at ASC, r.id ASC",
    )?;
    statement
        .query_map(params![run_id], check_result_from_row)?
        .collect()
}

pub fn insert_coverage_gap(conn: &Connection, gap: &CoverageGap) -> Result<()> {
    conn.execute(
        "INSERT INTO run_coverage_gaps
            (id, run_id, task_id, kind, subject, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            gap.id,
            gap.run_id,
            gap.task_id,
            gap.kind,
            gap.subject,
            gap.detail,
            gap.created_at,
        ],
    )?;
    Ok(())
}

fn coverage_gap_from_row(row: &rusqlite::Row<'_>) -> Result<CoverageGap> {
    Ok(CoverageGap {
        id: row.get(0)?,
        run_id: row.get(1)?,
        task_id: row.get(2)?,
        kind: row.get(3)?,
        subject: row.get(4)?,
        detail: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub fn list_coverage_gaps(conn: &Connection, run_id: &str) -> Result<Vec<CoverageGap>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, task_id, kind, subject, detail, created_at
         FROM run_coverage_gaps WHERE run_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    statement
        .query_map(params![run_id], coverage_gap_from_row)?
        .collect()
}

pub fn task_has_evidence(conn: &Connection, task_id: &str) -> Result<bool> {
    let mut statement = conn.prepare(
        "SELECT evidence_json FROM run_findings WHERE task_id = ?1
         ORDER BY created_at ASC, id ASC",
    )?;
    let mut rows = statement.query(params![task_id])?;
    while let Some(row) = rows.next()? {
        let evidence_json: String = row.get(0)?;
        let evidence: Vec<Evidence> = serde_json::from_str(&evidence_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        if !evidence.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn transition_task(
    conn: &Connection,
    task_id: &str,
    to: TaskState,
    blocked_reason: Option<&str>,
) -> Result<()> {
    let current_value: String = conn.query_row(
        "SELECT state FROM run_tasks WHERE id = ?1",
        params![task_id],
        |row| row.get(0),
    )?;
    let current = parse_task_state(current_value)?;
    if !is_legal_transition(current, to) {
        return Err(invalid_value(
            "task transition",
            &format!("{} -> {}", current.as_str(), to.as_str()),
        ));
    }

    conn.execute(
        "UPDATE run_tasks
         SET state = ?1, blocked_reason = ?2, updated_at = ?3
         WHERE id = ?4",
        params![to.as_str(), blocked_reason, now_ms(), task_id],
    )?;
    Ok(())
}

pub fn ready_task_ids(conn: &Connection, run_id: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT t.id
         FROM run_tasks t
         WHERE t.run_id = ?1
           AND t.state = 'pending'
           AND NOT EXISTS (
               SELECT 1
               FROM run_task_dependencies d
               JOIN run_tasks dependency ON dependency.id = d.depends_on_task_id
               WHERE d.task_id = t.id AND dependency.state <> 'done'
           )
         ORDER BY t.created_at ASC, t.id ASC",
    )?;
    statement
        .query_map(params![run_id], |row| row.get(0))?
        .collect()
}

pub fn list_runs(conn: &Connection) -> Result<Vec<Run>> {
    let mut statement = conn.prepare(
        "SELECT id, objective, root_path, status, cancel_requested,
                created_at, updated_at, completed_at
         FROM runs
         ORDER BY created_at ASC, id ASC",
    )?;
    statement
        .query_map([], |row| {
            Ok(Run {
                id: row.get(0)?,
                objective: row.get(1)?,
                root_path: row.get(2)?,
                status: parse_run_status(row.get(3)?)?,
                cancel_requested: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })?
        .collect()
}

pub fn load_run_snapshot(conn: &Connection, run_id: &str) -> Result<Option<RunSnapshot>> {
    let run = conn
        .query_row(
            "SELECT id, objective, root_path, status, cancel_requested,
                    created_at, updated_at, completed_at
             FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok(Run {
                    id: row.get(0)?,
                    objective: row.get(1)?,
                    root_path: row.get(2)?,
                    status: parse_run_status(row.get(3)?)?,
                    cancel_requested: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    completed_at: row.get(7)?,
                })
            },
        )
        .optional()?;
    let Some(run) = run else {
        return Ok(None);
    };

    let mut task_statement = conn.prepare(
        "SELECT id, run_id, title, brief, state, blocked_reason, created_at, updated_at
         FROM run_tasks WHERE run_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let tasks = task_statement
        .query_map(params![run_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                run_id: row.get(1)?,
                title: row.get(2)?,
                brief: row.get(3)?,
                state: parse_task_state(row.get(4)?)?,
                blocked_reason: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut dependency_statement = conn.prepare(
        "SELECT d.task_id, d.depends_on_task_id
         FROM run_task_dependencies d
         JOIN run_tasks t ON t.id = d.task_id
         WHERE t.run_id = ?1
         ORDER BY d.task_id, d.depends_on_task_id",
    )?;
    let dependencies = dependency_statement
        .query_map(params![run_id], |row| {
            Ok(TaskDependency {
                task_id: row.get(0)?,
                depends_on_task_id: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut assignment_statement = conn.prepare(
        "SELECT id, run_id, agent_type, model_id, role_label, created_at
         FROM run_agent_assignments WHERE run_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let assignments = assignment_statement
        .query_map(params![run_id], |row| {
            Ok(AgentAssignment {
                id: row.get(0)?,
                run_id: row.get(1)?,
                agent_type: row.get(2)?,
                model_id: row.get(3)?,
                role_label: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut attempt_statement = conn.prepare(
        "SELECT a.id, a.task_id, a.agent_assignment_id, a.agent_session_id,
                a.attempt_number, a.outcome, a.started_at, a.ended_at
         FROM run_attempts a
         JOIN run_tasks t ON t.id = a.task_id
         WHERE t.run_id = ?1 ORDER BY a.started_at ASC, a.id ASC",
    )?;
    let attempts = attempt_statement
        .query_map(params![run_id], |row| {
            Ok(Attempt {
                id: row.get(0)?,
                task_id: row.get(1)?,
                agent_assignment_id: row.get(2)?,
                agent_session_id: row.get(3)?,
                attempt_number: row.get(4)?,
                outcome: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut finding_statement = conn.prepare(
        "SELECT id, run_id, task_id, attempt_id, claim, confidence, evidence_json,
                proposed_artifact_json, needs_approval, status, created_at, updated_at
         FROM run_findings WHERE run_id = ?1 ORDER BY created_at ASC, id ASC",
    )?;
    let findings = finding_statement
        .query_map(params![run_id], |row| {
            let evidence_json: String = row.get(6)?;
            let proposed_artifact_json: Option<String> = row.get(7)?;
            Ok(Finding {
                id: row.get(0)?,
                run_id: row.get(1)?,
                task_id: row.get(2)?,
                attempt_id: row.get(3)?,
                claim: row.get(4)?,
                confidence: parse_finding_confidence(row.get(5)?)?,
                evidence: deserialize_json(evidence_json)?,
                proposed_artifact: proposed_artifact_json
                    .map(deserialize_json)
                    .transpose()?,
                needs_approval: row.get::<_, i64>(8)? != 0,
                status: parse_finding_status(row.get(9)?)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    let checks = list_checks(conn, run_id)?;
    let check_results = list_check_results(conn, run_id)?;
    let coverage_gaps = list_coverage_gaps(conn, run_id)?;

    Ok(Some(RunSnapshot {
        run,
        tasks,
        dependencies,
        assignments,
        attempts,
        findings,
        checks,
        check_results,
        coverage_gaps,
    }))
}

pub fn list_events(conn: &Connection, run_id: &str, after_sequence: i64) -> Result<Vec<RunEvent>> {
    let mut statement = conn.prepare(
        "SELECT id, run_id, task_id, attempt_id, agent_id, sequence, event_type,
                payload_json, provider_event_id, created_at
         FROM run_events
         WHERE run_id = ?1 AND sequence > ?2
         ORDER BY sequence ASC",
    )?;
    statement
        .query_map(params![run_id, after_sequence], |row| {
            let payload_json: String = row.get(7)?;
            Ok(RunEvent {
                id: row.get(0)?,
                run_id: row.get(1)?,
                task_id: row.get(2)?,
                attempt_id: row.get(3)?,
                agent_id: row.get(4)?,
                sequence: row.get(5)?,
                event_type: parse_event_type(row.get(6)?)?,
                payload: deserialize_json(payload_json)?,
                provider_event_id: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?
        .collect()
}

pub fn append_event(conn: &Connection, event: &NewRunEvent) -> Result<AppendOutcome> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> Result<AppendOutcome> {
        let payload_json = serialize_json(&event.payload)?;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO run_events
                (id, run_id, task_id, attempt_id, agent_id, sequence, event_type,
                 payload_json, provider_event_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
                 (SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?2),
                 ?6, ?7, ?8, ?9)",
            params![
                event.id,
                event.run_id,
                event.task_id,
                event.attempt_id,
                event.agent_id,
                event.event_type.as_str(),
                payload_json,
                event.provider_event_id,
                event.created_at,
            ],
        )?;
        if inserted == 0 {
            return Ok(AppendOutcome::Duplicate);
        }
        let sequence = conn.query_row(
            "SELECT sequence FROM run_events WHERE id = ?1",
            params![event.id],
            |row| row.get(0),
        )?;
        Ok(AppendOutcome::Inserted(sequence))
    })();

    match outcome {
        Ok(outcome) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(outcome),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::{configure_connection, setup_schema};
    use serde_json::json;
    use rusqlite::Connection;

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        setup_schema(&conn).unwrap();
        let foreign_keys: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        conn
    }

    fn run(id: &str) -> Run {
        Run {
            id: id.to_string(),
            objective: "Test objective".to_string(),
            root_path: Some("/tmp/run-engine".to_string()),
            status: RunStatus::Running,
            cancel_requested: false,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
        }
    }

    fn task(id: &str, run_id: &str) -> Task {
        Task {
            id: id.to_string(),
            run_id: run_id.to_string(),
            title: id.to_string(),
            brief: format!("Brief for {id}"),
            state: TaskState::Pending,
            blocked_reason: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn event(id: &str, run_id: &str, provider_event_id: Option<&str>) -> NewRunEvent {
        NewRunEvent {
            id: id.to_string(),
            run_id: run_id.to_string(),
            task_id: None,
            attempt_id: Some("attempt-1".to_string()),
            agent_id: None,
            event_type: RunEventType::TaskAdded,
            payload: json!({"id": id}),
            provider_event_id: provider_event_id.map(str::to_string),
            created_at: 1,
        }
    }

    #[test]
    fn cascade_delete_removes_all_run_children() {
        let conn = connection();
        create_run(&conn, &run("run-1")).unwrap();
        add_task(&conn, &task("task-a", "run-1"), &[]).unwrap();
        add_task(
            &conn,
            &task("task-b", "run-1"),
            &["task-a".to_string()],
        )
        .unwrap();
        add_assignment(
            &conn,
            &AgentAssignment {
                id: "assignment-1".to_string(),
                run_id: "run-1".to_string(),
                agent_type: "test-agent".to_string(),
                model_id: None,
                role_label: Some("worker".to_string()),
                created_at: 1,
            },
        )
        .unwrap();
        insert_attempt(
            &conn,
            &Attempt {
                id: "attempt-1".to_string(),
                task_id: "task-a".to_string(),
                agent_assignment_id: Some("assignment-1".to_string()),
                agent_session_id: Some("session-1".to_string()),
                attempt_number: 1,
                outcome: None,
                started_at: 1,
                ended_at: None,
            },
        )
        .unwrap();
        insert_workspace_lease(
            &conn,
            &WorkspaceLease {
                id: "lease-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: Some("task-a".to_string()),
                mode: LeaseMode::Worktree,
                root_path: Some("/tmp/worktree".to_string()),
                base_revision: Some("abc".to_string()),
                state: "requested".to_string(),
                created_at: 1,
                released_at: None,
            },
        )
        .unwrap();
        insert_finding(
            &conn,
            &Finding {
                id: "finding-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: Some("task-a".to_string()),
                attempt_id: Some("attempt-1".to_string()),
                claim: "A claim".to_string(),
                confidence: FindingConfidence::Asserted,
                evidence: vec![Evidence {
                    kind: super::super::types::EvidenceKind::CommandResult,
                    reference: "cargo test".to_string(),
                    excerpt: None,
                }],
                proposed_artifact: Some(ProposedArtifact {
                    kind: super::super::types::ArtifactKind::Diff,
                    title: "A diff".to_string(),
                    content: None,
                }),
                needs_approval: false,
                status: FindingStatus::Open,
                created_at: 1,
                updated_at: 1,
            },
        )
        .unwrap();
        insert_check(
            &conn,
            &RunCheck {
                id: "check-1".to_string(),
                run_id: "run-1".to_string(),
                name: "cargo test".to_string(),
                command: "cargo test".to_string(),
                approved: true,
                created_at: 1,
            },
        )
        .unwrap();
        insert_check_result(
            &conn,
            &CheckResult {
                id: "check-result-1".to_string(),
                check_id: "check-1".to_string(),
                task_id: Some("task-a".to_string()),
                attempt_id: Some("attempt-1".to_string()),
                kind: "baseline".to_string(),
                exit_code: Some(0),
                duration_ms: 1,
                output_tail: "ok".to_string(),
                pre_existing_failure: false,
                created_at: 1,
            },
        )
        .unwrap();
        insert_coverage_gap(
            &conn,
            &CoverageGap {
                id: "gap-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: Some("task-a".to_string()),
                kind: "skipped".to_string(),
                subject: "lint".to_string(),
                detail: Some("test gap".to_string()),
                created_at: 1,
            },
        )
        .unwrap();
        append_event(&conn, &event("event-1", "run-1", None)).unwrap();

        conn.execute("DELETE FROM runs WHERE id = 'run-1'", [])
            .unwrap();
        for table in [
            "run_tasks",
            "run_task_dependencies",
            "run_agent_assignments",
            "run_attempts",
            "run_workspace_leases",
            "run_findings",
            "run_events",
            "run_checks",
            "run_check_results",
            "run_coverage_gaps",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} should cascade");
        }
    }

    #[test]
    fn append_event_inserted_then_duplicate_final_count_1() {
        let conn = connection();
        create_run(&conn, &run("run-1")).unwrap();
        let first = append_event(&conn, &event("event-1", "run-1", Some("provider-1"))).unwrap();
        let second = append_event(&conn, &event("event-2", "run-1", Some("provider-1"))).unwrap();
        assert_eq!(first, AppendOutcome::Inserted(1));
        assert_eq!(second, AppendOutcome::Duplicate);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM run_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        assert_eq!(
            append_event(&conn, &event("event-3", "run-1", Some("provider-2"))).unwrap(),
            AppendOutcome::Inserted(2)
        );
        assert_eq!(
            append_event(&conn, &event("event-4", "run-1", Some("provider-3"))).unwrap(),
            AppendOutcome::Inserted(3)
        );

        create_run(&conn, &run("run-2")).unwrap();
        assert_eq!(
            append_event(&conn, &event("event-5", "run-2", Some("provider-4"))).unwrap(),
            AppendOutcome::Inserted(1)
        );
    }

    #[test]
    fn lease_state_round_trips_and_lists() {
        let conn = connection();
        create_run(&conn, &run("run-1")).unwrap();
        add_task(&conn, &task("task-1", "run-1"), &[]).unwrap();
        insert_lease(
            &conn,
            NewLease {
                id: "lease-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: "task-1".to_string(),
                mode: LeaseMode::Scratch,
            },
        )
        .unwrap();
        assert_eq!(
            get_lease(&conn, "lease-1").unwrap().unwrap().state,
            "requested"
        );
        update_lease_state(
            &conn,
            "lease-1",
            "active",
            Some("/tmp/run-workspace"),
            Some("revision"),
        )
        .unwrap();
        let leases = list_leases(&conn, "run-1").unwrap();
        assert_eq!(leases.len(), 1);
        assert_eq!(leases[0].root_path.as_deref(), Some("/tmp/run-workspace"));
        assert_eq!(leases[0].base_revision.as_deref(), Some("revision"));
        update_lease_state(&conn, "lease-1", "released", None, None).unwrap();
        assert!(get_lease(&conn, "lease-1")
            .unwrap()
            .unwrap()
            .released_at
            .is_some());
    }

    #[test]
    fn transition_task_rejects_illegal_and_clears_blocked_reason() {
        let conn = connection();
        create_run(&conn, &run("run-1")).unwrap();
        add_task(&conn, &task("task-1", "run-1"), &[]).unwrap();
        assert!(transition_task(&conn, "task-1", TaskState::Running, None).is_err());
        transition_task(&conn, "task-1", TaskState::Ready, None).unwrap();
        transition_task(&conn, "task-1", TaskState::Provisioning, None).unwrap();
        transition_task(&conn, "task-1", TaskState::Running, None).unwrap();
        transition_task(
            &conn,
            "task-1",
            TaskState::Blocked,
            Some("waiting for approval"),
        )
        .unwrap();
        let blocked_reason: Option<String> = conn
            .query_row(
                "SELECT blocked_reason FROM run_tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(blocked_reason.as_deref(), Some("waiting for approval"));
        transition_task(&conn, "task-1", TaskState::Running, None).unwrap();
        let cleared: Option<String> = conn
            .query_row(
                "SELECT blocked_reason FROM run_tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleared, None);
        transition_task(&conn, "task-1", TaskState::Verifying, None).unwrap();
        transition_task(&conn, "task-1", TaskState::Review, None).unwrap();
        transition_task(&conn, "task-1", TaskState::Done, None).unwrap();
    }

    #[test]
    fn ready_set_unblocks_after_dependency_done() {
        let conn = connection();
        create_run(&conn, &run("run-1")).unwrap();
        add_task(&conn, &task("task-a", "run-1"), &[]).unwrap();
        add_task(
            &conn,
            &task("task-b", "run-1"),
            &["task-a".to_string()],
        )
        .unwrap();
        assert_eq!(ready_task_ids(&conn, "run-1").unwrap(), vec!["task-a"]);
        transition_task(&conn, "task-a", TaskState::Ready, None).unwrap();
        assert_eq!(ready_task_ids(&conn, "run-1").unwrap(), Vec::<String>::new());
        transition_task(&conn, "task-a", TaskState::Provisioning, None).unwrap();
        transition_task(&conn, "task-a", TaskState::Running, None).unwrap();
        transition_task(&conn, "task-a", TaskState::Verifying, None).unwrap();
        transition_task(&conn, "task-a", TaskState::Review, None).unwrap();
        transition_task(&conn, "task-a", TaskState::Done, None).unwrap();
        assert_eq!(ready_task_ids(&conn, "run-1").unwrap(), vec!["task-b"]);
    }
}
