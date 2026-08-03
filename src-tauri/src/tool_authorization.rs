// ABOUTME: Host-owned authorization gate for every model-originated tool call.
// ABOUTME: Owns classification and a persisted, conversation-scoped decision store; the renderer only displays and dispatches.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::approval_continuation::{
    self, CompletionSettlement, ContinuationRow, ContinuationScope, ContinuationState,
    ContinuationView, RegisteredContinuation, RequestedCapability, ResolutionSummary,
    ResolveDecision, ResolveOutcome, TaskStateSnapshot,
};
use crate::authorization_audit::{self, AuditContext, AuditEntry, AuditEvent};
use crate::capability_lease::{
    self, CapabilityLease, LeaseBudgets, LeaseOutcome, LeasePredicates, OperationRequest,
    SpendOutcome,
};
use crate::orchestrator::types::TaskExecutionState;
use crate::standing_policy::{self, StandingPolicy, StandingPolicyInput};

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
    /// Host-minted dispatch handle, present only on "allow" (#3193-F). The
    /// transports refuse to execute without it; the renderer can only ferry it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    /// Opaque host-computed operation binding, present on "prompt" so the
    /// renderer can echo it into the suspended continuation. Tampering with it
    /// yields a handle that no transport will accept (fail-closed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
}

impl AuthorizationDecision {
    fn allow(class: OperationClass, handle: Option<String>) -> Self {
        Self {
            decision: "allow".to_string(),
            prompt_kind: None,
            operation_class: class.as_wire().to_string(),
            description: String::new(),
            is_destructive: false,
            handle,
            binding: None,
        }
    }

    fn deny(class: OperationClass) -> Self {
        Self {
            decision: "deny".to_string(),
            prompt_kind: None,
            operation_class: class.as_wire().to_string(),
            description: String::new(),
            is_destructive: false,
            handle: None,
            binding: None,
        }
    }

    fn prompt(
        class: OperationClass,
        kind: &str,
        description: String,
        is_destructive: bool,
        binding: Option<String>,
    ) -> Self {
        Self {
            decision: "prompt".to_string(),
            prompt_kind: Some(kind.to_string()),
            operation_class: class.as_wire().to_string(),
            description,
            is_destructive,
            handle: None,
            binding,
        }
    }
}

/// The host's verdict on reserving a call's realized monetary cost against its
/// covering lease (#3193-G). Returned to the renderer at the x402 payment gate
/// *before* any payment is signed. `outcome` is authoritative:
/// - `"charged"` — the cost was decremented from the covering lease's budget and
///   persisted; `reservation_id` settles it once the payment resolves.
/// - `"escalate"` — a lease covers the call but cannot absorb this spend (over
///   budget / mismatched asset); the caller must surface an explicit approval
///   instead of silently paying.
/// - `"uncovered"` — no lease covers the call; the caller uses its own payment
///   gate exactly as before this wiring existed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendReservation {
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reservation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettledGatewayCharge {
    pub micros: u64,
    pub asset: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct GatewaySettlementReceipt {
    pub receipt_id: String,
    pub status: String,
    pub charged_micros: Option<u64>,
    pub asset: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchRedemption {
    lease_id: Option<String>,
}

impl SpendReservation {
    fn charged(reservation_id: String) -> Self {
        Self {
            outcome: "charged".to_string(),
            reservation_id: Some(reservation_id),
        }
    }

    fn escalate() -> Self {
        Self {
            outcome: "escalate".to_string(),
            reservation_id: None,
        }
    }

    fn uncovered() -> Self {
        Self {
            outcome: "uncovered".to_string(),
            reservation_id: None,
        }
    }
}

// ============================================================================
// Dispatch handles (#3193-F) — the enforcement seam that makes the gate
// non-bypassable. Every side-effecting transport command refuses to execute
// without a live handle minted by this store for that exact operation, so a
// renderer path that skips the gate cannot reach a transport.
// ============================================================================

/// How long a minted handle stays redeemable. Long enough for the x402 payment
/// UI round-trip between the first dispatch and its retry; short enough that a
/// leaked handle is not a standing capability.
const DISPATCH_HANDLE_TTL_SECS: i64 = 300;

/// How long a spend reservation stays reconcilable before it is swept as stale.
/// A reserve→settle round-trip closes within one payment approval window
/// (minutes); an hour is comfortably beyond that, so only reservations orphaned
/// by a crash are ever pruned — and their charge is left standing, never released.
const SPEND_RESERVATION_TTL_SECS: i64 = 3600;

/// An unresolved Core receipt eventually revokes its bound lease instead of
/// leaving an operation silently undercounted or blocking the task forever.
const SETTLEMENT_PENDING_TTL_SECS: i64 = 86_400;

/// Every handle authorizes one dispatch. A payment challenge can mint one new
/// handle only after its receipt has passed the local budget gate.
fn handle_uses_for_route(_route: ToolRoute) -> i64 {
    1
}

/// Gateway metadata keys excluded from the operation binding: they are added,
/// moved, or stripped between the gate consultation and the wire dispatch
/// (account selection, payment retries) without changing which operation the
/// user authorized.
const BINDING_EXCLUDED_KEYS: &[&str] = &["_x402_payment", "connection_id"];

fn binding_digest(material: &str) -> String {
    hex::encode(Sha256::digest(material.as_bytes()))
}

/// serde_json (without `preserve_order`) stores objects as BTreeMaps, so
/// serializing a `Value` is already key-sorted and canonical for our purposes.
/// Both the mint side and the verify side normalize with this same function, so
/// no cross-language canonicalization is involved.
fn normalized_args_json(args: &serde_json::Value) -> String {
    match args {
        serde_json::Value::Object(map) => {
            let filtered: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .filter(|(key, _)| !BINDING_EXCLUDED_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            serde_json::Value::Object(filtered).to_string()
        }
        other => other.to_string(),
    }
}

/// Operation binding for the publisher-style routes (gateway, built-in seren,
/// local MCP): the exact normalized tool arguments.
pub fn binding_for_publisher_args(args: &serde_json::Value) -> String {
    binding_digest(&format!("args\u{0}{}", normalized_args_json(args)))
}

/// Operation binding for shell execution: the exact command line.
pub fn binding_for_command(command: &str) -> String {
    binding_digest(&format!("cmd\u{0}{command}"))
}

/// Operation binding for a skill script: the skill identity plus its exact argv
/// (kept as an array so `["a", "b c"]` and `["a", "b", "c"]` stay distinct).
pub fn binding_for_skill(skill_slug: &str, argv: &[String]) -> String {
    let material = serde_json::json!({ "argv": argv, "skillSlug": skill_slug });
    binding_digest(&format!("skill\u{0}{material}"))
}

/// Operation binding for a web fetch: the exact URL.
pub fn binding_for_url(url: &str) -> String {
    binding_digest(&format!("url\u{0}{url}"))
}

/// Compute the binding for a call at gate time from the renderer-supplied
/// argument payload. `None` means the material needed to bind this route was
/// not provided — no handle can be minted, and the dispatch will be refused.
fn binding_for_operation(
    route: ToolRoute,
    context: &OperationContext,
    call_args: Option<&serde_json::Value>,
) -> Option<String> {
    match route {
        ToolRoute::Shell => context.command.as_deref().map(binding_for_command),
        ToolRoute::Skill => {
            let args = call_args?;
            let skill_slug = args.get("skill_slug")?.as_str()?;
            let argv: Vec<String> = args
                .get("argv")?
                .as_array()?
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect::<Option<Vec<String>>>()?;
            Some(binding_for_skill(skill_slug, &argv))
        }
        ToolRoute::Web => {
            let url = call_args?.get("url")?.as_str()?;
            Some(binding_for_url(url))
        }
        ToolRoute::Gateway | ToolRoute::Seren | ToolRoute::Mcp => {
            call_args.map(binding_for_publisher_args)
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
        publisher_slug: "seren",
        tool_pattern: "create_publisher",
        description: "Create a publisher definition",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "seren",
        tool_pattern: "update_publisher",
        description: "Update a publisher definition",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "seren",
        tool_pattern: "update_publisher_pricing",
        description: "Update publisher pricing",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "seren",
        tool_pattern: "create_org_oauth_provider",
        description: "Create an organization OAuth provider",
        is_destructive: false,
    },
    ApprovalRequirement {
        publisher_slug: "seren",
        tool_pattern: "update_org_oauth_provider",
        description: "Update an organization OAuth provider",
        is_destructive: false,
    },
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
    // Gateway catalog discovery (#3193-F): pure metadata reads the app performs
    // at connect time. They ride the same enforced MCP transport as model
    // dispatch, so they authorize through the gate like everything else.
    ("seren", "list_agent_publishers"),
    ("seren", "get_agent_publisher"),
    ("seren", "list_mcp_tools"),
    ("seren", "list_organizations"),
    ("seren", "list_user_oauth_providers"),
    ("seren", "list_user_oauth_connections"),
    ("seren", "list_org_oauth_providers"),
    ("seren", "get_org_oauth_provider"),
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
            // Zero freed pages so wiped lease/audit/decision rows (tool names,
            // conversation ids) do not linger in the file's free list after an
            // erase-all wipe (#3348), matching the chat databases.
            conn.execute_batch("PRAGMA secure_delete = ON;")
                .map_err(|e| e.to_string())?;
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
        call_args: Option<&serde_json::Value>,
    ) -> Result<AuthorizationDecision, String> {
        let class = classify_for_route(route, publisher_slug, tool_name);
        let binding = binding_for_operation(route, context, call_args);

        if route == ToolRoute::Gateway
            && self.with_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS (
                        SELECT 1
                        FROM gateway_settlement_receipts receipt
                        JOIN capability_leases lease ON lease.id = receipt.lease_id
                        WHERE receipt.state = 'pending'
                          AND lease.conversation_id = ?1
                    )",
                    rusqlite::params![conversation_id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|e| e.to_string())
            })?
        {
            return Err(
                "A previous publisher charge is still settling. Retry after reconciliation."
                    .to_string(),
            );
        }

        if class == OperationClass::TrustedRead {
            let handle =
                self.mint_handle(conversation_id, route, publisher_slug, tool_name, &binding, None)?;
            return Ok(AuthorizationDecision::allow(class, handle));
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
            LeaseOutcome::Allow(lease_id) => {
                let handle = self.mint_handle(
                    conversation_id,
                    route,
                    publisher_slug,
                    tool_name,
                    &binding,
                    Some(&lease_id),
                )?;
                return Ok(AuthorizationDecision::allow(class, handle));
            }
            LeaseOutcome::Escalate => {}
        }

        // No active lease covers this call. Before escalating (which, with no
        // human present, would only time out and stall the task), consult the
        // owner-defined standing policies (#3193-E): a matching enabled policy
        // deterministically auto-materializes a bounded, conversation-scoped
        // lease from the same predicates + budgets a human grant produces — no
        // UI, no prompt. The call then runs silently under that lease exactly as
        // it would under a human-granted one. Out-of-policy work still falls
        // through to the escalation below.
        //
        // Re-evaluate the lease set unconditionally after the materialize attempt
        // (#3296): a concurrent first-call for the same conversation may have
        // already minted the covering lease, in which case this call's
        // `try_materialize` returns `None` (its per-conversation+policy idempotency
        // guard correctly refuses a second lease) yet a covering lease now exists.
        // Gating the re-check on `try_materialize` returning `Some` would then
        // spuriously prompt the loser of that race; re-checking regardless lets it
        // run silently under the sibling's lease.
        self.try_materialize_standing_policy(conversation_id, &request)?;
        if let LeaseOutcome::Allow(lease_id) =
            self.evaluate_and_charge_leases(conversation_id, &request)?
        {
            let handle = self.mint_handle(
                conversation_id,
                route,
                publisher_slug,
                tool_name,
                &binding,
                Some(&lease_id),
            )?;
            return Ok(AuthorizationDecision::allow(class, handle));
        }

        if class == OperationClass::HighRisk {
            let (description, is_destructive) = prompt_metadata(class, publisher_slug, tool_name);
            return Ok(AuthorizationDecision::prompt(
                class,
                "one-shot",
                description,
                is_destructive,
                binding,
            ));
        }

        // Unclassified: honor any durable conversation-scoped decision.
        match self.stored_decision(conversation_id, publisher_slug, tool_name)? {
            Some(StoredDecision::Denied) => Ok(AuthorizationDecision::deny(class)),
            Some(StoredDecision::Granted) => {
                let handle = self.mint_handle(
                    conversation_id,
                    route,
                    publisher_slug,
                    tool_name,
                    &binding,
                    None,
                )?;
                Ok(AuthorizationDecision::allow(class, handle))
            }
            None => {
                let (description, is_destructive) =
                    prompt_metadata(class, publisher_slug, tool_name);
                Ok(AuthorizationDecision::prompt(
                    class,
                    "session",
                    description,
                    is_destructive,
                    binding,
                ))
            }
        }
    }

    /// Mint a dispatch handle for an allowed operation. Returns `None` (allow
    /// without a redeemable handle — the dispatch will be refused) when the
    /// caller supplied no binding material for the route: an unbindable allow
    /// must fail closed at the transport, never widen into "any args".
    fn mint_handle(
        &self,
        conversation_id: &str,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        binding: &Option<String>,
        lease_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        let Some(binding) = binding else {
            return Ok(None);
        };
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            mint_dispatch_handle(
                conn,
                conversation_id,
                route,
                publisher_slug,
                tool_name,
                binding,
                lease_id,
                &now,
            )
            .map(Some)
        })
    }

    /// Verify and redeem a dispatch handle for the exact operation a transport
    /// is about to execute. Fail-closed on every mismatch: unknown or expired
    /// handle, spent handle, wrong route/publisher/tool, wrong argument binding,
    /// or a lease-bound handle whose lease has since been revoked or lapsed.
    ///
    /// Runs entirely under the store's single connection lock, so the check and
    /// the redemption are atomic — two racing dispatches cannot both spend the
    /// last use of a handle.
    pub fn consume_dispatch_handle(
        &self,
        handle_id: &str,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        binding: &str,
    ) -> Result<DispatchRedemption, String> {
        const REFUSED: &str =
            "Dispatch refused: no valid host authorization for this operation.";
        if handle_id.trim().is_empty() {
            return Err(REFUSED.to_string());
        }
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let row: Option<(String, String, String, String, Option<String>, i64, String)> = conn
                .query_row(
                    "SELECT route, publisher_slug, tool_name, binding, lease_id, \
                            uses_remaining, expires_at \
                     FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![handle_id],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    },
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            let Some((
                stored_route,
                stored_publisher,
                stored_tool,
                stored_binding,
                lease_id,
                uses_remaining,
                expires_at,
            )) = row
            else {
                return Err(REFUSED.to_string());
            };
            if uses_remaining <= 0
                || expires_at.as_str() <= now.as_str()
                || stored_route != route.as_wire()
                || stored_publisher != publisher_slug
                || stored_tool != tool_name
                || stored_binding != binding
            {
                return Err(REFUSED.to_string());
            }
            // A lease-bound handle is only as alive as its lease: revocation or
            // expiry between authorize and dispatch must stop the dispatch.
            if let Some(lease_id) = lease_id.as_deref() {
                let lease_json: Option<String> = conn
                    .query_row(
                        "SELECT lease_json FROM capability_leases WHERE id = ?1",
                        rusqlite::params![lease_id],
                        |r| r.get(0),
                    )
                    .map(Some)
                    .or_else(|err| match err {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        other => Err(other.to_string()),
                    })?;
                let live = lease_json
                    .and_then(|json| serde_json::from_str::<CapabilityLease>(&json).ok())
                    .map(|lease| !lease.revoked && lease.expires_at.as_str() > now.as_str())
                    .unwrap_or(false);
                if !live {
                    return Err(REFUSED.to_string());
                }
            }
            conn.execute(
                "UPDATE dispatch_handles SET uses_remaining = uses_remaining - 1 WHERE id = ?1",
                rusqlite::params![handle_id],
            )
            .map_err(|e| e.to_string())?;
            // A Gateway response may settle on its final allowed dispatch. Keep
            // that row until terminal completion records its lease charge.
            conn.execute(
                "DELETE FROM dispatch_handles \
                 WHERE (uses_remaining <= 0 AND route != 'gateway') OR expires_at <= ?1",
                rusqlite::params![now],
            )
            .map_err(|e| e.to_string())?;
            Ok(DispatchRedemption { lease_id })
        })
    }

    /// Mint the single retry authorization for a payment challenge. The quote
    /// receipt must already be recorded, so a retry cannot precede local budget
    /// accounting.
    pub fn renew_gateway_dispatch_handle(
        &self,
        exhausted_handle_id: &str,
        receipt_id: &str,
    ) -> Result<String, String> {
        const REFUSED: &str =
            "Dispatch refused: no valid host authorization for this payment retry.";
        let receipt_id = uuid::Uuid::parse_str(receipt_id)
            .map_err(|_| REFUSED.to_string())?
            .to_string();
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let now = current_timestamp(&transaction)?;
            let handle: Option<(
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                i64,
                String,
            )> = transaction
                .query_row(
                    "SELECT conversation_id, route, publisher_slug, tool_name, binding, \
                            lease_id, uses_remaining, expires_at \
                     FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![exhausted_handle_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                            row.get(7)?,
                        ))
                    },
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            let Some((
                conversation_id,
                route,
                publisher_slug,
                tool_name,
                binding,
                lease_id,
                uses_remaining,
                expires_at,
            )) = handle
            else {
                return Err(REFUSED.to_string());
            };
            let receipt: Option<(String, String, bool)> = transaction
                .query_row(
                    "SELECT initial_handle_id, state, retry_minted \
                     FROM gateway_settlement_receipts WHERE receipt_id = ?1",
                    rusqlite::params![&receipt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            let Some((initial_handle_id, receipt_state, retry_minted)) = receipt else {
                return Err(REFUSED.to_string());
            };
            if route != ToolRoute::Gateway.as_wire()
                || uses_remaining != 0
                || expires_at.as_str() <= now.as_str()
                || receipt_state != "pending"
                || retry_minted
                || initial_handle_id != exhausted_handle_id
            {
                return Err(REFUSED.to_string());
            }

            let retry_handle_id = uuid::Uuid::new_v4().to_string();
            let updated = transaction
                .execute(
                    "UPDATE gateway_settlement_receipts \
                     SET retry_minted = 1, retry_handle_id = ?2, updated_at = ?3 \
                     WHERE receipt_id = ?1 AND retry_minted = 0",
                    rusqlite::params![&receipt_id, &retry_handle_id, &now],
                )
                .map_err(|e| e.to_string())?;
            if updated != 1 {
                return Err(REFUSED.to_string());
            }
            transaction
                .execute(
                    "INSERT INTO dispatch_handles \
                       (id, conversation_id, route, publisher_slug, tool_name, binding, \
                        lease_id, uses_remaining, expires_at, created_at) \
                     VALUES (?1, ?2, 'gateway', ?3, ?4, ?5, ?6, 1, ?7, ?8)",
                    rusqlite::params![
                        &retry_handle_id,
                        conversation_id,
                        publisher_slug,
                        tool_name,
                        binding,
                        lease_id,
                        expires_at,
                        &now
                    ],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "DELETE FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![exhausted_handle_id],
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(retry_handle_id)
        })
    }

    /// Complete a successful gateway dispatch and record trusted settlement
    /// metadata against the exact lease that minted its handle.
    pub fn complete_gateway_dispatch(
        &self,
        handle_id: &str,
        receipt_id: Option<&str>,
        charge: Option<&SettledGatewayCharge>,
        redemption: &DispatchRedemption,
    ) -> Result<(), String> {
        if handle_id.trim().is_empty() {
            return Ok(());
        }
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;

            if let Some(receipt_id) = receipt_id {
                record_gateway_settlement(
                    &transaction,
                    receipt_id,
                    handle_id,
                    redemption.lease_id.as_deref(),
                    charge,
                )?;
            } else if let Some(charge) = charge {
                if let Some(lease_id) = redemption.lease_id.as_deref() {
                    revoke_lease_for_untracked_gateway_charge(&transaction, lease_id, charge)?;
                } else {
                    log::warn!(
                        "[tool-authorization] Ignored gateway charge {} {} without a settlement receipt or bound lease",
                        charge.micros,
                        charge.asset,
                    );
                }
            }

            transaction
                .execute(
                    "DELETE FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![handle_id],
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// Apply an authoritative Core receipt exactly once. A pending receipt
    /// remains durable until Core reports a terminal state.
    pub fn reconcile_gateway_settlement(
        &self,
        receipt: &GatewaySettlementReceipt,
    ) -> Result<(), String> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let row: Option<(String, bool, Option<String>, Option<i64>)> = transaction
                .query_row(
                    "SELECT state, locally_accounted, lease_id, charged_micros \
                     FROM gateway_settlement_receipts WHERE receipt_id = ?1",
                    rusqlite::params![receipt.receipt_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map(Some)
                .or_else(|err| match err {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other.to_string()),
                })?;
            let Some((state, locally_accounted, lease_id, charged_micros)) = row else {
                return Ok(());
            };
            if state != "pending" {
                return Ok(());
            }

            match receipt.status.as_str() {
                "pending" => return Ok(()),
                "paid" | "refunded" => {
                    let charge = SettledGatewayCharge {
                        micros: receipt.charged_micros.ok_or_else(|| {
                            "Settled receipt did not include a charged amount.".to_string()
                        })?,
                        asset: receipt.asset.clone(),
                    };
                    if !locally_accounted
                        && let Some(lease_id) = lease_id.as_deref()
                    {
                        apply_gateway_charge(&transaction, lease_id, &charge)?;
                    }
                    transaction
                        .execute(
                            "UPDATE gateway_settlement_receipts \
                             SET state = 'accounted', charged_micros = ?2, asset = ?3, \
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                             WHERE receipt_id = ?1 AND state = 'pending'",
                            rusqlite::params![
                                receipt.receipt_id,
                                i64::try_from(charge.micros)
                                    .map_err(|_| "Settled cost exceeds local storage range.")?,
                                charge.asset
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                }
                "expired" | "cancelled" => {
                    if locally_accounted
                        && let (Some(lease_id), Some(charged_micros)) =
                            (lease_id.as_deref(), charged_micros)
                        && let Some(mut lease) = read_lease(&transaction, lease_id)?
                    {
                        lease.budgets.release_spend(
                            u64::try_from(charged_micros)
                                .map_err(|_| "Stored settled cost is invalid.")?,
                        );
                        write_lease(&transaction, &lease)?;
                    }
                    transaction
                        .execute(
                            "UPDATE gateway_settlement_receipts \
                             SET state = 'cancelled', charged_micros = 0, asset = ?2, \
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                             WHERE receipt_id = ?1 AND state = 'pending'",
                            rusqlite::params![receipt.receipt_id, receipt.asset],
                        )
                        .map_err(|e| e.to_string())?;
                }
                _ => return Err("Core returned an unknown settlement status.".to_string()),
            }

            transaction.commit().map_err(|e| e.to_string())
        })
    }

    pub fn pending_gateway_settlement_receipts(&self) -> Result<Vec<String>, String> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let stale_before =
                timestamp_plus_seconds(&transaction, -SETTLEMENT_PENDING_TTL_SECS)?;
            let stale_rows = {
                let mut statement = transaction
                    .prepare(
                        "SELECT receipt_id, lease_id \
                         FROM gateway_settlement_receipts \
                         WHERE state = 'pending' AND created_at <= ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = statement
                    .query_map(rusqlite::params![stale_before], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                    })
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            for (_, lease_id) in &stale_rows {
                if let Some(lease_id) = lease_id
                    && let Some(mut lease) = read_lease(&transaction, lease_id)?
                    && !lease.revoked
                {
                    lease.revoked = true;
                    write_lease(&transaction, &lease)?;
                    let now = current_timestamp(&transaction)?;
                    audit(
                        &transaction,
                        &lease.conversation_id,
                        AuditEvent::LeaseRevoked,
                        &AuditContext::for_lease(&lease),
                        &now,
                    );
                }
            }
            if !stale_rows.is_empty() {
                transaction
                    .execute(
                        "UPDATE gateway_settlement_receipts \
                         SET state = 'cancelled', \
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                         WHERE state = 'pending' AND created_at <= ?1",
                        rusqlite::params![stale_before],
                    )
                    .map_err(|e| e.to_string())?;
            }

            let receipt_ids = {
                let mut statement = transaction
                .prepare(
                    "SELECT receipt_id FROM gateway_settlement_receipts \
                     WHERE state = 'pending' ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
                let rows = statement
                    .query_map([], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<String>, _>>()
                    .map_err(|e| e.to_string())?
            };
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(receipt_ids)
        })
    }

    /// Test-only mint so transport-level tests can exercise the real
    /// verify/consume path without driving a full approval flow.
    #[cfg(test)]
    pub fn mint_dispatch_handle_for_test(
        &self,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        binding: &str,
    ) -> Result<String, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            mint_dispatch_handle(
                conn,
                "test-conversation",
                route,
                publisher_slug,
                tool_name,
                binding,
                None,
                &now,
            )
        })
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
            record_lease_expiries_audited(conn, conversation_id, &now);
            let leases = read_leases(conn, conversation_id)?;
            let outcome = capability_lease::evaluate_for_conversation(
                &leases,
                request,
                conversation_id,
                &now,
            );
            match &outcome {
                LeaseOutcome::Allow(lease_id) => {
                    if let Some(mut lease) =
                        leases.into_iter().find(|lease| &lease.id == lease_id)
                    {
                        lease.budgets.calls_used = lease.budgets.calls_used.saturating_add(1);
                        if request.cost_micros > 0 {
                            lease.budgets.spend_used_micros = lease
                                .budgets
                                .spend_used_micros
                                .saturating_add(request.cost_micros);
                        }
                        // Rate window: increment the in-window count while the
                        // window is open, or open a fresh one for this call once it
                        // has closed (the admit check already allowed it).
                        if let Some(window_secs) = lease.budgets.window_secs {
                            let window_open = lease
                                .budgets
                                .window_ends_at
                                .as_deref()
                                .is_some_and(|end| now.as_str() < end);
                            if window_open {
                                lease.budgets.calls_in_window =
                                    lease.budgets.calls_in_window.saturating_add(1);
                            } else {
                                lease.budgets.window_ends_at =
                                    Some(timestamp_plus_seconds(conn, window_secs.max(1))?);
                                lease.budgets.calls_in_window = 1;
                            }
                        }
                        write_lease(conn, &lease)?;
                        audit(
                            conn,
                            conversation_id,
                            AuditEvent::LeaseUsed,
                            &AuditContext::for_request(request, Some(lease_id)),
                            &now,
                        );
                    }
                }
                LeaseOutcome::Deny => audit(
                    conn,
                    conversation_id,
                    AuditEvent::LeaseDenied,
                    &AuditContext::for_request(request, None),
                    &now,
                ),
                // An escalation is audited when its continuation is registered,
                // not here — the gate may escalate without a prompt ever showing.
                LeaseOutcome::Escalate => {}
            }
            Ok(outcome)
        })
    }

    /// Reserve a call's *realized* monetary cost against the lease that covers it
    /// (#3193-G). Called at the x402 payment gate once the 402 reveals the real
    /// price, before any payment is signed. Charging the reservation (decrementing
    /// `spend_used_micros`) and recording it happen under one connection lock, so
    /// two concurrent priced calls cannot both slip past the last of a budget.
    ///
    /// The call has already cleared the gate, so this weighs only the *monetary*
    /// budget (via `admits_spend`), never the call budget — re-charging a call
    /// slot here would double-count, and the last call of a call-metered lease
    /// would spuriously fail. `cost_micros` must be > 0; a free call never reaches
    /// a 402 and must not consume a reservation.
    pub fn reserve_lease_spend(
        &self,
        exhausted_handle_id: &str,
        publisher_slug: &str,
        tool_name: &str,
        conversation_id: &str,
        context: &OperationContext,
        receipt_id: &str,
        asset: &str,
        cost_micros: u64,
    ) -> Result<SpendReservation, String> {
        if cost_micros == 0 {
            // A zero cost is free: nothing to reserve, nothing to escalate.
            return Ok(SpendReservation::uncovered());
        }
        let receipt_id = uuid::Uuid::parse_str(receipt_id)
            .map_err(|_| "Payment quote did not include a valid settlement receipt.".to_string())?
            .to_string();
        let route = ToolRoute::Gateway;
        let class = classify_for_route(route, publisher_slug, tool_name);
        let request = OperationRequest {
            route,
            class,
            publisher_slug: publisher_slug.to_string(),
            tool_name: tool_name.to_string(),
            command: context.command.clone(),
            host: context.host.clone(),
            target: context.target.clone(),
            cost_micros,
        };
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let now = current_timestamp(&transaction)?;
            record_lease_expiries_audited(&transaction, conversation_id, &now);
            let handle_matches: bool = transaction
                .query_row(
                    "SELECT EXISTS (
                        SELECT 1 FROM dispatch_handles
                        WHERE id = ?1
                          AND conversation_id = ?2
                          AND route = 'gateway'
                          AND publisher_slug = ?3
                          AND tool_name = ?4
                          AND uses_remaining = 0
                          AND expires_at > ?5
                    )",
                    rusqlite::params![
                        exhausted_handle_id,
                        conversation_id,
                        publisher_slug,
                        tool_name,
                        now
                    ],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !handle_matches {
                return Err(
                    "Payment quote is not bound to the completed gateway dispatch.".to_string(),
                );
            }
            let leases = read_leases(&transaction, conversation_id)?;
            let receipt_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS (
                        SELECT 1 FROM gateway_settlement_receipts
                        WHERE receipt_id = ?1
                    )",
                    rusqlite::params![&receipt_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if receipt_exists {
                return Err("Payment quote has already been reserved locally.".to_string());
            }
            let outcome = match capability_lease::spend_for_conversation(
                &leases,
                &request,
                asset,
                cost_micros,
                conversation_id,
                &now,
            ) {
                SpendOutcome::Charge(lease_id) => {
                    // The matcher already proved this lease admits the spend; the
                    // `find` cannot miss unless a lease vanished mid-lock (it
                    // cannot — we hold the only connection), so a miss is a safe
                    // fall-through to "uncovered" rather than a charge on nothing.
                    let Some(mut lease) = leases.into_iter().find(|l| l.id == lease_id) else {
                        return Ok(SpendReservation::uncovered());
                    };
                    lease.budgets.charge_spend(cost_micros);
                    write_lease(&transaction, &lease)?;
                    transaction
                        .execute(
                            "INSERT INTO gateway_settlement_receipts \
                               (receipt_id, initial_handle_id, lease_id, state, \
                                locally_accounted, retry_minted, charged_micros, asset, \
                                created_at, updated_at) \
                             VALUES (?1, ?2, ?3, 'pending', 1, 0, ?4, ?5, ?6, ?6)",
                            rusqlite::params![
                                &receipt_id,
                                exhausted_handle_id,
                                lease_id,
                                i64::try_from(cost_micros)
                                    .map_err(|_| "Quoted cost exceeds local storage range.")?,
                                asset,
                                now
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    let reservation_id = uuid::Uuid::new_v4().to_string();
                    insert_spend_reservation(
                        &transaction,
                        &reservation_id,
                        &receipt_id,
                        conversation_id,
                        &lease_id,
                        cost_micros,
                        asset,
                        &now,
                    )?;
                    SpendReservation::charged(reservation_id)
                }
                SpendOutcome::Escalate => SpendReservation::escalate(),
                SpendOutcome::Uncovered => SpendReservation::uncovered(),
            };
            if outcome.outcome != "charged" {
                transaction
                    .execute(
                        "INSERT INTO gateway_settlement_receipts \
                           (receipt_id, initial_handle_id, lease_id, state, \
                            locally_accounted, retry_minted, charged_micros, asset, \
                            created_at, updated_at) \
                         VALUES (?1, ?2, NULL, 'pending', 0, 0, ?3, ?4, ?5, ?5)",
                        rusqlite::params![
                            &receipt_id,
                            exhausted_handle_id,
                            i64::try_from(cost_micros)
                                .map_err(|_| "Quoted cost exceeds local storage range.")?,
                            asset,
                            now
                        ],
                    )
                    .map_err(|e| e.to_string())?;
            }
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(outcome)
        })
    }

    /// Settle a reservation once its payment resolves (#3193-G). `settled_micros`
    /// is the amount actually paid: `None` means the payment never completed, so
    /// the whole reservation is released back to the budget; `Some(amount)`
    /// reconciles the lease's spend from the reserved estimate to the true settled
    /// amount (releasing the over-reserved portion, or charging the shortfall).
    /// Idempotent: an unknown or already-settled reservation is a no-op, so a
    /// retried settle never double-releases.
    pub fn settle_lease_spend(
        &self,
        reservation_id: &str,
        settled_micros: Option<u64>,
    ) -> Result<(), String> {
        self.with_conn(|conn| {
            let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let Some((lease_id, reserved, receipt_id, asset)) =
                take_spend_reservation(&transaction, reservation_id)?
            else {
                return Ok(());
            };
            let settled = settled_micros.unwrap_or(0);
            if settled != reserved
                && let Some(mut lease) = read_lease(&transaction, &lease_id)?
            {
                if settled < reserved {
                    lease.budgets.release_spend(reserved - settled);
                } else {
                    lease.budgets.charge_spend(settled - reserved);
                }
                write_lease(&transaction, &lease)?;
            }
            if settled_micros.is_some() {
                transaction.execute(
                    "UPDATE gateway_settlement_receipts \
                     SET charged_micros = ?2, asset = ?3, \
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                     WHERE receipt_id = ?1 AND state = 'pending'",
                    rusqlite::params![
                        receipt_id,
                        i64::try_from(settled)
                            .map_err(|_| "Settled cost exceeds local storage range.")?,
                        asset
                    ],
                )
                .map_err(|e| e.to_string())?;
            } else {
                transaction.execute(
                    "UPDATE gateway_settlement_receipts \
                     SET state = 'cancelled', charged_micros = 0, \
                         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
                     WHERE receipt_id = ?1 AND state = 'pending'",
                    rusqlite::params![receipt_id],
                )
                .map_err(|e| e.to_string())?;
            }
            transaction.commit().map_err(|e| e.to_string())
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
                created_at: now.clone(),
                expires_at,
                revoked: false,
                // A human-granted lease has no source policy.
                source_policy_id: None,
                predicates: predicates.clone(),
                budgets: budgets.clone(),
            };
            write_lease(conn, &lease)?;
            audit(
                conn,
                conversation_id,
                AuditEvent::LeaseGranted,
                &AuditContext::for_lease(&lease),
                &now,
            );
            Ok(lease)
        })
    }

    /// Every lease bound to a conversation, newest first. Backs inspection and the
    /// (slice-D) revocation UI.
    pub fn list_leases(&self, conversation_id: &str) -> Result<Vec<CapabilityLease>, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            record_lease_expiries_audited(conn, conversation_id, &now);
            read_leases(conn, conversation_id)
        })
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
            let now = current_timestamp(conn)?;
            audit(
                conn,
                &lease.conversation_id,
                AuditEvent::LeaseRevoked,
                &AuditContext::for_lease(&lease),
                &now,
            );
            Ok(true)
        })
    }

    /// Consult the owner-defined standing policies and, if one matches, mint the
    /// bounded conversation-scoped lease it pre-authorizes (#3193-E). Returns the
    /// materialized lease, or `None` when nothing matches (the caller then
    /// escalates exactly as before).
    ///
    /// Everything runs under one connection lock, so two racing first-calls for a
    /// conversation cannot both mint a lease from the same policy. Guardrails:
    /// - Only **enabled** policies are considered — disabling one stops all future
    ///   auto-grants at once.
    /// - A policy that already produced a lease for this conversation is skipped,
    ///   even if that lease is now exhausted, expired, or revoked. This is what
    ///   makes an out-of-budget or expired auto-lease re-escalate instead of
    ///   silently regranting itself on the next call.
    /// - Coverage is decided by the *same* deterministic matcher a human lease
    ///   uses (`evaluate_for_conversation` on the candidate). A policy can only
    ///   pre-authorize *within* its predicates + budgets: a high-risk, priced, or
    ///   out-of-scope call that the policy does not cover yields no lease, so it
    ///   still escalates to a one-shot approval.
    fn try_materialize_standing_policy(
        &self,
        conversation_id: &str,
        request: &OperationRequest,
    ) -> Result<Option<CapabilityLease>, String> {
        self.with_conn(|conn| {
            let policies = read_standing_policies(conn)?;
            if policies.iter().all(|policy| !policy.enabled) {
                return Ok(None);
            }
            let now = current_timestamp(conn)?;
            let existing = read_leases(conn, conversation_id)?;
            let already: std::collections::HashSet<String> = existing
                .iter()
                .filter_map(|lease| lease.source_policy_id.clone())
                .collect();

            for policy in policies.iter().filter(|policy| policy.enabled) {
                if already.contains(&policy.id) {
                    continue;
                }
                let lease_id = uuid::Uuid::new_v4().to_string();
                let expires_at = timestamp_plus_seconds(conn, policy.max_duration_secs.max(1))?;
                let candidate = standing_policy::candidate_lease(
                    policy,
                    conversation_id,
                    &lease_id,
                    &now,
                    &expires_at,
                );
                // The candidate is evaluated with the exact matcher a granted
                // lease is, so a policy can never authorize a call its predicates
                // + budgets do not already cover.
                if let LeaseOutcome::Allow(_) = capability_lease::evaluate_for_conversation(
                    std::slice::from_ref(&candidate),
                    request,
                    conversation_id,
                    &now,
                ) {
                    write_lease(conn, &candidate)?;
                    audit(
                        conn,
                        conversation_id,
                        AuditEvent::LeaseAutoGranted,
                        &AuditContext::for_auto_lease(&candidate, &policy.id),
                        &now,
                    );
                    return Ok(Some(candidate));
                }
            }
            Ok(None)
        })
    }

    /// Every standing policy, newest first, for the owner settings surface.
    pub fn list_standing_policies(&self) -> Result<Vec<StandingPolicy>, String> {
        self.with_conn(read_standing_policies)
    }

    /// Persist a new owner-authored standing policy. Invoked only by the settings
    /// command an owner drives — never from a model tool call — so model output
    /// can never create or widen a standing policy. The host owns the id and
    /// timestamps; the caller supplies only the reviewed envelope.
    pub fn create_standing_policy(
        &self,
        input: StandingPolicyInput,
    ) -> Result<StandingPolicy, String> {
        if input.label.trim().is_empty() {
            return Err("A standing policy needs a label.".to_string());
        }
        if input.max_duration_secs <= 0 {
            return Err("A standing policy needs a positive lease duration.".to_string());
        }
        let policy_id = uuid::Uuid::new_v4().to_string();
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let policy = StandingPolicy {
                id: policy_id.clone(),
                label: input.label.clone(),
                enabled: input.enabled,
                max_duration_secs: input.max_duration_secs,
                predicates: input.predicates.clone(),
                budgets: input.budgets.clone(),
                created_at: now.clone(),
                updated_at: now,
            };
            write_standing_policy(conn, &policy)?;
            Ok(policy)
        })
    }

    /// Update an existing standing policy in place (edit its envelope, or toggle
    /// `enabled`). Owner-only, like `create_standing_policy`. Returns the updated
    /// policy, or `None` if the id is unknown. Disabling a policy here stops every
    /// future auto-grant from it; leases it already materialized are unaffected
    /// (revoke those separately).
    pub fn update_standing_policy(
        &self,
        policy_id: &str,
        input: StandingPolicyInput,
    ) -> Result<Option<StandingPolicy>, String> {
        if input.label.trim().is_empty() {
            return Err("A standing policy needs a label.".to_string());
        }
        if input.max_duration_secs <= 0 {
            return Err("A standing policy needs a positive lease duration.".to_string());
        }
        self.with_conn(|conn| {
            let Some(existing) = read_standing_policy(conn, policy_id)? else {
                return Ok(None);
            };
            let now = current_timestamp(conn)?;
            let policy = StandingPolicy {
                id: existing.id,
                label: input.label.clone(),
                enabled: input.enabled,
                max_duration_secs: input.max_duration_secs,
                predicates: input.predicates.clone(),
                budgets: input.budgets.clone(),
                created_at: existing.created_at,
                updated_at: now,
            };
            write_standing_policy(conn, &policy)?;
            Ok(Some(policy))
        })
    }

    /// Delete a standing policy. Owner-only. Idempotent — returns whether a policy
    /// was actually removed. Future auto-grants from it stop immediately; any
    /// lease it already materialized lives out its own expiry unless revoked.
    pub fn delete_standing_policy(&self, policy_id: &str) -> Result<bool, String> {
        self.with_conn(|conn| {
            let removed = conn
                .execute(
                    "DELETE FROM standing_policies WHERE id = ?1",
                    rusqlite::params![policy_id],
                )
                .map_err(|e| e.to_string())?;
            Ok(removed > 0)
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
        self.persist_decision(conversation_id, publisher_slug, tool_name, decision)?;
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let event = if approved {
                AuditEvent::DecisionGranted
            } else {
                AuditEvent::DecisionDenied
            };
            audit(
                conn,
                conversation_id,
                event,
                &AuditContext::for_decision(route, publisher_slug, tool_name),
                &now,
            );
            Ok(())
        })
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
            expire_overdue_audited(conn, conversation_id, &now);
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
                created_at: now.clone(),
                expires_at: timestamp_plus_seconds(conn, ttl_secs.max(1))?,
                resolved_at: None,
                disclosed_at: None,
            };
            approval_continuation::insert_continuation(conn, &row)?;
            // A deduped retry reuses the pending record above and is deliberately
            // not re-audited — one suspended request, one audit row.
            audit(
                conn,
                conversation_id,
                AuditEvent::ApprovalRequested,
                &audit_context_for_row(&row),
                &now,
            );
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
                    dispatch_handle: None,
                });
            }
            if row.expires_at.as_str() <= now.as_str() {
                let changed = approval_continuation::settle_if_pending(
                    conn,
                    approval_id,
                    ContinuationState::Expired,
                    &now,
                )?;
                if changed {
                    audit(
                        conn,
                        &row.conversation_id,
                        AuditEvent::ApprovalExpired,
                        &audit_context_for_row(&row),
                        &now,
                    );
                }
                return Ok(ResolveOutcome {
                    changed,
                    state: ContinuationState::Expired,
                    task_state: ContinuationState::Expired.task_state(row.scope),
                    dispatch_handle: None,
                });
            }
            let new_state = decision.settled_state();
            let changed =
                approval_continuation::settle_if_pending(conn, approval_id, new_state, &now)?;
            if changed {
                let event = match new_state {
                    ContinuationState::Approved => AuditEvent::ApprovalApproved,
                    ContinuationState::Denied => AuditEvent::ApprovalDenied,
                    ContinuationState::Skipped => AuditEvent::ApprovalSkipped,
                    // settled_state never yields these; keep the mapping total.
                    ContinuationState::Pending | ContinuationState::Expired => {
                        AuditEvent::ApprovalExpired
                    }
                };
                audit(
                    conn,
                    &row.conversation_id,
                    event,
                    &audit_context_for_row(&row),
                    &now,
                );
            }
            // A pending→approved settle is the post-approval mint point (#3193-F):
            // the handle is bound to the continuation's registered operation, so a
            // resolver cannot redeem an approval for different work. Idempotent
            // replays and already-settled rows never mint — resolving is not a
            // handle faucet.
            let dispatch_handle = if changed && new_state == ContinuationState::Approved {
                mint_handle_for_capability(conn, &row, &now)?
            } else {
                None
            };
            Ok(ResolveOutcome {
                changed,
                state: new_state,
                task_state: new_state.task_state(row.scope),
                dispatch_handle,
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
                    dispatch_handle: None,
                });
            }
            let changed = approval_continuation::settle_if_pending(
                conn,
                approval_id,
                ContinuationState::Expired,
                &now,
            )?;
            if changed {
                audit(
                    conn,
                    &row.conversation_id,
                    AuditEvent::ApprovalExpired,
                    &audit_context_for_row(&row),
                    &now,
                );
            }
            Ok(ResolveOutcome {
                changed,
                state: ContinuationState::Expired,
                task_state: ContinuationState::Expired.task_state(row.scope),
                dispatch_handle: None,
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
            expire_overdue_audited(conn, conversation_id, &now);
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(approval_continuation::aggregate_task_state(&rows))
        })
    }

    /// The host's authoritative live state and outcome counts for a conversation in
    /// one consistent read. This is what the host broadcasts on every gate
    /// suspend/settle so the frontend converges without polling; combining the
    /// aggregate state and the summary under a single connection lock guarantees
    /// they describe the same instant. Overdue pending blocks are expired first, so
    /// a lapsed request never keeps a task spuriously `waiting_for_approval`.
    pub fn task_state_snapshot(
        &self,
        conversation_id: &str,
    ) -> Result<TaskStateSnapshot, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            expire_overdue_audited(conn, conversation_id, &now);
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(TaskStateSnapshot {
                conversation_id: conversation_id.to_string(),
                state: approval_continuation::aggregate_task_state(&rows),
                summary: approval_continuation::summarize(&rows),
            })
        })
    }

    /// The conversation that owns a continuation, or `None` if unknown. Host-internal
    /// (no resume token): the settle commands look this up so they can broadcast the
    /// affected conversation's new task state without the renderer having to name it.
    pub fn conversation_for_approval(
        &self,
        approval_id: &str,
    ) -> Result<Option<String>, String> {
        self.with_conn(|conn| {
            Ok(approval_continuation::find_by_id(conn, approval_id)?
                .map(|row| row.conversation_id))
        })
    }

    /// Outcome counts for a conversation, backing completion integrity
    /// (`can_complete`) and the final summary disclosure of denied/skipped/expired/
    /// unresolved work.
    pub fn resolution_summary(&self, conversation_id: &str) -> Result<ResolutionSummary, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            expire_overdue_audited(conn, conversation_id, &now);
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(approval_continuation::summarize(&rows))
        })
    }

    /// Host-owned completion settlement (#3193-C, completion integrity): drive a
    /// conversation's still-pending approvals to a terminal state at task
    /// completion, so a completed task can never carry an unresolved required
    /// approval. Because a worker blocks on its own linear approval before it can
    /// emit a completion (the tool call awaits the host result), any block still
    /// pending here is an orphan no continuation will resume; expiring it (audited)
    /// makes `unresolved == 0` hold at completion without hard-blocking the
    /// completion event — which would recreate the very hung agent this ticket
    /// exists to prevent — and records an expiry, never a denial, so a later
    /// re-attempt re-prompts. Returns the count expired by this call plus the
    /// resulting outcome counts, so the caller can disclose the lapsed work.
    pub fn settle_conversation_on_completion(
        &self,
        conversation_id: &str,
    ) -> Result<CompletionSettlement, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let expired = approval_continuation::expire_pending_for_conversation(
                conn,
                conversation_id,
                &now,
            )?;
            for row in &expired {
                audit(
                    conn,
                    &row.conversation_id,
                    AuditEvent::ApprovalExpired,
                    &audit_context_for_row(row),
                    &now,
                );
            }
            // Roll every settled-but-undisclosed lapse (the orphans just expired,
            // plus any denials/skips/expiries from this turn) into the final
            // summary, exactly once.
            let disclosed =
                approval_continuation::disclose_settled(conn, conversation_id, &now)?;
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(CompletionSettlement {
                newly_expired: expired.len(),
                disclosed,
                summary: approval_continuation::summarize(&rows),
            })
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
            expire_overdue_audited(conn, conversation_id, &now);
            let rows = approval_continuation::read_continuations(conn, conversation_id)?;
            Ok(rows.iter().map(ContinuationRow::view).collect())
        })
    }

    /// Every live pending continuation across all conversations, oldest first —
    /// the global approval inbox. Overdue rows are expired (and audited) first so
    /// the inbox never shows a lapsed request as actionable.
    pub fn list_pending_continuations_all(&self) -> Result<Vec<ContinuationView>, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            match approval_continuation::expire_overdue_all(conn, &now) {
                Ok(expired) => {
                    for row in &expired {
                        audit(
                            conn,
                            &row.conversation_id,
                            AuditEvent::ApprovalExpired,
                            &audit_context_for_row(row),
                            &now,
                        );
                    }
                }
                Err(err) => {
                    log::warn!("[tool-authorization] Failed to expire overdue approvals: {err}")
                }
            }
            let rows = approval_continuation::read_pending_all(conn)?;
            Ok(rows.iter().map(ContinuationRow::view).collect())
        })
    }

    /// Expire every pending continuation across all conversations, host-authoritative
    /// (no resume token, like the TTL sweep in `list_pending_continuations_all`).
    /// Called when the renderer is lost to a reload: the single webview that held
    /// every host-minted resume token is gone, so a surviving pending block can
    /// never be settled from the new page. Expiring it clears the stale
    /// `waiting_for_approval` state at once instead of leaving it dangling until its
    /// TTL. Fail-safe — it only revokes a pending approval opportunity, never grants
    /// authority, and records an expiry (not a denial), so a later re-attempt
    /// re-prompts. Each lapse is audited (#3193-D). Returns the distinct conversation
    /// ids it affected so the caller can broadcast each task's new (unblocked) state,
    /// clearing a stale `waiting_for_approval` at once instead of at the next poll.
    pub fn expire_all_pending_continuations(&self) -> Result<Vec<String>, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            let expired = approval_continuation::expire_all_pending(conn, &now)?;
            for row in &expired {
                audit(
                    conn,
                    &row.conversation_id,
                    AuditEvent::ApprovalExpired,
                    &audit_context_for_row(row),
                    &now,
                );
            }
            let mut conversations: Vec<String> =
                expired.into_iter().map(|row| row.conversation_id).collect();
            conversations.sort();
            conversations.dedup();
            Ok(conversations)
        })
    }

    /// The newest audit rows for a conversation (lease lifecycle, approval
    /// outcomes, durable decisions). Lease expiries are refreshed first so an
    /// expired-but-unobserved lease still shows its expiry event.
    pub fn list_audit(&self, conversation_id: &str, limit: u32) -> Result<Vec<AuditEntry>, String> {
        self.with_conn(|conn| {
            let now = current_timestamp(conn)?;
            record_lease_expiries_audited(conn, conversation_id, &now);
            expire_overdue_audited(conn, conversation_id, &now);
            authorization_audit::read_entries(conn, conversation_id, limit)
        })
    }

    /// Erase every stored decision, capability lease, standing policy, suspended
    /// continuation, and audit row. Backs the one-shot "erase all local
    /// conversation data" flow; the next access lazily reopens an empty store.
    /// Standing policies are cleared too, so a full wipe never leaves a standing
    /// pre-authorization silently minting leases afterward. Returns the total
    /// number of rows removed across all tables.
    pub fn wipe(&self) -> Result<usize, String> {
        self.with_conn(|conn| {
            let decisions = conn
                .execute("DELETE FROM tool_decisions", [])
                .map_err(|e| e.to_string())?;
            let leases = conn
                .execute("DELETE FROM capability_leases", [])
                .map_err(|e| e.to_string())?;
            let policies = conn
                .execute("DELETE FROM standing_policies", [])
                .map_err(|e| e.to_string())?;
            let continuations = conn
                .execute("DELETE FROM approval_continuations", [])
                .map_err(|e| e.to_string())?;
            let audit_rows = conn
                .execute("DELETE FROM authorization_audit", [])
                .map_err(|e| e.to_string())?;
            let handles = conn
                .execute("DELETE FROM dispatch_handles", [])
                .map_err(|e| e.to_string())?;
            let reservations = conn
                .execute("DELETE FROM spend_reservations", [])
                .map_err(|e| e.to_string())?;
            let settlement_receipts = conn
                .execute("DELETE FROM gateway_settlement_receipts", [])
                .map_err(|e| e.to_string())?;
            // Reclaim and zero the freed pages so no wiped authorization data
            // survives in the file after an erase-all (#3348).
            conn.execute_batch("VACUUM;").map_err(|e| e.to_string())?;
            Ok(
                decisions
                    + leases
                    + policies
                    + continuations
                    + audit_rows
                    + handles
                    + reservations
                    + settlement_receipts,
            )
        })
    }
}

/// Insert one dispatch-handle row and return its host-minted id. Expired rows
/// are swept opportunistically so the table stays bounded by live traffic.
#[allow(clippy::too_many_arguments)]
fn mint_dispatch_handle(
    conn: &Connection,
    conversation_id: &str,
    route: ToolRoute,
    publisher_slug: &str,
    tool_name: &str,
    binding: &str,
    lease_id: Option<&str>,
    now: &str,
) -> Result<String, String> {
    conn.execute(
        "DELETE FROM dispatch_handles WHERE expires_at <= ?1",
        rusqlite::params![now],
    )
    .map_err(|e| e.to_string())?;
    let handle_id = uuid::Uuid::new_v4().to_string();
    let expires_at = timestamp_plus_seconds(conn, DISPATCH_HANDLE_TTL_SECS)?;
    conn.execute(
        "INSERT INTO dispatch_handles \
           (id, conversation_id, route, publisher_slug, tool_name, binding, \
            lease_id, uses_remaining, expires_at, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            handle_id,
            conversation_id,
            route.as_wire(),
            publisher_slug,
            tool_name,
            binding,
            lease_id,
            handle_uses_for_route(route),
            expires_at,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(handle_id)
}

/// Mint the post-approval handle for a resolved continuation, bound to the
/// capability that was registered when the gate blocked the call. A capability
/// registered without a binding cannot mint — the dispatch fails closed rather
/// than run unbound.
fn mint_handle_for_capability(
    conn: &Connection,
    row: &ContinuationRow,
    now: &str,
) -> Result<Option<String>, String> {
    let Ok(route) = ToolRoute::parse(&row.requested.route) else {
        return Ok(None);
    };
    let Some(binding) = row.requested.binding.as_deref() else {
        return Ok(None);
    };
    mint_dispatch_handle(
        conn,
        &row.conversation_id,
        route,
        &row.requested.publisher_slug,
        &row.requested.tool_name,
        binding,
        None,
        now,
    )
    .map(Some)
}

/// Append one audit row, logging (never failing) on error: the audit trail lives
/// in the same database as the state it describes, so the only failure modes are
/// store-wide ones — and an authorization decision that was already persisted
/// must not be un-done by a failed audit insert.
fn audit(
    conn: &Connection,
    conversation_id: &str,
    event: AuditEvent,
    context: &AuditContext,
    now: &str,
) {
    if let Err(err) = authorization_audit::record(conn, conversation_id, event, context, now) {
        log::warn!(
            "[tool-authorization] Failed to record audit event {}: {err}",
            event.as_wire()
        );
    }
}

/// The audit identity of a continuation: ids and route/operation only. The full
/// capability (including any command text) stays in the continuation record —
/// the audit trail does not duplicate it.
fn audit_context_for_row(row: &ContinuationRow) -> AuditContext {
    AuditContext::for_approval(
        &row.approval_id,
        &row.requested.route,
        &row.requested.publisher_slug,
        &row.requested.tool_name,
    )
}

/// Expire a conversation's overdue pending continuations and audit each lapse.
/// Log-and-continue: a read path must not fail because expiry bookkeeping did.
fn expire_overdue_audited(conn: &Connection, conversation_id: &str, now: &str) {
    match approval_continuation::expire_overdue(conn, conversation_id, now) {
        Ok(expired) => {
            for row in &expired {
                audit(
                    conn,
                    &row.conversation_id,
                    AuditEvent::ApprovalExpired,
                    &audit_context_for_row(row),
                    now,
                );
            }
        }
        Err(err) => log::warn!("[tool-authorization] Failed to expire overdue approvals: {err}"),
    }
}

/// Record `lease_expired` audit rows for newly lapsed leases. Log-and-continue on
/// the same rationale as `audit`.
fn record_lease_expiries_audited(conn: &Connection, conversation_id: &str, now: &str) {
    if let Err(err) = authorization_audit::record_lease_expiries(conn, conversation_id, now) {
        log::warn!("[tool-authorization] Failed to record lease expiries: {err}");
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

/// One live capability lease by id, or `None` if it is unknown or unreadable.
/// A settlement reconciles the exact lease its reservation charged, so it reads
/// by id rather than re-running the conversation matcher.
fn read_lease(conn: &Connection, lease_id: &str) -> Result<Option<CapabilityLease>, String> {
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
    Ok(json.and_then(|json| serde_json::from_str::<CapabilityLease>(&json).ok()))
}

/// Every standing policy, newest first. A single corrupt row is logged and
/// skipped rather than blinding the resolver to the rest.
fn read_standing_policies(conn: &Connection) -> Result<Vec<StandingPolicy>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT policy_json FROM standing_policies ORDER BY created_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut policies = Vec::new();
    for row in rows {
        let json = row.map_err(|e| e.to_string())?;
        match serde_json::from_str::<StandingPolicy>(&json) {
            Ok(policy) => policies.push(policy),
            Err(err) => {
                log::warn!("[tool-authorization] Skipping unreadable standing policy row: {err}")
            }
        }
    }
    Ok(policies)
}

/// One standing policy by id, or `None` if unknown or unreadable.
fn read_standing_policy(conn: &Connection, policy_id: &str) -> Result<Option<StandingPolicy>, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT policy_json FROM standing_policies WHERE id = ?1",
            rusqlite::params![policy_id],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    Ok(json.and_then(|json| serde_json::from_str::<StandingPolicy>(&json).ok()))
}

/// Insert or replace a standing policy. The JSON blob is the source of truth;
/// `enabled` is mirrored to a column only so the resolver can cheaply skip
/// disabled policies without parsing every blob.
fn write_standing_policy(conn: &Connection, policy: &StandingPolicy) -> Result<(), String> {
    let json = serde_json::to_string(policy)
        .map_err(|e| format!("Standing policy could not be encoded: {e}"))?;
    conn.execute(
        "INSERT INTO standing_policies \
           (id, enabled, policy_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET \
           enabled = excluded.enabled, \
           policy_json = excluded.policy_json, \
           updated_at = excluded.updated_at",
        rusqlite::params![
            policy.id,
            policy.enabled as i64,
            json,
            policy.created_at,
            policy.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record a live spend reservation so a later settle reconciles against the
/// host-owned reserved amount rather than a renderer-supplied one. Stale rows
/// (older than the sweep window) are pruned opportunistically so a crash between
/// reserve and settle cannot grow the table without bound — the already-persisted
/// charge stays (a conservative over-charge, never a silent release).
fn insert_spend_reservation(
    conn: &Connection,
    reservation_id: &str,
    receipt_id: &str,
    conversation_id: &str,
    lease_id: &str,
    reserved_micros: u64,
    asset: &str,
    now: &str,
) -> Result<(), String> {
    let cutoff = timestamp_plus_seconds(conn, -SPEND_RESERVATION_TTL_SECS)?;
    conn.execute(
        "DELETE FROM spend_reservations WHERE created_at <= ?1",
        rusqlite::params![cutoff],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO spend_reservations \
           (id, receipt_id, conversation_id, lease_id, reserved_micros, asset, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            reservation_id,
            receipt_id,
            conversation_id,
            lease_id,
            reserved_micros as i64,
            asset,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Load and remove a reservation atomically (under the store lock), returning its
/// lease id and reserved amount. `None` if the reservation is unknown or already
/// settled — the source of settle's idempotency.
fn take_spend_reservation(
    conn: &Connection,
    reservation_id: &str,
) -> Result<Option<(String, u64, String, String)>, String> {
    let row: Option<(String, i64, String, String)> = conn
        .query_row(
            "SELECT lease_id, reserved_micros, receipt_id, asset \
             FROM spend_reservations WHERE id = ?1",
            rusqlite::params![reservation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })?;
    let Some((lease_id, reserved, receipt_id, asset)) = row else {
        return Ok(None);
    };
    conn.execute(
        "DELETE FROM spend_reservations WHERE id = ?1",
        rusqlite::params![reservation_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some((
        lease_id,
        reserved.max(0) as u64,
        receipt_id,
        asset,
    )))
}

fn apply_gateway_charge(
    conn: &Connection,
    lease_id: &str,
    charge: &SettledGatewayCharge,
) -> Result<(), String> {
    if charge.micros == 0 {
        return Ok(());
    }
    let Some(mut lease) = read_lease(conn, lease_id)? else {
        return Ok(());
    };
    let asset_matches = lease
        .budgets
        .asset
        .as_deref()
        .map(|expected| expected.eq_ignore_ascii_case(&charge.asset))
        .unwrap_or(true);
    if asset_matches {
        lease.budgets.charge_spend(charge.micros);
        write_lease(conn, &lease)?;
    } else {
        // The amount cannot be converted into the lease asset safely. Revoke
        // the lease so later calls cannot spend against an undercounted budget.
        lease.revoked = true;
        write_lease(conn, &lease)?;
        let now = current_timestamp(conn)?;
        audit(
            conn,
            &lease.conversation_id,
            AuditEvent::LeaseRevoked,
            &AuditContext::for_lease(&lease),
            &now,
        );
        log::warn!(
            "[tool-authorization] Revoked lease {} after settled gateway charge asset {} did not match {}",
            lease_id,
            charge.asset,
            lease.budgets.asset.as_deref().unwrap_or("unknown"),
        );
    }
    Ok(())
}

fn revoke_lease_for_untracked_gateway_charge(
    conn: &Connection,
    lease_id: &str,
    charge: &SettledGatewayCharge,
) -> Result<(), String> {
    let Some(mut lease) = read_lease(conn, lease_id)? else {
        log::warn!(
            "[tool-authorization] Ignored gateway charge {} {} without a settlement receipt because lease {} was unavailable",
            charge.micros,
            charge.asset,
            lease_id,
        );
        return Ok(());
    };
    if !lease.revoked {
        lease.revoked = true;
        write_lease(conn, &lease)?;
        let now = current_timestamp(conn)?;
        audit(
            conn,
            &lease.conversation_id,
            AuditEvent::LeaseRevoked,
            &AuditContext::for_lease(&lease),
            &now,
        );
    }
    log::warn!(
        "[tool-authorization] Revoked lease {} after a gateway charge {} {} arrived without a settlement receipt",
        lease_id,
        charge.micros,
        charge.asset,
    );
    Ok(())
}

fn record_gateway_settlement(
    conn: &Connection,
    receipt_id: &str,
    handle_id: &str,
    lease_id: Option<&str>,
    charge: Option<&SettledGatewayCharge>,
) -> Result<(), String> {
    let receipt_id = uuid::Uuid::parse_str(receipt_id)
        .map_err(|_| "Core returned an invalid settlement receipt ID.".to_string())?
        .to_string();
    let now = current_timestamp(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO gateway_settlement_receipts \
           (receipt_id, initial_handle_id, lease_id, state, locally_accounted, \
            created_at, updated_at) \
         VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4)",
        rusqlite::params![receipt_id, handle_id, lease_id, now],
    )
    .map_err(|e| e.to_string())?;

    let (initial_handle_id, retry_handle_id, state, locally_accounted): (
        String,
        Option<String>,
        String,
        bool,
    ) = conn
        .query_row(
            "SELECT initial_handle_id, retry_handle_id, state, locally_accounted \
             FROM gateway_settlement_receipts WHERE receipt_id = ?1",
            rusqlite::params![receipt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    if initial_handle_id != handle_id && retry_handle_id.as_deref() != Some(handle_id) {
        return Err("Settlement receipt does not match this gateway dispatch.".to_string());
    }
    if state != "pending" {
        return Ok(());
    }

    if let Some(charge) = charge {
        if !locally_accounted
            && let Some(lease_id) = lease_id
        {
            apply_gateway_charge(conn, lease_id, charge)?;
        }
        conn.execute(
            "UPDATE gateway_settlement_receipts \
             SET state = 'accounted', charged_micros = ?2, asset = ?3, updated_at = ?4 \
             WHERE receipt_id = ?1 AND state = 'pending'",
            rusqlite::params![
                receipt_id,
                i64::try_from(charge.micros)
                    .map_err(|_| "Settled cost exceeds local storage range.")?,
                charge.asset,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    } else if locally_accounted {
        conn.execute(
            "UPDATE gateway_settlement_receipts \
             SET state = 'accounted', updated_at = ?2 \
             WHERE receipt_id = ?1 AND state = 'pending'",
            rusqlite::params![receipt_id, now],
        )
        .map_err(|e| e.to_string())?;
    }
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
    // Standing policies (#3193-E): owner-defined, **non-conversation-scoped**
    // pre-authorizations that auto-materialize a bounded lease for a matching
    // task at start. The full policy (predicates + budgets + duration) lives in
    // the JSON blob; the `enabled` column exists only so the resolver can skip
    // disabled policies without parsing every blob.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS standing_policies (
            id          TEXT PRIMARY KEY,
            enabled     INTEGER NOT NULL DEFAULT 1,
            policy_json TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Dispatch handles (#3193-F): host-minted, short-lived proofs of a gate
    // decision that every side-effecting transport requires before executing.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dispatch_handles (
            id              TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            route           TEXT NOT NULL,
            publisher_slug  TEXT NOT NULL,
            tool_name       TEXT NOT NULL,
            binding         TEXT NOT NULL,
            lease_id        TEXT,
            uses_remaining  INTEGER NOT NULL,
            expires_at      TEXT NOT NULL,
            created_at      TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Spend reservations (#3193-G): a live reserve-to-settle record so the realized
    // cost charged at the x402 payment gate is reconciled against a host-owned
    // amount once the payment resolves, not a renderer-supplied one.
    let spend_reservations_need_rebuild: bool = conn
        .query_row(
            "SELECT EXISTS (
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'spend_reservations'
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?
        && conn
            .prepare("SELECT receipt_id FROM spend_reservations LIMIT 0")
            .is_err();
    if spend_reservations_need_rebuild {
        // Reservations are process-local in-flight records. No dispatch survives
        // application restart, so obsolete rows cannot be settled safely.
        conn.execute("DROP TABLE spend_reservations", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS spend_reservations (
            id              TEXT PRIMARY KEY,
            receipt_id      TEXT NOT NULL UNIQUE,
            conversation_id TEXT NOT NULL,
            lease_id        TEXT NOT NULL,
            reserved_micros INTEGER NOT NULL,
            asset           TEXT,
            created_at      TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Settlement receipts are the idempotency boundary for Core-owned charges.
    // A primary key makes repeated transport delivery impossible to double-count.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS gateway_settlement_receipts (
            receipt_id      TEXT PRIMARY KEY,
            initial_handle_id TEXT NOT NULL,
            retry_handle_id TEXT,
            lease_id        TEXT,
            state           TEXT NOT NULL CHECK (state IN ('pending', 'accounted', 'cancelled')),
            locally_accounted INTEGER NOT NULL DEFAULT 0,
            retry_minted    INTEGER NOT NULL DEFAULT 0,
            charged_micros  INTEGER,
            asset           TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_gateway_settlement_receipts_pending \
         ON gateway_settlement_receipts(state, created_at) WHERE state = 'pending'",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Suspended continuations (#3193-C): the host-owned blocked-action records that
    // make an authorization block visible and resumable instead of a hung tool call.
    approval_continuation::init_schema(conn)?;
    // Audit trail (#3193-D): lease lifecycle, approval outcomes, durable decisions.
    authorization_audit::init_schema(conn)?;
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

    #[test]
    fn schema_rebuilds_obsolete_spend_reservations() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute(
                "CREATE TABLE spend_reservations (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    lease_id TEXT NOT NULL,
                    reserved_micros INTEGER NOT NULL,
                    asset TEXT,
                    created_at TEXT NOT NULL
                )",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO spend_reservations \
                   (id, conversation_id, lease_id, reserved_micros, created_at) \
                 VALUES ('old', 'conversation', 'lease', 1, 'now')",
                [],
            )
            .unwrap();

        init_schema(&connection).unwrap();

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM spend_reservations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert!(
            connection
                .prepare("SELECT receipt_id FROM spend_reservations LIMIT 0")
                .is_ok()
        );
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
        for tool in [
            "list_projects",
            "get_agent_publisher",
            "list_organizations",
            "list_user_oauth_providers",
            "list_user_oauth_connections",
            "list_org_oauth_providers",
            "get_org_oauth_provider",
        ] {
            assert_eq!(
                classify_operation("seren", tool),
                OperationClass::TrustedRead,
                "{tool} is a read-only Seren operation"
            );
        }
    }

    #[test]
    fn seren_publisher_administration_mutations_are_high_risk() {
        for tool in [
            "create_publisher",
            "update_publisher",
            "update_publisher_pricing",
            "create_org_oauth_provider",
            "update_org_oauth_provider",
        ] {
            assert_eq!(
                classify_operation("seren", tool),
                OperationClass::HighRisk,
                "{tool} must require explicit approval"
            );
        }
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
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx(), None)
            .unwrap();
        assert_eq!(decision.decision, "allow");
        assert_eq!(decision.prompt_kind, None);
    }

    #[test]
    fn high_risk_prompts_one_shot_and_never_persists() {
        let s = state();
        for _ in 0..2 {
            let decision = s
                .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a", &ctx(), None)
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
            .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a", &ctx(), None)
            .unwrap();
        assert_eq!(decision.decision, "prompt", "still one-shot after a recorded approval");
    }

    #[test]
    fn unclassified_prompts_once_then_reuses_the_grant() {
        let s = state();
        let first = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
            .unwrap();
        assert_eq!(second.decision, "allow");
    }

    #[test]
    fn unclassified_denial_is_durable() {
        let s = state();
        s.authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
            .unwrap();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", false)
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-b", &ctx(), None)
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn a_newly_seen_publisher_is_never_silently_allowed() {
        let s = state();
        let decision = s
            .authorize(ToolRoute::Gateway, "never-seen", "inspect_everything", "conv-a", &ctx(), None)
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn wipe_clears_stored_decisions() {
        let s = state();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", true)
            .unwrap();
        // Two rows: the stored decision and its audit entry.
        assert_eq!(s.wipe().unwrap(), 2);
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
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
                    None,
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
                None,
            )
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
    }

    /// §3 rate budget: a lease capped at N calls per rolling window runs N
    /// silently, then escalates once while the window is still open — a runaway
    /// loop is bounded even under an approved lease. Driven through the real gate
    /// and store; the on-disk window counter reflects only the charged calls.
    #[test]
    fn rate_limited_lease_escalates_after_the_per_window_cap() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "rate-limited",
            4 * 3600,
            command_rules(&["cargo"]),
            LeaseBudgets {
                max_calls: Some(500),
                max_calls_per_window: Some(3),
                window_secs: Some(3600),
                ..Default::default()
            },
        )
        .unwrap();

        for i in 0..3 {
            let decision = s
                .authorize(
                    ToolRoute::Shell,
                    "seren",
                    "execute_command",
                    "conv-a",
                    &cmd_ctx("cargo build"),
                    None,
                )
                .unwrap();
            assert_eq!(
                decision.decision, "allow",
                "call {i} within the per-window cap runs silently"
            );
        }

        // The 4th call in the same window exceeds the rate cap → one escalation.
        let decision = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("cargo build"),
                None,
            )
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));

        // Only the 3 admitted calls are charged; the escalated one is not.
        let updated = s.list_leases("conv-a").unwrap().into_iter().next().unwrap();
        assert_eq!(updated.budgets.calls_in_window, 3);
        assert_eq!(updated.budgets.calls_used, 3);
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
                None,
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
                None,
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
                .authorize(ToolRoute::Gateway, "attio", tool, "conv-a", &target_ctx("conn-123"), None)
                .unwrap();
            assert_eq!(decision.decision, "allow", "{tool} should be covered");
        }

        // A different connection/account is not covered — one escalation.
        let decision = s
            .authorize(ToolRoute::Gateway, "attio", "post_notes", "conv-a", &target_ctx("conn-999"), None)
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
                None,
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
            s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
                .unwrap()
                .decision,
            "allow"
        );
        assert!(s.revoke_lease(&lease.id).unwrap());
        assert_eq!(
            s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
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
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-b", &cmd_ctx("cargo build"), None)
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
                s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
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
                s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo test"), None)
                    .unwrap()
                    .decision,
                "allow"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- live monetary metering (reserve → settle, #3193-G) --------------

    fn funded_publisher_predicates() -> LeasePredicates {
        LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "some-dex".to_string(),
                allow_high_risk: true,
                target: None,
            }],
            ..Default::default()
        }
    }

    fn money_budget(max_spend: u64, asset: &str) -> LeaseBudgets {
        LeaseBudgets {
            max_calls: Some(100),
            max_spend_micros: Some(max_spend),
            asset: Some(asset.to_string()),
            ..Default::default()
        }
    }

    fn spend_used(s: &ToolAuthorizationState) -> u64 {
        s.list_leases("conv-a").unwrap()[0].budgets.spend_used_micros
    }

    fn reserve(
        s: &ToolAuthorizationState,
        asset: &str,
        cost_micros: u64,
    ) -> SpendReservation {
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        s.consume_dispatch_handle(
            &handle,
            ToolRoute::Gateway,
            "some-dex",
            "post_swap",
            &binding_for_publisher_args(&args),
        )
        .unwrap();
        s.reserve_lease_spend(
            &handle,
            "some-dex",
            "post_swap",
            "conv-a",
            &ctx(),
            &uuid::Uuid::new_v4().to_string(),
            asset,
            cost_micros,
        )
        .unwrap()
    }

    /// A priced call charges its realized cost against the covering lease's
    /// monetary budget — the core wiring this ticket adds.
    #[test]
    fn realized_cost_is_charged_against_the_covering_lease() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 4_000_000);
        assert_eq!(reservation.outcome, "charged");
        assert!(reservation.reservation_id.is_some());
        assert_eq!(spend_used(&s), 4_000_000, "the realized cost decremented the budget");
    }

    /// A priced call whose cost would exceed the remaining budget escalates
    /// (before any payment) and leaves the budget untouched.
    #[test]
    fn over_budget_priced_call_escalates_without_charging() {
        let s = state();
        let mut budget = money_budget(10_000_000, "USDC");
        budget.spend_used_micros = 8_000_000;
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), budget)
            .unwrap();
        let reservation = reserve(&s, "USDC", 5_000_000); // 8M + 5M > 10M
        assert_eq!(reservation.outcome, "escalate");
        assert!(reservation.reservation_id.is_none());
        assert_eq!(spend_used(&s), 8_000_000, "an escalated call must not charge");
    }

    /// A payment in a different asset than the budget pins escalates rather than
    /// mis-charging the wrong-asset budget.
    #[test]
    fn mismatched_asset_escalates_without_charging() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "DAI", 1_000_000);
        assert_eq!(reservation.outcome, "escalate");
        assert_eq!(spend_used(&s), 0);
    }

    /// A priced call no lease covers is not lease-scoped: `uncovered`, so the
    /// caller falls back to its own payment gate. No budget is touched.
    #[test]
    fn priced_call_with_no_covering_lease_is_uncovered() {
        let s = state();
        // A lease that covers a *different* publisher does not cover this call.
        // The dispatch is still authorized (a trusted read needs no lease), so
        // the reservation reaches the budget matcher and finds nothing.
        let other = LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "attio".to_string(),
                allow_high_risk: true,
                target: None,
            }],
            ..Default::default()
        };
        s.grant_lease("conv-a", "crm", 3600, other, money_budget(10_000_000, "USDC"))
            .unwrap();
        let args = gmail_read_args();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        s.consume_dispatch_handle(
            &handle,
            ToolRoute::Gateway,
            "gmail",
            "get_messages",
            &binding_for_publisher_args(&args),
        )
        .unwrap();

        let reservation = s
            .reserve_lease_spend(
                &handle,
                "gmail",
                "get_messages",
                "conv-a",
                &ctx(),
                &uuid::Uuid::new_v4().to_string(),
                "USDC",
                1_000_000,
            )
            .unwrap();

        assert_eq!(reservation.outcome, "uncovered");
        assert!(reservation.reservation_id.is_none());
    }

    /// A zero-cost (free) call reserves nothing and never escalates — free calls
    /// behave exactly as before this wiring existed.
    #[test]
    fn free_call_reserves_nothing() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 0);
        assert_eq!(reservation.outcome, "uncovered");
        assert_eq!(spend_used(&s), 0);
    }

    /// A cancelled/failed payment releases its reservation, so the lease budget is
    /// not permanently consumed by a payment that never happened.
    #[test]
    fn settle_releases_a_reservation_when_payment_fails() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 4_000_000);
        assert_eq!(spend_used(&s), 4_000_000);
        s.settle_lease_spend(reservation.reservation_id.as_deref().unwrap(), None)
            .unwrap();
        assert_eq!(spend_used(&s), 0, "a failed payment released the reservation");
    }

    /// Reserve → settle reconciles the lease spend when the settled amount is less
    /// than the reserved estimate (the over-reserved portion is released).
    #[test]
    fn settle_reconciles_a_lower_settled_amount() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 10_000_000);
        assert_eq!(spend_used(&s), 10_000_000);
        s.settle_lease_spend(reservation.reservation_id.as_deref().unwrap(), Some(6_000_000))
            .unwrap();
        assert_eq!(spend_used(&s), 6_000_000, "spend reconciled down to the settled amount");
    }

    /// Settling is idempotent: a replayed settle never double-releases.
    #[test]
    fn settle_is_idempotent() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 4_000_000);
        let id = reservation.reservation_id.unwrap();
        s.settle_lease_spend(&id, None).unwrap();
        assert_eq!(spend_used(&s), 0);
        // A second settle of the same reservation is a no-op, not a double-release.
        s.settle_lease_spend(&id, None).unwrap();
        assert_eq!(spend_used(&s), 0);
    }

    /// The realized cost charged at the 402 survives the store being closed and
    /// reopened on the same on-disk database — spend persistence, not just calls.
    #[test]
    fn charged_spend_persists_across_store_reopen_on_disk() {
        let dir = std::env::temp_dir().join(format!("seren-authz-spend-{}", uuid::Uuid::new_v4()));
        let db = dir.join("tool_authorization.db");
        {
            let s = ToolAuthorizationState::new(db.clone());
            s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
                .unwrap();
            let args = serde_json::json!({});
            let decision = s
                .authorize(
                    ToolRoute::Gateway,
                    "some-dex",
                    "post_swap",
                    "conv-a",
                    &ctx(),
                    Some(&args),
                )
                .unwrap();
            let handle = decision.handle.unwrap();
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();
            let reservation = s
                .reserve_lease_spend(
                    &handle,
                    "some-dex",
                    "post_swap",
                    "conv-a",
                    &ctx(),
                    &uuid::Uuid::new_v4().to_string(),
                    "USDC",
                    4_000_000,
                )
                .unwrap();
            assert_eq!(reservation.outcome, "charged");
        }
        {
            let s = ToolAuthorizationState::new(db.clone());
            let leases = s.list_leases("conv-a").unwrap();
            assert_eq!(leases[0].budgets.spend_used_micros, 4_000_000, "charged spend persisted to disk");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The erase-all flow removes live spend reservations too.
    #[test]
    fn wipe_clears_spend_reservations() {
        let s = state();
        s.grant_lease("conv-a", "trading", 3600, funded_publisher_predicates(), money_budget(10_000_000, "USDC"))
            .unwrap();
        let reservation = reserve(&s, "USDC", 4_000_000);
        let id = reservation.reservation_id.unwrap();
        s.wipe().unwrap();
        // The reservation is gone, so settling it is a no-op against a fresh store.
        s.settle_lease_spend(&id, None).unwrap();
        assert!(s.list_leases("conv-a").unwrap().is_empty());
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
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", &ctx(), None)
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
            binding: None,
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
            binding: None,
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

    /// Completion integrity is *enforced*, not merely disclosed: an approval still
    /// pending when a task completes is an orphan no worker awaits (a worker blocks
    /// on its own approval before it can complete), so the host settles it on
    /// completion — expiring it, driving `unresolved` to zero so the task no longer
    /// carries an unresolved required approval, and surfacing a disclosure of the
    /// lapsed work. The lapse is an explicit expiry (auditable), never a durable
    /// denial, so a later re-attempt re-prompts.
    #[test]
    fn completion_settles_orphaned_pending_approvals() {
        let s = state();
        s.register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        // Before completion the task honestly cannot complete — one block is open.
        assert!(!s.resolution_summary("conv-a").unwrap().can_complete());

        let settlement = s.settle_conversation_on_completion("conv-a").unwrap();
        assert_eq!(settlement.newly_expired, 1);
        // The invariant a completed task must hold: no unresolved required approval.
        assert_eq!(settlement.summary.unresolved, 0);
        assert_eq!(settlement.summary.expired, 1);
        assert!(settlement.summary.can_complete());
        // The expired-on-completion block is rolled up into the final summary once.
        assert_eq!(settlement.disclosed.expired, 1);
        let notice = settlement
            .completion_notice()
            .expect("an expired-on-completion block is disclosed");
        assert!(notice.contains("not performed"));
        assert!(notice.contains("1 expired"));

        // Host-owned and terminal: the store now reports the task runnable (no
        // stranded `waiting_for_approval`), and the block is `expired`, not `denied`.
        assert!(s.resolution_summary("conv-a").unwrap().can_complete());
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::Running
        );
        let views = s.list_continuations("conv-a").unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].state, ContinuationState::Expired);

        // A clean completion (nothing pending) is left untouched — no spurious notice.
        let clean = s.settle_conversation_on_completion("conv-a").unwrap();
        assert_eq!(clean.newly_expired, 0);
        assert_eq!(clean.completion_notice(), None);
    }

    /// The host snapshot the frontend consumes is authoritative across the whole
    /// lifecycle: `waiting_for_approval` with one unresolved block on register, then
    /// `running` with the block counted as approved on settle. This is the payload
    /// broadcast on every gate suspend/settle so the frontend never has to derive or
    /// poll for the state.
    #[test]
    fn task_state_snapshot_tracks_host_state_across_lifecycle() {
        let s = state();
        let registered = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();

        let blocked = s.task_state_snapshot("conv-a").unwrap();
        assert_eq!(blocked.conversation_id, "conv-a");
        assert_eq!(blocked.state, TaskExecutionState::WaitingForApproval);
        assert_eq!(blocked.summary.unresolved, 1);
        assert!(!blocked.summary.can_complete());

        s.resolve_continuation(
            &registered.approval_id,
            &registered.resume_token,
            ResolveDecision::Approve,
        )
        .unwrap();

        let released = s.task_state_snapshot("conv-a").unwrap();
        assert_eq!(released.state, TaskExecutionState::Running);
        assert_eq!(released.summary.unresolved, 0);
        assert_eq!(released.summary.approved, 1);
        assert!(released.summary.can_complete());
    }

    /// The settle commands broadcast the affected conversation's new state without
    /// the renderer naming it, so the host must resolve a continuation's owner from
    /// its id alone.
    #[test]
    fn conversation_for_approval_resolves_owner() {
        let s = state();
        let registered = s
            .register_continuation("conv-owner", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        assert_eq!(
            s.conversation_for_approval(&registered.approval_id).unwrap(),
            Some("conv-owner".to_string())
        );
        assert_eq!(s.conversation_for_approval("no-such-id").unwrap(), None);
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

        // §7: the task's final summary rolls up every un-performed action —
        // denied, skipped, and expired — enumerated once.
        let settlement = s.settle_conversation_on_completion("conv-a").unwrap();
        assert_eq!(settlement.disclosed.denied, 1);
        assert_eq!(settlement.disclosed.skipped, 1);
        assert_eq!(settlement.disclosed.expired, 1);
        let notice = settlement
            .completion_notice()
            .expect("settled lapses are disclosed in the final summary");
        assert!(notice.contains("3 actions"));
        assert!(notice.contains("1 denied"));
        assert!(notice.contains("1 skipped"));
        assert!(notice.contains("1 expired"));

        // Exactly once: a later clean completion of the same conversation
        // re-discloses nothing (no prompt/notice storm across turns).
        let again = s.settle_conversation_on_completion("conv-a").unwrap();
        assert_eq!(again.disclosed.total(), 0);
        assert_eq!(again.completion_notice(), None);
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

    /// A view reload orphans every live approval: the renderer that held each
    /// resume token is gone. The host-authoritative reconciliation expires them all
    /// — across conversations, regardless of TTL — so each task returns to `running`
    /// at once instead of showing a stale `waiting_for_approval` until its window
    /// lapses. It is an expiry (audited, re-promptable), never a denial, and settled
    /// rows are untouched.
    #[test]
    fn reload_reconciliation_expires_all_live_pending_across_conversations() {
        let s = state();
        // Long TTLs: these are not overdue, so only the reload reconciliation — not
        // the ordinary TTL sweep — can expire them.
        s.register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 3600)
            .unwrap();
        s.register_continuation("conv-b", shell_cap("git push"), ContinuationScope::Branch, 3600)
            .unwrap();
        // A previously-settled block must stay settled, not be reopened or re-expired.
        let approved = s
            .register_continuation("conv-a", shell_cap("cargo build"), ContinuationScope::Linear, 3600)
            .unwrap();
        s.resolve_continuation(&approved.approval_id, &approved.resume_token, ResolveDecision::Approve)
            .unwrap();

        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::WaitingForApproval
        );
        assert_eq!(
            s.task_execution_state("conv-b").unwrap(),
            TaskExecutionState::RunningWithBlockedActions
        );

        // Two live pending blocks (the approved one is already settled) are expired;
        // the sweep reports both owning conversations so the caller can broadcast
        // each task's now-unblocked state.
        assert_eq!(
            s.expire_all_pending_continuations().unwrap(),
            vec!["conv-a".to_string(), "conv-b".to_string()]
        );

        // Both tasks are released; nothing blocks completion.
        assert_eq!(
            s.task_execution_state("conv-a").unwrap(),
            TaskExecutionState::Running
        );
        assert_eq!(
            s.task_execution_state("conv-b").unwrap(),
            TaskExecutionState::Running
        );
        let summary_a = s.resolution_summary("conv-a").unwrap();
        assert!(summary_a.can_complete());
        assert_eq!(summary_a.expired, 1, "the pending block was expired, not the approved one");
        assert_eq!(summary_a.approved, 1, "a settled decision is left intact");

        // The lapse is audited as an expiry (not a denial), so a later attempt re-prompts.
        assert!(audit_events(&s, "conv-a").contains(&"approval_expired".to_string()));
        assert!(audit_events(&s, "conv-b").contains(&"approval_expired".to_string()));

        // Idempotent: nothing pending remains, so a second reconciliation is a no-op.
        assert!(s.expire_all_pending_continuations().unwrap().is_empty());
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

    // ---- audit trail (#3193-D) -------------------------------------------

    fn audit_events(s: &ToolAuthorizationState, conversation_id: &str) -> Vec<String> {
        s.list_audit(conversation_id, 100)
            .unwrap()
            .into_iter()
            .map(|entry| entry.event)
            .collect()
    }

    /// The lease lifecycle is fully auditable: grant, silent use, and revoke each
    /// leave exactly one row, newest first.
    #[test]
    fn lease_grant_use_and_revoke_are_audited() {
        let s = state();
        let lease = s
            .grant_lease("conv-a", "Coding lease", 3600, command_rules(&["cargo"]), call_budget(10))
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(decision.decision, "allow");
        assert!(s.revoke_lease(&lease.id).unwrap());

        assert_eq!(
            audit_events(&s, "conv-a"),
            vec!["lease_revoked", "lease_used", "lease_granted"],
        );

        // Idempotent replay of the revoke adds nothing.
        assert!(!s.revoke_lease(&lease.id).unwrap());
        assert_eq!(audit_events(&s, "conv-a").len(), 3);

        // Rows carry identity, not arguments.
        let entries = s.list_audit("conv-a", 100).unwrap();
        let used = entries.iter().find(|e| e.event == "lease_used").unwrap();
        assert_eq!(used.subject_id.as_deref(), Some(lease.id.as_str()));
        assert_eq!(used.route.as_deref(), Some("shell"));
        assert_eq!(used.detail.as_deref(), Some("cargo"));
    }

    /// Credential safety: a shell command's arguments (which may contain secrets)
    /// never reach the audit table — only the leading program token does.
    #[test]
    fn audit_rows_never_store_command_arguments() {
        let s = state();
        s.grant_lease("conv-a", "lease", 3600, command_rules(&["curl"]), call_budget(10))
            .unwrap();
        let secret_command = "curl -H 'Authorization: Bearer sk-live-SECRET' https://api.example.com";
        s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx(secret_command), None)
            .unwrap();

        let entries = s.list_audit("conv-a", 100).unwrap();
        assert!(entries.iter().any(|e| e.event == "lease_used"));
        for entry in &entries {
            let row = serde_json::to_string(entry).unwrap();
            assert!(!row.contains("SECRET"), "audit row leaked command arguments: {row}");
            assert!(!row.contains("Bearer"), "audit row leaked command arguments: {row}");
        }
    }

    /// A lease-exclusion deny is audited as such.
    #[test]
    fn lease_exclusion_deny_is_audited() {
        let s = state();
        let mut predicates = command_rules(&["git"]);
        predicates.exclusions = vec![capability_lease::Exclusion {
            program: Some("git".to_string()),
            ..Default::default()
        }];
        s.grant_lease("conv-a", "lease", 3600, predicates, call_budget(10))
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("git push"), None)
            .unwrap();
        assert_eq!(decision.decision, "deny");
        assert_eq!(audit_events(&s, "conv-a"), vec!["lease_denied", "lease_granted"]);
    }

    /// One suspended request logs once — a deduped retry does not re-audit — and
    /// its resolution logs exactly once more, even on idempotent replay.
    #[test]
    fn approval_lifecycle_is_audited_exactly_once() {
        let s = state();
        let r = s
            .register_continuation("conv-a", shell_cap("cargo build"), ContinuationScope::Linear, 300)
            .unwrap();
        // Dedup reuse must not add a second requested row.
        s.register_continuation("conv-a", shell_cap("cargo test"), ContinuationScope::Linear, 300)
            .unwrap();
        assert_eq!(audit_events(&s, "conv-a"), vec!["approval_requested"]);

        s.resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Deny)
            .unwrap();
        // Idempotent replay adds nothing.
        s.resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Deny)
            .unwrap();
        assert_eq!(
            audit_events(&s, "conv-a"),
            vec!["approval_denied", "approval_requested"],
        );
        let denied = &s.list_audit("conv-a", 100).unwrap()[0];
        assert_eq!(denied.subject_id.as_deref(), Some(r.approval_id.as_str()));
    }

    /// A durable session decision is audited; a high-risk prompt outcome (which
    /// never persists) is not.
    #[test]
    fn durable_decisions_are_audited_and_one_shots_are_not() {
        let s = state();
        s.record_decision(ToolRoute::Gateway, "attio", "post_notes", "conv-a", true)
            .unwrap();
        // High-risk outcomes are one-shot: no durable decision, no decision audit.
        s.record_decision(ToolRoute::Gateway, "gmail", "post_send", "conv-a", true)
            .unwrap();
        assert_eq!(audit_events(&s, "conv-a"), vec!["decision_granted"]);
    }

    /// A lapsed lease gets exactly one `lease_expired` row, on first observation.
    #[test]
    fn lease_expiry_is_audited_once() {
        let s = state();
        let lease = s
            .grant_lease("conv-a", "lease", 3600, command_rules(&["cargo"]), call_budget(10))
            .unwrap();
        // Force the window closed by rewriting the stored expiry into the past.
        s.with_conn(|conn| {
            let mut expired = lease.clone();
            expired.expires_at = "2000-01-01T00:00:00.000Z".to_string();
            write_lease(conn, &expired)
        })
        .unwrap();

        s.list_leases("conv-a").unwrap();
        s.list_leases("conv-a").unwrap();
        let events = audit_events(&s, "conv-a");
        assert_eq!(
            events.iter().filter(|e| e.as_str() == "lease_expired").count(),
            1,
            "expiry must be recorded exactly once: {events:?}"
        );
    }

    /// The global pending listing spans conversations and drops settled rows —
    /// the badge that stays visible after navigating away.
    #[test]
    fn pending_approvals_span_conversations() {
        let s = state();
        let a = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        s.register_continuation("conv-b", shell_cap("git push"), ContinuationScope::Linear, 300)
            .unwrap();

        let pending = s.list_pending_continuations_all().unwrap();
        assert_eq!(pending.len(), 2);
        let tasks: Vec<&str> = pending.iter().map(|view| view.task_id.as_str()).collect();
        assert!(tasks.contains(&"conv-a") && tasks.contains(&"conv-b"));

        s.resolve_continuation(&a.approval_id, &a.resume_token, ResolveDecision::Approve)
            .unwrap();
        let pending = s.list_pending_continuations_all().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].task_id, "conv-b");
    }

    /// The erase-all flow removes the audit trail with everything else.
    #[test]
    fn wipe_clears_audit_rows() {
        let s = state();
        s.grant_lease("conv-a", "lease", 3600, command_rules(&["cargo"]), call_budget(10))
            .unwrap();
        assert!(!s.list_audit("conv-a", 10).unwrap().is_empty());
        s.wipe().unwrap();
        assert!(s.list_audit("conv-a", 10).unwrap().is_empty());
    }

    // ---- dispatch-handle enforcement (#3193-F) -----------------------------

    fn gmail_read_args() -> serde_json::Value {
        serde_json::json!({ "q": "from:example" })
    }

    /// A silent allow mints one handle for one exact transport dispatch.
    #[test]
    fn allow_mints_a_redeemable_handle_that_exhausts() {
        let s = state();
        let args = gmail_read_args();
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx(), Some(&args))
            .unwrap();
        assert_eq!(decision.decision, "allow");
        let handle = decision.handle.expect("allow carries a dispatch handle");
        let binding = binding_for_publisher_args(&args);

        s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "get_messages", &binding)
            .unwrap();
        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "get_messages", &binding)
                .is_err(),
            "a spent handle must be refused"
        );
    }

    #[test]
    fn terminal_dispatch_completion_removes_unused_redemptions() {
        let s = state();
        let args = gmail_read_args();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let binding = binding_for_publisher_args(&args);

        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding,
            )
            .unwrap();
        s.complete_gateway_dispatch(&handle, None, None, &redemption)
            .unwrap();

        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding,
            )
            .is_err()
        );
    }

    #[test]
    fn terminal_dispatch_records_settled_charge_on_its_lease() {
        let s = state();
        let mut budget = money_budget(10_000_000, "USDC");
        budget.spend_used_micros = 8_000_000;
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            budget,
        )
        .unwrap();
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();
        let receipt_id = uuid::Uuid::new_v4().to_string();

        s.complete_gateway_dispatch(
            &handle,
            Some(&receipt_id),
            Some(&SettledGatewayCharge {
                micros: 5_000_000,
                asset: "USDC".to_string(),
            }),
            &redemption,
        )
        .unwrap();

        assert_eq!(spend_used(&s), 13_000_000);
        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .is_err()
        );
    }

    #[test]
    fn settlement_receipt_is_a_database_enforced_idempotency_key() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(20_000_000, "USDC"),
        )
        .unwrap();
        let args = serde_json::json!({});
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let charge = SettledGatewayCharge {
            micros: 5_000_000,
            asset: "USDC".to_string(),
        };

        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();
        for _ in 0..2 {
            s.complete_gateway_dispatch(
                &handle,
                Some(&receipt_id),
                Some(&charge),
                &redemption,
            )
            .unwrap();
        }

        assert_eq!(spend_used(&s), 5_000_000);
        let count = s
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM gateway_settlement_receipts WHERE receipt_id = ?1",
                    rusqlite::params![receipt_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn pending_receipt_blocks_more_gateway_spend_until_reconciled() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(20_000_000, "USDC"),
        )
        .unwrap();
        let args = serde_json::json!({});
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();
        s.complete_gateway_dispatch(&handle, Some(&receipt_id), None, &redemption)
            .unwrap();

        assert_eq!(
            s.pending_gateway_settlement_receipts().unwrap(),
            vec![receipt_id.clone()]
        );
        assert!(
            s.authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .is_err()
        );

        s.reconcile_gateway_settlement(&GatewaySettlementReceipt {
            receipt_id,
            status: "paid".to_string(),
            charged_micros: Some(4_000_000),
            asset: "USDC".to_string(),
        })
        .unwrap();

        assert_eq!(spend_used(&s), 4_000_000);
        assert!(s.pending_gateway_settlement_receipts().unwrap().is_empty());
        assert!(
            s.authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .is_ok()
        );
    }

    #[test]
    fn expired_receipt_releases_locally_reserved_spend() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(20_000_000, "USDC"),
        )
        .unwrap();
        let reservation = reserve(&s, "USDC", 4_000_000);
        let mut pending_receipts = s.pending_gateway_settlement_receipts().unwrap();
        let receipt_id = pending_receipts.remove(0);
        s.settle_lease_spend(
            reservation.reservation_id.as_deref().unwrap(),
            Some(4_000_000),
        )
        .unwrap();
        assert_eq!(spend_used(&s), 4_000_000);

        s.reconcile_gateway_settlement(&GatewaySettlementReceipt {
            receipt_id,
            status: "expired".to_string(),
            charged_micros: Some(0),
            asset: "USDC".to_string(),
        })
        .unwrap();

        assert_eq!(spend_used(&s), 0);
        assert!(s.pending_gateway_settlement_receipts().unwrap().is_empty());
    }

    #[test]
    fn stale_pending_receipt_revokes_its_lease() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(20_000_000, "USDC"),
        )
        .unwrap();
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();
        let receipt_id = uuid::Uuid::new_v4().to_string();
        s.complete_gateway_dispatch(&handle, Some(&receipt_id), None, &redemption)
            .unwrap();
        s.with_conn(|conn| {
            conn.execute(
                "UPDATE gateway_settlement_receipts \
                 SET created_at = '2000-01-01T00:00:00.000Z' \
                 WHERE receipt_id = ?1",
                rusqlite::params![receipt_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .unwrap();

        assert!(s.pending_gateway_settlement_receipts().unwrap().is_empty());
        assert!(s.list_leases("conv-a").unwrap()[0].revoked);
    }

    #[test]
    fn settled_charge_asset_mismatch_revokes_the_lease() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(10_000_000, "USDC"),
        )
        .unwrap();
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();

        let receipt_id = uuid::Uuid::new_v4().to_string();
        s.complete_gateway_dispatch(
            &handle,
            Some(&receipt_id),
            Some(&SettledGatewayCharge {
                micros: 5_000_000,
                asset: "EUR".to_string(),
            }),
            &redemption,
        )
        .unwrap();

        let leases = s.list_leases("conv-a").unwrap();
        assert_eq!(leases.len(), 1);
        assert!(leases[0].revoked);
        assert_eq!(leases[0].budgets.spend_used_micros, 0);
    }

    #[test]
    fn settled_charge_without_a_receipt_revokes_the_lease() {
        let s = state();
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            money_budget(10_000_000, "USDC"),
        )
        .unwrap();
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding_for_publisher_args(&args),
            )
            .unwrap();

        s.complete_gateway_dispatch(
            &handle,
            None,
            Some(&SettledGatewayCharge {
                micros: 5_000_000,
                asset: "USDC".to_string(),
            }),
            &redemption,
        )
        .unwrap();

        let leases = s.list_leases("conv-a").unwrap();
        assert_eq!(leases.len(), 1);
        assert!(leases[0].revoked);
        assert_eq!(leases[0].budgets.spend_used_micros, 0);
        assert!(audit_events(&s, "conv-a").contains(&"lease_revoked".to_string()));
    }

    #[test]
    fn settled_charge_without_a_lease_still_completes_the_handle() {
        let s = state();
        let args = gmail_read_args();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let binding = binding_for_publisher_args(&args);
        let redemption = s
            .consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding,
            )
            .unwrap();

        s.complete_gateway_dispatch(
            &handle,
            None,
            Some(&SettledGatewayCharge {
                micros: 5_000_000,
                asset: "USDC".to_string(),
            }),
            &redemption,
        )
        .unwrap();

        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding,
            )
            .is_err()
        );
    }

    #[test]
    fn prepaid_retry_does_not_duplicate_reserved_spend() {
        let s = state();
        let mut budget = money_budget(20_000_000, "USDC");
        budget.spend_used_micros = 5_000_000;
        s.grant_lease(
            "conv-a",
            "trading",
            3600,
            funded_publisher_predicates(),
            budget,
        )
        .unwrap();
        let args = serde_json::json!({});
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let other_decision = s
            .authorize(
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let other_handle = other_decision.handle.unwrap();
        let binding = binding_for_publisher_args(&args);

        s.consume_dispatch_handle(
            &handle,
            ToolRoute::Gateway,
            "some-dex",
            "post_swap",
            &binding,
        )
        .unwrap();
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let reservation = s
            .reserve_lease_spend(
                &handle,
                "some-dex",
                "post_swap",
                "conv-a",
                &ctx(),
                &receipt_id,
                "USDC",
                5_000_000,
            )
            .unwrap();
        s.settle_lease_spend(
            reservation.reservation_id.as_deref().unwrap(),
            Some(5_000_000),
        )
        .unwrap();
        s.consume_dispatch_handle(
            &other_handle,
            ToolRoute::Gateway,
            "some-dex",
            "post_swap",
            &binding,
        )
        .unwrap();
        assert!(
            s.renew_gateway_dispatch_handle(&other_handle, &receipt_id)
                .is_err()
        );
        let retry_handle = s
            .renew_gateway_dispatch_handle(&handle, &receipt_id)
            .unwrap();
        let retry_redemption = s
            .consume_dispatch_handle(
                &retry_handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding,
            )
            .unwrap();
        s.complete_gateway_dispatch(
            &retry_handle,
            Some(&receipt_id),
            None,
            &retry_redemption,
        )
        .unwrap();

        assert_eq!(spend_used(&s), 10_000_000);
        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "some-dex",
                "post_swap",
                &binding,
            )
            .is_err()
        );
    }

    #[test]
    fn exhausted_gateway_handle_is_retained_until_retry_or_expiry() {
        let s = state();
        let args = gmail_read_args();
        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                "conv-a",
                &ctx(),
                Some(&args),
            )
            .unwrap();
        let handle = decision.handle.unwrap();
        let binding = binding_for_publisher_args(&args);

        s.consume_dispatch_handle(
            &handle,
            ToolRoute::Gateway,
            "gmail",
            "get_messages",
            &binding,
        )
        .unwrap();
        let retained_uses = s
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT uses_remaining FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![&handle],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(retained_uses, 0);

        s.with_conn(|conn| {
            conn.execute(
                "UPDATE dispatch_handles SET expires_at = '1970-01-01T00:00:00Z' WHERE id = ?1",
                rusqlite::params![&handle],
            )
            .map_err(|error| error.to_string())?;
            let now = current_timestamp(conn)?;
            mint_dispatch_handle(
                conn,
                "conv-a",
                ToolRoute::Gateway,
                "gmail",
                "get_labels",
                &binding_for_publisher_args(&serde_json::json!({})),
                None,
                &now,
            )?;
            let retained: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM dispatch_handles WHERE id = ?1",
                    rusqlite::params![&handle],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            assert_eq!(retained, 0);
            Ok(())
        })
        .unwrap();
    }

    /// A transport invoked with no handle, a forged handle, or an expired
    /// handle is refused — the bypass path this ticket exists to close.
    #[test]
    fn transports_refuse_missing_forged_and_expired_handles() {
        let s = state();
        let binding = binding_for_publisher_args(&gmail_read_args());
        assert!(
            s.consume_dispatch_handle("", ToolRoute::Gateway, "gmail", "get_messages", &binding)
                .is_err(),
            "no handle"
        );
        assert!(
            s.consume_dispatch_handle(
                "11111111-2222-3333-4444-555555555555",
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding
            )
            .is_err(),
            "forged handle"
        );

        let args = gmail_read_args();
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx(), Some(&args))
            .unwrap();
        let handle = decision.handle.unwrap();
        // Force the handle's window closed.
        s.with_conn(|conn| {
            conn.execute(
                "UPDATE dispatch_handles SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
                rusqlite::params![handle],
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();
        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "get_messages", &binding)
                .is_err(),
            "expired handle"
        );
    }

    /// A handle for one operation cannot be replayed for a different operation,
    /// route, publisher, or argument payload.
    #[test]
    fn handle_is_bound_to_route_operation_and_args() {
        let s = state();
        let args = gmail_read_args();
        let handle = s
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx(), Some(&args))
            .unwrap()
            .handle
            .unwrap();
        let binding = binding_for_publisher_args(&args);
        let other_binding =
            binding_for_publisher_args(&serde_json::json!({ "q": "from:someone-else" }));

        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "delete_messages", &binding)
                .is_err(),
            "different operation"
        );
        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Mcp, "gmail", "get_messages", &binding)
                .is_err(),
            "different route"
        );
        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "attio", "get_messages", &binding)
                .is_err(),
            "different publisher"
        );
        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &other_binding
            )
            .is_err(),
            "different args"
        );
        // The exact operation still redeems.
        s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "get_messages", &binding)
            .unwrap();
    }

    /// The operation binding ignores dispatch metadata (`connection_id`,
    /// `_x402_payment`) that legitimately changes between the gate consultation
    /// and the wire dispatch, and nothing else.
    #[test]
    fn binding_normalization_excludes_only_dispatch_metadata() {
        let base = serde_json::json!({ "q": "x" });
        let with_meta = serde_json::json!({
            "q": "x",
            "connection_id": "conn-1",
            "_x402_payment": "header",
        });
        let different = serde_json::json!({ "q": "y" });
        assert_eq!(
            binding_for_publisher_args(&base),
            binding_for_publisher_args(&with_meta)
        );
        assert_ne!(
            binding_for_publisher_args(&base),
            binding_for_publisher_args(&different)
        );
    }

    /// Non-gateway routes are strictly one dispatch per authorization.
    #[test]
    fn non_gateway_handles_are_single_use() {
        let s = state();
        s.grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(10))
            .unwrap();
        let handle = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("cargo build"),
                None,
            )
            .unwrap()
            .handle
            .unwrap();
        let binding = binding_for_command("cargo build");
        s.consume_dispatch_handle(&handle, ToolRoute::Shell, "seren", "execute_command", &binding)
            .unwrap();
        assert!(
            s.consume_dispatch_handle(&handle, ToolRoute::Shell, "seren", "execute_command", &binding)
                .is_err()
        );
    }

    /// A lease-bound handle dies with its lease: revocation between authorize
    /// and dispatch stops the dispatch.
    #[test]
    fn lease_bound_handle_is_refused_after_revocation() {
        let s = state();
        let lease = s
            .grant_lease("conv-a", "coding", 3600, command_rules(&["cargo"]), call_budget(10))
            .unwrap();
        let handle = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-a",
                &cmd_ctx("cargo build"),
                None,
            )
            .unwrap()
            .handle
            .unwrap();
        assert!(s.revoke_lease(&lease.id).unwrap());
        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Shell,
                "seren",
                "execute_command",
                &binding_for_command("cargo build")
            )
            .is_err(),
            "a revoked lease must invalidate its outstanding handles"
        );
    }

    /// The prompt decision carries the host-computed binding; the approved
    /// continuation mints a handle bound to exactly that operation, exactly
    /// once — a replayed resolve is not a handle faucet.
    #[test]
    fn approved_continuation_mints_the_post_approval_handle_once() {
        let s = state();
        let args = serde_json::json!({ "to": "a@example.com" });
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "post_send", "conv-a", &ctx(), Some(&args))
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        let binding = decision.binding.expect("prompt carries the operation binding");
        assert_eq!(binding, binding_for_publisher_args(&args));

        let mut cap = send_cap();
        cap.binding = Some(binding.clone());
        let r = s
            .register_continuation("conv-a", cap, ContinuationScope::Linear, 300)
            .unwrap();
        let outcome = s
            .resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Approve)
            .unwrap();
        assert!(outcome.changed);
        let handle = outcome
            .dispatch_handle
            .expect("pending→approved settle mints the dispatch handle");
        s.consume_dispatch_handle(&handle, ToolRoute::Gateway, "gmail", "post_send", &binding)
            .unwrap();

        // Idempotent replay of the resolve mints nothing.
        let replay = s
            .resolve_continuation(&r.approval_id, &r.resume_token, ResolveDecision::Approve)
            .unwrap();
        assert!(!replay.changed);
        assert!(replay.dispatch_handle.is_none());
    }

    /// Deny/skip settles never mint; a capability registered without a binding
    /// cannot mint either (the dispatch fails closed instead).
    #[test]
    fn non_approve_settles_and_unbound_capabilities_mint_nothing() {
        let s = state();
        let denied = s
            .register_continuation("conv-a", shell_cap("git push"), ContinuationScope::Linear, 300)
            .unwrap();
        let outcome = s
            .resolve_continuation(&denied.approval_id, &denied.resume_token, ResolveDecision::Deny)
            .unwrap();
        assert!(outcome.dispatch_handle.is_none());

        // send_cap() has no binding: approval settles but cannot mint.
        let unbound = s
            .register_continuation("conv-a", send_cap(), ContinuationScope::Linear, 300)
            .unwrap();
        let outcome = s
            .resolve_continuation(&unbound.approval_id, &unbound.resume_token, ResolveDecision::Approve)
            .unwrap();
        assert!(outcome.changed);
        assert!(outcome.dispatch_handle.is_none());
    }

    /// Distinct argument payloads for the same tool are distinct pending
    /// requests — a differently-argued retry must not inherit a continuation
    /// whose post-approval handle it can never redeem.
    #[test]
    fn continuation_dedup_keys_on_the_operation_binding() {
        let s = state();
        let mut first = send_cap();
        first.binding = Some("binding-a".to_string());
        let mut second = send_cap();
        second.binding = Some("binding-b".to_string());

        let a = s
            .register_continuation("conv-a", first.clone(), ContinuationScope::Linear, 300)
            .unwrap();
        let b = s
            .register_continuation("conv-a", second, ContinuationScope::Linear, 300)
            .unwrap();
        assert!(!b.deduplicated, "different args are a different request");
        assert_ne!(a.approval_id, b.approval_id);

        // The same args still dedup.
        let retry = s
            .register_continuation("conv-a", first, ContinuationScope::Linear, 300)
            .unwrap();
        assert!(retry.deduplicated);
        assert_eq!(retry.approval_id, a.approval_id);
    }

    /// Gateway catalog discovery reads are trusted and mint silently — the
    /// enforced MCP transport must not break gateway initialization.
    #[test]
    fn gateway_catalog_reads_mint_silently() {
        let s = state();
        for (tool, args) in [
            ("list_agent_publishers", serde_json::json!({})),
            ("list_mcp_tools", serde_json::json!({ "publisher": "gmail" })),
        ] {
            let decision = s
                .authorize(ToolRoute::Seren, "seren", tool, "gateway-catalog", &ctx(), Some(&args))
                .unwrap();
            assert_eq!(decision.decision, "allow", "{tool} should be a trusted read");
            assert!(decision.handle.is_some(), "{tool} should carry a handle");
        }
    }

    /// Wipe clears outstanding handles: after erase-all nothing is redeemable.
    #[test]
    fn wipe_clears_dispatch_handles() {
        let s = state();
        let args = gmail_read_args();
        let handle = s
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a", &ctx(), Some(&args))
            .unwrap()
            .handle
            .unwrap();
        s.wipe().unwrap();
        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "gmail",
                "get_messages",
                &binding_for_publisher_args(&args)
            )
            .is_err()
        );
    }

    // ---- closing E2E: a high-risk external write through the gate (#3280) ---
    //
    // Slice D proved the lease mechanism with local `echo` shell commands; it
    // never drove a genuine high-risk *external side-effect* (a publisher send)
    // through the gate under an explicitly-approved high-risk lease. These tests
    // close that gap deterministically: the covered send is allowed silently, the
    // gateway transport redeems its handle for the exact operation, the decision
    // is audited credential-safe, and a revoked or expired lease refuses the
    // outstanding handle and re-escalates instead of leaking a late write.

    /// The external-write args a model would send. Carries a secret-shaped value
    /// so the credential-safety assertion has something real to catch.
    fn external_write_args() -> serde_json::Value {
        serde_json::json!({
            "to": "recipient@example.com",
            "subject": "Q3 report",
            "idempotency_key": "sk-live-DO-NOT-LEAK-1234567890"
        })
    }

    /// A lease that opts one publisher + one target into high-risk coverage — the
    /// explicit, bounded envelope a user approves for an outbound workflow. The
    /// publisher slug is deliberately one with no hard-coded Desktop entry.
    fn high_risk_send_lease(s: &ToolAuthorizationState, conversation_id: &str) -> CapabilityLease {
        let predicates = LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "outbound-mailer".to_string(),
                allow_high_risk: true,
                target: Some("conn-primary".to_string()),
            }],
            ..Default::default()
        };
        s.grant_lease(
            conversation_id,
            "Send outbound mail via the primary connection",
            3600,
            predicates,
            call_budget(25),
        )
        .unwrap()
    }

    /// The happy path: a model-originated high-risk publisher send, covered by an
    /// explicitly-approved high-risk lease, is authorized *silently* (an allow,
    /// not a one-shot prompt); the gateway transport redeems its handle for that
    /// exact publisher/tool/body; and the decision is recorded in
    /// `authorization_audit` as `lease_used`, keyed to the lease and the resource
    /// target, with no argument payload or credential.
    #[test]
    fn high_risk_external_write_runs_silently_under_a_lease_and_is_audited() {
        let s = state();
        let lease = high_risk_send_lease(&s, "conv-a");
        let args = external_write_args();

        let decision = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-primary"),
                Some(&args),
            )
            .unwrap();
        assert_eq!(
            decision.decision, "allow",
            "an approved high-risk lease covers the send silently"
        );
        let handle = decision.handle.expect("a silent allow still mints a dispatch handle");

        // What gateway_http::enforce_publisher_dispatch does before the POST
        // leaves the app: redeem exactly this handle for this publisher/tool/body.
        // Redemption succeeding is what permits the real external write.
        let binding = binding_for_publisher_args(&args);
        s.consume_dispatch_handle(
            &handle,
            ToolRoute::Gateway,
            "outbound-mailer",
            "post_send_message",
            &binding,
        )
        .unwrap();

        // The decision is auditable as a lease use — keyed to the lease and the
        // resource target, never the argument payload or the secret it carried.
        let entries = s.list_audit("conv-a", 100).unwrap();
        let used = entries
            .iter()
            .find(|e| e.event == "lease_used")
            .expect("the covered send is audited as lease_used");
        assert_eq!(used.subject_id.as_deref(), Some(lease.id.as_str()));
        assert_eq!(used.route.as_deref(), Some("gateway"));
        assert_eq!(used.publisher_slug.as_deref(), Some("outbound-mailer"));
        assert_eq!(used.tool_name.as_deref(), Some("post_send_message"));
        assert_eq!(used.detail.as_deref(), Some("conn-primary"));
        for entry in &entries {
            let row = serde_json::to_string(entry).unwrap();
            assert!(!row.contains("sk-live"), "audit row leaked a credential-shaped argument: {row}");
            assert!(
                !row.contains("recipient@example.com"),
                "audit row leaked the argument payload: {row}"
            );
        }

        // Target scoping: the same send to a different connection is not covered
        // and escalates to an exact one-shot instead of riding the lease.
        let other = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-secondary"),
                Some(&args),
            )
            .unwrap();
        assert_eq!(other.decision, "prompt");
        assert_eq!(other.prompt_kind.as_deref(), Some("one-shot"));
    }

    /// The denial half: once the covering lease is revoked, an already-minted
    /// handle can no longer be redeemed (the real POST is refused at the
    /// transport), and re-authorizing the same send returns a fresh one-shot
    /// prompt — a durable, distinct block, never a silent allow.
    #[test]
    fn revoking_the_lease_blocks_the_external_write_with_a_distinct_signal() {
        let s = state();
        let lease = high_risk_send_lease(&s, "conv-a");
        let args = external_write_args();
        let binding = binding_for_publisher_args(&args);

        let handle = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-primary"),
                Some(&args),
            )
            .unwrap()
            .handle
            .expect("the covered send mints a handle");

        assert!(s.revoke_lease(&lease.id).unwrap());

        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                &binding,
            )
            .is_err(),
            "a revoked lease must kill its outstanding dispatch handle"
        );

        let after = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-primary"),
                Some(&args),
            )
            .unwrap();
        assert_eq!(after.decision, "prompt", "a revoked envelope re-escalates, never silently allows");
        assert_eq!(after.prompt_kind.as_deref(), Some("one-shot"));
        assert!(audit_events(&s, "conv-a").contains(&"lease_revoked".to_string()));
    }

    /// The expiry half: an expired lease covers nothing. The gate escalates to a
    /// one-shot prompt, and a handle minted before expiry is refused at the
    /// transport, so a lapsed envelope cannot leak a late external write.
    #[test]
    fn an_expired_lease_blocks_the_external_write() {
        let s = state();
        let lease = high_risk_send_lease(&s, "conv-a");
        let args = external_write_args();
        let binding = binding_for_publisher_args(&args);

        let handle = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-primary"),
                Some(&args),
            )
            .unwrap()
            .handle
            .expect("the covered send mints a handle");

        // Force the lease window closed by rewriting its stored expiry into the past.
        s.with_conn(|conn| {
            let mut expired = lease.clone();
            expired.expires_at = "2000-01-01T00:00:00.000Z".to_string();
            write_lease(conn, &expired)
        })
        .unwrap();

        assert!(
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                &binding,
            )
            .is_err(),
            "an expired lease must refuse its outstanding dispatch handle"
        );

        let after = s
            .authorize(
                ToolRoute::Gateway,
                "outbound-mailer",
                "post_send_message",
                "conv-a",
                &target_ctx("conn-primary"),
                Some(&args),
            )
            .unwrap();
        assert_eq!(after.decision, "prompt");
        assert_eq!(after.prompt_kind.as_deref(), Some("one-shot"));
    }

    // ---- closing E2E: the 500-call coding task under one lease (#3281) -------
    //
    // Slice D proved silent lease reuse at 2 calls and with hand-built command
    // rules over cargo/pnpm/git only. It never drove the *derived* coding bundle
    // (`derive_bundle`'s `CODING_*` defaults) across the full documented toolchain
    // at the ceiling, and it never checked the on-disk `authorization_audit`
    // trail. This test closes that gap deterministically against a real file-backed
    // store (no mocks): a lease derived from the coding profile runs an entire
    // 500-call task — cargo/pnpm/npm/node/git — as silent, budget-charged allows
    // whose handles the transport actually redeems; the audit trail persists the
    // full `lease_used` sequence credential-safe; and budget exhaustion produces
    // exactly one escalation that dedups to a single request, never a prompt storm.

    /// The whole documented coding toolchain, one command per `CODING_COMMAND_PROGRAMS`
    /// entry. The `npm` command carries a secret-shaped token so the credential-safety
    /// assertion has a real target: the audit must keep only the `npm` program token,
    /// never this argument.
    const CODING_TOOLCHAIN: [&str; 5] = [
        "cargo test --manifest-path src-tauri/Cargo.toml",
        "pnpm check",
        "npm publish --//registry.npmjs.org/:_authToken=npm_live-DO-NOT-LEAK-abcdef",
        "node scripts/prepare-runtime.mjs",
        "git commit -m wip",
    ];

    #[test]
    fn derived_coding_lease_runs_a_500_call_task_silently_on_disk_and_is_audited() {
        let dir = std::env::temp_dir().join(format!("seren-authz-coding-{}", uuid::Uuid::new_v4()));
        let db = dir.join("tool_authorization.db");
        let s = ToolAuthorizationState::new(db.clone());

        // The envelope is *derived* from the coding profile, not hand-built: this is
        // the `derive_bundle` / `CODING_*` path #3281 names. The derived bundle must
        // carry the full documented toolchain and the 500-call ceiling — anything
        // less would silently narrow what an approved coding lease can do.
        let bundle = capability_lease::derive_bundle(&capability_lease::BundleRequest {
            profile: "coding".to_string(),
            duration_secs: 4 * 3600,
            ..Default::default()
        });
        let derived_programs: Vec<&str> = bundle
            .predicates
            .command_rules
            .iter()
            .map(|rule| rule.program.as_str())
            .collect();
        for program in ["cargo", "pnpm", "npm", "node", "git"] {
            assert!(
                derived_programs.contains(&program),
                "the coding profile must derive the `{program}` toolchain rule"
            );
        }
        assert_eq!(
            bundle.budgets.max_calls,
            Some(500),
            "the derived coding ceiling is CODING_DEFAULT_MAX_CALLS"
        );
        let ceiling = bundle.budgets.max_calls.unwrap();

        // The user approves the derived bundle once — the real human-grant path.
        let lease = s
            .grant_lease(
                "conv-coding",
                &bundle.label,
                bundle.duration_secs,
                bundle.predicates,
                bundle.budgets,
            )
            .unwrap();

        // Drive the whole task: `ceiling` gated shell calls cycling the full
        // toolchain. Every one is a silent allow, and the transport redeems its
        // minted handle for that exact command — proving each authorization is a
        // usable dispatch, not just a decision string. Zero prompts fire.
        for i in 0..ceiling {
            let command = CODING_TOOLCHAIN[(i as usize) % CODING_TOOLCHAIN.len()];
            let decision = s
                .authorize(
                    ToolRoute::Shell,
                    "seren",
                    "execute_command",
                    "conv-coding",
                    &cmd_ctx(command),
                    None,
                )
                .unwrap();
            assert_eq!(
                decision.decision, "allow",
                "call {i} ({command}) must run silently under the derived coding lease"
            );
            let handle = decision
                .handle
                .expect("a silent allow mints a redeemable dispatch handle");
            let binding = binding_for_command(command);
            s.consume_dispatch_handle(
                &handle,
                ToolRoute::Shell,
                "seren",
                "execute_command",
                &binding,
            )
            .unwrap();
        }

        // The budget incremented to the ceiling, one charge per gated call.
        let charged = s
            .list_leases("conv-coding")
            .unwrap()
            .into_iter()
            .find(|l| l.id == lease.id)
            .unwrap();
        assert_eq!(charged.budgets.calls_used, ceiling);

        // The ceiling+1 call exhausts the budget: exactly one scope-escalation, a
        // one-shot prompt — not a silent overrun.
        let exhausted = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-coding",
                &cmd_ctx("cargo build --release"),
                None,
            )
            .unwrap();
        assert_eq!(exhausted.decision, "prompt");
        assert_eq!(exhausted.prompt_kind.as_deref(), Some("one-shot"));

        // The renderer registers the blocked action as one pending request. A
        // deduped retry of the still-blocked task adds no second request — this is
        // what makes exhaustion a single escalation, never a prompt storm.
        s.register_continuation(
            "conv-coding",
            shell_cap("cargo build --release"),
            ContinuationScope::Linear,
            300,
        )
        .unwrap();
        s.register_continuation(
            "conv-coding",
            shell_cap("cargo build --release"),
            ContinuationScope::Linear,
            300,
        )
        .unwrap();

        // Evidence: the on-disk audit trail. Exactly one grant, the full
        // `lease_used` sequence (one per silent call, all keyed to the lease), and
        // exactly one escalation — nothing else, no prompt inside the envelope.
        let entries = s.list_audit("conv-coding", 2000).unwrap();
        let count = |event: &str| entries.iter().filter(|e| e.event == event).count();
        assert_eq!(count("lease_granted"), 1, "one grant");
        assert_eq!(
            count("lease_used"),
            ceiling as usize,
            "one lease_used row per silently-gated call"
        );
        assert_eq!(
            count("approval_requested"),
            1,
            "budget exhaustion escalates exactly once — no prompt storm"
        );
        // Those three event kinds account for every row: no denial, no in-envelope
        // prompt, no durable-decision fallback leaked in.
        assert_eq!(
            entries.len(),
            1 + ceiling as usize + 1,
            "the trail is exactly grant + {ceiling} uses + one escalation"
        );

        // Every lease_used row is attributed to the lease and reduced to the leading
        // program token — the credential-safe detail the matcher keys on.
        let mut used_programs: Vec<&str> = entries
            .iter()
            .filter(|e| e.event == "lease_used")
            .map(|e| {
                assert_eq!(e.subject_id.as_deref(), Some(lease.id.as_str()));
                assert_eq!(e.route.as_deref(), Some("shell"));
                e.detail.as_deref().expect("a lease_used row records its program token")
            })
            .collect();
        used_programs.sort_unstable();
        used_programs.dedup();
        assert_eq!(
            used_programs,
            vec!["cargo", "git", "node", "npm", "pnpm"],
            "the audited sequence spans the whole coding toolchain"
        );

        // Credential safety at scale: no full command line or secret-shaped argument
        // ever reached the persisted trail, only program tokens.
        for entry in &entries {
            let row = serde_json::to_string(entry).unwrap();
            assert!(
                !row.contains("npm_live"),
                "audit row leaked a credential-shaped argument: {row}"
            );
            assert!(
                !row.contains("registry.npmjs.org"),
                "audit row leaked a command argument: {row}"
            );
            assert!(
                !row.contains("--manifest-path"),
                "audit row leaked a command argument: {row}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- standing policies (#3193-E) — headless pre-authorization -----------

    fn standing_policy_input(
        label: &str,
        enabled: bool,
        duration_secs: i64,
        predicates: LeasePredicates,
        budgets: LeaseBudgets,
    ) -> StandingPolicyInput {
        StandingPolicyInput {
            label: label.to_string(),
            enabled,
            max_duration_secs: duration_secs,
            predicates,
            budgets,
        }
    }

    /// The core headless path: a conversation with **no prior lease** and no human
    /// present runs an in-policy shell command end-to-end with zero prompts,
    /// because the owner's enabled standing policy auto-materializes a bounded
    /// lease. The materialized lease is attributed to its source policy and its
    /// budget is charged, and the audit trail records both the auto-grant and the
    /// use.
    #[test]
    fn standing_policy_auto_materializes_a_lease_for_an_unattended_conversation() {
        let s = state();
        let policy = s
            .create_standing_policy(standing_policy_input(
                "Unattended coding",
                true,
                4 * 3600,
                command_rules(&["cargo", "pnpm", "git"]),
                call_budget(500),
            ))
            .unwrap();

        // No lease exists yet for this fresh conversation.
        assert!(s.list_leases("conv-unattended").unwrap().is_empty());

        let decision = s
            .authorize(
                ToolRoute::Shell,
                "seren",
                "execute_command",
                "conv-unattended",
                &cmd_ctx("cargo test --manifest-path src-tauri/Cargo.toml"),
                None,
            )
            .unwrap();
        assert_eq!(decision.decision, "allow", "in-policy work must not prompt");
        assert!(decision.handle.is_some(), "an allow must carry a dispatch handle");

        // Exactly one lease was minted, attributed to the policy, and charged.
        let leases = s.list_leases("conv-unattended").unwrap();
        assert_eq!(leases.len(), 1, "one auto-materialized lease");
        assert_eq!(leases[0].source_policy_id.as_deref(), Some(policy.id.as_str()));
        assert_eq!(leases[0].budgets.calls_used, 1);

        // A second in-policy call runs silently under the same lease (no re-mint).
        let second = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-unattended", &cmd_ctx("pnpm check"), None)
            .unwrap();
        assert_eq!(second.decision, "allow");
        assert_eq!(s.list_leases("conv-unattended").unwrap().len(), 1, "still one lease");

        let events: Vec<String> = s
            .list_audit("conv-unattended", 50)
            .unwrap()
            .into_iter()
            .map(|entry| entry.event)
            .collect();
        assert!(events.iter().any(|e| e == "lease_auto_granted"), "auto-grant audited");
        assert!(events.iter().any(|e| e == "lease_used"), "use audited");
    }

    /// A standing policy pre-authorizes only within its predicates: a command it
    /// does not list, and a high-risk publisher op it did not opt into, both still
    /// produce a single scope-escalation rather than a silent auto-grant.
    #[test]
    fn standing_policy_only_pre_authorizes_within_its_predicates() {
        let s = state();
        s.create_standing_policy(standing_policy_input(
            "Unattended coding",
            true,
            3600,
            command_rules(&["cargo"]),
            call_budget(500),
        ))
        .unwrap();

        // An unlisted program is out of policy — one escalation, no lease minted.
        let out = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("rm -rf /"), None)
            .unwrap();
        assert_eq!(out.decision, "prompt");
        assert_eq!(out.prompt_kind.as_deref(), Some("one-shot"));
        assert!(s.list_leases("conv-a").unwrap().is_empty(), "no lease for out-of-policy work");
    }

    /// A high-risk / outbound-send publisher op is not silently pre-authorized by
    /// a policy that did not explicitly opt into high-risk for that publisher — it
    /// still requires an explicit one-shot approval.
    #[test]
    fn standing_policy_does_not_auto_cover_unopted_high_risk_ops() {
        let s = state();
        let predicates = LeasePredicates {
            publisher_ops: vec![capability_lease::PublisherRule {
                publisher_slug: "gmail".to_string(),
                allow_high_risk: false,
                target: None,
            }],
            ..Default::default()
        };
        s.create_standing_policy(standing_policy_input("Gmail reads", true, 3600, predicates, call_budget(100)))
            .unwrap();
        // Sending mail is high-risk; the policy did not opt into it.
        let decision = s
            .authorize(ToolRoute::Gateway, "gmail", "post_send", "conv-a", &ctx(), Some(&serde_json::json!({"to": "x"})))
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert_eq!(decision.prompt_kind.as_deref(), Some("one-shot"));
        assert!(s.list_leases("conv-a").unwrap().is_empty());
    }

    /// A disabled policy grants nothing: in-policy work escalates exactly as if no
    /// policy existed, and enabling it (via update) then makes the same call run
    /// silently — proving the toggle is the control point.
    #[test]
    fn disabled_standing_policy_grants_nothing_until_enabled() {
        let s = state();
        let policy = s
            .create_standing_policy(standing_policy_input(
                "Unattended coding",
                false,
                3600,
                command_rules(&["cargo"]),
                call_budget(500),
            ))
            .unwrap();
        let blocked = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(blocked.decision, "prompt", "a disabled policy must not auto-grant");
        assert!(s.list_leases("conv-a").unwrap().is_empty());

        // Enabling it makes the same call run silently on a fresh conversation.
        s.update_standing_policy(
            &policy.id,
            standing_policy_input("Unattended coding", true, 3600, command_rules(&["cargo"]), call_budget(500)),
        )
        .unwrap()
        .expect("policy exists");
        let allowed = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-b", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(allowed.decision, "allow");
    }

    /// Deleting a policy stops future auto-grants immediately.
    #[test]
    fn deleting_a_standing_policy_stops_auto_grants() {
        let s = state();
        let policy = s
            .create_standing_policy(standing_policy_input(
                "Unattended coding",
                true,
                3600,
                command_rules(&["cargo"]),
                call_budget(500),
            ))
            .unwrap();
        assert!(s.delete_standing_policy(&policy.id).unwrap());
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-fresh", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(decision.decision, "prompt");
        assert!(!s.delete_standing_policy(&policy.id).unwrap(), "second delete is a no-op");
    }

    /// An auto-lease is bounded: once its budget is exhausted the next in-policy
    /// call re-escalates rather than silently minting a *fresh* lease from the same
    /// policy. Exactly one lease is ever materialized per conversation+policy.
    #[test]
    fn exhausted_auto_lease_budget_re_escalates_without_reminting() {
        let s = state();
        s.create_standing_policy(standing_policy_input(
            "One-shot budget",
            true,
            3600,
            command_rules(&["cargo"]),
            call_budget(1),
        ))
        .unwrap();

        let first = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(first.decision, "allow", "first in-budget call runs silently");

        let second = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo test"), None)
            .unwrap();
        assert_eq!(second.decision, "prompt", "exhausted budget re-escalates");
        assert_eq!(
            s.list_leases("conv-a").unwrap().len(),
            1,
            "the policy must not re-mint a fresh lease to dodge its own budget",
        );
    }

    /// Revoking an auto-materialized lease is immediate and durable: the policy
    /// does not silently re-grant a replacement on the next call.
    #[test]
    fn revoking_an_auto_lease_is_not_undone_by_the_policy() {
        let s = state();
        s.create_standing_policy(standing_policy_input(
            "Unattended coding",
            true,
            3600,
            command_rules(&["cargo"]),
            call_budget(500),
        ))
        .unwrap();
        s.authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        let lease = s.list_leases("conv-a").unwrap().remove(0);
        assert!(s.revoke_lease(&lease.id).unwrap());
        let after = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(after.decision, "prompt", "a revoked auto-lease is not silently re-granted");
        assert_eq!(s.list_leases("conv-a").unwrap().len(), 1, "no replacement lease minted");
    }

    /// The model reaches the host only through `authorize` (and dispatch/reserve/
    /// settle). None of those write a policy: with an empty policy store, an
    /// in-policy-looking call still escalates — the model can never conjure a
    /// standing policy or a lease. Only the owner `create_standing_policy` path
    /// writes one.
    #[test]
    fn the_gate_path_cannot_author_a_standing_policy() {
        let s = state();
        // No owner policy exists.
        assert!(s.list_standing_policies().unwrap().is_empty());
        let decision = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(decision.decision, "prompt", "the gate cannot self-author a policy");
        assert!(s.list_standing_policies().unwrap().is_empty(), "authorize wrote no policy");
        assert!(s.list_leases("conv-a").unwrap().is_empty());
    }

    /// Validation guards: a policy needs a label and a positive lease duration.
    #[test]
    fn create_standing_policy_rejects_invalid_input() {
        let s = state();
        assert!(
            s.create_standing_policy(standing_policy_input("", true, 3600, LeasePredicates::default(), call_budget(1)))
                .is_err()
        );
        assert!(
            s.create_standing_policy(standing_policy_input("x", true, 0, LeasePredicates::default(), call_budget(1)))
                .is_err()
        );
    }

    /// #3296 guard: when a covering auto-lease already exists for the conversation
    /// (as a concurrent first-call would have minted) *and* a matching enabled
    /// policy is still present, a further in-policy call runs silently under the
    /// existing lease and mints **no** second lease — the policy hook must never
    /// double-mint. (The pure race that motivated this — the loser of two
    /// simultaneous first-calls — is a threading window that a single-threaded
    /// test cannot deterministically reproduce; this pins the adjacent
    /// no-double-mint invariant the fix relies on.)
    #[test]
    fn a_matching_policy_never_double_mints_over_an_existing_auto_lease() {
        let s = state();
        s.create_standing_policy(standing_policy_input(
            "Unattended coding",
            true,
            3600,
            command_rules(&["cargo"]),
            call_budget(500),
        ))
        .unwrap();

        // First in-policy call materializes exactly one lease.
        let first = s
            .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx("cargo build"), None)
            .unwrap();
        assert_eq!(first.decision, "allow");
        let leases = s.list_leases("conv-a").unwrap();
        assert_eq!(leases.len(), 1);
        let lease_id = leases[0].id.clone();

        // Further in-policy calls run under that same lease; the policy still
        // matches but must not mint a second lease.
        for command in ["cargo test", "cargo clippy", "cargo fmt"] {
            let decision = s
                .authorize(ToolRoute::Shell, "seren", "execute_command", "conv-a", &cmd_ctx(command), None)
                .unwrap();
            assert_eq!(decision.decision, "allow", "{command} runs under the existing lease");
        }
        let after = s.list_leases("conv-a").unwrap();
        assert_eq!(after.len(), 1, "no second lease minted");
        assert_eq!(after[0].id, lease_id, "same lease throughout");
        assert_eq!(after[0].budgets.calls_used, 4, "all four calls charged one lease");
    }
}
