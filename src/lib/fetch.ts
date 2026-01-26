// ABOUTME: Fetch wrapper for HTTP requests in Tauri environment.
// ABOUTME: Uses Tauri HTTP plugin when available, falls back to browser fetch.

import { getToken, isTauriRuntime } from "./tauri-bridge";

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

// Endpoints that should not trigger auto-refresh (to avoid loops)
const NO_REFRESH_ENDPOINTS = ["/auth/login", "/auth/refresh", "/auth/signup"];

/**
 * Check if the request URL is an auth endpoint that should skip refresh.
 */
function shouldSkipRefresh(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  return NO_REFRESH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
}

/**
 * Make an HTTP request using the appropriate fetch for the environment.
 * In Tauri, uses the HTTP plugin which bypasses CORS restrictions.
 * In browser, uses native fetch.
 * Automatically refreshes access token on 401 and retries once.
 */
export async function appFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  console.log("[appFetch] Starting request to:", input);
  console.log("[appFetch] isTauriRuntime:", isTauriRuntime());

  const fetchFn = await getFetch();
  console.log("[appFetch] Using Tauri fetch:", fetchFn !== globalThis.fetch);

  try {
    const response = await fetchFn(input, init);
    console.log("[appFetch] Response status:", response.status);

    // Handle 401 with auto-refresh (skip for auth endpoints to avoid loops)
    if (response.status === 401 && !shouldSkipRefresh(input)) {
      console.log("[appFetch] Got 401, attempting token refresh...");
      // Dynamic import to avoid circular dependency
      const { refreshAccessToken } = await import("@/services/auth");
      const refreshed = await refreshAccessToken();

      if (refreshed) {
        console.log("[appFetch] Token refreshed, retrying request...");
        // Get new token and retry with updated Authorization header
        const newToken = await getToken();
        const retryInit: RequestInit = {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${newToken}`,
          },
        };
        const retryResponse = await fetchFn(input, retryInit);
        console.log("[appFetch] Retry response status:", retryResponse.status);
        return retryResponse;
      } else {
        console.log("[appFetch] Token refresh failed, returning 401");
      }
    }

    return response;
  } catch (error) {
    console.error("[appFetch] Fetch error:", error);
    throw error;
  }
}
