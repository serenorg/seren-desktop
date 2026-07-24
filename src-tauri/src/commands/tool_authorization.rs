// ABOUTME: Tauri commands exposing the host-owned tool authorization gate to the renderer.
// ABOUTME: The renderer consults the gate before every route and records prompt outcomes host-side.

use tauri::{AppHandle, Emitter, State};

use crate::approval_continuation::{
    ContinuationScope, ContinuationView, RegisteredContinuation, RequestedCapability,
    ResolutionSummary, ResolveDecision, ResolveOutcome,
};
use crate::authorization_audit::AuditEntry;
use crate::capability_lease::{
    BundleRequest, CapabilityLease, LeaseBudgets, LeasePredicates, ProposedBundle, derive_bundle,
};
use crate::orchestrator::types::TaskExecutionState;
use crate::standing_policy::{StandingPolicy, StandingPolicyInput};
use crate::tool_authorization::{
    AuthorizationDecision, OperationContext, SpendReservation, ToolAuthorizationState, ToolRoute,
};

/// Classify a model-originated tool call and return the host's decision. The
/// renderer honors `allow`/`deny` directly and, on `prompt`, runs the matching
/// approval UI. Passing through the gate never itself prompts the user.
///
/// `context` carries the small argument slice a capability-lease predicate needs
/// (command, host, resource target, monetary cost). It is optional so callers
/// that have nothing to contribute pass nothing; a predicate that needs a field
/// simply will not match a call that omits it.
///
/// `call_args` is the full tool-argument payload for the operation. The host
/// derives the exact-operation binding from it (#3193-F); an `allow` without it
/// carries no dispatch handle, and the transports then refuse to execute.
#[tauri::command]
pub fn authorize_tool_operation(
    state: State<'_, ToolAuthorizationState>,
    route: String,
    publisher_slug: String,
    tool_name: String,
    conversation_id: String,
    context: Option<OperationContext>,
    call_args: Option<serde_json::Value>,
) -> Result<AuthorizationDecision, String> {
    let route = ToolRoute::parse(&route)?;
    let context = context.unwrap_or_default();
    state.authorize(
        route,
        &publisher_slug,
        &tool_name,
        &conversation_id,
        &context,
        call_args.as_ref(),
    )
}

/// Persist a prompt outcome host-side. Classification is re-derived here, so a
/// renderer cannot mark a high-risk (one-shot) or trusted-read (silent) operation
/// as durably approved — only unclassified session decisions are stored.
#[tauri::command]
pub fn record_tool_operation_decision(
    state: State<'_, ToolAuthorizationState>,
    route: String,
    publisher_slug: String,
    tool_name: String,
    conversation_id: String,
    approved: bool,
) -> Result<(), String> {
    let route = ToolRoute::parse(&route)?;
    state.record_decision(route, &publisher_slug, &tool_name, &conversation_id, approved)
}

/// Reserve a priced call's realized monetary cost against the lease that covers
/// it (#3193-G), at the x402 payment gate and *before* any payment is signed. The
/// renderer calls this once the 402 reveals the real price. `"charged"` carries a
/// `reservationId` the renderer settles once the payment resolves; `"escalate"`
/// tells the renderer to force an explicit approval (the silent budget cannot
/// absorb this spend) rather than paying; `"uncovered"` means no lease applies and
/// the renderer uses its own payment gate. Charging is host-owned and persisted —
/// the renderer never supplies the amount charged.
#[tauri::command]
pub fn reserve_lease_spend(
    state: State<'_, ToolAuthorizationState>,
    route: String,
    publisher_slug: String,
    tool_name: String,
    conversation_id: String,
    context: Option<OperationContext>,
    asset: String,
    cost_micros: u64,
) -> Result<SpendReservation, String> {
    let route = ToolRoute::parse(&route)?;
    let context = context.unwrap_or_default();
    state.reserve_lease_spend(
        route,
        &publisher_slug,
        &tool_name,
        &conversation_id,
        &context,
        &asset,
        cost_micros,
    )
}

/// Settle a spend reservation once its payment resolves (#3193-G). `settledMicros`
/// omitted (`None`) releases the whole reservation — the payment never completed;
/// a value reconciles the lease's spend from the reserved estimate to the amount
/// actually paid. Idempotent: settling an unknown or already-settled reservation
/// is a no-op.
#[tauri::command]
pub fn settle_lease_spend(
    state: State<'_, ToolAuthorizationState>,
    reservation_id: String,
    settled_micros: Option<u64>,
) -> Result<(), String> {
    state.settle_lease_spend(&reservation_id, settled_micros)
}

/// Derive a *proposed* capability bundle for a task. This is read-only: it grants
/// nothing. The model may request a bundle this way, but only a human-approved
/// `grant_capability_lease` call persists authority — model output can never mint
/// or widen a lease.
#[tauri::command]
pub fn propose_capability_bundle(request: BundleRequest) -> Result<ProposedBundle, String> {
    Ok(derive_bundle(&request))
}

/// Persist a user-approved capability lease bound to a conversation. Invoked by
/// the approval UI after the user reviews (and optionally edits) a proposed
/// bundle — never by a model tool call. The host owns the lease id, timestamps,
/// and expiry; the caller supplies only the reviewed envelope.
#[tauri::command]
pub fn grant_capability_lease(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
    label: String,
    duration_secs: i64,
    predicates: LeasePredicates,
    budgets: LeaseBudgets,
) -> Result<CapabilityLease, String> {
    state.grant_lease(&conversation_id, &label, duration_secs, predicates, budgets)
}

/// Every capability lease bound to a conversation, newest first. Backs inspection
/// and the revocation surface.
#[tauri::command]
pub fn list_capability_leases(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
) -> Result<Vec<CapabilityLease>, String> {
    state.list_leases(&conversation_id)
}

/// Revoke a capability lease immediately. Idempotent — returns whether a lease
/// was actually revoked by this call.
#[tauri::command]
pub fn revoke_capability_lease(
    state: State<'_, ToolAuthorizationState>,
    lease_id: String,
) -> Result<bool, String> {
    state.revoke_lease(&lease_id)
}

/// Every standing policy, newest first, for the owner settings surface (#3193-E).
/// Read-only inspection; authoring happens through the create/update/delete
/// commands below.
#[tauri::command]
pub fn list_standing_policies(
    state: State<'_, ToolAuthorizationState>,
) -> Result<Vec<StandingPolicy>, String> {
    state.list_standing_policies()
}

/// Create an owner-authored standing policy that auto-materializes a bounded lease
/// for a matching unattended/long-running task (#3193-E). Invoked **only** from
/// the owner settings surface — there is no model tool or dispatch path that
/// reaches this command, so model output can never create or widen a standing
/// policy. The host owns the id and timestamps; the caller supplies only the
/// reviewed predicates/budgets/duration.
#[tauri::command]
pub fn create_standing_policy(
    state: State<'_, ToolAuthorizationState>,
    input: StandingPolicyInput,
) -> Result<StandingPolicy, String> {
    state.create_standing_policy(input)
}

/// Update an existing standing policy in place — edit its envelope or toggle it
/// on/off. Owner-only. Returns `None` if the id is unknown. Disabling stops all
/// future auto-grants from the policy immediately.
#[tauri::command]
pub fn update_standing_policy(
    state: State<'_, ToolAuthorizationState>,
    policy_id: String,
    input: StandingPolicyInput,
) -> Result<Option<StandingPolicy>, String> {
    state.update_standing_policy(&policy_id, input)
}

/// Delete a standing policy. Owner-only. Idempotent — returns whether a policy was
/// actually removed.
#[tauri::command]
pub fn delete_standing_policy(
    state: State<'_, ToolAuthorizationState>,
    policy_id: String,
) -> Result<bool, String> {
    state.delete_standing_policy(&policy_id)
}

/// The host's authoritative task-execution-state broadcast. Emitted on every gate
/// suspend/settle so the frontend converges immediately instead of waiting on its
/// poll, and so a host-initiated transition (a reload sweep) surfaces at once. The
/// payload is `approval_continuation::TaskStateSnapshot`.
pub const TASK_EXECUTION_STATE_EVENT: &str = "orchestrator://task-execution-state";

/// Broadcast the host's authoritative task-execution state for a conversation after
/// a gate suspend/settle. Best-effort: a snapshot or emit failure is logged, never
/// surfaced to the caller — the store mutation already succeeded and the frontend's
/// poll is the backstop, so a missed push must not fail the command.
pub(crate) fn emit_task_execution_state<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &ToolAuthorizationState,
    conversation_id: &str,
) {
    match state.task_state_snapshot(conversation_id) {
        Ok(snapshot) => {
            if let Err(err) = app.emit(TASK_EXECUTION_STATE_EVENT, &snapshot) {
                log::warn!(
                    "[tool-authorization] Failed to emit task state for {conversation_id}: {err}"
                );
            }
        }
        Err(err) => log::warn!(
            "[tool-authorization] Failed to snapshot task state for {conversation_id}: {err}"
        ),
    }
}

/// Register a suspended continuation for an authorization-blocked action so the
/// paused action is a visible, resumable record rather than a hung tool call
/// (#3193-C). The renderer calls this when the gate returns `prompt`, then keeps
/// the returned `resumeToken` in its own state and forwards only `modelResult` to
/// the model. Equivalent retries dedup to one pending request. The host broadcasts
/// the conversation's new (blocked) state so the frontend shows it without polling.
#[tauri::command]
pub fn register_approval_continuation(
    app: AppHandle,
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
    requested: RequestedCapability,
    scope: Option<ContinuationScope>,
    ttl_secs: i64,
) -> Result<RegisteredContinuation, String> {
    // A linear turn is the conservative default: the whole task waits unless the
    // caller can prove the blocked action is an independent branch.
    let scope = scope.unwrap_or(ContinuationScope::Linear);
    let registered = state.register_continuation(&conversation_id, requested, scope, ttl_secs)?;
    emit_task_execution_state(&app, &state, &conversation_id);
    Ok(registered)
}

/// Resolve a suspended continuation with the user's decision (approve/deny/skip).
/// Idempotent exactly once and gated on the host-minted `resumeToken`, so a model
/// that learns the public `approvalId` cannot self-approve.
#[tauri::command]
pub fn resolve_approval_continuation(
    app: AppHandle,
    state: State<'_, ToolAuthorizationState>,
    approval_id: String,
    resume_token: String,
    decision: ResolveDecision,
) -> Result<ResolveOutcome, String> {
    let outcome = state.resolve_continuation(&approval_id, &resume_token, decision)?;
    if let Ok(Some(conversation_id)) = state.conversation_for_approval(&approval_id) {
        emit_task_execution_state(&app, &state, &conversation_id);
    }
    Ok(outcome)
}

/// Explicitly expire a suspended continuation (the renderer's approval timeout),
/// so a lapsed action becomes `approval_expired` rather than a degraded generic
/// tool failure. Idempotent and token-gated.
#[tauri::command]
pub fn expire_approval_continuation(
    app: AppHandle,
    state: State<'_, ToolAuthorizationState>,
    approval_id: String,
    resume_token: String,
) -> Result<ResolveOutcome, String> {
    let outcome = state.expire_continuation(&approval_id, &resume_token)?;
    if let Ok(Some(conversation_id)) = state.conversation_for_approval(&approval_id) {
        emit_task_execution_state(&app, &state, &conversation_id);
    }
    Ok(outcome)
}

/// The live task-execution state for a conversation, derived from its
/// continuations. Backs the persistent thread status surface.
#[tauri::command]
pub fn task_execution_state(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
) -> Result<TaskExecutionState, String> {
    state.task_execution_state(&conversation_id)
}

/// Outcome counts for a conversation, backing completion integrity
/// (`can_complete`) and the final summary disclosure of denied/skipped/expired/
/// unresolved work.
#[tauri::command]
pub fn approval_resolution_summary(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
) -> Result<ResolutionSummary, String> {
    state.resolution_summary(&conversation_id)
}

/// Every suspended continuation for a conversation, redacted (no resume tokens),
/// for the inspection surface.
#[tauri::command]
pub fn list_approval_continuations(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
) -> Result<Vec<ContinuationView>, String> {
    state.list_continuations(&conversation_id)
}

/// Every live pending approval across all conversations — the global approval
/// inbox and its badge, which stay visible after navigating away from a thread.
#[tauri::command]
pub fn list_pending_approvals(
    state: State<'_, ToolAuthorizationState>,
) -> Result<Vec<ContinuationView>, String> {
    state.list_pending_continuations_all()
}

/// The newest audit rows for a conversation: lease create/use/deny/expiry/revoke,
/// approval request/decision outcomes, and durable session decisions. Rows never
/// contain credentials or full command arguments.
#[tauri::command]
pub fn list_authorization_audit(
    state: State<'_, ToolAuthorizationState>,
    conversation_id: String,
    limit: Option<u32>,
) -> Result<Vec<AuditEntry>, String> {
    state.list_audit(&conversation_id, limit.unwrap_or(200).min(1000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval_continuation::ContinuationScope;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

    fn in_memory_state() -> ToolAuthorizationState {
        // The store opens and schema-inits its cached connection lazily on first
        // use, so the first `register_continuation` bootstraps the `:memory:` db.
        ToolAuthorizationState::new(PathBuf::from(":memory:"))
    }

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

    /// The host broadcast reaches a real event listener with the authoritative
    /// payload — the exact seam (event name + camelCase shape) the frontend store
    /// subscribes to. Exercises a real mock app and the real `app.emit`, so a broken
    /// event name or payload shape fails here rather than silently in production.
    #[test]
    fn emit_broadcasts_task_state_to_listeners() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");

        let state = in_memory_state();
        state
            .register_continuation("conv-x", send_cap(), ContinuationScope::Linear, 300)
            .expect("register continuation");

        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        app.handle().listen(TASK_EXECUTION_STATE_EVENT, move |event| {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                let _ = tx.send(value);
            }
        });

        emit_task_execution_state(app.handle(), &state, "conv-x");

        let payload = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("a listener received the host broadcast");
        assert_eq!(payload["conversationId"], "conv-x");
        assert_eq!(payload["state"], "waiting_for_approval");
        assert_eq!(payload["summary"]["unresolved"], 1);
    }
}
