// ABOUTME: Serde-facing types for durable runs, tasks, attempts, findings, and events.
// ABOUTME: Enum spellings are the stable snake_case values stored in SQLite.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Ready,
    Provisioning,
    Running,
    Blocked,
    Verifying,
    Review,
    Done,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Provisioning => "provisioning",
            Self::Running => "running",
            Self::Blocked => "blocked",
            Self::Verifying => "verifying",
            Self::Review => "review",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "ready" => Self::Ready,
            "provisioning" => Self::Provisioning,
            "running" => Self::Running,
            "blocked" => Self::Blocked,
            "verifying" => Self::Verifying,
            "review" => Self::Review,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "partial" => Self::Partial,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseMode {
    SharedReadonly,
    Worktree,
    Scratch,
    ExternalRead,
    ExternalWrite,
}

impl LeaseMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SharedReadonly => "shared_readonly",
            Self::Worktree => "worktree",
            Self::Scratch => "scratch",
            Self::ExternalRead => "external_read",
            Self::ExternalWrite => "external_write",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "shared_readonly" => Self::SharedReadonly,
            "worktree" => Self::Worktree,
            "scratch" => Self::Scratch,
            "external_read" => Self::ExternalRead,
            "external_write" => Self::ExternalWrite,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseState {
    Requested,
    Provisioning,
    Active,
    SetupFailed,
    Released,
    Failed,
}

impl LeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Provisioning => "provisioning",
            Self::Active => "active",
            Self::SetupFailed => "setup_failed",
            Self::Released => "released",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "requested" => Self::Requested,
            "provisioning" => Self::Provisioning,
            "active" => Self::Active,
            "setup_failed" => Self::SetupFailed,
            "released" => Self::Released,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingConfidence {
    Asserted,
    Verified,
    Refuted,
}

impl FindingConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asserted => "asserted",
            Self::Verified => "verified",
            Self::Refuted => "refuted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "asserted" => Self::Asserted,
            "verified" => Self::Verified,
            "refuted" => Self::Refuted,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingStatus {
    Open,
    Accepted,
    Rejected,
    Superseded,
}

impl FindingStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Superseded => "superseded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "open" => Self::Open,
            "accepted" => Self::Accepted,
            "rejected" => Self::Rejected,
            "superseded" => Self::Superseded,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    CommandResult,
    FileRange,
    Email,
    Document,
    Url,
    LogExcerpt,
    PublisherResult,
}

impl EvidenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CommandResult => "command_result",
            Self::FileRange => "file_range",
            Self::Email => "email",
            Self::Document => "document",
            Self::Url => "url",
            Self::LogExcerpt => "log_excerpt",
            Self::PublisherResult => "publisher_result",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "command_result" => Self::CommandResult,
            "file_range" => Self::FileRange,
            "email" => Self::Email,
            "document" => Self::Document,
            "url" => Self::Url,
            "log_excerpt" => Self::LogExcerpt,
            "publisher_result" => Self::PublisherResult,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Diff,
    Document,
    Email,
    Comment,
}

impl ArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Diff => "diff",
            Self::Document => "document",
            Self::Email => "email",
            Self::Comment => "comment",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "diff" => Self::Diff,
            "document" => Self::Document,
            "email" => Self::Email,
            "comment" => Self::Comment,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunEventType {
    RunCreated,
    TaskAdded,
    DependencyAdded,
    AssignmentAdded,
    TaskStateChanged,
    AttemptStarted,
    AttemptFinished,
    FindingRecorded,
    EvidenceAttached,
    ApprovalRequested,
    RunCancelRequested,
    RunFinalized,
    LeaseStateChanged,
}

impl RunEventType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunCreated => "run_created",
            Self::TaskAdded => "task_added",
            Self::DependencyAdded => "dependency_added",
            Self::AssignmentAdded => "assignment_added",
            Self::TaskStateChanged => "task_state_changed",
            Self::AttemptStarted => "attempt_started",
            Self::AttemptFinished => "attempt_finished",
            Self::FindingRecorded => "finding_recorded",
            Self::EvidenceAttached => "evidence_attached",
            Self::ApprovalRequested => "approval_requested",
            Self::RunCancelRequested => "run_cancel_requested",
            Self::RunFinalized => "run_finalized",
            Self::LeaseStateChanged => "lease_state_changed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "run_created" => Self::RunCreated,
            "task_added" => Self::TaskAdded,
            "dependency_added" => Self::DependencyAdded,
            "assignment_added" => Self::AssignmentAdded,
            "task_state_changed" => Self::TaskStateChanged,
            "attempt_started" => Self::AttemptStarted,
            "attempt_finished" => Self::AttemptFinished,
            "finding_recorded" => Self::FindingRecorded,
            "evidence_attached" => Self::EvidenceAttached,
            "approval_requested" => Self::ApprovalRequested,
            "run_cancel_requested" => Self::RunCancelRequested,
            "run_finalized" => Self::RunFinalized,
            "lease_state_changed" => Self::LeaseStateChanged,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub root_path: Option<String>,
    pub status: RunStatus,
    pub cancel_requested: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub brief: String,
    pub state: TaskState,
    pub blocked_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDependency {
    pub task_id: String,
    pub depends_on_task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAssignment {
    pub id: String,
    pub run_id: String,
    pub agent_type: String,
    pub model_id: Option<String>,
    pub role_label: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub task_id: String,
    pub agent_assignment_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub attempt_number: i64,
    pub outcome: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceLease {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub mode: LeaseMode,
    pub root_path: Option<String>,
    pub base_revision: Option<String>,
    pub state: String,
    pub created_at: i64,
    pub released_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewLease {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub mode: LeaseMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub reference: String,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedArtifact {
    pub kind: ArtifactKind,
    pub title: String,
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub claim: String,
    pub confidence: FindingConfidence,
    pub evidence: Vec<Evidence>,
    pub proposed_artifact: Option<ProposedArtifact>,
    pub needs_approval: bool,
    pub status: FindingStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewRunEvent {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub agent_id: Option<String>,
    pub event_type: RunEventType,
    pub payload: Value,
    pub provider_event_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunEvent {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub attempt_id: Option<String>,
    pub agent_id: Option<String>,
    pub sequence: i64,
    pub event_type: RunEventType,
    pub payload: Value,
    pub provider_event_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSnapshot {
    pub run: Run,
    pub tasks: Vec<Task>,
    pub dependencies: Vec<TaskDependency>,
    pub assignments: Vec<AgentAssignment>,
    pub attempts: Vec<Attempt>,
    pub findings: Vec<Finding>,
}
