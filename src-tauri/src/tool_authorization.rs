// ABOUTME: Host-owned authorization gate for every model-originated tool call.
// ABOUTME: Owns classification and a persisted, conversation-scoped decision store; the renderer only displays and dispatches.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::approval_continuation::{
    self, ContinuationRow, ContinuationScope, ContinuationState, ContinuationView,
    RegisteredContinuation, RequestedCapability, ResolutionSummary, ResolveDecision, ResolveOutcome,
};
use crate::capability_lease::{
    self, CapabilityLease, LeaseBudgets, LeaseOutcome, LeasePredicates, OperationRequest,
};
use crate::orchestrator::types::TaskExecutionState;

/// The small argument slice the gate needs to evaluate lease predicates for a
/// call. Extracted from the tool arguments by the renderer per route: `command`
/// for shell/skill, `host` for web fetch, `target` (resource/account/connection)
/// and `cost_micros` for publisher operations. All optional — a call with no
/// context simply cannot match a predicate that requires it.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationContext {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub cost_micros: Option<u64>,
}

/// Which executor route the renderer is asking about. The route decides how a
/// call is classified: publisher routes use the operationId verb grammar, while
/// shell/skill subprocess execution is always high-risk regardless of its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolRoute {
    /// `gateway__publisher__tool` — a Seren Gateway publisher operation.
    Gateway,
    /// `seren__tool` — a built-in Seren tool.
    Seren,
    /// `mcp__server__tool` — a local stdio MCP server. User-controlled name, no
    /// trusted metadata, so its reads are never auto-trusted.
    Mcp,
    /// `execute_command` — shell execution.
    Shell,
    /// `run_skill_script` — skill-launched subprocess execution.
    Skill,
    /// `seren_web_fetch` — arbitrary-URL fetch (open-world data egress).
    Web,
}

impl ToolRoute {
    pub fn parse(route: &str) -> Result<Self, String> {
        match route {
            "gateway" => Ok(Self::Gateway),
            "seren" => Ok(Self::Seren),
            "mcp" => Ok(Self::Mcp),
            "shell" => Ok(Self::Shell),
            "skill" => Ok(Self::Skill),
            "web" => Ok(Self::Web),
            other => Err(format!("Unknown tool route: {other}")),
        }
    }

    /// The lowercase wire token for this route. Kept in sync with `parse` so an
    /// exclusion predicate can name a route by the same string the renderer sends.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Gateway => "gateway",
            Self::Seren => "seren",
            Self::Mcp => "mcp",
            Self::Shell => "shell",
            Self::Skill => "skill",
            Self::Web => "web",
        }
    }
}

/// Trusted classification of a single operation. Unknown operations stay
/// `Unclassified` until trusted metadata exists — they never become an implicit
/// allow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationClass {
    TrustedRead,
    HighRisk,
    Unclassified,
}

impl OperationClass {
    fn as_wire(self) -> &'static str {
        match self {
            Self::TrustedRead => "trusted-read",
            Self::HighRisk => "high-risk",
            Self::Unclassified => "unclassified",
        }
    }
}

/// The gate's decision handed back to the renderer. `decision` is authoritative;
/// `description`/`is_destructive` are host-owned display metadata for the prompt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationDecision {
    /// "allow" (silent), "deny" (durable refusal), or "prompt".
    pub decision: String,
    /// "one-shot" or "session" when `decision` is "prompt"; otherwise `None`.
    pub prompt_kind: Option<String>,
    pub operation_class: String,
    pub description: String,
    pub is_destructive: bool,
}

impl AuthorizationDecision {
    fn allow(class: OperationClass) -> Self {
        Self {
            decision: "allow".to_string(),
            prompt_kind: None,
            operation_class: class.as_wire().to_string(),
            description: String::new(),
            is_destructive: false,
        }
    }

    fn deny(class: OperationClass) -> Self {
        Self {
            decision: "deny".to_string(),
            prompt_kind: None,
            operation_class: class.as_wire().to_string(),
            description: String::new(),
            is_destructive: false,
        }
    }

    fn prompt(class: OperationClass, kind: &str, description: String, is_destructive: bool) -> Self {
        Self {
            decision: "prompt".to_string(),
            prompt_kind: Some(kind.to_string()),
            operation_class: class.as_wire().to_string(),
            description,
            is_destructive,
        }
    }
}

// ============================================================================
// Classification — ported verbatim from the renderer's approval-config so the
// trusted policy is host-side and not editable by renderer code.
// ============================================================================

/// An explicit high-risk operation that carries a specific prompt description.
struct ApprovalRequirement {
    publisher_slug: &'static str,
    tool_pattern: &'static str,
    description: &'static str,
    is_destructive: bool,
}

const APPROVAL_REQUIREMENTS: &[ApprovalRequirement] = &[
    ApprovalRequirement {
        publisher_slug: "gmail",
        tool_pattern: "delete_messages_by_message_id",
        description: "Permanently delete email",
        is_destructive: true,
    },
    ApprovalRequirement {
        publisher_slug: "gmail",
        tool_pattern: "delete_labels_by_label_id",
        description: "Delete label",
        is_destructive: true,
    },
    ApprovalRequirement {
        publisher_slug: "gmail",
        tool_pattern: "post_send",
        description: "Send email",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "gmail",
        tool_pattern: "post_messages_send",
        description: "Send email (raw RFC 2822)",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "gmail",
        tool_pattern: "post_drafts_by_draft_id_send",
        description: "Send draft email",
        is_destructive: false,
    },
];

/// Publishers whose reads (safe verb tokens) execute silently. Reads for any
/// other publisher stay unclassified — an unknown publisher's reads are not
/// assumed safe.
const TRUSTED_READ_PUBLISHERS: &[&str] = &["gmail"];

/// Positively identified read-only operations for publishers not covered by
/// `TRUSTED_READ_PUBLISHERS`. Kept narrow on purpose.
const TRUSTED_READ_OPERATIONS: &[(&str, &str)] = &[
    ("seren", "list_projects"),
    ("seren", "get_project"),
    ("seren", "search_projects"),
    ("seren", "get_status"),
];

/// Leading verb tokens that denote a side-effect-free read.
const READ_VERBS: &[&str] = &[
    "get", "head", "list", "search", "describe", "read", "fetch", "query", "count", "find",
    "lookup", "check", "view", "show", "poll", "status", "info", "ping", "health", "has", "is",
    "exists",
];

/// Tokens that mark an operation as high-risk: irreversible, monetary, outbound,
/// or credential/security sensitive.
const HIGH_RISK_TOKENS: &[&str] = &[
    // irreversible / destructive
    "delete",
    "destroy",
    "drop",
    "purge",
    "terminate",
    "wipe",
    "erase",
    "remove",
    "revoke",
    // monetary / trading
    "pay",
    "payment",
    "payout",
    "withdraw",
    "withdrawal",
    "deposit",
    "transfer",
    "remit",
    "trade",
    "order",
    "buy",
    "sell",
    "charge",
    "refund",
    "settle",
    "settlement",
    "swap",
    "mint",
    "burn",
    "bet",
    "wager",
    "stake",
    // outbound
    "send",
    "email",
    "sms",
    "notify",
    "dispatch",
    "broadcast",
    // credential / security / execution
    "credential",
    "secret",
    "password",
    "sign",
    "execute",
    "deploy",
];

fn operation_tokens(tool_name: &str) -> Vec<String> {
    tool_name
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect()
}

fn leading_verb(tool_name: &str) -> String {
    operation_tokens(tool_name)
        .into_iter()
        .next()
        .unwrap_or_default()
}

fn is_high_risk_token(token: &str) -> bool {
    if HIGH_RISK_TOKENS.contains(&token) {
        return true;
    }
    // Light singularization so plurals like "orders" / "transfers" still match.
    token.ends_with('s') && HIGH_RISK_TOKENS.contains(&&token[..token.len() - 1])
}

/// Whether the operation is a read. Reads are never high-risk: the read verb
/// gates the high-risk token scan so `get_transfers` is not mistaken for a money
/// movement.
pub fn is_read_operation(tool_name: &str) -> bool {
    READ_VERBS.contains(&leading_verb(tool_name).as_str())
}

/// Escalate operations whose verb marks them irreversible, monetary, outbound, or
/// credential-sensitive. Never fires for a read operation.
pub fn is_high_risk_operation(tool_name: &str) -> bool {
    if is_read_operation(tool_name) {
        return false;
    }
    operation_tokens(tool_name)
        .iter()
        .any(|token| is_high_risk_token(token))
}

fn matching_requirement(
    publisher_slug: &str,
    tool_name: &str,
) -> Option<&'static ApprovalRequirement> {
    // Live operationIds are literal (path parameters are call arguments), so an
    // exact match is sufficient and faithful to the renderer's classifier.
    APPROVAL_REQUIREMENTS
        .iter()
        .find(|req| req.publisher_slug == publisher_slug && req.tool_pattern == tool_name)
}

/// Classify a publisher operation by its structural verb token plus explicit
/// policy entries. Deny-safe: high-risk is decided before trusted-read, and
/// anything unrecognized stays unclassified rather than implicitly safe.
pub fn classify_operation(publisher_slug: &str, tool_name: &str) -> OperationClass {
    if matching_requirement(publisher_slug, tool_name).is_some() {
        return OperationClass::HighRisk;
    }
    if is_high_risk_operation(tool_name) {
        return OperationClass::HighRisk;
    }
    let trusted_read = (TRUSTED_READ_PUBLISHERS.contains(&publisher_slug)
        && is_read_operation(tool_name))
        || TRUSTED_READ_OPERATIONS
            .iter()
            .any(|(publisher, tool)| *publisher == publisher_slug && *tool == tool_name);
    if trusted_read {
        return OperationClass::TrustedRead;
    }
    OperationClass::Unclassified
}

/// Route-aware classification. Returns the effective class the gate acts on.
///
/// - Shell/Skill subprocess execution is always high-risk, regardless of name.
/// - Local MCP servers and open-world web fetches carry no trusted metadata, so
///   they are unclassified unless a high-risk verb escalates them.
/// - Gateway/Seren use the full publisher classifier.
fn classify_for_route(
    route: ToolRoute,
    publisher_slug: &str,
    tool_name: &str,
) -> OperationClass {
    match route {
        ToolRoute::Shell | ToolRoute::Skill => OperationClass::HighRisk,
        ToolRoute::Mcp | ToolRoute::Web => {
            if is_high_risk_operation(tool_name) {
                OperationClass::HighRisk
            } else {
                OperationClass::Unclassified
            }
        }
        ToolRoute::Gateway | ToolRoute::Seren => classify_operation(publisher_slug, tool_name),
    }
}

/// Display metadata for a prompt, host-owned so the renderer cannot fabricate a
/// less-alarming description than the classification warrants.
fn prompt_metadata(
    class: OperationClass,
    publisher_slug: &str,
    tool_name: &str,
) -> (String, bool) {
    if let Some(req) = matching_requirement(publisher_slug, tool_name) {
        return (req.description.to_string(), req.is_destructive);
    }
    match class {
        OperationClass::HighRisk => (
            format!("High-risk operation on {publisher_slug}/{tool_name}"),
            false,
        ),
        _ => (
            format!("Unclassified operation on {publisher_slug} — first use this session"),
            false,
        ),
    }
}

// ============================================================================
// Persisted decision store
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredDecision {
    Granted,
    Denied,
}

/// Managed state: a conversation-scoped, host-owned decision store. Lazily opens
/// one SQLite database that slice B's capability-lease store will extend.
pub struct ToolAuthorizationState {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl ToolAuthorizationState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            conn: Mutex::new(None),
        }
    }

    /// Open the store on first use and create the schema. Held under the same
    /// mutex as every read/write so the connection is never shared concurrently.
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.conn.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            if let Some(parent) = self.db_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
            init_schema(&conn)?;
            *guard = Some(conn);
        }
        let conn = guard
            .as_ref()
            .ok_or_else(|| "authorization store unavailable".to_string())?;
        f(conn)
    }

    fn stored_decision(
        &self,
        conversation_id: &str,
        publisher_slug: &str,
        tool_name: &str,
    ) -> Result<Option<StoredDecision>, String> {
        self.with_conn(|conn| {
            let decision: Option<String> = conn
                .query_row(
                    "SELECT decision FROM tool_decisions \
                     WHERE conversation_id = ?1 AND publisher_slug = ?2 AND tool_name = ?3",
                    rusqlite::params![conversation_id, publisher_slug, tool_name],
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            Ok(decision.and_then(|value| match value.as_str() {
                "granted" => Some(StoredDecision::Granted),
                "denied" => Some(StoredDecision::Denied),
                _ => None,
            }))
        })
    }

    fn persist_decision(
        &self,
        conversation_id: &str,
        publisher_slug: &str,
        tool_name: &str,
        decision: StoredDecision,
    ) -> Result<(), String> {
        let decision = match decision {
            StoredDecision::Granted => "granted",
            StoredDecision::Denied => "denied",
        };
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tool_decisions \
                   (conversation_id, publisher_slug, tool_name, decision, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
                 ON CONFLICT(conversation_id, publisher_slug, tool_name) \
                 DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at",
                rusqlite::params![conversation_id, publisher_slug, tool_name, decision],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// The gate: classify, evaluate any task-scoped capability lease, then fall
    /// back to the per-tool decision store.
    ///
    /// Order enforces `deny > prompt > allow`:
    /// 1. Trusted reads run silently.
    /// 2. An active lease is consulted next. A lease exclusion denies outright;
    ///    a covered call inside budget runs silently (and the budget is charged),
    ///    letting a long-running task proceed without per-call prompts. This is
    ///    what lets an otherwise one-shot high-risk shell command run under an
    ///    approved command-rule lease.
    /// 3. If no lease covers the call, the Stage-1 posture is preserved: high-risk
    ///    prompts one-shot; unclassified reuses a stored grant/denial or prompts
    ///    once for a session decision. A new host/account/root/operation class or
    ///    an exhausted budget therefore surfaces as a single scope-escalation.
    pub fn authorize(
        &self,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        conversation_id: &str,
        context: &OperationContext,
    ) -> Result<AuthorizationDecision, String> {
        let class = classify_for_route(route, publisher_slug, tool_name);

        if class == OperationClass::TrustedRead {
            return Ok(AuthorizationDecision::allow(class));
        }

        let request = OperationRequest {
            route,
            class,
            publisher_slug: publisher_slug.to_string(),
            tool_name: tool_name.to_string(),
            command: context.command.clone(),
            host: context.host.clone(),
            target: context.target.clone(),
            cost_micros: context.cost_micros.unwrap_or(0),
        };
        match self.evaluate_and_charge_leases(conversation_id, &request)? {
            LeaseOutcome::Deny => return Ok(AuthorizationDecision::deny(class)),
            LeaseOutcome::Allow(_) => return Ok(AuthorizationDecision::allow(class)),
            LeaseOutcome::Escalate => {}
        }

        if class == OperationClass::HighRisk {
            let (description, is_destructive) = prompt_metadata(class, publisher_slug, tool_name);
            return Ok(AuthorizationDecision::prompt(
                class,
                "one-shot",
                description,
                is_destructive,
            ));
        }

        // Unclassified: honor any durable conversation-scoped decision.
        match self.stored_decision(conversation_id, publisher_slug, tool_name)? {
            Some(StoredDecision::Denied) => Ok(AuthorizationDecision::deny(class)),
            Some(StoredDecision::Granted) => Ok(AuthorizationDecision::allow(class)),
            None => {
                let (description, is_destructive) =
                    prompt_metadata(class, publisher_slug, tool_name);
                Ok(AuthorizationDecision::prompt(
                    class,
                    "session",
                    description,
                    is_destructive,
                ))
            }
        }
    }

    /// Read the active leases for a conversation, evaluate the call, and — when a
    /// lease covers it — charge that lease's budget, all under one connection lock
    /// so the read/decrement is atomic and two concurrent calls cannot both spend
    /// the last unit of a budget.
    fn evaluate_and_charge_leases(
        &self,
        conversation_id: &str,
        request: &OperationRequest,
    ) -> Result<LeaseOutcome, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let leases = read_leases(conn, conversation_id)?;
            let outcome = capability_lease::evaluate_for_conversation(
                &leases,
                request,
                conversation_id,
                &now,
            );
            if let LeaseOutcome::Allow(lease_id) = &outcome
                && let Some(mut lease) = leases.into_iter().find(|lease| &lease.id == lease_id)
            {
                lease.budgets.calls_used = lease.budgets.calls_used.saturating_add(1);
                if request.cost_micros > 0 {
                    lease.budgets.spend_used_micros = lease
                        .budgets
                        .spend_used_micros
                        .saturating_add(request.cost_micros);
                }
                write_lease(conn, &lease)?;
            }
            Ok(outcome)
        })
    }

    /// Persist a user-approved lease. Called only from the host-side grant command
    /// a human approval invokes — never from a model tool call — so model output
    /// can never mint or widen a lease. The host owns the id, timestamps, and
    /// expiry; the caller supplies only the reviewed predicates, budgets, label,
    /// and requested duration.
    pub fn grant_lease(
        &self,
        conversation_id: &str,
        label: &str,
        duration_secs: i64,
        predicates: LeasePredicates,
        budgets: LeaseBudgets,
    ) -> Result<CapabilityLease, String> {
        if duration_secs <= 0 {
            return Err("A capability lease needs a positive duration.".to_string());
        }
        let lease_id = uuid::Uuid::new_v4().to_string();
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let expires_at = timestamp_plus_seconds(conn, duration_secs)?;
            let lease = CapabilityLease {
                id: lease_id.clone(),
                conversation_id: conversation_id.to_string(),
                label: label.to_string(),
                created_at: now,
                expires_at,
                revoked: false,
                predicates: predicates.clone(),
                budgets: budgets.clone(),
            };
            write_lease(conn, &lease)?;
            Ok(lease)
        })
    }

    /// Every lease bound to a conversation, newest first. Backs inspection and the
    /// (slice-D) revocation UI.
    pub fn list_leases(&self, conversation_id: &str) -> Result<Vec<CapabilityLease>, String> {
        self.with_conn(|conn| read_leases(conn, conversation_id))
    }

    /// Mark a lease revoked. Idempotent: revoking an unknown or already-revoked
    /// lease is a no-op that reports whether this call changed anything.
    ///
    /// The stored `lease_json` blob is the source of truth the matcher reads, so
    /// revocation must flip the flag *inside the blob* — updating only the
    /// `revoked` column would leave the matcher still honoring the lease.
    pub fn revoke_lease(&self, lease_id: &str) -> Result<bool, String> {
        self.with_conn(|conn| {
            let json: Option<String> = conn
                .query_row(
                    "SELECT lease_json FROM capability_leases WHERE id = ?1",
                    rusqlite::params![lease_id],
                    |row| row.get(0),
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            let Some(json) = json else {
                return Ok(false);
            };
            let mut lease: CapabilityLease = serde_json::from_str(&json)
                .map_err(|e| format!("Capability lease was unreadable: {e}"))?;
            if lease.revoked {
                return Ok(false);
            }
            lease.revoked = true;
            write_lease(conn, &lease)?;
            Ok(true)
        })
    }

    /// Record a prompt outcome. Re-derives classification host-side so a renderer
    /// cannot persist a grant for a high-risk (one-shot) or trusted-read (silent)
    /// operation — only unclassified session decisions are durable.
    pub fn record_decision(
        &self,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        conversation_id: &str,
        approved: bool,
    ) -> Result<(), String> {
        let class = classify_for_route(route, publisher_slug, tool_name);
        if class != OperationClass::Unclassified {
            return Ok(());
        }
        let decision = if approved {
            StoredDecision::Granted
        } else {
            StoredDecision::Denied
        };
        self.persist_decision(conversation_id, publisher_slug, tool_name, decision)
    }

    /// Register a suspended continuation for an authorization-blocked action, so a
    /// paused action is a visible, resumable record rather than a hung tool call
    /// (#3193-C). The host mints the `approval_id` and the unforgeable
    /// `resume_token`; the model receives only the redacted `model_result`.
    ///
    /// Dedup is built in: an equivalent, still-pending request (same conversation +
    /// capability fingerprint) reuses the existing record, so retries cannot cause a
    /// prompt/notification storm. A lapsed pending block is expired first, so a
    /// stale record never masquerades as a live dedup target.
    pub fn register_continuation(
        &self,
        conversation_id: &str,
        requested: RequestedCapability,
        scope: ContinuationScope,
        ttl_secs: i64,
    ) -> Result<RegisteredContinuation, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            approval_continuation::expire_overdue(conn, conversation_id, &now)?;
            let fingerprint = approval_continuation::fingerprint(&requested);
            if let Some(existing) = approval_continuation::find_pending_by_fingerprint(
                conn,
                conversation_id,
                &fingerprint,
                &now,
            )? {
                return Ok(existing.registered(true));
            }
            let row = ContinuationRow {
                approval_id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.to_string(),
                fingerprint,
                resume_token: uuid::Uuid::new_v4().to_string(),
                scope,
                state: ContinuationState::Pending,
                requested,
                created_at: now,
                expires_at: timestamp_plus_seconds(conn, ttl_secs.max(1))?,
                resolved_at: None,
            };
            approval_continuation::insert_continuation(conn, &row)?;
            Ok(row.registered(false))
        })
    }

    /// Resolve a suspended continuation with a human decision. Idempotent exactly
    /// once: a replayed decision reports the settled state without re-firing, and a
    /// settled continuation is never re-opened. The `resume_token` is required and
    /// checked, so a model that learns the public `approval_id` cannot self-approve.
    /// A pending row whose window has already closed expires instead of taking the
    /// decision — a stale approval never executes a destructive action after the fact.
    pub fn resolve_continuation(
        &self,
        approval_id: &str,
        resume_token: &str,
        decision: ResolveDecision,
    ) -> Result<ResolveOutcome, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let row = self.load_authorized_continuation(conn, approval_id, resume_token)?;
            if row.state != ContinuationState::Pending {
                return Ok(ResolveOutcome {
                    changed: false,
                    state: row.state,
                    task_state: row.state.task_state(row.scope),
                });
            }
            if row.expires_at.as_str() <= now.as_str() {
                let changed = approval_continuation::settle_if_pending(
                    conn,
                    approval_id,
                    ContinuationState::Expired,
                    &now,
                )?;
                return Ok(ResolveOutcome {
                    changed,
                    state: ContinuationState::Expired,
                    task_state: ContinuationState::Expired.task_state(row.scope),
                });
            }
            let new_state = decision.settled_state();
            let changed =
                approval_continuation::settle_if_pending(conn, approval_id, new_state, &now)?;
            Ok(ResolveOutcome {
                changed,
                state: new_state,
                task_state: new_state.task_state(row.scope),
            })
        })
    }

    /// Explicitly expire a suspended continuation (the renderer's approval timeout
    /// calls this), so a lapsed action becomes `approval_expired` rather than a
    /// degraded generic tool failure. Idempotent and token-gated like `resolve`.
    pub fn expire_continuation(
        &self,
        approval_id: &str,
        resume_token: &str,
    ) -> Result<ResolveOutcome, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let row = self.load_authorized_continuation(conn, approval_id, resume_token)?;
            if row.state != ContinuationState::Pending {
                return Ok(ResolveOutcome {
                    changed: false,
                    state: row.state,
                    task_state: row.state.task_state(row.scope),
                });
            }
            let changed = approval_continuation::settle_if_pending(
                conn,
                approval_id,
                ContinuationState::Expired,
                &now,
            )?;
            Ok(ResolveOutcome {
                changed,
                state: ContinuationState::Expired,
                task_state: ContinuationState::Expired.task_state(row.scope),
            })
        })
    }

    /// Fetch a continuation by id and verify the caller holds the host-minted
    /// resume token. A wrong or absent token is rejected — the model cannot forge
    /// authority to resolve a block it did not create.
    fn load_authorized_continuation(
        &self,
        conn: &Connection,
        approval_id: &str,
        resume_token: &str,
    ) -> Result<ContinuationRow, String> {
        let row = approval_continuation::find_by_id(conn, approval_id)?
            .ok_or_else(|| "Unknown approval continuation.".to_string())?;
        if row.resume_token != resume_token {
            return Err("Invalid resume token for this approval continuation.".to_string());
        }
        Ok(row)
    }

    /// The live task-execution state for a conversation, derived from its
    /// continuations. Overdue pending blocks are expired first, so a lapsed request
    /// never keeps a task spuriously `waiting_for_approval`.
    pub fn task_execution_state(
        &self,
        conversation_id: &str,
    ) -> Result<TaskExecutionState, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            approval_continuation::expire_overdue(conn, conversation_id, &now)?;
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(approval_continuation::aggregate_task_state(&rows))
        })
    }

    /// Outcome counts for a conversation, backing completion integrity
    /// (`can_complete`) and the final summary disclosure of denied/skipped/expired/
    /// unresolved work.
    pub fn resolution_summary(&self, conversation_id: &str) -> Result<ResolutionSummary, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            approval_continuation::expire_overdue(conn, conversation_id, &now)?;
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(approval_continuation::summarize(&rows))
        })
    }

    /// Every continuation for a conversation, redacted (no resume tokens), for the
    /// inspection surface. Overdue pending blocks are expired first so the listing
    /// reflects true live state.
    pub fn list_continuations(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ContinuationView>, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            approval_continuation::expire_overdue(conn, conversation_id, &now)?;
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(rows.iter().map(ContinuationRow::view).collect())
        })
    }

    /// Erase every stored decision, capability lease, and suspended continuation.
    /// Backs the one-shot "erase all local conversation data" flow; the next access
    /// lazily reopens an empty store. Returns the total number of rows removed
    /// across all tables.
    pub fn wipe(&self) -> Result<usize, String> {
        self.with_conn(|conn| {
            let decisions = conn
                .execute("DELETE FROM tool_decisions", [])
                .map_err(|e| e.to_string())?;
            let leases = conn
                .execute("DELETE FROM capability_leases", [])
                .map_err(|e| e.to_string())?;
            let continuations = conn
                .execute("DELETE FROM approval_continuations", [])
                .map_err(|e| e.to_string())?;
            Ok(decisions + leases + continuations)
        })
    }
}

/// SQLite's clock, formatted to match `created_at`/`updated_at` in the store, so
/// lease lifetime comparisons use one time source rather than mixing Rust and DB
/// clocks.
fn current_timestamp(conn: &Connection) -> Result<String, String> {
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// `now + duration_secs` in the same format. Used to stamp a lease's expiry
/// host-side from a reviewed duration.
fn timestamp_plus_seconds(conn: &Connection, duration_secs: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now', ?1)",
        rusqlite::params![format!("{duration_secs} seconds")],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn read_leases(conn: &Connection, conversation_id: &str) -> Result<Vec<CapabilityLease>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT lease_json FROM capability_leases \
             WHERE conversation_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![conversation_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    let mut leases = Vec::new();
    for row in rows {
        let json = row.map_err(|e| e.to_string())?;
        // A single corrupt row must not blind the gate to every other lease, but
        // it also must not silently vanish — log and skip.
        match serde_json::from_str::<CapabilityLease>(&json) {
            Ok(lease) => leases.push(lease),
            Err(err) => log::warn!("[tool-authorization] Skipping unreadable lease row: {err}"),
        }
    }
    Ok(leases)
}

fn write_lease(conn: &Connection, lease: &CapabilityLease) -> Result<(), String> {
    let json = serde_json::to_string(lease)
        .map_err(|e| format!("Capability lease could not be encoded: {e}"))?;
    conn.execute(
        "INSERT INTO capability_leases \
           (id, conversation_id, expires_at, revoked, lease_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(id) DO UPDATE SET \
           expires_at = excluded.expires_at, \
           revoked = excluded.revoked, \
           lease_json = excluded.lease_json",
        rusqlite::params![
            lease.id,
            lease.conversation_id,
            lease.expires_at,
            lease.revoked as i64,
            json,
            lease.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tool_decisions (
            conversation_id TEXT NOT NULL,
            publisher_slug  TEXT NOT NULL,
            tool_name       TEXT NOT NULL,
            decision        TEXT NOT NULL,
            updated_at      TEXT NOT NULL,
            PRIMARY KEY (conversation_id, publisher_slug, tool_name)
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Capability leases (#3193-B). The full lease is stored as JSON (the source
    // of truth for predicates + mutable budget counters); the columns exist only
    // to index by conversation and to prune by expiry/revocation without parsing
    // every blob.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS capability_leases (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            expires_at      TEXT NOT NULL,
            revoked         INTEGER NOT NULL DEFAULT 0,
            lease_json      TEXT NOT NULL,
            created_at      TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_capability_leases_conversation \
         ON capability_leases(conversation_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Suspended continuations (#3193-C): the host-owned blocked-action records that
    // make an authorization block visible and resumable instead of a hung tool call.
    approval_continuation::init_schema(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ToolAuthorizationState {
        // An in-memory database keeps each test isolated and needs no filesystem.
        let s = ToolAuthorizationState::new(PathBuf::from(":memory:"));
        // Force the connection open against :memory: by touching the store.
        s.with_conn(|_| Ok(())).unwrap();
        s
    }

    // No lease context: the classification/decision-store tests exercise the
    // path where no argument predicate applies.
    fn ctx() -> OperationContext {
        OperationContext::default()
    }

    fn cmd_ctx(command: &str) -> OperationContext {
        OperationContext {
            command: Some(command.to_string()),
            ..Default::default()
        }
    }

    fn target_ctx(target: &str) -> OperationContext {
        OperationContext {
            target: Some(target.to_string()),
            ..Default::default()
        }
    }

    fn command_rules(programs: &[&str]) -> LeasePredicates {
        LeasePredicates {
            command_rules: programs
                .iter()
                .map(|p| capability_lease::CommandRule {
                    program: p.to_string(),
                })
                .collect(),
            ..Default::default()
        }
    }

    fn call_budget(max: u64) -> LeaseBudgets {
        LeaseBudgets {
            max_calls: Some(max),
            ..Default::default()
        }
    }

    // ---- classification --------------------------------------------------

    #[test]
    fn gmail_reads_are_trusted() {
        for tool in [
            "get_messages",
            "get_messages_by_message_id",
            "get_threads",
            "get_labels",
            "get_profile",
            "get_health",
        ] {
            assert_eq!(
                classify_operation("gmail", tool),
                OperationClass::TrustedRead,
                "{tool} should be a trusted read"
            );
        }
    }

    #[test]
    fn gmail_permanent_deletes_and_sends_are_high_risk() {
        for tool in [
            "delete_messages_by_message_id",
            "delete_labels_by_label_id",
            "post_send",
            "post_messages_send",
            "post_drafts_by_draft_id_send",
        ] {
            assert_eq!(classify_operation("gmail", tool), OperationClass::HighRisk);
        }
    }

    #[test]
    fn gmail_reversible_writes_are_unclassified() {
        for tool in [
            "post_messages_by_message_id_trash",
            "post_messages_by_message_id_modify",
            "post_threads_by_thread_id_trash",
            "post_labels",
        ] {
            assert_eq!(
                classify_operation("gmail", tool),
                OperationClass::Unclassified
            );
        }
    }

    #[test]
    fn monetary_and_destructive_verbs_escalate_on_any_publisher() {
        assert_eq!(classify_operation("alpaca", "post_orders"), OperationClass::HighRisk);
        assert_eq!(classify_operation("some-dex", "post_swap"), OperationClass::HighRisk);
        assert_eq!(classify_operation("some-wallet", "post_transfers"), OperationClass::HighRisk);
        assert_eq!(classify_operation("some-bank", "post_withdrawals"), OperationClass::HighRisk);
        assert_eq!(classify_operation("attio", "delete_records_by_id"), OperationClass::HighRisk);
    }

    #[test]
    fn reads_never_escalate_even_with_money_shaped_nouns() {
        assert!(is_read_operation("get_transfers"));
        assert!(!is_high_risk_operation("get_transfers"));
        assert!(!is_high_risk_operation("list_orders"));
        assert!(!is_high_risk_operation("search_payments"));
    }

    #[test]
    fn unknown_publisher_reads_and_writes_stay_unclassified() {
        assert_eq!(classify_operation("attio", "get_records"), OperationClass::Unclassified);
        assert_eq!(classify_operation("attio", "post_notes"), OperationClass::Unclassified);
        assert_eq!(
            classify_operation("new-publisher", "inspect_records"),
            OperationClass::Unclassified
        );
    }

    #[test]
    fn seren_builtin_reads_stay_trusted() {
        assert_eq!(classify_operation("seren", "list_projects"), OperationClass::TrustedRead);
    }

    // ---- route-aware behavior -------------------------------------------

    #[test]
    fn shell_and_skill_are_always_high_risk() {
        assert_eq!(
            classify_for_route(ToolRoute::Shell, "seren", "execute_command"),
            OperationClass::HighRisk
        );
        // "run_skill_script" carries no high-risk verb token, but the route forces it.
        assert_eq!(
            classify_for_route(ToolRoute::Skill, "seren", "run_skill_script"),
            OperationClass::HighRisk
        );
    }

    #[test]
    fn local_mcp_never_inherits_publisher_read_trust() {
        // A local server can be named "gmail" but has no trusted metadata.
        assert_eq!(
            classify_for_route(ToolRoute::Mcp, "gmail", "get_messages"),
            OperationClass::Unclassified
        );
        // A high-risk verb still escalates a local MCP tool.
        assert_eq!(
            classify_for_route(ToolRoute::Mcp, "local", "delete_records"),
            OperationClass::HighRisk
        );
    }

    #[test]
    fn web_fetch_is_unclassified_open_world() {
        assert_eq!(
            classify_for_route(ToolRoute::Web, "seren", "web_fetch"),
            OperationClass::Unclassified
        );
    }

    // ---- gate decisions --------------------------------------------------

    #[test]
    fn trusted_read_allows_silently() {
        let s = state();
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "allow");
        assert_eq!(decision.prompt_kind, None);
    }

    #[test]
    fn high_risk_prompts_one_shot_and_never_persists() {
        let s = state();
        for _ in 0..2 {
            let decision = s
                .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a", &ctx())
                .unwrap();
            assert_eq!(decision.decision, "prompt");
            assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
            assert_eq!(decision.description, "Permanently delete email");
            assert!(decision.is_destructive);
        }
        // Even if the renderer reports an approval, a high-risk op is not durable.
        s.record_decision(
            ToolRoute::Gateway,
            "gmail",
            "delete_messages_by_message_id",
            "conv-a",
            true,
        )
        .unwrap();
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "prompt", "still one-shot after a recorded approval");
    }

    #[test]
    fn unclassified_prompts_once_then_reuses_the_grant() {
        let s = state();
        let first = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        assert_eq!(first.decision, "prompt");
        assert_eq!(first.prompt_kind.as_deref(), Some("session"));
        assert_eq!(
            first.description,
            "Unclassified operation on new-publisher — first use this session"
        );

        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", true)
            .unwrap();

        let second = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        assert_eq!(second.decision, "allow");
    }

    #[test]
    fn unclassified_denial_is_durable() {
        let s = state();
        s.authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", false)
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "deny");
    }

    #[test]
    fn decisions_are_scoped_per_conversation() {
        let s = state();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", true)
            .unwrap();
        // A different conversation does not inherit the grant.
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-b", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn a_newly_seen_publisher_is_never_silently_allowed() {
        let s = state();
        let decision = s
            .authorize(ToolRoute::Gateway, "never-seen", "inspect_everything", "conv-a", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn wipe_clears_stored_decisions() {
        let s = state();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", true)
            .unwrap();
        assert_eq!(s.wipe().unwrap(), 1);
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn route_parse_rejects_unknown_routes() {
        assert!(ToolRoute::parse("gateway").is_ok());
        assert!(ToolRoute::parse("web").is_ok());
        assert!(ToolRoute::parse("bogus").is_err());
    }

    // ---- capability-lease integration (real store + matcher + budgets) ---

    /// The headline acceptance criterion: a 500-call coding task runs under one
    /// approved lease with zero recurring prompts, and the budget is consumed.
    #[test]
    fn granted_command_lease_runs_a_500_call_task_silently() {
        let s = state();
        let lease = s
            .grant_lease(
                "conv-a",
                "coding",
                4 * 3600,
                command_rules(&["cargo", "pnpm", "git"]),
                call_budget(500),
            )
            .unwrap();

        for i in 0..500 {
            let command = match i % 3 {
                0 => "cargo test --manifest-path src-tauri/Cargo.toml",
                1 => "pnpm check",
                _ => "git status --porcelain",
            };
            let decision = s
                .authorize(
                    ToolRoute::Shell,
                    "seren",
                    "execute_command",
                    "conv-a",
                    &cmd_ctx(command),
                )
                .unwrap();
            assert_eq!(
                decision.decision, "allow",
                "call {i} ({command}) should run silently under the lease"
            );
        }

        let updated = s
            .list_leases("conv-a")
            .unwrap()
            .into_iter()
            .find(|l| l.id == lease.id)
            .unwrap();
        assert_eq!(updated.budgets.calls_used, 500);

        // The 501st call exhausts the budget: exactly one scope-escalation.
        let decision = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("cargo build"),
            )
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
    }

    /// A shell command outside the lease's command rules is not covered and
    /// escalates once, rather than silently running.
    #[test]
    fn shell_command_outside_the_lease_escalates() {
        let s = state();
        s.grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(500))
            .unwrap();
        let decision = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("curl https://example.com/pay"),
            )
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
    }

    /// deny > allow: a lease exclusion denies a command its own command rule
    /// would otherwise allow.
    #[test]
    fn lease_exclusion_denies_over_a_command_grant() {
        let s = state();
        let mut predicates = command_rules(&["git"]);
        predicates.exclusions = vec![capability_lease::Exclusion {
            program: Some("git".to_string()),
            ..Default::default()
        }];
        s.grant_lease("conv-a", "coding", 3600, predicates, call_budget(50))
            .unwrap();
        let decision = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("git push origin main"),
            )
            .unwrap();
        assert_eq!(decision.decision, "deny");
    }

    /// Repeated publisher operations inside one resource/account constraint run
    /// silently; a different account is out of scope and escalates.
    #[test]
    fn publisher_lease_covers_repeated_ops_within_one_target() {
        let s = state();
        let predicates = LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "attio".to_string(),
                allow_high_risk: false,
                target: Some("conn-123".to_string()),
            }],
            ..Default::default()
        };
        s.grant_lease("conv-a", "crm", 3600, predicates, call_budget(100))
            .unwrap();

        for tool in ["post_notes", "post_records", "patch_records_by_id"] {
            let decision = s
                .authorize(ToolRoute::Gateway, "attio", tool, "conv-a", &target_ctx("conn-123"))
                .unwrap();
            assert_eq!(decision.decision, "allow", "{tool} should be covered");
        }

        // A different connection/account is not covered — one escalation.
        let decision = s
            .authorize(ToolRoute::Gateway, "attio", "post_notes", "conv-a", &target_ctx("conn-999"))
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    /// A high-risk publisher op is not silently covered by a lease that did not
    /// opt into high-risk, even on the approved target.
    #[test]
    fn publisher_lease_without_high_risk_still_escalates_destructive_ops() {
        let s = state();
        let predicates = LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "attio".to_string(),
                allow_high_risk: false,
                target: Some("conn-123".to_string()),
            }],
            ..Default::default()
        };
        s.grant_lease("conv-a", "crm", 3600, predicates, call_budget(100))
            .unwrap();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "attio",
                "delete_records_by_id",
                "conv-a",
                &target_ctx("conn-123"),
            )
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
    }

    /// Revoking a lease immediately stops its silent coverage; revocation is
    /// idempotent.
    #[test]
    fn revoking_a_lease_stops_silent_coverage() {
        let s = state();
        let lease = s
            .grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(500))
            .unwrap();
        assert_eq!(
            s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"))
                .unwrap()
                .decision,
            "allow"
        );
        assert!(s.revoke_lease(&lease.id).unwrap());
        assert_eq!(
            s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"))
                .unwrap()
                .decision,
            "prompt"
        );
        assert!(!s.revoke_lease(&lease.id).unwrap(), "second revoke is a no-op");
    }

    /// A lease granted for one conversation never covers another.
    #[test]
    fn lease_does_not_leak_across_conversations() {
        let s = state();
        s.grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(500))
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-b", &cmd_ctx("cargo build"))
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn grant_lease_rejects_nonpositive_duration() {
        let s = state();
        assert!(
            s.grant_lease("conv-a", "x", 0, LeasePredicates::default(), LeaseBudgets::default())
                .is_err()
        );
    }

    /// A lease and its consumed budget survive the store being closed and
    /// reopened on the same on-disk database — real file I/O, no in-memory shim.
    #[test]
    fn leases_persist_across_store_reopen_on_disk() {
        let dir = std::env::temp_dir().join(format!("seren-authz-{}", uuid::Uuid::new_v4()));
        let db = dir.join("tool_authorization.db");
        {
            let s = ToolAuthorizationState::new(db.clone());
            s.grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(500))
                .unwrap();
            assert_eq!(
                s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"))
                    .unwrap()
                    .decision,
                "allow"
            );
        }
        {
            // A fresh state reopens the same file, re-inits the schema, and honors
            // the persisted lease and its already-charged budget.
            let s = ToolAuthorizationState::new(db.clone());
            let leases = s.list_leases("conv-a").unwrap();
            assert_eq!(leases.len(), 1);
            assert_eq!(leases[0].budgets.calls_used, 1, "budget spend persisted to disk");
            assert_eq!(
                s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo test"))
                    .unwrap()
                    .decision,
                "allow"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The renderer sends the operation context as camelCase; pin `costMicros`.
    #[test]
    fn operation_context_deserializes_camel_case() {
        let context: OperationContext = serde_json::from_value(serde_json::json!({
            "command": "cargo build",
            "host": "example.com",
            "target": "conn-1",
            "costMicros": 5,
        }))
        .expect("camelCase context deserializes");
        assert_eq!(context.command.as_deref(), Some("cargo build"));
        assert_eq!(context.cost_micros, Some(5));
    }

    /// The erase-all flow removes leases too, not just per-tool decisions.
    #[test]
    fn wipe_clears_capability_leases() {
        let s = state();
        s.grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(500))
            .unwrap();
        assert!(s.wipe().unwrap() >= 1);
        assert!(s.list_leases("conv-a").unwrap().is_empty());
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"))
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    /// The `:memory:` tests above prove the SQL; this proves the headline
    /// property that decisions are durable host-side. A grant recorded through
    /// one state must survive a fresh state opened against the same file — the
    /// on-disk equivalent of an app restart.
    #[test]
    fn decisions_survive_reopening_the_on_disk_store() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let db_path = dir.path().join("tool_authorization.db");

        {
            let first = ToolAuthorizationState::new(db_path.clone());
            first
                .record_decision(
                    ToolRoute::Gateway,
                    "new-publisher",
                    "inspect_records",
                    "conv-a",
                    true,
                )
                .unwrap();
        }
        assert!(db_path.exists(), "store should be written to disk");

        // A brand-new state (no shared connection) at the same path.
        let second = ToolAuthorizationState::new(db_path);
        let decision = second
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx())
            .unwrap();
        assert_eq!(
            decision.decision, "allow",
            "the recorded grant must survive reopening the store"
        );
    }

    // ---- suspended continuations (#3193-C) -------------------------------

    fn send_cap() -> RequestedCapability {
        RequestedCapability {
            route: "gateway".to_string(),
            publisher_slug: "gmail".to_string(),
            tool_name: "post_send".to_string(),
            operation_class: "high-risk".to_string(),
            description: "Send email".to_string(),
            is_destructive: false,
            command: None,
            host: None,
            target: None,
        }
    }

    fn shell_cap(command: &str) -> RequestedCapability {
        RequestedCapability {
            route: "shell".to_string(),
            publisher_slug: "seren".to_string(),
            tool_name: "execute_command".to_string(),
            operation_class: "high-risk".to_string(),
            description: "Run shell command".to_string(),
            is_destructive: false,
            command: Some(command.to_string()),
            host: None,
            target: None,
        }
    }

    /// A registered block immediately puts the task in `waiting_for_approval`, and
    /// completion integrity refuses `completed` until it is resolved. It never
    /// appears hung and the model gets a structured `approval_pending`, not a token.
    #[test]
    fn registering_a_block_suspends_the_task_and_blocks_completion() {
        let s = state();
        let registered = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(!registered.deduplicated);
        assert_eq!(registered.task_state, TaskExecutionState::WaitingForApproval);
        assert_eq!(registered.model_result["status"], "approval_pending");
        assert!(registered.model_result.get("resumeToken").is_none());
        assert!(!registered.resume_token.is_empty());

        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::WaitingForApproval
        );
        assert!(!s.resolution_summary("conv-a").unwrap().can_complete());
    }

    /// Equivalent retries reuse the same pending request — no prompt storm.
    #[test]
    fn equivalent_retries_dedup_to_one_pending_request() {
        let s = state();
        let first = s
            .register_continuation("conv-a", shell_cap("cargo build"), ContinuationScope::Linear, 300)
            .unwrap();
        // A retry of the same program (different args) reuses the record.
        let retry = s
            .register_continuation("conv-a", shell_cap("cargo test --workspace"), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(retry.deduplicated);
        assert_eq!(retry.approval_id, first.approval_id);
        assert_eq!(retry.resume_token, first.resume_token);
        assert_eq!(s.list_continuations("conv-a").unwrap().len(), 1);

        // A genuinely different capability is its own request.
        let other = s
            .register_continuation("conv-a", shell_cap("git push"), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(!other.deduplicated);
        assert_ne!(other.approval_id, first.approval_id);
        assert_eq!(s.list_continuations("conv-a").unwrap().len(), 2);
    }

    /// Approval resumes the continuation exactly once; a replayed resume is a no-op.
    #[test]
    fn resolve_is_idempotent_exactly_once() {
        let s = state();
        let r = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();

        let first = s
            .resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Approve)
            .unwrap();
        assert!(first.changed);
        assert_eq!(first.state, ContinuationState::Approved);

        // Replay: same decision, no re-fire.
        let replay = s
            .resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Approve)
            .unwrap();
        assert!(!replay.changed);
        assert_eq!(replay.state, ContinuationState::Approved);

        // A conflicting late decision cannot re-open a settled continuation.
        let late_deny = s
            .resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Deny)
            .unwrap();
        assert!(!late_deny.changed);
        assert_eq!(late_deny.state, ContinuationState::Approved);

        // Task can complete once nothing is pending.
        assert!(s.resolution_summary("conv-a").unwrap().can_complete());
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::Running
        );
    }

    /// The resume token is required: the public approval_id alone cannot resolve.
    #[test]
    fn resolve_rejects_a_forged_or_missing_token() {
        let s = state();
        let r = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(
            s.resolve_continuation(&r.approval_id, "not-the-token", ResolveDecision::Approve)
                .is_err()
        );
        // Still pending — the forged attempt changed nothing.
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::WaitingForApproval
        );
        assert!(
            s.resolve_continuation("no-such-id", &r.resume_token, ResolveDecision::Approve)
                .is_err()
        );
    }

    /// Denial, skip, and expiry are distinct terminal states — expiry is never a
    /// degraded generic failure — and all three are disclosed in the summary.
    #[test]
    fn denial_skip_and_expiry_are_distinct_and_disclosed() {
        let s = state();
        let deny = s
            .register_continuation("conv-a", shell_cap("git push"), ContinuationScope::Linear, 300)
            .unwrap();
        assert_eq!(
            s.resolve_continuation(&deny.approval_id, &deny.resume_token, ResolveDecision::Deny)
                .unwrap()
                .task_state,
            TaskExecutionState::ApprovalDenied
        );

        let skip = s
            .register_continuation("conv-a", shell_cap("cargo build"), ContinuationScope::Linear, 300)
            .unwrap();
        assert_eq!(
            s.resolve_continuation(&skip.approval_id, &skip.resume_token, ResolveDecision::Skip)
                .unwrap()
                .task_state,
            TaskExecutionState::ActionSkipped
        );

        let expire = s
            .register_continuation("conv-a", shell_cap("pnpm check"), ContinuationScope::Linear, 300)
            .unwrap();
        let outcome = s
            .expire_continuation(&expire.approval_id, &expire.resume_token)
            .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.task_state, TaskExecutionState::ApprovalExpired);
        // Re-expiring is idempotent.
        assert!(
            !s.expire_continuation(&expire.approval_id, &expire.resume_token)
                .unwrap()
                .changed
        );

        let summary = s.resolution_summary("conv-a").unwrap();
        assert_eq!(summary.denied, 1);
        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.expired, 1);
        assert_eq!(summary.unresolved, 0);
        assert!(summary.can_complete());
        assert!(summary.has_disclosable());
    }

    /// An expired block no longer holds the task and is not a dedup target for a
    /// fresh request; expiry is explicit, not a lingering `waiting_for_approval`.
    #[test]
    fn an_expired_block_releases_the_task_and_is_not_a_dedup_target() {
        let s = state();
        let r = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        let outcome = s
            .expire_continuation(&r.approval_id, &r.resume_token)
            .unwrap();
        assert_eq!(outcome.state, ContinuationState::Expired);
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::Running,
            "an expired block no longer holds the task"
        );
        // A fresh request after expiry is not deduped against the dead one.
        let fresh = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(!fresh.deduplicated);
        assert_ne!(fresh.approval_id, r.approval_id);
    }

    /// An independent branch block keeps the task running-with-blocked-actions,
    /// not fully waiting.
    #[test]
    fn a_branch_block_keeps_other_work_running() {
        let s = state();
        s.register_continuation("conv-a", send_cap(), ContinuationScope::Branch, 300)
            .unwrap();
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::RunningWithBlockedActions
        );
        // Completion is still blocked while the branch action is unresolved.
        assert!(!s.resolution_summary("conv-a").unwrap().can_complete());
    }

    /// A pending continuation and its resolution survive the store being closed and
    /// reopened on a real on-disk database — resolve remains idempotent afterward.
    #[test]
    fn continuations_persist_across_store_reopen_on_disk() {
        let dir = std::env::temp_dir().join(format!("seren-continuation-{}", uuid::Uuid::new_v4()));
        let db = dir.join("tool_authorization.db");
        let (approval_id, resume_token) = {
            let s = ToolAuthorizationState::new(db.clone());
            let r = s
                .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
                .unwrap();
            (r.approval_id, r.resume_token)
        };
        {
            // A fresh state reopens the same file and still sees the pending block.
            let s = ToolAuthorizationState::new(db.clone());
            assert_eq!(
                s.task_execution_state("conv-a").unwrap(),
                TaskExecutionState::WaitingForApproval
            );
            let outcome = s
                .resolve_continuation(&approval_id, &resume_token, ResolveDecision::Approve)
                .unwrap();
            assert!(outcome.changed);
            // Replay after reopen is still a no-op.
            assert!(
                !s.resolve_continuation(&approval_id, &resume_token, ResolveDecision::Approve)
                    .unwrap()
                    .changed
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wipe_clears_continuations() {
        let s = state();
        s.register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        assert!(s.wipe().unwrap() >= 1);
        assert!(s.list_continuations("conv-a").unwrap().is_empty());
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::Running
        );
    }
}
