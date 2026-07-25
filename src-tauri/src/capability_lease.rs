// ABOUTME: Task/session capability-lease model + deterministic matcher for the host authorization gate.
// ABOUTME: A lease pre-approves a bounded envelope (predicates + budgets) so work runs silently without per-call prompts.

use serde::{Deserialize, Serialize};

use crate::tool_authorization::{OperationClass, ToolRoute};

/// A shell/skill command the lease pre-approves, identified by its leading
/// executable token (e.g. `cargo`, `pnpm`, `git`). Arguments may vary — the
/// point of a lease is that a build/test/format command runs without a fresh
/// prompt for every invocation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRule {
    /// Lowercased program name, matched against the command's first token.
    pub program: String,
}

/// A publisher/operation predicate. `publisher_slug` may be `*` to cover any
/// publisher. `allow_high_risk` gates whether the rule extends to operations the
/// classifier flags high-risk (destructive/monetary/outbound/credential); a
/// coding lease leaves it false so a `post_send` still needs an exact one-shot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherRule {
    pub publisher_slug: String,
    #[serde(default)]
    pub allow_high_risk: bool,
    /// Resource/account/connection this rule is scoped to. `None` means any
    /// target; `Some(id)` means the call's target must match exactly, so a lease
    /// for one repository/account does not silently cover another.
    #[serde(default)]
    pub target: Option<String>,
}

/// An explicit deny predicate. Any field left `None` is a wildcard. A single
/// matching exclusion denies the call regardless of what any allow-predicate
/// says — this is how `deny > prompt > allow` is enforced within a lease.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub publisher_slug: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub program: Option<String>,
}

/// The predicate surface a lease pre-approves. Only the dimensions the gate's
/// live routes evaluate are modeled here: command rules (shell/skill), network
/// hosts (web), and publisher operations with a resource constraint
/// (gateway/seren/mcp). Filesystem-root enforcement stays in
/// `orchestrator/file_access_policy.rs`; model-originated file tools never reach
/// this gate.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeasePredicates {
    #[serde(default)]
    pub command_rules: Vec<CommandRule>,
    #[serde(default)]
    pub network_hosts: Vec<String>,
    #[serde(default)]
    pub publisher_ops: Vec<PublisherRule>,
    #[serde(default)]
    pub exclusions: Vec<Exclusion>,
}

/// Consumable limits. A lease is bounded by predicates *and* budgets: even a
/// covered call is escalated once a budget is exhausted, producing a single
/// scope-escalation request rather than silently running unbounded work.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseBudgets {
    /// Total call count across every route the lease covers. `None` = unmetered.
    #[serde(default)]
    pub max_calls: Option<u64>,
    #[serde(default)]
    pub calls_used: u64,
    /// Monetary ceiling in micro-units of `asset` (e.g. USDC micros). `None` =
    /// no monetary allowance; any priced call escalates.
    #[serde(default)]
    pub max_spend_micros: Option<u64>,
    #[serde(default)]
    pub spend_used_micros: u64,
    #[serde(default)]
    pub asset: Option<String>,
    /// Rate limit: at most `max_calls_per_window` covered calls within each
    /// rolling `window_secs` window. Both must be set for the limit to apply.
    /// Bounds a runaway autonomous loop even under an approved lease, on top of
    /// the total `max_calls` ceiling.
    #[serde(default)]
    pub max_calls_per_window: Option<u64>,
    #[serde(default)]
    pub window_secs: Option<i64>,
    /// End instant (RFC3339 UTC) of the current window, or `None` before the
    /// first call opens one. A call arriving after this instant opens a fresh
    /// window, so an idle lease is never permanently rate-blocked.
    #[serde(default)]
    pub window_ends_at: Option<String>,
    #[serde(default)]
    pub calls_in_window: u64,
    // Data-egress budget (max outbound bytes under this lease) is intentionally
    // not implemented: no consumer authors a byte budget today, and enforcing it
    // needs an `egress_bytes` measure threaded onto `OperationRequest`. Deferred
    // to serenorg/seren-desktop#3337 until a consumer needs it (YAGNI).
}

impl LeaseBudgets {
    /// Reject a rate limit that can never fire. `max_calls_per_window` only
    /// applies while a window is open, and a window is only opened when
    /// `window_secs` is set — so a per-window cap with no window length (or a
    /// window length with no cap) is silently unenforced. Require both or
    /// neither at grant time rather than accepting the misconfiguration (#3349).
    pub fn validate(&self) -> Result<(), String> {
        if self.max_calls_per_window.is_some() != self.window_secs.is_some() {
            return Err(
                "a rate limit needs both max_calls_per_window and window_secs, or neither"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// Whether charging `cost_micros` for one more call at `now` stays within
    /// budget. `now` is an RFC3339 UTC instant, compared lexicographically
    /// against the rate window's end.
    fn admits(&self, cost_micros: u64, now: &str) -> bool {
        if let Some(max) = self.max_calls
            && self.calls_used.saturating_add(1) > max
        {
            return false;
        }
        // Rate window: only enforce while the current window is still open. A
        // window with no end (never opened) or one already closed does not block
        // — the charge opens a fresh window for that call.
        if let Some(max_per_window) = self.max_calls_per_window
            && let Some(window_ends_at) = &self.window_ends_at
            && now < window_ends_at.as_str()
            && self.calls_in_window.saturating_add(1) > max_per_window
        {
            return false;
        }
        if cost_micros > 0 {
            match self.max_spend_micros {
                // A priced call with no monetary allowance is not covered.
                None => return false,
                Some(max) => {
                    if self.spend_used_micros.saturating_add(cost_micros) > max {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// Whether this budget can absorb `cost_micros` of `asset` spend, independent
    /// of the call-count budget. Used when the realized price of a call is known
    /// only after the gate has already charged the call slot (the x402 402), so
    /// re-checking `admits` would spuriously fail on the last call of a
    /// call-metered lease. Asset-aware: a lease that pins an `asset` only absorbs
    /// spend in that asset — a mismatch is not admitted (the caller escalates
    /// rather than mis-charging a differently-denominated budget). A lease with no
    /// pinned `asset` treats its ceiling as denominating whatever is charged.
    pub fn admits_spend(&self, cost_micros: u64, asset: &str) -> bool {
        if cost_micros == 0 {
            return true;
        }
        if let Some(granted) = &self.asset
            && !granted.eq_ignore_ascii_case(asset)
        {
            return false;
        }
        match self.max_spend_micros {
            // A priced call with no monetary allowance is not covered.
            None => false,
            Some(max) => self.spend_used_micros.saturating_add(cost_micros) <= max,
        }
    }

    /// Consume `cost_micros` of the monetary budget. Saturating so a settlement
    /// that reconciles upward can never wrap the counter.
    pub fn charge_spend(&mut self, cost_micros: u64) {
        self.spend_used_micros = self.spend_used_micros.saturating_add(cost_micros);
    }

    /// Release `cost_micros` previously charged (a reservation whose payment never
    /// settled, or the over-reserved portion of a settlement). Saturating so a
    /// double release can never underflow the counter below zero.
    pub fn release_spend(&mut self, cost_micros: u64) {
        self.spend_used_micros = self.spend_used_micros.saturating_sub(cost_micros);
    }
}

/// A persisted, thread-scoped capability lease. Bound to a conversation (the only
/// local task/session identifier), a start/expiry window, and a revocation flag.
/// The model may *request* one but never mint it: leases are created only by the
/// host-side grant command a user's approval invokes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityLease {
    pub id: String,
    /// Thread binding — matches the gate's decision store key.
    pub conversation_id: String,
    /// Human-readable summary of the approved envelope, shown at review time.
    pub label: String,
    pub created_at: String,
    /// RFC3339 UTC instant after which the lease no longer matches.
    pub expires_at: String,
    #[serde(default)]
    pub revoked: bool,
    /// The standing policy this lease was auto-materialized from (#3193-E), or
    /// `None` for a human-granted lease. Purely attributive: it lets the audit
    /// trail say "auto-granted from standing policy <id>" and lets the resolver
    /// avoid re-minting a fresh lease for a policy that already produced one for
    /// this conversation (so an exhausted budget or expiry re-escalates instead
    /// of silently regranting).
    #[serde(default)]
    pub source_policy_id: Option<String>,
    pub predicates: LeasePredicates,
    pub budgets: LeaseBudgets,
}

impl CapabilityLease {
    /// Active = bound to this conversation, not revoked, not expired at `now`.
    /// `now` and `expires_at` are RFC3339 UTC strings; lexicographic comparison
    /// is a correct time ordering for that fixed format.
    pub fn is_active(&self, conversation_id: &str, now: &str) -> bool {
        !self.revoked && self.conversation_id == conversation_id && self.expires_at.as_str() > now
    }
}

/// The normalized call the matcher evaluates. The renderer supplies the route,
/// publisher/tool identity, and the small argument slice a predicate needs; the
/// host owns classification (`class`).
#[derive(Clone, Debug)]
pub struct OperationRequest {
    pub route: ToolRoute,
    pub class: OperationClass,
    pub publisher_slug: String,
    pub tool_name: String,
    /// Shell/skill command line; its first token is matched against command rules.
    pub command: Option<String>,
    /// Web-fetch host (already extracted from the URL by the caller).
    pub host: Option<String>,
    /// Publisher resource/account/connection identifier, if the call names one.
    pub target: Option<String>,
    /// Declared monetary cost of this call in micro-units. 0 when free/unknown.
    pub cost_micros: u64,
}

/// The matcher's verdict for one call against the active lease set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseOutcome {
    /// A lease's exclusion matched — deny outright, beating every allow.
    Deny,
    /// A lease covers the call and its budget admits it; `String` is the lease id
    /// to charge.
    Allow(String),
    /// No active lease covers the call, or the only covering lease is out of
    /// budget. The caller escalates (prompts) exactly once.
    Escalate,
}

/// Leading executable token of a command line, lowercased. Mirrors the gate's
/// operation tokenizer so `"cargo build --release"` → `"cargo"`.
pub fn command_program(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .next()
        .map(|token| {
            // Strip a path prefix so `/usr/bin/git` matches a `git` rule.
            token
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(token)
                .to_lowercase()
        })
        .filter(|program| !program.is_empty())
}

/// Host suffix match: an entry `example.com` covers `example.com` and
/// `api.example.com`, but not `notexample.com`. Case-insensitive.
fn host_matches(rule: &str, host: &str) -> bool {
    let rule = rule.trim().trim_start_matches('.').to_lowercase();
    let host = host.trim().to_lowercase();
    if rule.is_empty() {
        return false;
    }
    host == rule || host.ends_with(&format!(".{rule}"))
}

fn exclusion_matches(exclusion: &Exclusion, req: &OperationRequest) -> bool {
    // Every specified field must match; an all-`None` exclusion is ignored rather
    // than denying everything (that would be a footgun, not a policy).
    let mut constrained = false;
    if let Some(route) = &exclusion.route {
        constrained = true;
        if !route.eq_ignore_ascii_case(req.route.as_wire()) {
            return false;
        }
    }
    if let Some(publisher) = &exclusion.publisher_slug {
        constrained = true;
        if publisher != &req.publisher_slug {
            return false;
        }
    }
    if let Some(tool) = &exclusion.tool_name {
        constrained = true;
        if tool != &req.tool_name {
            return false;
        }
    }
    if let Some(host) = &exclusion.host {
        constrained = true;
        match &req.host {
            Some(req_host) if host_matches(host, req_host) => {}
            _ => return false,
        }
    }
    if let Some(program) = &exclusion.program {
        constrained = true;
        let matched = req
            .command
            .as_deref()
            .and_then(command_program)
            .is_some_and(|actual| actual == program.to_lowercase());
        if !matched {
            return false;
        }
    }
    constrained
}

/// Whether a lease's predicates cover this call. Coverage is route-specific and
/// deliberately conservative: an unmatched route/predicate is never covered.
fn predicates_cover(lease: &CapabilityLease, req: &OperationRequest) -> bool {
    match req.route {
        ToolRoute::Shell | ToolRoute::Skill => {
            let Some(program) = req.command.as_deref().and_then(command_program) else {
                return false;
            };
            lease
                .predicates
                .command_rules
                .iter()
                .any(|rule| rule.program.to_lowercase() == program)
        }
        ToolRoute::Web => {
            let Some(host) = req.host.as_deref() else {
                return false;
            };
            lease
                .predicates
                .network_hosts
                .iter()
                .any(|entry| host_matches(entry, host))
        }
        ToolRoute::Gateway | ToolRoute::Seren | ToolRoute::Mcp => {
            lease.predicates.publisher_ops.iter().any(|rule| {
                let publisher_ok =
                    rule.publisher_slug == "*" || rule.publisher_slug == req.publisher_slug;
                let risk_ok = req.class != OperationClass::HighRisk || rule.allow_high_risk;
                let target_ok = match &rule.target {
                    None => true,
                    Some(target) => req.target.as_deref() == Some(target.as_str()),
                };
                publisher_ok && risk_ok && target_ok
            })
        }
    }
}

/// Evaluate one call against the leases bound to `conversation_id` with
/// `deny > allow` resolution.
///
/// Deny wins: if any active lease excludes the call, the verdict is `Deny` even
/// when another predicate would allow it. Otherwise the first covering lease
/// whose budget admits the call yields `Allow`; if a lease covers but is out of
/// budget and nothing else covers, the verdict is `Escalate` (one
/// scope-escalation request), never a silent allow.
pub fn evaluate_for_conversation(
    leases: &[CapabilityLease],
    req: &OperationRequest,
    conversation_id: &str,
    now: &str,
) -> LeaseOutcome {
    let active: Vec<&CapabilityLease> = leases
        .iter()
        .filter(|lease| lease.is_active(conversation_id, now))
        .collect();

    // Deny beats everything: one matching exclusion on any active lease wins.
    for lease in &active {
        if lease
            .predicates
            .exclusions
            .iter()
            .any(|exclusion| exclusion_matches(exclusion, req))
        {
            return LeaseOutcome::Deny;
        }
    }

    // First lease that both covers the call and has budget for it.
    for lease in &active {
        if predicates_cover(lease, req) && lease.budgets.admits(req.cost_micros, now) {
            return LeaseOutcome::Allow(lease.id.clone());
        }
    }

    LeaseOutcome::Escalate
}

/// The matcher's verdict for charging a realized monetary cost against the lease
/// that already authorized a call. Distinct from `LeaseOutcome`: by the time a
/// price is realized (the x402 402), the call has already passed the gate — this
/// decides only whether the covering lease's *monetary* budget absorbs the cost.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpendOutcome {
    /// A covering lease absorbs the cost; `String` is the lease id to charge.
    Charge(String),
    /// A lease covers the call's predicates but cannot absorb this spend (no
    /// monetary allowance, over budget, a mismatched asset, or an exclusion) —
    /// the caller escalates *before* paying rather than silently overspending.
    Escalate,
    /// No active lease covers the call: it is not running inside a lease
    /// envelope, so no lease budget applies and the caller uses its own payment
    /// gate (the x402 approval UI), exactly as before this wiring existed.
    Uncovered,
}

/// Decide how a realized `cost_micros` of `asset` charges against the leases
/// bound to `conversation_id` for a call that has already been authorized.
///
/// Resolution mirrors `evaluate_for_conversation`'s `deny > allow` ordering: a
/// matching exclusion on any active lease escalates (a covered-then-excluded call
/// must never silently pay). Otherwise the first lease that covers the predicates
/// *and* whose monetary budget admits the spend is charged; if a lease covers the
/// predicates but none admits the spend, the verdict is `Escalate`; if nothing
/// covers the predicates, the verdict is `Uncovered`.
pub fn spend_for_conversation(
    leases: &[CapabilityLease],
    req: &OperationRequest,
    asset: &str,
    cost_micros: u64,
    conversation_id: &str,
    now: &str,
) -> SpendOutcome {
    let active: Vec<&CapabilityLease> = leases
        .iter()
        .filter(|lease| lease.is_active(conversation_id, now))
        .collect();

    // Deny still beats everything: a call an exclusion would deny must not
    // silently pay under a broader allow.
    for lease in &active {
        if lease
            .predicates
            .exclusions
            .iter()
            .any(|exclusion| exclusion_matches(exclusion, req))
        {
            return SpendOutcome::Escalate;
        }
    }

    let mut covered = false;
    for lease in &active {
        if predicates_cover(lease, req) {
            covered = true;
            if lease.budgets.admits_spend(cost_micros, asset) {
                return SpendOutcome::Charge(lease.id.clone());
            }
        }
    }

    if covered {
        SpendOutcome::Escalate
    } else {
        SpendOutcome::Uncovered
    }
}

// ============================================================================
// Capability-bundle derivation
//
// At task start the host derives a *proposed* bundle the user reviews once. This
// produces the proposal only — it never grants authority. The model may request
// a bundle this way but cannot approve or widen it; only a human-invoked grant
// persists a lease.
// ============================================================================

/// The default shell programs a coding task needs: this project's documented
/// build/test/format/VCS toolchain. Anything outside this set escalates once, so
/// a coding lease does not silently cover arbitrary shell execution.
const CODING_COMMAND_PROGRAMS: &[&str] = &["cargo", "pnpm", "npm", "node", "git"];

/// Default call ceiling for a derived coding bundle. Sized so an ordinary
/// long-running coding task (edits, searches, builds, tests) completes under one
/// lease, per the acceptance criteria, while still bounding runaway loops.
const CODING_DEFAULT_MAX_CALLS: u64 = 500;

/// The task profile the (slice-D) approval UI selects, plus any plan-specific
/// predicates it wants folded into the proposal. Derivation is pure: it maps this
/// request to concrete predicates and default budgets for review.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleRequest {
    /// `"coding"` seeds the workspace toolchain; any other value seeds nothing and
    /// relies solely on the explicit predicates below.
    #[serde(default)]
    pub profile: String,
    /// Extra shell programs to pre-approve beyond the profile defaults.
    #[serde(default)]
    pub extra_commands: Vec<String>,
    /// Publisher operations (with optional resource/account constraints) the plan
    /// needs — e.g. issue/PR operations scoped to one repository.
    #[serde(default)]
    pub publisher_ops: Vec<PublisherRule>,
    /// Hosts to pre-approve for web fetches (package registries, docs).
    #[serde(default)]
    pub network_hosts: Vec<String>,
    /// Explicit exclusions carried straight into the proposal.
    #[serde(default)]
    pub exclusions: Vec<Exclusion>,
    /// Requested lifetime; the grant command stamps the real expiry.
    #[serde(default)]
    pub duration_secs: i64,
    /// Overrides the default call ceiling when set.
    #[serde(default)]
    pub max_calls: Option<u64>,
    #[serde(default)]
    pub max_spend_micros: Option<u64>,
    #[serde(default)]
    pub asset: Option<String>,
}

/// A reviewable, editable proposal. Carries no id, timestamps, or grant — those
/// are minted only when a user approves it via the grant command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedBundle {
    pub label: String,
    pub duration_secs: i64,
    pub predicates: LeasePredicates,
    pub budgets: LeaseBudgets,
}

/// Turn a task profile into a concrete, editable capability proposal. Pure and
/// side-effect-free.
pub fn derive_bundle(request: &BundleRequest) -> ProposedBundle {
    let mut programs: Vec<String> = Vec::new();
    if request.profile == "coding" {
        programs.extend(CODING_COMMAND_PROGRAMS.iter().map(|p| p.to_string()));
    }
    for extra in &request.extra_commands {
        let normalized = extra.trim().to_lowercase();
        if !normalized.is_empty() && !programs.contains(&normalized) {
            programs.push(normalized);
        }
    }
    let command_rules = programs
        .into_iter()
        .map(|program| CommandRule { program })
        .collect();

    let predicates = LeasePredicates {
        command_rules,
        network_hosts: request.network_hosts.clone(),
        publisher_ops: request.publisher_ops.clone(),
        exclusions: request.exclusions.clone(),
    };

    let budgets = LeaseBudgets {
        max_calls: Some(request.max_calls.unwrap_or(CODING_DEFAULT_MAX_CALLS)),
        calls_used: 0,
        max_spend_micros: request.max_spend_micros,
        spend_used_micros: 0,
        asset: request.asset.clone(),
        ..Default::default()
    };

    let label = if request.profile == "coding" {
        "Coding task capability lease".to_string()
    } else {
        "Task capability lease".to_string()
    };

    ProposedBundle {
        label,
        duration_secs: request.duration_secs,
        predicates,
        budgets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-07-24T00:00:00Z";
    const LATER: &str = "2026-07-24T04:00:00Z";
    const PAST: &str = "2026-07-23T00:00:00Z";

    #[test]
    fn validate_rejects_a_rate_cap_that_can_never_fire() {
        // A per-window cap with no window length (or vice versa) is silently
        // unenforced, so grant-time validation must reject it.
        let cap_without_window = LeaseBudgets {
            max_calls_per_window: Some(5),
            window_secs: None,
            ..LeaseBudgets::default()
        };
        assert!(cap_without_window.validate().is_err());

        let window_without_cap = LeaseBudgets {
            max_calls_per_window: None,
            window_secs: Some(60),
            ..LeaseBudgets::default()
        };
        assert!(window_without_cap.validate().is_err());

        let both = LeaseBudgets {
            max_calls_per_window: Some(5),
            window_secs: Some(60),
            ..LeaseBudgets::default()
        };
        assert!(both.validate().is_ok());

        assert!(LeaseBudgets::default().validate().is_ok());
    }

    fn lease(predicates: LeasePredicates, budgets: LeaseBudgets) -> CapabilityLease {
        CapabilityLease {
            id: "lease-1".to_string(),
            conversation_id: "conv-a".to_string(),
            label: "test lease".to_string(),
            created_at: NOW.to_string(),
            expires_at: LATER.to_string(),
            revoked: false,
            source_policy_id: None,
            predicates,
            budgets,
        }
    }

    fn shell_req(command: &str) -> OperationRequest {
        OperationRequest {
            route: ToolRoute::Shell,
            class: OperationClass::HighRisk,
            publisher_slug: "seren".to_string(),
            tool_name: "execute_command".to_string(),
            command: Some(command.to_string()),
            host: None,
            target: None,
            cost_micros: 0,
        }
    }

    fn gateway_req(publisher: &str, tool: &str, class: OperationClass) -> OperationRequest {
        OperationRequest {
            route: ToolRoute::Gateway,
            class,
            publisher_slug: publisher.to_string(),
            tool_name: tool.to_string(),
            command: None,
            host: None,
            target: None,
            cost_micros: 0,
        }
    }

    fn eval(leases: &[CapabilityLease], req: &OperationRequest, now: &str) -> LeaseOutcome {
        evaluate_for_conversation(leases, req, "conv-a", now)
    }

    // ---- command tokenizing ---------------------------------------------

    #[test]
    fn command_program_strips_paths_and_lowercases() {
        assert_eq!(command_program("cargo build").as_deref(), Some("cargo"));
        assert_eq!(command_program("/usr/bin/GIT status").as_deref(), Some("git"));
        assert_eq!(command_program("   pnpm   test  ").as_deref(), Some("pnpm"));
        assert_eq!(command_program("").as_deref(), None);
    }

    // ---- command-rule coverage (the 500-call coding task) ---------------

    #[test]
    fn command_lease_covers_matching_program_regardless_of_args() {
        let l = lease(
            LeasePredicates {
                command_rules: vec![
                    CommandRule { program: "cargo".to_string() },
                    CommandRule { program: "pnpm".to_string() },
                    CommandRule { program: "git".to_string() },
                ],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        for command in [
            "cargo build --release",
            "cargo test --manifest-path src-tauri/Cargo.toml",
            "pnpm check",
            "git status",
        ] {
            assert_eq!(
                eval(&[l.clone()], &shell_req(command), NOW),
                LeaseOutcome::Allow("lease-1".to_string()),
                "{command} should be covered"
            );
        }
    }

    #[test]
    fn command_lease_escalates_an_unlisted_program() {
        let l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        assert_eq!(eval(&[l], &shell_req("rm -rf /"), NOW), LeaseOutcome::Escalate);
    }

    // ---- publisher + resource coverage ----------------------------------

    #[test]
    fn publisher_lease_covers_unclassified_ops_but_not_high_risk_by_default() {
        let l = lease(
            LeasePredicates {
                publisher_ops: vec![PublisherRule {
                    publisher_slug: "attio".to_string(),
                    allow_high_risk: false,
                    target: None,
                }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(100), ..Default::default() },
        );
        assert_eq!(
            eval(&[l.clone()], &gateway_req("attio", "post_notes", OperationClass::Unclassified), NOW),
            LeaseOutcome::Allow("lease-1".to_string()),
        );
        // A high-risk op on the same publisher is not covered without opt-in.
        assert_eq!(
            eval(&[l], &gateway_req("attio", "delete_records", OperationClass::HighRisk), NOW),
            LeaseOutcome::Escalate,
        );
    }

    #[test]
    fn publisher_lease_target_constraint_scopes_to_one_resource() {
        let l = lease(
            LeasePredicates {
                publisher_ops: vec![PublisherRule {
                    publisher_slug: "github".to_string(),
                    allow_high_risk: true,
                    target: Some("serenorg/seren-desktop".to_string()),
                }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(100), ..Default::default() },
        );
        let mut in_scope = gateway_req("github", "post_issues", OperationClass::Unclassified);
        in_scope.target = Some("serenorg/seren-desktop".to_string());
        assert_eq!(eval(&[l.clone()], &in_scope, NOW), LeaseOutcome::Allow("lease-1".to_string()));

        let mut other_repo = gateway_req("github", "post_issues", OperationClass::Unclassified);
        other_repo.target = Some("serenorg/other".to_string());
        assert_eq!(eval(&[l], &other_repo, NOW), LeaseOutcome::Escalate);
    }

    // ---- deny > allow ----------------------------------------------------

    #[test]
    fn exclusion_denies_even_when_a_predicate_would_allow() {
        let l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "git".to_string() }],
                exclusions: vec![Exclusion { program: Some("git".to_string()), ..Default::default() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        assert_eq!(eval(&[l], &shell_req("git push"), NOW), LeaseOutcome::Deny);
    }

    #[test]
    fn deny_from_one_lease_beats_allow_from_another() {
        let allow = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "git".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(10), ..Default::default() },
        );
        let mut deny = lease(LeasePredicates::default(), LeaseBudgets::default());
        deny.id = "lease-2".to_string();
        deny.predicates.exclusions = vec![Exclusion {
            route: Some("shell".to_string()),
            ..Default::default()
        }];
        // Order independent: deny wins whichever lease is scanned first.
        assert_eq!(eval(&[allow.clone(), deny.clone()], &shell_req("git status"), NOW), LeaseOutcome::Deny);
        assert_eq!(eval(&[deny, allow], &shell_req("git status"), NOW), LeaseOutcome::Deny);
    }

    // ---- budgets ---------------------------------------------------------

    #[test]
    fn call_budget_exhaustion_escalates() {
        let mut l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(2), calls_used: 2, ..Default::default() },
        );
        l.budgets.calls_used = 2;
        assert_eq!(eval(&[l], &shell_req("cargo build"), NOW), LeaseOutcome::Escalate);
    }

    #[test]
    fn priced_call_requires_monetary_budget() {
        let base = LeasePredicates {
            publisher_ops: vec![PublisherRule {
                publisher_slug: "*".to_string(),
                allow_high_risk: true,
                target: None,
            }],
            ..Default::default()
        };
        // No monetary allowance → a priced call escalates.
        let free_only = lease(base.clone(), LeaseBudgets { max_calls: Some(100), ..Default::default() });
        let mut priced = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        priced.cost_micros = 5_000_000;
        assert_eq!(eval(&[free_only], &priced, NOW), LeaseOutcome::Escalate);

        // With allowance the same call is covered.
        let funded = lease(
            base,
            LeaseBudgets {
                max_calls: Some(100),
                max_spend_micros: Some(10_000_000),
                asset: Some("USDC".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(eval(&[funded], &priced, NOW), LeaseOutcome::Allow("lease-1".to_string()));
    }

    #[test]
    fn monetary_budget_overrun_escalates() {
        let l = lease(
            LeasePredicates {
                publisher_ops: vec![PublisherRule {
                    publisher_slug: "*".to_string(),
                    allow_high_risk: true,
                    target: None,
                }],
                ..Default::default()
            },
            LeaseBudgets {
                max_calls: Some(100),
                max_spend_micros: Some(10_000_000),
                spend_used_micros: 8_000_000,
                asset: Some("USDC".to_string()),
                ..Default::default()
            },
        );
        let mut priced = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        priced.cost_micros = 5_000_000; // 8M + 5M > 10M
        assert_eq!(eval(&[l], &priced, NOW), LeaseOutcome::Escalate);
    }

    // ---- realized-cost spend matcher (the x402 402 charge point) ----------

    fn funded_publisher_lease(max_spend: u64, spend_used: u64, asset: &str) -> CapabilityLease {
        lease(
            LeasePredicates {
                publisher_ops: vec![PublisherRule {
                    publisher_slug: "*".to_string(),
                    allow_high_risk: true,
                    target: None,
                }],
                ..Default::default()
            },
            LeaseBudgets {
                max_calls: Some(100),
                max_spend_micros: Some(max_spend),
                spend_used_micros: spend_used,
                asset: Some(asset.to_string()),
                ..Default::default()
            },
        )
    }

    fn spend(
        leases: &[CapabilityLease],
        req: &OperationRequest,
        asset: &str,
        cost_micros: u64,
    ) -> SpendOutcome {
        spend_for_conversation(leases, req, asset, cost_micros, "conv-a", NOW)
    }

    #[test]
    fn realized_cost_charges_the_covering_lease() {
        let l = funded_publisher_lease(10_000_000, 0, "USDC");
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(
            spend(&[l], &req, "USDC", 4_000_000),
            SpendOutcome::Charge("lease-1".to_string()),
        );
    }

    #[test]
    fn realized_cost_over_remaining_budget_escalates() {
        // 8M used of 10M → a 5M call cannot be absorbed.
        let l = funded_publisher_lease(10_000_000, 8_000_000, "USDC");
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(spend(&[l], &req, "USDC", 5_000_000), SpendOutcome::Escalate);
    }

    #[test]
    fn priced_call_with_no_allowance_escalates() {
        let l = lease(
            LeasePredicates {
                publisher_ops: vec![PublisherRule {
                    publisher_slug: "*".to_string(),
                    allow_high_risk: true,
                    target: None,
                }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(100), ..Default::default() },
        );
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(spend(&[l], &req, "USDC", 1_000_000), SpendOutcome::Escalate);
    }

    #[test]
    fn mismatched_asset_escalates_rather_than_mischarging() {
        // Budget is denominated in USDC; a DAI-priced call must not decrement it.
        let l = funded_publisher_lease(10_000_000, 0, "USDC");
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(spend(&[l], &req, "DAI", 1_000_000), SpendOutcome::Escalate);
    }

    #[test]
    fn unpinned_asset_budget_charges_any_asset() {
        // A monetary ceiling with no pinned asset denominates whatever is charged.
        let mut l = funded_publisher_lease(10_000_000, 0, "USDC");
        l.budgets.asset = None;
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(
            spend(&[l], &req, "DAI", 1_000_000),
            SpendOutcome::Charge("lease-1".to_string()),
        );
    }

    #[test]
    fn uncovered_call_is_not_lease_scoped() {
        // A lease that does not cover the publisher predicates yields Uncovered,
        // so the caller falls back to its own payment gate rather than escalating.
        let l = lease(
            LeasePredicates {
                network_hosts: vec!["example.com".to_string()],
                ..Default::default()
            },
            LeaseBudgets {
                max_calls: Some(100),
                max_spend_micros: Some(10_000_000),
                asset: Some("USDC".to_string()),
                ..Default::default()
            },
        );
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(spend(&[l], &req, "USDC", 1_000_000), SpendOutcome::Uncovered);
    }

    #[test]
    fn spend_admission_is_independent_of_an_exhausted_call_budget() {
        // The call slot is charged at the gate; by the 402 the last call may have
        // exhausted `max_calls`. Re-checking `admits` would wrongly reject it —
        // `admits_spend` must only weigh the monetary budget.
        let budgets = LeaseBudgets {
            max_calls: Some(1),
            calls_used: 1,
            max_spend_micros: Some(10_000_000),
            spend_used_micros: 0,
            asset: Some("USDC".to_string()),
            ..Default::default()
        };
        assert!(
            !budgets.admits(1_000_000, "2026-07-25T00:00:00Z"),
            "call budget is exhausted"
        );
        assert!(
            budgets.admits_spend(1_000_000, "USDC"),
            "spend admission ignores the call budget",
        );
    }

    #[test]
    fn rate_window_admits_to_the_cap_then_blocks_until_it_closes() {
        let now = "2026-07-25T00:00:00Z";
        // A window of 3 that is still open at `now` and has seen 2 calls admits the
        // 3rd but blocks the 4th.
        let two_used = LeaseBudgets {
            max_calls: Some(500),
            max_calls_per_window: Some(3),
            window_secs: Some(60),
            window_ends_at: Some("2026-07-25T00:01:00Z".to_string()),
            calls_in_window: 2,
            ..Default::default()
        };
        assert!(two_used.admits(0, now), "3rd call in a window of 3 is admitted");

        let saturated = LeaseBudgets {
            calls_in_window: 3,
            ..two_used.clone()
        };
        assert!(
            !saturated.admits(0, now),
            "4th call in a window of 3 is blocked"
        );

        // The same saturated window, but `now` is past its end → a fresh window
        // opens, so an idle lease is never permanently rate-blocked.
        assert!(
            saturated.admits(0, "2026-07-25T00:02:00Z"),
            "a call after the window closes is admitted"
        );

        // A per-window cap with no window ever opened does not block the first call.
        let unopened = LeaseBudgets {
            max_calls_per_window: Some(1),
            window_secs: Some(60),
            ..Default::default()
        };
        assert!(
            unopened.admits(0, now),
            "the first call opens the window rather than being blocked"
        );
    }

    #[test]
    fn charge_and_release_spend_saturate() {
        let mut budgets = LeaseBudgets {
            max_spend_micros: Some(u64::MAX),
            spend_used_micros: 5,
            ..Default::default()
        };
        budgets.charge_spend(10);
        assert_eq!(budgets.spend_used_micros, 15);
        budgets.release_spend(100); // saturating: never below zero
        assert_eq!(budgets.spend_used_micros, 0);
        budgets.spend_used_micros = u64::MAX;
        budgets.charge_spend(10); // saturating: never wraps
        assert_eq!(budgets.spend_used_micros, u64::MAX);
    }

    #[test]
    fn spend_exclusion_beats_a_covering_allowance() {
        // A call an exclusion would deny must escalate the spend, not pay silently.
        let mut l = funded_publisher_lease(10_000_000, 0, "USDC");
        l.predicates.exclusions = vec![Exclusion {
            publisher_slug: Some("some-dex".to_string()),
            ..Default::default()
        }];
        let req = gateway_req("some-dex", "post_swap", OperationClass::HighRisk);
        assert_eq!(spend(&[l], &req, "USDC", 1_000_000), SpendOutcome::Escalate);
    }

    // ---- lifetime binding ------------------------------------------------

    #[test]
    fn expired_lease_does_not_match() {
        let l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        // now == LATER means the window has closed (expires_at is exclusive).
        assert_eq!(eval(&[l.clone()], &shell_req("cargo build"), LATER), LeaseOutcome::Escalate);
        // and clearly after.
        assert_eq!(eval(&[l], &shell_req("cargo build"), "2026-07-25T00:00:00Z"), LeaseOutcome::Escalate);
    }

    #[test]
    fn revoked_lease_does_not_match() {
        let mut l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        l.revoked = true;
        assert_eq!(eval(&[l], &shell_req("cargo build"), NOW), LeaseOutcome::Escalate);
    }

    #[test]
    fn lease_for_another_conversation_does_not_match() {
        let l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        assert_eq!(
            evaluate_for_conversation(&[l], &shell_req("cargo build"), "conv-b", NOW),
            LeaseOutcome::Escalate,
        );
    }

    #[test]
    fn host_lease_covers_subdomains_only() {
        let l = lease(
            LeasePredicates {
                network_hosts: vec!["example.com".to_string()],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(50), ..Default::default() },
        );
        let mut allowed = OperationRequest {
            route: ToolRoute::Web,
            class: OperationClass::Unclassified,
            publisher_slug: "seren".to_string(),
            tool_name: "web_fetch".to_string(),
            command: None,
            host: Some("api.example.com".to_string()),
            target: None,
            cost_micros: 0,
        };
        assert_eq!(eval(&[l.clone()], &allowed, NOW), LeaseOutcome::Allow("lease-1".to_string()));
        allowed.host = Some("notexample.com".to_string());
        assert_eq!(eval(&[l], &allowed, NOW), LeaseOutcome::Escalate);
    }

    // ---- bundle derivation ----------------------------------------------

    #[test]
    fn coding_profile_seeds_the_toolchain_and_a_bounded_budget() {
        let bundle = derive_bundle(&BundleRequest {
            profile: "coding".to_string(),
            duration_secs: 4 * 3600,
            ..Default::default()
        });
        let programs: Vec<&str> = bundle
            .predicates
            .command_rules
            .iter()
            .map(|rule| rule.program.as_str())
            .collect();
        assert!(programs.contains(&"cargo"));
        assert!(programs.contains(&"pnpm"));
        assert!(programs.contains(&"git"));
        assert_eq!(bundle.budgets.max_calls, Some(500));
        // Derivation grants no money by default.
        assert_eq!(bundle.budgets.max_spend_micros, None);
    }

    #[test]
    fn derivation_folds_in_plan_predicates_and_dedupes_extra_commands() {
        let bundle = derive_bundle(&BundleRequest {
            profile: "coding".to_string(),
            extra_commands: vec!["cargo".to_string(), "Rg".to_string()],
            publisher_ops: vec![PublisherRule {
                publisher_slug: "github".to_string(),
                allow_high_risk: true,
                target: Some("serenorg/seren-desktop".to_string()),
            }],
            network_hosts: vec!["registry.npmjs.org".to_string()],
            duration_secs: 3600,
            max_calls: Some(1000),
            ..Default::default()
        });
        let cargo_rules = bundle
            .predicates
            .command_rules
            .iter()
            .filter(|rule| rule.program == "cargo")
            .count();
        assert_eq!(cargo_rules, 1, "extra command must not duplicate a profile default");
        assert!(bundle.predicates.command_rules.iter().any(|rule| rule.program == "rg"));
        assert_eq!(bundle.predicates.publisher_ops.len(), 1);
        assert_eq!(bundle.predicates.network_hosts, vec!["registry.npmjs.org".to_string()]);
        assert_eq!(bundle.budgets.max_calls, Some(1000));
    }

    #[test]
    fn non_coding_profile_only_uses_explicit_predicates() {
        let bundle = derive_bundle(&BundleRequest {
            profile: "custom".to_string(),
            duration_secs: 3600,
            ..Default::default()
        });
        assert!(bundle.predicates.command_rules.is_empty());
        assert_eq!(bundle.label, "Task capability lease");
    }

    #[test]
    fn past_created_lease_is_not_spuriously_expired() {
        // Guards the string-time comparison: a lease created in the past but
        // expiring in the future is active now.
        let mut l = lease(
            LeasePredicates {
                command_rules: vec![CommandRule { program: "cargo".to_string() }],
                ..Default::default()
            },
            LeaseBudgets { max_calls: Some(500), ..Default::default() },
        );
        l.created_at = PAST.to_string();
        assert_eq!(eval(&[l], &shell_req("cargo build"), NOW), LeaseOutcome::Allow("lease-1".to_string()));
    }

    // ---- wire contract ---------------------------------------------------

    /// The predicates/budgets cross the Tauri command boundary as camelCase JSON.
    /// A field rename that broke that contract would silently make the grant
    /// command reject the renderer's payload; pin it.
    #[test]
    fn predicates_and_budgets_use_the_camel_case_wire_contract() {
        let predicates: LeasePredicates = serde_json::from_value(serde_json::json!({
            "commandRules": [{ "program": "cargo" }],
            "networkHosts": ["registry.npmjs.org"],
            "publisherOps": [{
                "publisherSlug": "github",
                "allowHighRisk": true,
                "target": "serenorg/seren-desktop"
            }],
            "exclusions": [{ "program": "rm" }],
        }))
        .expect("camelCase predicates deserialize");
        assert_eq!(predicates.command_rules.len(), 1);
        assert!(predicates.publisher_ops[0].allow_high_risk);
        assert_eq!(predicates.exclusions[0].program.as_deref(), Some("rm"));

        let budgets: LeaseBudgets = serde_json::from_value(serde_json::json!({
            "maxCalls": 500,
            "maxSpendMicros": 10_000_000,
            "asset": "USDC",
        }))
        .expect("camelCase budgets deserialize");
        assert_eq!(budgets.max_calls, Some(500));
        assert_eq!(budgets.max_spend_micros, Some(10_000_000));

        // A lease serializes back to camelCase for inspection/listing.
        let value = serde_json::to_value(lease(predicates, budgets)).expect("lease serializes");
        assert!(value.get("conversationId").is_some());
        assert!(value.get("expiresAt").is_some());
        assert!(value["budgets"].get("maxCalls").is_some());
        assert!(value["predicates"].get("commandRules").is_some());
    }
}
