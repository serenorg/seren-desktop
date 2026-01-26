// ABOUTME: Hey-API client configuration for Tauri environment.
// ABOUTME: Integrates with Tauri HTTP plugin and handles token refresh.

import type { Config, ClientOptions } from "./client";
import { apiBase } from "@/lib/config";
import { isTauriRuntime } from "@/lib/tauri-bridge";

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

/**
 * Custom fetch that uses Tauri HTTP plugin when available.
 */
const customFetch: typeof globalThis.fetch = async (input, init) => {
  const fetchFn = await getTauriFetch();
  return fetchFn(input, init);
};

/**
 * Create the client configuration for hey-api.
 * This is called by the generated client during initialization.
 */
export const createClientConfig = <T extends ClientOptions>(
  override?: Config<T>
): Config<T> => {
  return {
    ...override,
    baseUrl: apiBase,
    fetch: customFetch,
  } as Config<T>;
};
