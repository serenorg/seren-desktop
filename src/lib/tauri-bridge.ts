// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

const TOKEN_STORAGE_KEY = "seren_token";
const REFRESH_TOKEN_STORAGE_KEY = "seren_refresh_token";
const API_KEY_STORAGE_KEY = "seren_api_key";
const DEFAULT_ORG_ID_STORAGE_KEY = "seren_default_org_id";

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
async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
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

/**
 * Store refresh token securely using OS keychain.
 * Falls back to localStorage in browser environments (for testing).
 */
export async function storeRefreshToken(token: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("store_refresh_token", { token });
  } else {
    // Browser fallback for testing
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
  }
}

/**
 * Retrieve stored refresh token.
 * Returns null if no token is stored.
 */
export async function getRefreshToken(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string | null>("get_refresh_token");
  }
  // Browser fallback for testing
  return localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
}

/**
 * Clear stored refresh token (logout).
 */
export async function clearRefreshToken(): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("clear_refresh_token");
  } else {
    // Browser fallback for testing
    localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  }
}

// ============================================================================
// Seren API Key Management (for MCP authentication)
// ============================================================================

/**
 * Store Seren API key securely.
 * This key is used to authenticate with seren-mcp.
 */
export async function storeSerenApiKey(apiKey: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("set_setting", {
      store: "auth.json",
      key: "seren_api_key",
      value: apiKey,
    });
  } else {
    // Browser fallback for testing
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  }
}

/**
 * Retrieve stored Seren API key.
 * Returns null if no key is stored.
 */
export async function getSerenApiKey(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<string | null>("get_setting", {
      store: "auth.json",
      key: "seren_api_key",
    });
    return result && result.length > 0 ? result : null;
  }
  // Browser fallback for testing
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

/**
 * Clear stored Seren API key (logout).
 */
export async function clearSerenApiKey(): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("set_setting", {
      store: "auth.json",
      key: "seren_api_key",
      value: "",
    });
  } else {
    // Browser fallback for testing
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}

// ============================================================================
// Default Organization ID (for API key creation)
// ============================================================================

/**
 * Store the user's default organization ID.
 * This is returned from login and used for API key creation.
 */
export async function storeDefaultOrganizationId(orgId: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("set_setting", {
      store: "auth.json",
      key: "default_organization_id",
      value: orgId,
    });
  } else {
    // Browser fallback for testing
    localStorage.setItem(DEFAULT_ORG_ID_STORAGE_KEY, orgId);
  }
}

/**
 * Retrieve stored default organization ID.
 * Returns null if not stored.
 */
export async function getDefaultOrganizationId(): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<string | null>("get_setting", {
      store: "auth.json",
      key: "default_organization_id",
    });
    return result && result.length > 0 ? result : null;
  }
  // Browser fallback for testing
  return localStorage.getItem(DEFAULT_ORG_ID_STORAGE_KEY);
}

/**
 * Clear stored default organization ID (logout).
 */
export async function clearDefaultOrganizationId(): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("set_setting", {
      store: "auth.json",
      key: "default_organization_id",
      value: "",
    });
  } else {
    // Browser fallback for testing
    localStorage.removeItem(DEFAULT_ORG_ID_STORAGE_KEY);
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
export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
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
export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
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
export async function storeProviderKey(
  provider: string,
  apiKey: string,
): Promise<void> {
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
// OAuth Credentials Management
// ============================================================================

/**
 * Store OAuth credentials for a provider securely.
 * @param provider - Provider ID (e.g., "openai", "gemini")
 * @param credentials - JSON string of OAuthCredentials
 */
export async function storeOAuthCredentials(
  provider: string,
  credentials: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("store_oauth_credentials", { provider, credentials });
  } else {
    // Browser fallback for testing
    localStorage.setItem(`oauth_creds_${provider}`, credentials);
  }
}

/**
 * Get stored OAuth credentials for a provider.
 * Returns null if no credentials are stored.
 */
export async function getOAuthCredentials(
  provider: string,
): Promise<string | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string | null>("get_oauth_credentials", { provider });
  }
  // Browser fallback for testing
  return localStorage.getItem(`oauth_creds_${provider}`);
}

/**
 * Clear OAuth credentials for a provider.
 */
export async function clearOAuthCredentials(provider: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("clear_oauth_credentials", { provider });
  } else {
    // Browser fallback for testing
    localStorage.removeItem(`oauth_creds_${provider}`);
  }
}

/**
 * Get a list of providers that have OAuth credentials configured.
 */
export async function getOAuthProviders(): Promise<string[]> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string[]>("get_oauth_providers");
  }
  // Browser fallback for testing - scan localStorage
  const providers: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("oauth_creds_")) {
      providers.push(key.replace("oauth_creds_", ""));
    }
  }
  return providers;
}

/**
 * Listen for OAuth callback events from deep links.
 * @param callback - Function to call with the callback URL
 * @returns Cleanup function to remove the listener
 */
export async function listenForOAuthCallback(
  callback: (url: string) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    // Browser fallback - no deep link support
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<string>("oauth-callback", (event) => {
    callback(event.payload);
  });
  return unlisten;
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
export async function storeCryptoPrivateKey(
  privateKey: string,
): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    const result = await invoke<WalletCommandResult<string>>(
      "store_crypto_private_key",
      { privateKey },
    );
    if (!result.success) {
      throw new Error(result.error || "Failed to store private key");
    }
    if (result.data === undefined) {
      throw new Error(result.error || "Failed to store private key");
    }
    return result.data;
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
    const result = await invoke<WalletCommandResult<string | null>>(
      "get_crypto_wallet_address",
    );
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
    const result = await invoke<WalletCommandResult<null>>(
      "clear_crypto_wallet",
    );
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
export async function signX402Payment(
  requirementsJson: string,
): Promise<SignX402Response> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("x402 signing requires Tauri runtime");
  }
  const result = await invoke<WalletCommandResult<SignX402Response>>(
    "sign_x402_payment",
    {
      request: { requirementsJson },
    },
  );
  if (!result.success) {
    throw new Error(result.error || "Failed to sign x402 payment");
  }
  if (result.data === undefined) {
    throw new Error(result.error || "Failed to sign x402 payment");
  }
  return result.data;
}

/**
 * Response from USDC balance query.
 */
export interface UsdcBalanceResponse {
  balance: string;
  balanceRaw: string;
  network: string;
}

/**
 * Get the USDC balance for the stored crypto wallet on Base mainnet.
 *
 * @returns The USDC balance with human-readable amount and raw value
 * @throws Error if wallet is not configured or query fails
 */
export async function getCryptoUsdcBalance(): Promise<UsdcBalanceResponse> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("USDC balance query requires Tauri runtime");
  }
  const result = await invoke<WalletCommandResult<UsdcBalanceResponse>>(
    "get_crypto_usdc_balance",
  );
  if (!result.success) {
    throw new Error(result.error || "Failed to get USDC balance");
  }
  if (result.data === undefined) {
    throw new Error(result.error || "Failed to get USDC balance");
  }
  return result.data;
}

// ============================================================================
// Chat Conversation Management
// ============================================================================

/**
 * A chat conversation that groups messages together.
 */
export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  selected_model: string | null;
  selected_provider: string | null;
  is_archived: boolean;
}

/**
 * A chat message stored in a conversation.
 */
export interface StoredMessage {
  id: string;
  conversation_id: string | null;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
}

/**
 * Create a new conversation.
 */
export async function createConversation(
  id: string,
  title: string,
  selectedModel?: string,
  selectedProvider?: string,
): Promise<Conversation> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<Conversation>("create_conversation", {
    id,
    title,
    selectedModel,
    selectedProvider,
  });
}

/**
 * Get all non-archived conversations.
 */
export async function getConversations(): Promise<Conversation[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<Conversation[]>("get_conversations");
}

/**
 * Get a single conversation by ID.
 */
export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<Conversation | null>("get_conversation", { id });
}

/**
 * Update a conversation's properties.
 */
export async function updateConversation(
  id: string,
  title?: string,
  selectedModel?: string,
  selectedProvider?: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("update_conversation", {
    id,
    title,
    selectedModel,
    selectedProvider,
  });
}

/**
 * Archive a conversation (hides from tabs but preserves data).
 */
export async function archiveConversation(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("archive_conversation", { id });
}

/**
 * Permanently delete a conversation and its messages.
 */
export async function deleteConversation(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("delete_conversation", { id });
}

/**
 * Save a message to a conversation.
 */
export async function saveMessage(
  id: string,
  conversationId: string,
  role: string,
  content: string,
  model: string | null,
  timestamp: number,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Message operations require Tauri runtime");
  }
  await invoke("save_message", {
    id,
    conversationId,
    role,
    content,
    model,
    timestamp,
  });
}

/**
 * Get messages for a conversation.
 */
export async function getMessages(
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Message operations require Tauri runtime");
  }
  return await invoke<StoredMessage[]>("get_messages", {
    conversationId,
    limit,
  });
}

/**
 * Clear all messages in a conversation.
 */
export async function clearConversationHistory(
  conversationId: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Message operations require Tauri runtime");
  }
  await invoke("clear_conversation_history", { conversationId });
}

/**
 * Clear all conversations and messages (full reset).
 */
export async function clearAllHistory(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Message operations require Tauri runtime");
  }
  await invoke("clear_all_history");
}
