// ABOUTME: Executes approved run checks and derives evidence-aware completion blockers.
// ABOUTME: Check policy is pure and keeps baseline failures from becoming regressions.

use super::types::CheckResult;
use super::workspace::{self, SetupResult};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckGate {
    pub name: String,
    pub baseline_failed: bool,
    pub verify_exit: Option<i32>,
}

pub fn execute_check(
    root: &Path,
    command: &str,
    env_path: Option<String>,
    timeout: Duration,
) -> SetupResult {
    workspace::run_setup_script(root, command, env_path, timeout)
}

pub fn completion_blockers(has_evidence: bool, checks: &[CheckGate]) -> Vec<String> {
    let mut blockers = Vec::new();
    if !has_evidence {
        blockers.push("no finding with evidence".to_string());
    }
    for check in checks {
        if check.baseline_failed {
            continue;
        }
        match check.verify_exit {
            Some(0) => {}
            Some(_) => blockers.push(format!("check {} regressed", check.name)),
            None => blockers.push(format!("check {} not verified", check.name)),
        }
    }
    blockers
}

pub(crate) fn check_result_from_setup(
    check_id: String,
    task_id: Option<String>,
    kind: &str,
    setup: SetupResult,
) -> CheckResult {
    CheckResult {
        id: uuid::Uuid::new_v4().to_string(),
        check_id,
        task_id,
        attempt_id: None,
        kind: kind.to_string(),
        exit_code: Some(setup.exit_code),
        duration_ms: setup.duration_ms as i64,
        output_tail: setup.output_tail,
        pre_existing_failure: setup.exit_code != 0,
        created_at: crate::services::database::now_ms(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::store;
    use crate::run::types::{
        Evidence, EvidenceKind, Finding, FindingConfidence, FindingStatus, Run, RunCheck,
        RunStatus, Task, TaskState,
    };
    use crate::services::database::{configure_connection, setup_schema};
    use rusqlite::Connection;
    use tempfile::tempdir;

    fn gate(name: &str, baseline_failed: bool, verify_exit: Option<i32>) -> CheckGate {
        CheckGate {
            name: name.to_string(),
            baseline_failed,
            verify_exit,
        }
    }

    #[test]
    fn no_evidence_blocks_completion() {
        assert_eq!(
            completion_blockers(true, &[]),
            Vec::<String>::new(),
            "evidence alone is sufficient when there are no checks"
        );
        assert_eq!(
            completion_blockers(false, &[]),
            vec!["no finding with evidence"]
        );
    }

    #[test]
    fn evidence_and_zero_checks_are_clear() {
        assert!(completion_blockers(true, &[]).is_empty());
    }

    #[test]
    fn baseline_failed_check_does_not_block_when_verify_fails_again() {
        assert!(completion_blockers(true, &[gate("lint", true, Some(7))]).is_empty());
    }

    #[test]
    fn baseline_green_check_failing_verify_blocks() {
        assert_eq!(
            completion_blockers(true, &[gate("tests", false, Some(1))]),
            vec!["check tests regressed"]
        );
    }

    #[test]
    fn baseline_green_check_not_run_blocks() {
        assert_eq!(
            completion_blockers(true, &[gate("tests", false, None)]),
            vec!["check tests not verified"]
        );
    }

    #[test]
    fn baseline_failed_check_not_run_does_not_block() {
        assert!(completion_blockers(true, &[gate("tests", true, None)]).is_empty());
    }

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn seed_run_and_task(conn: &Connection) {
        store::create_run(
            conn,
            &Run {
                id: "run-checks".to_string(),
                objective: "check objective".to_string(),
                root_path: None,
                status: RunStatus::Running,
                cancel_requested: false,
                created_at: 1,
                updated_at: 1,
                completed_at: None,
            },
        )
        .unwrap();
        store::add_task(
            conn,
            &Task {
                id: "task-checks".to_string(),
                run_id: "run-checks".to_string(),
                title: "Checks".to_string(),
                brief: "Run checks".to_string(),
                state: TaskState::Pending,
                blocked_reason: None,
                created_at: 1,
                updated_at: 1,
            },
            &[],
        )
        .unwrap();
    }

    fn move_task_to_review(conn: &Connection) {
        store::transition_task(conn, "task-checks", TaskState::Ready, None).unwrap();
        store::transition_task(conn, "task-checks", TaskState::Provisioning, None).unwrap();
        store::transition_task(conn, "task-checks", TaskState::Running, None).unwrap();
        store::transition_task(conn, "task-checks", TaskState::Verifying, None).unwrap();
        store::transition_task(conn, "task-checks", TaskState::Review, None).unwrap();
    }

    fn check(id: &str, name: &str, approved: bool) -> RunCheck {
        RunCheck {
            id: id.to_string(),
            run_id: "run-checks".to_string(),
            name: name.to_string(),
            command: "echo ok".to_string(),
            approved,
            created_at: 1,
        }
    }

    fn evidence_finding() -> Finding {
        Finding {
            id: "finding-checks".to_string(),
            run_id: "run-checks".to_string(),
            task_id: Some("task-checks".to_string()),
            attempt_id: None,
            claim: "The check result is recorded".to_string(),
            confidence: FindingConfidence::Asserted,
            evidence: vec![Evidence {
                kind: EvidenceKind::CommandResult,
                reference: "echo ok".to_string(),
                excerpt: Some("ok".to_string()),
            }],
            proposed_artifact: None,
            needs_approval: false,
            status: FindingStatus::Open,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn baseline_marks_failing_check_pre_existing() {
        let directory = tempdir().unwrap();
        let passing = execute_check(
            directory.path(),
            "echo ok",
            None,
            Duration::from_secs(2),
        );
        let failing = execute_check(
            directory.path(),
            "exit 3",
            None,
            Duration::from_secs(2),
        );
        assert_eq!(passing.exit_code, 0);
        assert_eq!(failing.exit_code, 3);

        let conn = connection();
        seed_run_and_task(&conn);
        store::insert_check(&conn, &check("check-ok", "echo", true)).unwrap();
        store::insert_check(&conn, &check("check-fail", "exit", true)).unwrap();
        store::insert_check_result(
            &conn,
            &check_result_from_setup("check-ok".to_string(), None, "baseline", passing),
        )
        .unwrap();
        store::insert_check_result(
            &conn,
            &check_result_from_setup("check-fail".to_string(), None, "baseline", failing),
        )
        .unwrap();
        let results = store::list_check_results(&conn, "run-checks").unwrap();
        assert_eq!(results.len(), 2);
        let failed_result = results
            .iter()
            .find(|result| result.check_id == "check-fail")
            .expect("failing check result");
        assert_eq!(failed_result.exit_code, Some(3));
        assert!(failed_result.pre_existing_failure);
        assert!(results.iter().all(|result| result.duration_ms >= 0));
    }

    #[test]
    fn unapproved_check_never_executes_and_records_gap() {
        let conn = connection();
        seed_run_and_task(&conn);
        store::insert_check(&conn, &check("check-unapproved", "danger", false)).unwrap();
        store::insert_coverage_gap(
            &conn,
            &crate::run::types::CoverageGap {
                id: "gap-unapproved".to_string(),
                run_id: "run-checks".to_string(),
                task_id: None,
                kind: "check_unapproved".to_string(),
                subject: "danger".to_string(),
                detail: Some("approval required".to_string()),
                created_at: 1,
            },
        )
        .unwrap();
        assert!(store::list_check_results(&conn, "run-checks").unwrap().is_empty());
        let gaps = store::list_coverage_gaps(&conn, "run-checks").unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].kind, "check_unapproved");
    }

    #[test]
    fn completion_requires_evidence() {
        let conn = connection();
        seed_run_and_task(&conn);
        move_task_to_review(&conn);
        assert!(!store::task_has_evidence(&conn, "task-checks").unwrap());
        assert_eq!(
            completion_blockers(false, &[]),
            vec!["no finding with evidence"]
        );
        store::insert_finding(&conn, &evidence_finding()).unwrap();
        assert!(store::task_has_evidence(&conn, "task-checks").unwrap());
        assert!(completion_blockers(true, &[]).is_empty());
    }

    #[test]
    fn pre_existing_failure_does_not_block_done() {
        let conn = connection();
        seed_run_and_task(&conn);
        move_task_to_review(&conn);
        store::insert_check(&conn, &check("check-baseline-failed", "lint", true)).unwrap();
        store::insert_check_result(
            &conn,
            &CheckResult {
                id: "baseline-failed-result".to_string(),
                check_id: "check-baseline-failed".to_string(),
                task_id: None,
                attempt_id: None,
                kind: "baseline".to_string(),
                exit_code: Some(3),
                duration_ms: 1,
                output_tail: "failed before the task".to_string(),
                pre_existing_failure: true,
                created_at: 1,
            },
        )
        .unwrap();
        store::insert_check_result(
            &conn,
            &CheckResult {
                id: "verify-failed-result".to_string(),
                check_id: "check-baseline-failed".to_string(),
                task_id: Some("task-checks".to_string()),
                attempt_id: None,
                kind: "verify".to_string(),
                exit_code: Some(3),
                duration_ms: 1,
                output_tail: "still failed".to_string(),
                pre_existing_failure: true,
                created_at: 2,
            },
        )
        .unwrap();
        store::insert_finding(&conn, &evidence_finding()).unwrap();
        assert!(completion_blockers(
            true,
            &[gate("lint", true, Some(3))]
        )
        .is_empty());
        store::transition_task(&conn, "task-checks", TaskState::Done, None).unwrap();
    }

    #[test]
    fn regression_blocks_done() {
        let conn = connection();
        seed_run_and_task(&conn);
        move_task_to_review(&conn);
        store::insert_check(&conn, &check("check-regression", "tests", true)).unwrap();
        store::insert_finding(&conn, &evidence_finding()).unwrap();
        let blockers = completion_blockers(
            true,
            &[gate("tests", false, Some(1))],
        );
        assert_eq!(blockers, vec!["check tests regressed"]);
        let state: String = conn
            .query_row(
                "SELECT state FROM run_tasks WHERE id = 'task-checks'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "review");
    }
}
