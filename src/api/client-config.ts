// ABOUTME: Hey-API client configuration for Tauri environment.
// ABOUTME: Integrates with Tauri HTTP plugin and handles token refresh.

import type { ClientOptions, Config } from "./generated/client";
import { apiBase } from "@/lib/config";
import { getToken, isTauriRuntime } from "@/lib/tauri-bridge";

type TauriFetch = typeof globalThis.fetch;
let tauriFetch: TauriFetch | null = null;

/**
 * Get the appropriate fetch function for the current environment.
 * Uses Tauri HTTP plugin in Tauri runtime, browser fetch otherwise.
 */
async function getTauriFetch(): Promise<TauriFetch> {
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
    baseUrl: apiBase,
    fetch: customFetch,
  } as Config<T>;
};
