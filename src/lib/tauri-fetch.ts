// ABOUTME: Shared Tauri HTTP plugin fetch resolution.
// ABOUTME: Used by both appFetch (direct calls) and hey-api client config.

import { isTauriRuntime } from "./tauri-bridge";

type TauriFetch = typeof globalThis.fetch;

let cached: TauriFetch | null = null;

/**
 * Get the appropriate fetch function for the current environment.
 * Uses Tauri HTTP plugin in Tauri runtime, browser fetch otherwise.
 * Caches the result after first resolution.
 */
export async function getTauriFetch(): Promise<TauriFetch> {
  if (!isTauriRuntime()) {
    return globalThis.fetch;
  }

  if (cached) {
    return cached;
  }

  try {
    const mod = await import("@tauri-apps/plugin-http");
    cached = mod.fetch as TauriFetch;
    return cached;
  } catch {
    return globalThis.fetch;
  }
}

/**
 * Auth endpoints that should never trigger 401 auto-refresh (to avoid loops).
 */
const NO_REFRESH_PATHS = ["/auth/login", "/auth/refresh", "/auth/signup"];

/**
 * Check if a request URL targets an auth endpoint that should skip refresh.
 * Uses pathname matching rather than substring to avoid false positives
 * (e.g. a URL containing "auth/refresh" in a query parameter).
 */
export function shouldSkipRefresh(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  try {
    const { pathname } = new URL(raw);
    return NO_REFRESH_PATHS.some((p) => pathname.endsWith(p));
  } catch {
    // Fallback for relative URLs or malformed input
    return NO_REFRESH_PATHS.some((p) => raw.includes(p));
  }
}
