// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

const TOKEN_STORAGE_KEY = "seren_token";

/**
 * Check if running in Tauri runtime (vs browser).
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * Get invoke function only when in Tauri runtime.
 */
async function getInvoke(): Promise<typeof import("@tauri-apps/api/core").invoke | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

/**
 * Store authentication token securely using OS keychain.
 * Falls back to localStorage in browser environments (for testing).
 */
export async function storeToken(token: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("store_token", { token });
  } else {
    // Browser fallback for testing
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
}

/**
 * Retrieve stored authentication token.
 * Returns null if no token is stored.
 */
export async function getToken(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string | null>("get_token");
  }
  // Browser fallback for testing
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

/**
 * Clear stored authentication token (logout).
 */
export async function clearToken(): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("clear_token");
  } else {
    // Browser fallback for testing
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

// ============================================================================
// File System Operations
// ============================================================================

/**
 * File entry from directory listing.
 */
export interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

/**
 * List entries in a directory.
 * Returns files and folders sorted with directories first.
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("list_directory", { path });
}

/**
 * Read the contents of a file.
 */
export async function readFile(path: string): Promise<string> {
  return await invoke<string>("read_file", { path });
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, content });
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  return await invoke<boolean>("path_exists", { path });
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  return await invoke<boolean>("is_directory", { path });
}

/**
 * Create a new file with optional content.
 */
export async function createFile(path: string, content?: string): Promise<void> {
  await invoke("create_file", { path, content });
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  await invoke("create_directory", { path });
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  await invoke("delete_path", { path });
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  await invoke("rename_path", { oldPath, newPath });
}

// ============================================================================
// Provider API Key Management
// ============================================================================

/**
 * Store an API key for a provider securely.
 */
export async function storeProviderKey(provider: string, apiKey: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("store_provider_key", { provider, apiKey });
  } else {
    // Browser fallback for testing
    localStorage.setItem(`provider_key_${provider}`, apiKey);
  }
}

/**
 * Get the stored API key for a provider.
 * Returns null if no key is stored.
 */
export async function getProviderKey(provider: string): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string | null>("get_provider_key", { provider });
  }
  // Browser fallback for testing
  return localStorage.getItem(`provider_key_${provider}`);
}

/**
 * Clear the stored API key for a provider.
 */
export async function clearProviderKey(provider: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("clear_provider_key", { provider });
  } else {
    // Browser fallback for testing
    localStorage.removeItem(`provider_key_${provider}`);
  }
}

/**
 * Get a list of providers that have API keys configured.
 */
export async function getConfiguredProviders(): Promise<string[]> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string[]>("get_configured_providers");
  }
  // Browser fallback for testing - scan localStorage
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("provider_key_")) {
      providers.push(key.replace("provider_key_", ""));
    }
  }
  return providers;
}
