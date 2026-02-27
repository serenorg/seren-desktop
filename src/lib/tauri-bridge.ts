// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

const TOKEN_STORAGE_KEY = "seren_token";
const REFRESH_TOKEN_STORAGE_KEY = "seren_refresh_token";
const API_KEY_STORAGE_KEY = "seren_api_key";
const DEFAULT_ORG_ID_STORAGE_KEY = "seren_default_org_id";

/**
 * Development-only localStorage wrapper.
 * In production builds, all operations are no-ops to prevent
 * credentials from being stored insecurely outside Tauri.
 */
const devStorage = {
  getItem: (key: string): string | null =>
    import.meta.env.DEV ? localStorage.getItem(key) : null,
  setItem: (key: string, value: string): void => {
    if (import.meta.env.DEV) localStorage.setItem(key, value);
  },
  removeItem: (key: string): void => {
    if (import.meta.env.DEV) localStorage.removeItem(key);
  },
  get length(): number {
    return import.meta.env.DEV ? localStorage.length : 0;
  },
  key: (index: number): string | null =>
    import.meta.env.DEV ? localStorage.key(index) : null,
};

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
    devStorage.setItem(TOKEN_STORAGE_KEY, token);
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
  return devStorage.getItem(TOKEN_STORAGE_KEY);
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
    devStorage.removeItem(TOKEN_STORAGE_KEY);
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
    devStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
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
  return devStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
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
    devStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
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
    devStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
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
  return devStorage.getItem(API_KEY_STORAGE_KEY);
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
    devStorage.removeItem(API_KEY_STORAGE_KEY);
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
    devStorage.setItem(DEFAULT_ORG_ID_STORAGE_KEY, orgId);
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
  return devStorage.getItem(DEFAULT_ORG_ID_STORAGE_KEY);
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
    devStorage.removeItem(DEFAULT_ORG_ID_STORAGE_KEY);
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
    devStorage.setItem(`provider_key_${provider}`, apiKey);
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
  return devStorage.getItem(`provider_key_${provider}`);
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
    devStorage.removeItem(`provider_key_${provider}`);
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
  for (let i = 0; i < devStorage.length; i++) {
    const key = devStorage.key(i);
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
    devStorage.setItem(`oauth_creds_${provider}`, credentials);
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
  return devStorage.getItem(`oauth_creds_${provider}`);
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
    devStorage.removeItem(`oauth_creds_${provider}`);
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
  for (let i = 0; i < devStorage.length; i++) {
    const key = devStorage.key(i);
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
  project_root: string | null;
  is_archived: boolean;
}

/**
 * An agent conversation stored in SQLite.
 *
 * Note: These are persisted separately from normal chat conversations
 * and are filtered out of `getConversations()`.
 */
export interface AgentConversation {
  id: string;
  title: string;
  created_at: number;
  agent_type: string;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_model_id: string | null;
  project_id: string | null;
  project_root: string | null;
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
  metadata: string | null;
}

/**
 * Create a new conversation.
 */
export async function createConversation(
  id: string,
  title: string,
  selectedModel?: string,
  selectedProvider?: string,
  projectRoot?: string,
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
    projectRoot,
  });
}

/**
 * Get all non-archived conversations.
 */
export async function getConversations(
  projectRoot?: string,
): Promise<Conversation[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<Conversation[]>("get_conversations", {
    projectRoot: projectRoot ?? null,
  });
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
 * Create (or re-open) an agent conversation.
 */
export async function createAgentConversation(
  id: string,
  title: string,
  agentType: string,
  agentCwd?: string,
  projectRoot?: string,
  agentSessionId?: string,
): Promise<AgentConversation> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<AgentConversation>("create_agent_conversation", {
    id,
    title,
    agentType,
    agentCwd,
    projectRoot,
    agentSessionId,
  });
}

/**
 * List recent persisted agent conversations.
 */
export async function getAgentConversations(
  limit = 20,
  projectRoot?: string,
): Promise<AgentConversation[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<AgentConversation[]>("get_agent_conversations", {
    limit,
    projectRoot,
  });
}

/**
 * Get a single persisted agent conversation by ID.
 */
export async function getAgentConversation(
  id: string,
): Promise<AgentConversation | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<AgentConversation | null>("get_agent_conversation", {
    id,
  });
}

/**
 * Update the remote ACP session id (e.g., Codex thread id) for a persisted agent conversation.
 */
export async function setAgentConversationSessionId(
  id: string,
  agentSessionId: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("set_agent_conversation_session_id", { id, agentSessionId });
}

/**
 * Update the selected model id for a persisted agent conversation.
 */
export async function setAgentConversationModelId(
  id: string,
  agentModelId: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("set_agent_conversation_model_id", { id, agentModelId });
}

/**
 * Archive an agent conversation (hides from tabs but preserves data).
 */
export async function archiveAgentConversation(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("archive_agent_conversation", { id });
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
  metadata?: string | null,
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
    metadata: metadata ?? null,
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
