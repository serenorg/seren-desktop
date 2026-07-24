// ABOUTME: Host-owned authorization gate for every model-originated tool call.
// ABOUTME: Owns classification and a persisted, conversation-scoped decision store; the renderer only displays and dispatches.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

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

    /// The gate: classify, then resolve against the persisted store. High-risk
    /// operations always prompt (one-shot) and are never persisted; trusted reads
    /// run silently; unclassified operations reuse a stored grant/denial or prompt
    /// once for a session decision.
    pub fn authorize(
        &self,
        route: ToolRoute,
        publisher_slug: &str,
        tool_name: &str,
        conversation_id: &str,
    ) -> Result<AuthorizationDecision, String> {
        let class = classify_for_route(route, publisher_slug, tool_name);

        if class == OperationClass::TrustedRead {
            return Ok(AuthorizationDecision::allow(class));
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

    /// Erase every stored decision. Backs the one-shot "erase all local
    /// conversation data" flow; the next access lazily reopens an empty store.
    pub fn wipe(&self) -> Result<usize, String> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM tool_decisions", [])
                .map_err(|e| e.to_string())
        })
    }
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
            .authorize(ToolRoute::Gateway, "gmail", "get_messages", "conv-a")
            .unwrap();
        assert_eq!(decision.decision, "allow");
        assert_eq!(decision.prompt_kind, None);
    }

    #[test]
    fn high_risk_prompts_one_shot_and_never_persists() {
        let s = state();
        for _ in 0..2 {
            let decision = s
                .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a")
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
            .authorize(ToolRoute::Gateway, "gmail", "delete_messages_by_message_id", "conv-a")
            .unwrap();
        assert_eq!(decision.decision, "prompt", "still one-shot after a recorded approval");
    }

    #[test]
    fn unclassified_prompts_once_then_reuses_the_grant() {
        let s = state();
        let first = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a")
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a")
            .unwrap();
        assert_eq!(second.decision, "allow");
    }

    #[test]
    fn unclassified_denial_is_durable() {
        let s = state();
        s.authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a")
            .unwrap();
        s.record_decision(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a", false)
            .unwrap();
        let decision = s
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a")
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-b")
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn a_newly_seen_publisher_is_never_silently_allowed() {
        let s = state();
        let decision = s
            .authorize(ToolRoute::Gateway, "never-seen", "inspect_everything", "conv-a")
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
            .authorize(ToolRoute::Gateway, "new-publisher", "inspect_records", "conv-a")
            .unwrap();
        assert_eq!(decision.decision, "prompt");
    }

    #[test]
    fn route_parse_rejects_unknown_routes() {
        assert!(ToolRoute::parse("gateway").is_ok());
        assert!(ToolRoute::parse("web").is_ok());
        assert!(ToolRoute::parse("bogus").is_err());
    }
}
