// ABOUTME: Tauri commands exposing the host-owned tool authorization gate to the renderer.
// ABOUTME: The renderer consults the gate before every route and records prompt outcomes host-side.

use tauri::State;

use crate::tool_authorization::{AuthorizationDecision, ToolAuthorizationState, ToolRoute};

/// Classify a model-originated tool call and return the host's decision. The
/// renderer honors `allow`/`deny` directly and, on `prompt`, runs the matching
/// approval UI. Passing through the gate never itself prompts the user.
#[tauri::command]
pub fn authorize_tool_operation(
    state: State<'_, ToolAuthorizationState>,
    route: String,
    publisher_slug: String,
    tool_name: String,
    conversation_id: String,
) -> Result<AuthorizationDecision, String> {
    let route = ToolRoute::parse(&route)?;
    state.authorize(route, &publisher_slug, &tool_name, &conversation_id)
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
