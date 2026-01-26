// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

import { invoke } from "@tauri-apps/api/core";

const FALLBACK_TOKEN_KEY = "seren_token";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Record<string, unknown>).__TAURI_IPC__)
  );
}

function fallbackStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Store authentication token securely using OS keychain.
 */
export async function storeToken(token: string): Promise<void> {
  if (!isTauriRuntime()) {
    fallbackStorage()?.setItem(FALLBACK_TOKEN_KEY, token);
    return;
  }
  await invoke("store_token", { token });
}

/**
 * Retrieve stored authentication token.
 * Returns null if no token is stored.
 */
export async function getToken(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return fallbackStorage()?.getItem(FALLBACK_TOKEN_KEY) ?? null;
  }
  return await invoke<string | null>("get_token");
}

/**
 * Clear stored authentication token (logout).
 */
export async function clearToken(): Promise<void> {
  if (!isTauriRuntime()) {
    fallbackStorage()?.removeItem(FALLBACK_TOKEN_KEY);
    return;
  }
  await invoke("clear_token");
}

export { isTauriRuntime };
