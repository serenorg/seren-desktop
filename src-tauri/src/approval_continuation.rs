// ABOUTME: Host-owned suspended continuations for authorization-blocked actions (#3193-C).
// ABOUTME: A blocked action becomes a first-class, dedup'd, idempotently-resolvable record — never a hung agent or a generic tool error.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::capability_lease::command_program;
use crate::orchestrator::types::TaskExecutionState;
use crate::tool_authorization::ToolRoute;

/// Whether a blocked action holds up the whole turn or only an independent branch.
///
/// Conservative by default: the linear turn is what the current renderer drives,
/// so the whole task waits (`WaitingForApproval`). `Branch` is reserved for work
/// the scheduler can prove independent, which continues (`RunningWithBlockedActions`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinuationScope {
    Linear,
    Branch,
}

impl ContinuationScope {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Linear => "linear",
            Self::Branch => "branch",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "linear" => Ok(Self::Linear),
            "branch" => Ok(Self::Branch),
            other => Err(format!("Unknown continuation scope: {other}")),
        }
    }
}

/// The lifecycle of one suspended continuation. `Pending` is the only non-terminal
/// state; every other is settled exactly once. `Expired` is a first-class terminal
/// outcome — an approval that never arrived, distinct from a `Denied` decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContinuationState {
    Pending,
    Approved,
    Denied,
    Skipped,
    Expired,
}

impl ContinuationState {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Skipped => "skipped",
            Self::Expired => "expired",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "denied" => Ok(Self::Denied),
            "skipped" => Ok(Self::Skipped),
            "expired" => Ok(Self::Expired),
            other => Err(format!("Unknown continuation state: {other}")),
        }
    }

    /// Map this outcome to the task-level state the frontend renders.
    pub fn task_state(self, scope: ContinuationScope) -> TaskExecutionState {
        match self {
            Self::Pending => match scope {
                ContinuationScope::Linear => TaskExecutionState::WaitingForApproval,
                ContinuationScope::Branch => TaskExecutionState::RunningWithBlockedActions,
            },
            Self::Approved => TaskExecutionState::Running,
            Self::Denied => TaskExecutionState::ApprovalDenied,
            Self::Skipped => TaskExecutionState::ActionSkipped,
            Self::Expired => TaskExecutionState::ApprovalExpired,
        }
    }
}

/// A human decision on a suspended action. Expiry is not here: it is a system
/// outcome (`expire_continuation`), not a user choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolveDecision {
    Approve,
    Deny,
    Skip,
}

impl ResolveDecision {
    pub fn settled_state(self) -> ContinuationState {
        match self {
            Self::Approve => ContinuationState::Approved,
            Self::Deny => ContinuationState::Denied,
            Self::Skip => ContinuationState::Skipped,
        }
    }
}

/// What the gate blocked, in host-owned terms. Carries both the display metadata
/// the approval UI renders and the argument slice the dedup fingerprint keys on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestedCapability {
    /// `ToolRoute` wire token (gateway/seren/mcp/shell/skill/web).
    pub route: String,
    pub publisher_slug: String,
    pub tool_name: String,
    /// Host classification (trusted-read/high-risk/unclassified). Host-owned so the
    /// renderer cannot understate what was blocked.
    pub operation_class: String,
    pub description: String,
    #[serde(default)]
    pub is_destructive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// The renderer's contract for a freshly registered (or deduped) continuation.
///
/// `resume_token` is the host-minted secret the renderer holds to resolve the
/// continuation; it is deliberately absent from `model_result`, so a model that
/// learns the public `approval_id` still cannot forge a resume or self-approve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredContinuation {
    pub approval_id: String,
    pub resume_token: String,
    pub blocked_scope: ContinuationScope,
    pub task_state: TaskExecutionState,
    /// Whether this call created the record. `false` when an equivalent pending
    /// request already existed and was reused (dedup) — the renderer can suppress a
    /// duplicate prompt/notification.
    pub deduplicated: bool,
    /// The redacted `approval_pending` payload safe to surface to the model as a
    /// tool result. Never contains the resume token.
    pub model_result: serde_json::Value,
}

/// The result of resolving (or expiring) a continuation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveOutcome {
    /// Whether THIS call changed the continuation. `false` on idempotent replay of
    /// an already-settled decision — the continuation resolves exactly once.
    pub changed: bool,
    pub state: ContinuationState,
    pub task_state: TaskExecutionState,
}

/// A redacted continuation record for inspection surfaces (slice D). Never carries
/// the resume token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationView {
    pub approval_id: String,
    pub task_id: String,
    pub blocked_scope: ContinuationScope,
    pub state: ContinuationState,
    pub task_state: TaskExecutionState,
    pub requested_capability: RequestedCapability,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

/// Aggregate outcome counts for a task, backing completion integrity and the final
/// summary disclosure.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionSummary {
    /// Still pending (and not expired) — the completion blocker.
    pub unresolved: usize,
    pub approved: usize,
    pub denied: usize,
    pub skipped: usize,
    pub expired: usize,
}

impl ResolutionSummary {
    /// Completion integrity: a task with an unresolved required approval cannot
    /// report completed.
    pub fn can_complete(&self) -> bool {
        self.unresolved == 0
    }

    /// Whether any action was denied, skipped, expired, or is still unresolved —
    /// i.e. the final summary must disclose incomplete authority.
    pub fn has_disclosable(&self) -> bool {
        self.unresolved + self.denied + self.skipped + self.expired > 0
    }
}

/// A persisted continuation row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContinuationRow {
    pub approval_id: String,
    pub conversation_id: String,
    pub fingerprint: String,
    pub resume_token: String,
    pub scope: ContinuationScope,
    pub state: ContinuationState,
    pub requested: RequestedCapability,
    pub created_at: String,
    pub expires_at: String,
    pub resolved_at: Option<String>,
}

impl ContinuationRow {
    /// The redacted `approval_pending` object surfaced to the model. Enough to stop
    /// retrying (status, id, scope, what was requested, when it lapses) and nothing
    /// the model could use to resolve the block itself.
    pub fn model_result(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "approval_pending",
            "approvalId": self.approval_id,
            "taskId": self.conversation_id,
            "blockedScope": self.scope,
            "requestedCapability": self.requested,
            "expiresAt": self.expires_at,
        })
    }

    pub fn registered(&self, deduplicated: bool) -> RegisteredContinuation {
        RegisteredContinuation {
            approval_id: self.approval_id.clone(),
            resume_token: self.resume_token.clone(),
            blocked_scope: self.scope,
            task_state: self.state.task_state(self.scope),
            deduplicated,
            model_result: self.model_result(),
        }
    }

    pub fn view(&self) -> ContinuationView {
        ContinuationView {
            approval_id: self.approval_id.clone(),
            task_id: self.conversation_id.clone(),
            blocked_scope: self.scope,
            state: self.state,
            task_state: self.state.task_state(self.scope),
            requested_capability: self.requested.clone(),
            created_at: self.created_at.clone(),
            expires_at: self.expires_at.clone(),
            resolved_at: self.resolved_at.clone(),
        }
    }
}

/// Canonical capability fingerprint used to dedup equivalent pending requests.
///
/// Keyed at the same granularity the gate and capability leases evaluate, so a
/// retry of the same blocked operation reuses one pending request (no
/// prompt/notification storms) while a genuinely different capability gets its
/// own. Shell/skill key on the leading program (matching lease command rules),
/// web keys on the host (matching network-host rules), and publisher routes key
/// on publisher + operation + resource target (matching the gate's session-grant
/// key and publisher predicates).
pub fn fingerprint(cap: &RequestedCapability) -> String {
    match ToolRoute::parse(&cap.route) {
        Ok(ToolRoute::Shell) | Ok(ToolRoute::Skill) => {
            let program = cap
                .command
                .as_deref()
                .and_then(command_program)
                .unwrap_or_default();
            format!("{}|{}", cap.route, program)
        }
        Ok(ToolRoute::Web) => {
            let host = cap
                .host
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            format!("web|{host}")
        }
        // Gateway/Seren/Mcp, and any unrecognized route treated conservatively as a
        // publisher operation, key on operation + resource identity.
        _ => format!(
            "{}|{}|{}|{}",
            cap.route,
            cap.publisher_slug,
            cap.tool_name,
            cap.target.as_deref().unwrap_or("")
        ),
    }
}

/// The aggregate live task state from all continuations of a conversation. A
/// linear pending block dominates (the whole turn waits); a branch-only pending
/// block downgrades to running-with-blocked-actions; otherwise the task runs.
///
/// Callers must expire overdue rows first so a lapsed pending block does not keep a
/// task spuriously waiting.
pub fn aggregate_task_state(rows: &[ContinuationRow]) -> TaskExecutionState {
    let mut branch_blocked = false;
    for row in rows {
        if row.state == ContinuationState::Pending {
            match row.scope {
                ContinuationScope::Linear => return TaskExecutionState::WaitingForApproval,
                ContinuationScope::Branch => branch_blocked = true,
            }
        }
    }
    if branch_blocked {
        TaskExecutionState::RunningWithBlockedActions
    } else {
        TaskExecutionState::Running
    }
}

/// Count each terminal (and unresolved) outcome across a conversation's rows.
pub fn summarize(rows: &[ContinuationRow]) -> ResolutionSummary {
    let mut summary = ResolutionSummary::default();
    for row in rows {
        match row.state {
            ContinuationState::Pending => summary.unresolved += 1,
            ContinuationState::Approved => summary.approved += 1,
            ContinuationState::Denied => summary.denied += 1,
            ContinuationState::Skipped => summary.skipped += 1,
            ContinuationState::Expired => summary.expired += 1,
        }
    }
    summary
}

// ============================================================================
// Persistence — free functions over a borrowed connection, mirroring the lease
// store so the whole authorization database shares one connection + mutex.
// ============================================================================

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS approval_continuations (
            approval_id     TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            fingerprint     TEXT NOT NULL,
            resume_token    TEXT NOT NULL,
            scope           TEXT NOT NULL,
            state           TEXT NOT NULL,
            requested_json  TEXT NOT NULL,
            created_at      TEXT NOT NULL,
            expires_at      TEXT NOT NULL,
            resolved_at     TEXT
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_approval_continuations_conversation \
         ON approval_continuations(conversation_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_from_sql(row: &rusqlite::Row) -> rusqlite::Result<ContinuationRow> {
    let scope_raw: String = row.get(4)?;
    let state_raw: String = row.get(5)?;
    let requested_raw: String = row.get(6)?;
    // A corrupt row must surface as an error, not silently decode to a wrong
    // decision; the caller logs and skips it rather than trusting garbage.
    let scope = ContinuationScope::parse(&scope_raw)
        .map_err(|e| rusqlite::Error::InvalidColumnType(4, e, rusqlite::types::Type::Text))?;
    let state = ContinuationState::parse(&state_raw)
        .map_err(|e| rusqlite::Error::InvalidColumnType(5, e, rusqlite::types::Type::Text))?;
    let requested: RequestedCapability = serde_json::from_str(&requested_raw).map_err(|e| {
        rusqlite::Error::InvalidColumnType(6, e.to_string(), rusqlite::types::Type::Text)
    })?;
    Ok(ContinuationRow {
        approval_id: row.get(0)?,
        conversation_id: row.get(1)?,
        fingerprint: row.get(2)?,
        resume_token: row.get(3)?,
        scope,
        state,
        requested,
        created_at: row.get(7)?,
        expires_at: row.get(8)?,
        resolved_at: row.get(9)?,
    })
}

const SELECT_COLUMNS: &str = "approval_id, conversation_id, fingerprint, resume_token, \
     scope, state, requested_json, created_at, expires_at, resolved_at";

pub fn read_continuations(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<ContinuationRow>, String> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM approval_continuations \
         WHERE conversation_id = ?1 ORDER BY created_at ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![conversation_id], row_from_sql)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(row) => out.push(row),
            Err(err) => log::warn!("[approval-continuation] Skipping unreadable row: {err}"),
        }
    }
    Ok(out)
}

pub fn find_by_id(conn: &Connection, approval_id: &str) -> Result<Option<ContinuationRow>, String> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM approval_continuations WHERE approval_id = ?1");
    conn.query_row(&sql, rusqlite::params![approval_id], row_from_sql)
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
}

/// A still-pending, not-yet-lapsed row matching this fingerprint — the dedup target.
pub fn find_pending_by_fingerprint(
    conn: &Connection,
    conversation_id: &str,
    fingerprint: &str,
    now: &str,
) -> Result<Option<ContinuationRow>, String> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM approval_continuations \
         WHERE conversation_id = ?1 AND fingerprint = ?2 AND state = 'pending' \
           AND expires_at > ?3 ORDER BY created_at ASC LIMIT 1"
    );
    conn.query_row(
        &sql,
        rusqlite::params![conversation_id, fingerprint, now],
        row_from_sql,
    )
    .map(Some)
    .or_else(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other.to_string()),
    })
}

pub fn insert_continuation(conn: &Connection, row: &ContinuationRow) -> Result<(), String> {
    let requested_json = serde_json::to_string(&row.requested)
        .map_err(|e| format!("Requested capability could not be encoded: {e}"))?;
    conn.execute(
        "INSERT INTO approval_continuations \
           (approval_id, conversation_id, fingerprint, resume_token, scope, state, \
            requested_json, created_at, expires_at, resolved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            row.approval_id,
            row.conversation_id,
            row.fingerprint,
            row.resume_token,
            row.scope.as_wire(),
            row.state.as_wire(),
            requested_json,
            row.created_at,
            row.expires_at,
            row.resolved_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Settle a continuation to a terminal state, stamping `resolved_at`. Only mutates
/// a row that is still pending, so a concurrent double-resolve cannot both win.
/// Returns whether a pending row was actually transitioned.
pub fn settle_if_pending(
    conn: &Connection,
    approval_id: &str,
    state: ContinuationState,
    resolved_at: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE approval_continuations \
             SET state = ?2, resolved_at = ?3 \
             WHERE approval_id = ?1 AND state = 'pending'",
            rusqlite::params![approval_id, state.as_wire(), resolved_at],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// Expire every pending row for a conversation whose window has closed. Explicit
/// and persisted: a lapsed action becomes `Expired`, never a generic failure and
/// never a silently-live pending block. Returns how many rows expired.
pub fn expire_overdue(
    conn: &Connection,
    conversation_id: &str,
    now: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE approval_continuations \
         SET state = 'expired', resolved_at = ?2 \
         WHERE conversation_id = ?1 AND state = 'pending' AND expires_at <= ?2",
        rusqlite::params![conversation_id, now],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(route: &str, publisher: &str, tool: &str) -> RequestedCapability {
        RequestedCapability {
            route: route.to_string(),
            publisher_slug: publisher.to_string(),
            tool_name: tool.to_string(),
            operation_class: "high-risk".to_string(),
            description: "test".to_string(),
            is_destructive: false,
            command: None,
            host: None,
            target: None,
        }
    }

    fn row(id: &str, scope: ContinuationScope, state: ContinuationState) -> ContinuationRow {
        ContinuationRow {
            approval_id: id.to_string(),
            conversation_id: "conv-a".to_string(),
            fingerprint: "fp".to_string(),
            resume_token: "tok".to_string(),
            scope,
            state,
            requested: cap("gateway", "gmail", "post_send"),
            created_at: "2026-07-24T00:00:00Z".to_string(),
            expires_at: "2026-07-24T00:05:00Z".to_string(),
            resolved_at: None,
        }
    }

    // ---- fingerprint granularity ----------------------------------------

    #[test]
    fn shell_fingerprint_keys_on_program_not_full_command() {
        let mut a = cap("shell", "seren", "execute_command");
        a.command = Some("cargo build --release".to_string());
        let mut b = cap("shell", "seren", "execute_command");
        b.command = Some("cargo test --workspace".to_string());
        // Same program → same pending request (matches lease command-rule grain).
        assert_eq!(fingerprint(&a), fingerprint(&b));

        let mut c = cap("shell", "seren", "execute_command");
        c.command = Some("git push".to_string());
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn publisher_fingerprint_separates_tool_and_target() {
        let mut base = cap("gateway", "attio", "post_notes");
        base.target = Some("conn-1".to_string());
        let mut same = cap("gateway", "attio", "post_notes");
        same.target = Some("conn-1".to_string());
        assert_eq!(fingerprint(&base), fingerprint(&same));

        let mut other_tool = cap("gateway", "attio", "post_records");
        other_tool.target = Some("conn-1".to_string());
        assert_ne!(fingerprint(&base), fingerprint(&other_tool));

        let mut other_target = cap("gateway", "attio", "post_notes");
        other_target.target = Some("conn-2".to_string());
        assert_ne!(fingerprint(&base), fingerprint(&other_target));
    }

    #[test]
    fn web_fingerprint_keys_on_host() {
        let mut a = cap("web", "seren", "web_fetch");
        a.host = Some("API.example.com".to_string());
        let mut b = cap("web", "seren", "web_fetch");
        b.host = Some("api.example.com".to_string());
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    // ---- task-state derivation ------------------------------------------

    #[test]
    fn linear_pending_makes_the_whole_task_wait() {
        let rows = vec![row(
            "a",
            ContinuationScope::Linear,
            ContinuationState::Pending,
        )];
        assert_eq!(
            aggregate_task_state(&rows),
            TaskExecutionState::WaitingForApproval
        );
    }

    #[test]
    fn branch_only_pending_keeps_task_running_with_blocked_actions() {
        let rows = vec![row(
            "a",
            ContinuationScope::Branch,
            ContinuationState::Pending,
        )];
        assert_eq!(
            aggregate_task_state(&rows),
            TaskExecutionState::RunningWithBlockedActions
        );
    }

    #[test]
    fn linear_pending_dominates_a_branch_block() {
        let rows = vec![
            row("a", ContinuationScope::Branch, ContinuationState::Pending),
            row("b", ContinuationScope::Linear, ContinuationState::Pending),
        ];
        assert_eq!(
            aggregate_task_state(&rows),
            TaskExecutionState::WaitingForApproval
        );
    }

    #[test]
    fn all_settled_returns_to_running() {
        let rows = vec![
            row("a", ContinuationScope::Linear, ContinuationState::Denied),
            row("b", ContinuationScope::Branch, ContinuationState::Approved),
            row("c", ContinuationScope::Linear, ContinuationState::Expired),
        ];
        assert_eq!(aggregate_task_state(&rows), TaskExecutionState::Running);
    }

    // ---- outcome → task-state mapping -----------------------------------

    #[test]
    fn terminal_states_map_to_disclosable_task_states() {
        assert_eq!(
            ContinuationState::Denied.task_state(ContinuationScope::Linear),
            TaskExecutionState::ApprovalDenied
        );
        assert_eq!(
            ContinuationState::Expired.task_state(ContinuationScope::Linear),
            TaskExecutionState::ApprovalExpired
        );
        assert_eq!(
            ContinuationState::Skipped.task_state(ContinuationScope::Linear),
            TaskExecutionState::ActionSkipped
        );
        assert_eq!(
            ContinuationState::Approved.task_state(ContinuationScope::Linear),
            TaskExecutionState::Running
        );
    }

    // ---- summary + completion integrity ---------------------------------

    #[test]
    fn summary_counts_and_blocks_completion_only_while_unresolved() {
        let pending = vec![row(
            "a",
            ContinuationScope::Linear,
            ContinuationState::Pending,
        )];
        let summary = summarize(&pending);
        assert_eq!(summary.unresolved, 1);
        assert!(!summary.can_complete());
        assert!(summary.has_disclosable());

        let settled = vec![
            row("a", ContinuationScope::Linear, ContinuationState::Denied),
            row("b", ContinuationScope::Linear, ContinuationState::Skipped),
            row("c", ContinuationScope::Linear, ContinuationState::Expired),
            row("d", ContinuationScope::Linear, ContinuationState::Approved),
        ];
        let summary = summarize(&settled);
        assert_eq!(summary.denied, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.expired, 1);
        assert_eq!(summary.approved, 1);
        assert_eq!(summary.unresolved, 0);
        // No unresolved required approval → completion is allowed, but the denied /
        // skipped / expired work must still be disclosed.
        assert!(summary.can_complete());
        assert!(summary.has_disclosable());
    }

    #[test]
    fn model_result_never_leaks_the_resume_token() {
        let row = row("a", ContinuationScope::Linear, ContinuationState::Pending);
        let value = row.model_result();
        assert_eq!(value["status"], "approval_pending");
        assert_eq!(value["approvalId"], "a");
        assert!(value.get("resumeToken").is_none());
        assert!(value.get("resume_token").is_none());
        // The registered contract carries the token for the renderer but never
        // folds it into the model-facing payload.
        let registered = row.registered(false);
        assert_eq!(registered.resume_token, "tok");
        assert!(registered.model_result.get("resumeToken").is_none());
    }
}
