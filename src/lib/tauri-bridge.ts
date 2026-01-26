// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

const TOKEN_STORAGE_KEY = "seren_token";

/**
 * Check if running in Tauri runtime (vs browser).
 * Tauri 2.x uses __TAURI_INTERNALS__ for IPC communication.
 */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
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
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  return await invoke<FileEntry[]>("list_directory", { path });
}

/**
 * Read the contents of a file.
 */
export async function readFile(path: string): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  return await invoke<string>("read_file", { path });
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  await invoke("write_file", { path, content });
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  return await invoke<boolean>("path_exists", { path });
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  return await invoke<boolean>("is_directory", { path });
}

/**
 * Create a new file with optional content.
 */
export async function createFile(path: string, content?: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  await invoke("create_file", { path, content });
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  await invoke("create_directory", { path });
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
  await invoke("delete_path", { path });
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("File system operations require Tauri runtime");
  }
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

// ============================================================================
// Crypto Wallet Operations (x402)
// ============================================================================

const CRYPTO_WALLET_ADDRESS_KEY = "seren_crypto_wallet_address";

/**
 * Result type from wallet commands.
 */
interface WalletCommandResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Response from sign_x402_payment command.
 */
export interface SignX402Response {
  headerName: string;
  headerValue: string;
  x402Version: number;
}

/**
 * Store a crypto private key for x402 payments.
 * Returns the derived Ethereum address.
 *
 * @param privateKey - Hex-encoded private key (64 chars, with or without 0x prefix)
 * @returns The Ethereum address derived from the private key
 * @throws Error if the key is invalid or storage fails
 */
export async function storeCryptoPrivateKey(privateKey: string): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<WalletCommandResult<string>>("store_crypto_private_key", { privateKey });
    if (!result.success) {
      throw new Error(result.error || "Failed to store private key");
    }
    return result.data!;
  }
  // Browser fallback - just store a placeholder (can't derive address without alloy)
  localStorage.setItem(CRYPTO_WALLET_ADDRESS_KEY, "browser-fallback");
  return "browser-fallback";
}

/**
 * Get the stored crypto wallet address, if any.
 * Returns null if no wallet is configured.
 */
export async function getCryptoWalletAddress(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<WalletCommandResult<string | null>>("get_crypto_wallet_address");
    if (!result.success) {
      throw new Error(result.error || "Failed to get wallet address");
    }
    return result.data ?? null;
  }
  // Browser fallback
  return localStorage.getItem(CRYPTO_WALLET_ADDRESS_KEY);
}

/**
 * Clear the stored crypto wallet (remove private key and address).
 */
export async function clearCryptoWallet(): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<WalletCommandResult<null>>("clear_crypto_wallet");
    if (!result.success) {
      throw new Error(result.error || "Failed to clear wallet");
    }
  } else {
    // Browser fallback
    localStorage.removeItem(CRYPTO_WALLET_ADDRESS_KEY);
  }
}

/**
 * Sign an x402 payment request using the stored private key.
 *
 * @param requirementsJson - The 402 response body as a JSON string
 * @returns The header name and base64-encoded signed payload
 * @throws Error if wallet is not configured or signing fails
 */
export async function signX402Payment(requirementsJson: string): Promise<SignX402Response> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("x402 signing requires Tauri runtime");
  }
  const result = await invoke<WalletCommandResult<SignX402Response>>("sign_x402_payment", {
    request: { requirementsJson }
  });
  if (!result.success) {
    throw new Error(result.error || "Failed to sign x402 payment");
  }
  return result.data!;
}
