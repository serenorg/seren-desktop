// ABOUTME: Hey-API client configuration for Tauri environment.
// ABOUTME: Integrates with Tauri HTTP plugin and handles token refresh.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import type { ClientOptions, Config } from "./generated/seren-core/client";

/**
 * Create the client configuration for hey-api.
 * This is called by the generated client during initialization.
 */
export const createClientConfig = <T extends ClientOptions>(
  override?: Config<T>,
): Config<T> => {
  const resolvedBaseUrl =
    typeof override?.baseUrl === "string" && override.baseUrl.length > 0
      ? new URL(override.baseUrl, apiBase).toString()
      : apiBase;

  return {
    ...override,
    // Sub-spec clients pass relative baseUrls (e.g. '/publishers/seren-db').
    // Resolve them against the configured API root instead of dropping them.
    baseUrl: resolvedBaseUrl,
    // Use the shared fetch path so generated clients receive token refresh,
    // organization OTP challenges, support diagnostics, and Tauri routing.
    fetch: appFetch,
  } as Config<T>;
};
