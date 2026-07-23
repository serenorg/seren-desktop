// ABOUTME: Renderer bridge for Rust-owned, per-agent-session publisher credential leases.
// ABOUTME: Only broker endpoints and an opaque capability cross this boundary; the real key never does.

import { invoke } from "@tauri-apps/api/core";

export interface CredentialLease {
  sessionId: string;
  keyId: string;
  expiresAt: string;
  /**
   * Opaque bearer value for the loopback credential broker. It authorizes
   * nothing at api.serendb.com and stops working the moment the session's
   * lease is revoked.
   */
  capability: string;
  /** Loopback MCP endpoint the provider runtime points the Seren MCP server at. */
  mcpUrl: string;
  /** Loopback base URL publisher API paths are resolved against. */
  apiBaseUrl: string;
}

/** Create or recover the unique, expiring credential lease for one agent session. */
export async function createCredentialLease(
  sessionId: string,
): Promise<CredentialLease> {
  return invoke<CredentialLease>("credential_lease_create", { sessionId });
}

/** Close the broker route first, then ask Rust to revoke its remote key. */
export async function revokeCredentialLease(sessionId: string): Promise<void> {
  await invoke("credential_lease_revoke", { sessionId });
}

/** Revoke every in-memory lease before the frontend clears authentication. */
export async function revokeAllCredentialLeases(): Promise<void> {
  await invoke("credential_lease_revoke_all");
}
