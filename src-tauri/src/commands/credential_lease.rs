// ABOUTME: Tauri commands for Rust-owned per-session publisher credential leases.
// ABOUTME: The renderer receives a key only to configure the immediately spawned child process.

use tauri::{AppHandle, State};

use crate::credential_lease::{CredentialLease, CredentialLeaseManager};

#[tauri::command]
pub async fn credential_lease_create(
    app: AppHandle,
    state: State<'_, CredentialLeaseManager>,
    session_id: String,
) -> Result<CredentialLease, String> {
    state.create_lease(&app, session_id).await
}

#[tauri::command]
pub async fn credential_lease_revoke(
    app: AppHandle,
    state: State<'_, CredentialLeaseManager>,
    session_id: String,
) -> Result<(), String> {
    state.revoke_lease(&app, session_id).await
}

#[tauri::command]
pub async fn credential_lease_revoke_all(
    app: AppHandle,
    state: State<'_, CredentialLeaseManager>,
) -> Result<(), String> {
    state.revoke_all(&app).await
}
