// ABOUTME: Fetch wrapper for HTTP requests in Tauri environment.
// ABOUTME: Uses Tauri HTTP plugin when available, falls back to browser fetch.

import { isTauriRuntime } from "./tauri-bridge";

type TauriFetch = typeof globalThis.fetch;

let tauriFetch: TauriFetch | null = null;

/**
 * Get the appropriate fetch function for the current environment.
 * Uses Tauri HTTP plugin in Tauri runtime, browser fetch otherwise.
 */
async function getFetch(): Promise<TauriFetch> {
  if (!isTauriRuntime()) {
    return globalThis.fetch;
  }

  if (tauriFetch) {
    return tauriFetch;
  }

  try {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetch = mod.fetch as TauriFetch;
    return tauriFetch;
  } catch {
    // Fall back to browser fetch if plugin import fails
    return globalThis.fetch;
  }
}

/**
 * Make an HTTP request using the appropriate fetch for the environment.
 * In Tauri, uses the HTTP plugin which bypasses CORS restrictions.
 * In browser, uses native fetch.
 */
export async function appFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  console.log("[appFetch] Starting request to:", input);
  console.log("[appFetch] isTauriRuntime:", isTauriRuntime());

  const fetchFn = await getFetch();
  console.log("[appFetch] Using Tauri fetch:", fetchFn !== globalThis.fetch);

  try {
    const response = await fetchFn(input, init);
    console.log("[appFetch] Response status:", response.status);
    return response;
  } catch (error) {
    console.error("[appFetch] Fetch error:", error);
    throw error;
  }
}
