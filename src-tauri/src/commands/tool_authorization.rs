// ABOUTME: Tauri commands exposing the host-owned tool authorization gate to the renderer.
// ABOUTME: The renderer consults the gate before every route and records prompt outcomes host-side.

use tauri::State;

use crate::capability_lease::{
    BundleRequest, CapabilityLease, LeaseBudgets, LeasePredicates, ProposedBundle, derive_bundle,
};
use crate::tool_authorization::{
    AuthorizationDecision, OperationContext, ToolAuthorizationState, ToolRoute,
};

/// Classify a model-originated tool call and return the host's decision. The
/// renderer honors `allow`/`deny` directly and, on `prompt`, runs the matching
/// approval UI. Passing through the gate never itself prompts the user.
///
/// `context` carries the small argument slice a capability-lease predicate needs
/// (command, host, resource target, monetary cost). It is optional so callers
/// that have nothing to contribute pass nothing; a predicate that needs a field
/// simply will not match a call that omits it.
#[tauri::command]
pub fn authorize_tool_operation(
    state: State<'_, ToolAuthorizationState>,
    route: String,
    publisher_slug: String,
    tool_name: String,
    conversation_id: String,
    context: Option<OperationContext>,
) -> Result<AuthorizationDecision, String> {
    let route = ToolRoute::parse(&route)?;
    let context = context.unwrap_or_default();
    state.authorize(route, &publisher_slug, &tool_name, &conversation_id, &context)
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
