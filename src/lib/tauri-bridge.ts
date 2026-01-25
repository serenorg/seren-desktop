// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

import { invoke } from "@tauri-apps/api/core";

/**
 * Store authentication token securely using OS keychain.
 */
export async function storeToken(token: string): Promise<void> {
  await invoke("store_token", { token });
}

/**
 * Retrieve stored authentication token.
 * Returns null if no token is stored.
 */
export async function getToken(): Promise<string | null> {
  return await invoke<string | null>("get_token");
}

/**
 * Clear stored authentication token (logout).
 */
export async function clearToken(): Promise<void> {
  await invoke("clear_token");
}
