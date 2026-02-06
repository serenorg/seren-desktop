// ABOUTME: Fetch wrapper for HTTP requests in Tauri environment.
// ABOUTME: Uses Tauri HTTP plugin when available, falls back to browser fetch.

import { getToken } from "./tauri-bridge";
import { getTauriFetch, shouldSkipRefresh } from "./tauri-fetch";

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
  const fetchFn = await getTauriFetch();
  const request = new Request(input, init);
  const retryRequest = request.clone();

  const response = await fetchFn(request);

  // Handle 401 with auto-refresh (skip for auth endpoints to avoid loops)
  if (response.status === 401 && !shouldSkipRefresh(request)) {
    // Dynamic import to avoid circular dependency
    const { refreshAccessToken } = await import("@/services/auth");
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      const newToken = await getToken();
      if (newToken) {
        retryRequest.headers.set("Authorization", `Bearer ${newToken}`);

        // Close original response body before retrying
        try {
          await response.body?.cancel();
        } catch {
          // noop
        }

        return fetchFn(retryRequest);
      }
    }
  }

  return response;
}
