// ABOUTME: Append-only audit trail for the authorization gate: lease lifecycle, approval outcomes, and durable decisions (#3193-D).
// ABOUTME: Rows carry identity + a credential-safe detail (program token/host/target) — never full command lines, arguments, or credentials.

use rusqlite::Connection;
use serde::Serialize;

use crate::capability_lease::{CapabilityLease, OperationRequest, command_program};
use crate::tool_authorization::ToolRoute;

/// Every event the gate audits. Lease "expand" from the epic has no dedicated
/// operation today — widening authority is only possible via a fresh grant, which
/// `LeaseGranted` records.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuditEvent {
    /// A user-approved capability lease was persisted.
    LeaseGranted,
    /// A lease was auto-materialized from an owner-defined standing policy at
    /// task start, with no human present (#3193-E).
    LeaseAutoGranted,
    /// A covered call ran silently under a lease (its budget was charged).
    LeaseUsed,
    /// A lease exclusion denied a call outright.
    LeaseDenied,
    /// A lease's expiry window closed (recorded once, on first observation).
    LeaseExpired,
    /// A lease was revoked by the user.
    LeaseRevoked,
    /// The gate suspended an action pending approval (deduped requests log once).
    ApprovalRequested,
    /// A suspended action was settled by a user decision or lapse.
    ApprovalApproved,
    ApprovalDenied,
    ApprovalSkipped,
    ApprovalExpired,
    /// A durable session decision was stored for an unclassified operation.
    DecisionGranted,
    DecisionDenied,
}

impl AuditEvent {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::LeaseGranted => "lease_granted",
            Self::LeaseAutoGranted => "lease_auto_granted",
            Self::LeaseUsed => "lease_used",
            Self::LeaseDenied => "lease_denied",
            Self::LeaseExpired => "lease_expired",
            Self::LeaseRevoked => "lease_revoked",
            Self::ApprovalRequested => "approval_requested",
            Self::ApprovalApproved => "approval_approved",
            Self::ApprovalDenied => "approval_denied",
            Self::ApprovalSkipped => "approval_skipped",
            Self::ApprovalExpired => "approval_expired",
            Self::DecisionGranted => "decision_granted",
            Self::DecisionDenied => "decision_denied",
        }
    }
}

/// One audit row, serialized camelCase for the inspection UI. `subject_id` links
/// the row to its lease or approval continuation; `detail` is the credential-safe
/// summary written at record time (never recomputed from stored arguments).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub conversation_id: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}

/// What one event needs to say about the operation involved, already reduced to
/// the credential-safe slice. Built by the helpers below — call sites never pass
/// raw arguments in.
#[derive(Clone, Debug, Default)]
pub struct AuditContext {
    pub subject_id: Option<String>,
    pub route: Option<String>,
    pub publisher_slug: Option<String>,
    pub tool_name: Option<String>,
    pub detail: Option<String>,
}

impl AuditContext {
    /// Context for a lease lifecycle event: the lease id and its human label.
    /// The label was reviewed by the user at grant time, so it is display-safe.
    pub fn for_lease(lease: &CapabilityLease) -> Self {
        Self {
            subject_id: Some(lease.id.clone()),
            detail: Some(lease.label.clone()),
            ..Default::default()
        }
    }

    /// Context for an auto-granted lease (#3193-E): the lease id, its reviewed
    /// label, and the standing policy it was materialized from, so the trail can
    /// say "auto-granted from standing policy <id>". Credential-safe: the policy
    /// id and label were both authored by the owner.
    pub fn for_auto_lease(lease: &CapabilityLease, policy_id: &str) -> Self {
        Self {
            subject_id: Some(lease.id.clone()),
            detail: Some(format!(
                "{} — auto-granted from standing policy {policy_id}",
                lease.label
            )),
            ..Default::default()
        }
    }

    /// Context for a gate evaluation event. Reduces the operation to the same
    /// granularity lease predicates match on: the leading program token for
    /// subprocess routes (never the full command line), the host for web, and
    /// the resource target for publisher routes.
    pub fn for_request(request: &OperationRequest, lease_id: Option<&str>) -> Self {
        let detail = match request.route {
            ToolRoute::Shell | ToolRoute::Skill => {
                request.command.as_deref().and_then(command_program)
            }
            ToolRoute::Web => request.host.clone(),
            ToolRoute::Gateway | ToolRoute::Seren | ToolRoute::Mcp => request.target.clone(),
        };
        Self {
            subject_id: lease_id.map(str::to_string),
            route: Some(request.route.as_wire().to_string()),
            publisher_slug: Some(request.publisher_slug.clone()),
            tool_name: Some(request.tool_name.clone()),
            detail,
        }
    }

    /// Context for an approval-continuation event. The continuation's stored
    /// capability already excludes credentials; the audit row keeps only its
    /// identity — the continuation record remains the display source of truth.
    pub fn for_approval(
        approval_id: &str,
        route: &str,
        publisher_slug: &str,
        tool_name: &str,
    ) -> Self {
        Self {
            subject_id: Some(approval_id.to_string()),
            route: Some(route.to_string()),
            publisher_slug: Some(publisher_slug.to_string()),
            tool_name: Some(tool_name.to_string()),
            detail: None,
        }
    }

    /// Context for a durable per-tool session decision.
    pub fn for_decision(route: ToolRoute, publisher_slug: &str, tool_name: &str) -> Self {
        Self {
            subject_id: None,
            route: Some(route.as_wire().to_string()),
            publisher_slug: Some(publisher_slug.to_string()),
            tool_name: Some(tool_name.to_string()),
            detail: None,
        }
    }
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS authorization_audit (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            event           TEXT NOT NULL,
            subject_id      TEXT,
            route           TEXT,
            publisher_slug  TEXT,
            tool_name       TEXT,
            detail          TEXT,
            created_at      TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_authorization_audit_conversation \
         ON authorization_audit(conversation_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_authorization_audit_subject \
         ON authorization_audit(subject_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Append one audit row. Failures are returned, not panicked; callers on the hot
/// gate path log-and-continue so a full disk never blocks an authorization
/// decision that is otherwise sound.
pub fn record(
    conn: &Connection,
    conversation_id: &str,
    event: AuditEvent,
    context: &AuditContext,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO authorization_audit \
           (conversation_id, event, subject_id, route, publisher_slug, tool_name, detail, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            conversation_id,
            event.as_wire(),
            context.subject_id,
            context.route,
            context.publisher_slug,
            context.tool_name,
            context.detail,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record `lease_expired` exactly once per lease whose window has closed. Runs
/// on the gate path, so it is a single set-based statement guarded by NOT EXISTS
/// rather than a per-lease read-modify-write.
pub fn record_lease_expiries(
    conn: &Connection,
    conversation_id: &str,
    now: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO authorization_audit \
           (conversation_id, event, subject_id, created_at) \
         SELECT cl.conversation_id, 'lease_expired', cl.id, ?2 \
         FROM capability_leases cl \
         WHERE cl.conversation_id = ?1 AND cl.revoked = 0 AND cl.expires_at <= ?2 \
           AND NOT EXISTS ( \
             SELECT 1 FROM authorization_audit a \
             WHERE a.subject_id = cl.id AND a.event = 'lease_expired')",
        rusqlite::params![conversation_id, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The newest `limit` audit rows for a conversation.
pub fn read_entries(
    conn: &Connection,
    conversation_id: &str,
    limit: u32,
) -> Result<Vec<AuditEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, conversation_id, event, subject_id, route, publisher_slug, \
                    tool_name, detail, created_at \
             FROM authorization_audit WHERE conversation_id = ?1 \
             ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![conversation_id, limit], |row| {
            Ok(AuditEntry {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                event: row.get(2)?,
                subject_id: row.get(3)?,
                route: row.get(4)?,
                publisher_slug: row.get(5)?,
                tool_name: row.get(6)?,
                detail: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}
