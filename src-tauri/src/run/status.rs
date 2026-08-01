// ABOUTME: Pure run-engine state-machine and terminal-status derivation rules.
// ABOUTME: Unit tests keep task transitions and aggregate run outcomes deterministic.

use super::types::{RunStatus, TaskState};

pub fn is_legal_transition(from: TaskState, to: TaskState) -> bool {
    match from {
        TaskState::Pending => matches!(to, TaskState::Ready | TaskState::Cancelled),
        TaskState::Ready => matches!(
            to,
            TaskState::Provisioning | TaskState::Running | TaskState::Cancelled
        ),
        TaskState::Provisioning => matches!(
            to,
            TaskState::Running | TaskState::Ready | TaskState::Failed | TaskState::Cancelled
        ),
        TaskState::Running => matches!(
            to,
            TaskState::Blocked
                | TaskState::Verifying
                | TaskState::Ready
                | TaskState::Failed
                | TaskState::Cancelled
        ),
        TaskState::Blocked => matches!(
            to,
            TaskState::Running | TaskState::Ready | TaskState::Failed | TaskState::Cancelled
        ),
        TaskState::Verifying => matches!(
            to,
            TaskState::Review
                | TaskState::Running
                | TaskState::Ready
                | TaskState::Failed
                | TaskState::Cancelled
        ),
        // Failed is reachable from review: an attempt can satisfy verification
        // and still miss the completion gate (no evidence-bearing finding), and
        // that task has to be able to end rather than rest in review forever.
        TaskState::Review => matches!(
            to,
            TaskState::Done
                | TaskState::Running
                | TaskState::Ready
                | TaskState::Failed
                | TaskState::Cancelled
        ),
        TaskState::Done | TaskState::Failed | TaskState::Cancelled => false,
    }
}

pub fn derive_run_status(
    task_states: &[TaskState],
    cancel_requested: bool,
    interrupted: bool,
) -> RunStatus {
    if cancel_requested {
        return RunStatus::Cancelled;
    }
    if task_states.is_empty() {
        return RunStatus::Running;
    }
    if task_states.iter().any(|state| !state.is_terminal()) {
        return if interrupted {
            RunStatus::Interrupted
        } else {
            RunStatus::Running
        };
    }
    if task_states.iter().all(|state| *state == TaskState::Done) {
        RunStatus::Completed
    } else if task_states.iter().any(|state| *state == TaskState::Done) {
        RunStatus::Partial
    } else {
        RunStatus::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legal_task_edges_are_accepted() {
        let edges = [
            (TaskState::Pending, TaskState::Ready),
            (TaskState::Pending, TaskState::Cancelled),
            (TaskState::Ready, TaskState::Provisioning),
            (TaskState::Ready, TaskState::Running),
            (TaskState::Ready, TaskState::Cancelled),
            (TaskState::Provisioning, TaskState::Running),
            (TaskState::Provisioning, TaskState::Ready),
            (TaskState::Provisioning, TaskState::Failed),
            (TaskState::Provisioning, TaskState::Cancelled),
            (TaskState::Running, TaskState::Blocked),
            (TaskState::Running, TaskState::Verifying),
            (TaskState::Running, TaskState::Ready),
            (TaskState::Running, TaskState::Failed),
            (TaskState::Running, TaskState::Cancelled),
            (TaskState::Blocked, TaskState::Running),
            (TaskState::Blocked, TaskState::Ready),
            (TaskState::Blocked, TaskState::Failed),
            (TaskState::Blocked, TaskState::Cancelled),
            (TaskState::Verifying, TaskState::Review),
            (TaskState::Verifying, TaskState::Running),
            (TaskState::Verifying, TaskState::Ready),
            (TaskState::Verifying, TaskState::Failed),
            (TaskState::Verifying, TaskState::Cancelled),
            (TaskState::Review, TaskState::Done),
            (TaskState::Review, TaskState::Running),
            (TaskState::Review, TaskState::Ready),
            (TaskState::Review, TaskState::Cancelled),
        ];
        for (from, to) in edges {
            assert!(is_legal_transition(from, to), "{from:?} -> {to:?}");
        }
    }

    #[test]
    fn representative_illegal_task_edges_are_rejected() {
        assert!(!is_legal_transition(TaskState::Pending, TaskState::Running));
        assert!(!is_legal_transition(TaskState::Done, TaskState::Running));
        assert!(!is_legal_transition(TaskState::Cancelled, TaskState::Ready));
    }

    #[test]
    fn derive_run_status_completed() {
        assert_eq!(
            derive_run_status(&[TaskState::Done, TaskState::Done], false, false),
            RunStatus::Completed
        );
    }

    #[test]
    fn derive_run_status_partial() {
        assert_eq!(
            derive_run_status(&[TaskState::Done, TaskState::Failed], false, false),
            RunStatus::Partial
        );
    }

    #[test]
    fn derive_run_status_failed() {
        assert_eq!(
            derive_run_status(&[TaskState::Failed, TaskState::Cancelled], false, false),
            RunStatus::Failed
        );
    }

    #[test]
    fn derive_run_status_cancelled() {
        assert_eq!(
            derive_run_status(&[TaskState::Running, TaskState::Done], true, false),
            RunStatus::Cancelled
        );
    }

    #[test]
    fn derive_run_status_cancel_requested_overrides_all_done() {
        assert_eq!(
            derive_run_status(&[TaskState::Done, TaskState::Done], true, true),
            RunStatus::Cancelled
        );
    }

    #[test]
    fn derive_run_status_any_nonterminal_is_running() {
        assert_eq!(
            derive_run_status(&[TaskState::Done, TaskState::Review], false, false),
            RunStatus::Running
        );
        assert_eq!(derive_run_status(&[], false, false), RunStatus::Running);
    }

    #[test]
    fn derive_run_status_cancelled_beats_interrupted() {
        assert_eq!(
            derive_run_status(&[TaskState::Running], true, true),
            RunStatus::Cancelled
        );
    }

    #[test]
    fn derive_run_status_all_terminal_beats_interrupted() {
        assert_eq!(
            derive_run_status(&[TaskState::Done, TaskState::Failed], false, true),
            RunStatus::Partial
        );
    }

    #[test]
    fn derive_run_status_interrupted_beats_running() {
        assert_eq!(
            derive_run_status(&[TaskState::Running], false, true),
            RunStatus::Interrupted
        );
    }
}
