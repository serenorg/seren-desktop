// ABOUTME: Renderer bridge for Rust-owned, per-agent-session publisher key leases.
// ABOUTME: Lease values are returned only for immediate child-env injection and are never persisted here.

import { invoke } from "@tauri-apps/api/core";

export interface CredentialLease {
  sessionId: string;
  keyId: string;
  apiKey: string;
  expiresAt: string;
}

/** Create or recover the unique, expiring credential lease for one agent session. */
export async function createCredentialLease(
  sessionId: string,
): Promise<CredentialLease> {
  return invoke<CredentialLease>("credential_lease_create", { sessionId });
}

/** Drop local lease access first, then ask Rust to revoke its remote key. */
export async function revokeCredentialLease(sessionId: string): Promise<void> {
  await invoke("credential_lease_revoke", { sessionId });
}

/** Revoke every in-memory lease before the frontend clears authentication. */
export async function revokeAllCredentialLeases(): Promise<void> {
  await invoke("credential_lease_revoke_all");
}
