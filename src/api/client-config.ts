// ABOUTME: Hey-API client configuration for Tauri environment.
// ABOUTME: Integrates with Tauri HTTP plugin and handles token refresh.

import { apiBase } from "@/lib/config";
import { getToken } from "@/lib/tauri-bridge";
import { getTauriFetch, shouldSkipRefresh } from "@/lib/tauri-fetch";
import type { ClientOptions, Config } from "./generated/seren-core/client";

/**
 * Custom fetch that uses Tauri HTTP plugin when available.
 */
const customFetch: typeof globalThis.fetch = async (input, init) => {
  const fetchFn = await getTauriFetch();

  // Always create a Request so we can safely retry by cloning it
  const request = new Request(input, init);
  const retryRequest = request.clone();

  const response = await fetchFn(request);

  // Handle 401 with auto-refresh and retry once (skip auth endpoints to avoid loops)
  if (response.status === 401 && !shouldSkipRefresh(request)) {
    // Dynamic import to avoid circular dependency
    const { refreshAccessToken } = await import("@/services/auth");
    const refreshed = await refreshAccessToken();

    if (refreshed) {
      const token = await getToken();
      if (token) {
        retryRequest.headers.set("Authorization", `Bearer ${token}`);

        // Close original response body before retrying (best-effort)
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
};

/**
 * Create the client configuration for hey-api.
 * This is called by the generated client during initialization.
 */
export const createClientConfig = <T extends ClientOptions>(
  override?: Config<T>,
): Config<T> => {
  return {
    ...override,
    // Sub-spec clients pass relative baseUrls (e.g. '/publishers/seren-db')
    // from their spec's servers[].url. Override because the Gateway routes
    // all SDK paths from the API root.
    baseUrl: apiBase,
    fetch: customFetch,
  } as Config<T>;
};
