// ABOUTME: Frontend wrapper for Tauri IPC commands.
// ABOUTME: Provides typed functions for secure token storage and Rust communication.

import {
  isBrowserLocalRuntime,
  runtimeInvoke,
} from "@/lib/browser-local-runtime";

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

// Module-level cache. The default org id is a per-session setting that any
// number of detail/inbox/catalog/tasks components will read; without a cache
// each mount fires a fresh Tauri invoke which manifests as a visible "loading"
// flash on every navigation. The store-mutating helpers below invalidate.
let cachedDefaultOrganizationId: string | null | undefined;
let cachedDefaultOrganizationIdPromise: Promise<string | null> | null = null;

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
  cachedDefaultOrganizationId = orgId.length > 0 ? orgId : null;
  cachedDefaultOrganizationIdPromise = null;
}

/**
 * Retrieve stored default organization ID.
 * Returns null if not stored. Subsequent calls return the cached value
 * instantly, avoiding a Tauri roundtrip on every detail/inbox mount.
 */
export async function getDefaultOrganizationId(): Promise<string | null> {
  if (cachedDefaultOrganizationId !== undefined) {
    return cachedDefaultOrganizationId;
  }
  if (cachedDefaultOrganizationIdPromise) {
    return cachedDefaultOrganizationIdPromise;
  }
  cachedDefaultOrganizationIdPromise = (async () => {
    try {
      const invoke = await getInvoke();
      let value: string | null;
      if (invoke) {
        const result = await invoke<string | null>("get_setting", {
          store: "auth.json",
          key: "default_organization_id",
        });
        value = result && result.length > 0 ? result : null;
      } else {
        // Browser fallback for testing
        value = devStorage.getItem(DEFAULT_ORG_ID_STORAGE_KEY);
      }
      cachedDefaultOrganizationId = value;
      return value;
    } catch (err) {
      cachedDefaultOrganizationIdPromise = null;
      throw err;
    }
  })();
  return cachedDefaultOrganizationIdPromise;
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
  cachedDefaultOrganizationId = null;
  cachedDefaultOrganizationIdPromise = null;
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
  if (invoke) {
    return await invoke<FileEntry[]>("list_directory", { path });
  }
  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<FileEntry[]>("list_directory", { path });
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Read the contents of a file.
 */
export async function readFile(path: string): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string>("read_file", { path });
  }
  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<string>("read_file", { path });
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Read a file as base64.
 */
export async function readFileBase64(path: string): Promise<string> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<string>("read_file_base64", { path });
  }
  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<string>("read_file_base64", { path });
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Write content to a file.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("write_file", { path, content });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("write_file", { path, content });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Check if a path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<boolean>("path_exists", { path });
  }
  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<boolean>("path_exists", { path });
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  const invoke = await getInvoke();
  if (invoke) {
    return await invoke<boolean>("is_directory", { path });
  }
  if (isBrowserLocalRuntime()) {
    return runtimeInvoke<boolean>("is_directory", { path });
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Create a new file with optional content.
 */
export async function createFile(
  path: string,
  content?: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("create_file", { path, content });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("create_file", { path, content });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Create a new directory.
 */
export async function createDirectory(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("create_directory", { path });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("create_directory", { path });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Delete a file or empty directory.
 */
export async function deletePath(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_path", { path });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("delete_path", { path });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Rename/move a file or directory.
 */
export async function renamePath(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("rename_path", { oldPath, newPath });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("rename_path", { oldPath, newPath });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Reveal a file or directory in the system file manager.
 */
export async function revealInFileManager(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("reveal_in_file_manager", { path });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("reveal_in_file_manager", { path });
    return;
  }
  throw new Error("File system operations require a local runtime");
}

/**
 * Open a file with the operating system's default application.
 */
export async function openPathWithDefaultApp(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("open_path_with_default_app", { path });
    return;
  }
  if (isBrowserLocalRuntime()) {
    await runtimeInvoke("open_path_with_default_app", { path });
    return;
  }
  throw new Error("File system operations require a local runtime");
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
 * @param provider - Provider ID (e.g., "openai")
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

export interface InterviewLaunchPayload {
  employee?: string | null;
}

/**
 * Listen for employee interview launch events from deep links.
 * @param callback - Function to call with the requested employee slug
 * @returns Cleanup function to remove the listener
 */
export async function listenForInterviewLaunch(
  callback: (payload: InterviewLaunchPayload) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    // Browser fallback - no deep link support
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<InterviewLaunchPayload>(
    "interview-launch",
    (event) => {
      callback(event.payload);
    },
  );
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
  employee_id: string | null;
}

/**
 * An agent conversation stored in SQLite.
 *
 * Note: chat and agent conversations live in the same `conversations`
 * table, partitioned by the `kind` column. The unified `listConversations`
 * reader returns both kinds in one call and is the preferred way to
 * load the sidebar; this typed shape is what each store projects to
 * after filtering.
 */
export interface AgentConversation {
  id: string;
  title: string;
  created_at: number;
  agent_type: string;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_model_id: string | null;
  agent_permission_mode: string | null;
  agent_metadata: string | null;
  project_id: string | null;
  project_root: string | null;
  is_archived: boolean;
}

/**
 * Wire-format row returned by the unified `list_conversations` reader.
 * `kind` here is derived from `provider_session_runtime.provider` and
 * is authoritative for shell selection - prefer it over any cached
 * `conversations.kind` column read.
 */
export interface UnifiedConversationRow {
  id: string;
  title: string;
  created_at: number;
  kind: "chat" | "agent";
  project_root: string | null;
  is_archived: boolean;
  selected_provider: string | null;
  selected_model: string | null;
  employee_id: string | null;
  agent_type: string | null;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_model_id: string | null;
  agent_permission_mode: string | null;
  agent_metadata: string | null;
  project_id: string | null;
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
  provider: string | null;
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
  employeeId?: string,
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
    employeeId,
  });
}

/**
 * Read both chat and agent conversations in one call, filtered by kind
 * and/or project root. The `kind` field on each returned row reflects
 * the live provider binding via `provider_session_runtime.provider`,
 * not the stored `conversations.kind` column - that mirror is only the
 * fallback for legacy rows with no binding row yet.
 *
 * Pass `kind: undefined` to fetch both kinds; pass `"chat"` or
 * `"agent"` to filter. The `limit` is shared across kinds and is
 * unbounded when omitted (mirrors the prior unlimited chat read).
 */
export async function listConversations(options?: {
  kind?: "chat" | "agent";
  projectRoot?: string;
  limit?: number;
}): Promise<UnifiedConversationRow[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<UnifiedConversationRow[]>("list_conversations", {
    kind: options?.kind ?? null,
    projectRoot: options?.projectRoot ?? null,
    limit: options?.limit ?? null,
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
 * Create or refresh an agent conversation without changing archive state.
 */
export async function createAgentConversation(
  id: string,
  title: string,
  agentType: string,
  agentCwd?: string,
  projectRoot?: string,
  agentSessionId?: string,
  agentMetadata?: string,
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
    agentMetadata: agentMetadata ?? null,
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
 * Update the remote agent session id (e.g., Codex thread id) for a persisted agent conversation.
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

export async function claimHappyProviderSessionOwner(
  conversationId: string,
  providerSessionId: string,
  agentSessionId?: string,
): Promise<{ archived: boolean }> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  return await invoke<{ archived: boolean }>(
    "claim_happy_provider_session_owner",
    {
      conversationId,
      providerSessionId,
      agentSessionId: agentSessionId ?? null,
    },
  );
}

export async function fenceHappyProviderSessionArchive(
  providerSessionId: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("fence_happy_provider_session_archive", {
    providerSessionId,
  });
}

/**
 * Update the title of a persisted agent conversation.
 */
export async function setAgentConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("set_agent_conversation_title", { id, title });
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
 * Update the permission mode for a persisted agent conversation.
 */
export async function setAgentConversationPermissionMode(
  id: string,
  agentPermissionMode: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("set_agent_conversation_permission_mode", {
    id,
    agentPermissionMode,
  });
}

/**
 * Append a user-entered prompt to the conversation's input-history buffer.
 * Buffer is capped at the last 200 entries per conversation.
 */
export async function appendInputHistory(
  conversationId: string,
  content: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke("append_input_history", { conversationId, content });
}

/**
 * Load the persisted input-history buffer for a conversation, oldest first.
 */
export async function getInputHistory(
  conversationId: string,
): Promise<string[]> {
  const invoke = await getInvoke();
  if (!invoke) return [];
  return (await invoke("get_input_history", { conversationId })) as string[];
}

/**
 * Read the persisted composer draft for a thread. Returns `""` when the
 * thread has no draft or when the Tauri bridge is unavailable (web/preview). #1631.
 */
export async function getThreadDraft(threadId: string): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) return "";
  try {
    return (await invoke("get_thread_draft", { threadId })) as string;
  } catch (err) {
    console.warn("[tauri-bridge] getThreadDraft failed:", err);
    return "";
  }
}

/**
 * Persist the composer draft for a thread. Survives hard crashes. Called
 * on a 500ms input debounce and on thread switch. #1631.
 */
export async function setThreadDraft(
  threadId: string,
  draft: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke("set_thread_draft", { threadId, draft });
  } catch (err) {
    console.warn("[tauri-bridge] setThreadDraft failed:", err);
  }
}

export async function setAgentConversationMetadata(
  id: string,
  agentMetadata?: string | null,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Conversation operations require Tauri runtime");
  }
  await invoke("set_agent_conversation_metadata", {
    id,
    agentMetadata: agentMetadata ?? null,
  });
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
  provider?: string | null,
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
    provider: provider ?? null,
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

// ============================================================================
// Runtime Session Operations
// ============================================================================

export interface RawRuntimeSessionRow {
  id: string;
  title: string;
  status: string;
  environment: string;
  context: string | null;
  policy: string | null;
  thread_id: string | null;
  project_root: string | null;
  created_at: number;
  updated_at: number;
  resumed_at: number | null;
}

export interface RawSessionEventRow {
  id: string;
  session_id: string;
  event_type: string;
  title: string;
  content: string | null;
  metadata: string | null;
  status: string;
  created_at: number;
}

export async function createRuntimeSession(
  id: string,
  title: string,
  environment: string,
  threadId?: string,
  projectRoot?: string,
  policy?: string,
): Promise<RawRuntimeSessionRow> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  return await invoke<RawRuntimeSessionRow>("create_runtime_session", {
    id,
    title,
    environment,
    threadId: threadId ?? null,
    projectRoot: projectRoot ?? null,
    policy: policy ?? null,
  });
}

export async function getRuntimeSession(
  id: string,
): Promise<RawRuntimeSessionRow | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  return await invoke<RawRuntimeSessionRow | null>("get_runtime_session", {
    id,
  });
}

export async function listRuntimeSessions(
  limit?: number,
  threadId?: string,
): Promise<RawRuntimeSessionRow[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  return await invoke<RawRuntimeSessionRow[]>("list_runtime_sessions", {
    limit: limit ?? null,
    threadId: threadId ?? null,
  });
}

export async function updateRuntimeSession(
  id: string,
  updates: {
    title?: string;
    status?: string;
    context?: string;
    policy?: string;
    threadId?: string;
  },
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  await invoke("update_runtime_session", {
    id,
    title: updates.title ?? null,
    status: updates.status ?? null,
    context: updates.context ?? null,
    policy: updates.policy ?? null,
    threadId: updates.threadId ?? null,
  });
}

export async function resumeRuntimeSession(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  await invoke("resume_runtime_session", { id });
}

export async function deleteRuntimeSession(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  await invoke("delete_runtime_session", { id });
}

export async function addSessionEvent(
  id: string,
  sessionId: string,
  eventType: string,
  title: string,
  content?: string,
  metadata?: string,
  status?: string,
): Promise<RawSessionEventRow> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  return await invoke<RawSessionEventRow>("add_session_event", {
    id,
    sessionId,
    eventType,
    title,
    content: content ?? null,
    metadata: metadata ?? null,
    status: status ?? null,
  });
}

export async function getSessionEvents(
  sessionId: string,
  limit?: number,
): Promise<RawSessionEventRow[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  return await invoke<RawSessionEventRow[]>("get_session_events", {
    sessionId,
    limit: limit ?? null,
  });
}

export async function updateSessionEventStatus(
  id: string,
  status: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Session operations require Tauri runtime");
  }
  await invoke("update_session_event_status", { id, status });
}

/**
 * Per-thread provider runtime binding. Mirrors the Rust
 * `ProviderSessionRuntime` struct shipped by `commands::provider_runtime`.
 */
export interface ProviderSessionRuntime {
  thread_id: string;
  provider: string;
  model: string | null;
  native_session_id: string | null;
  resume_cursor_json: string | null;
  status: string;
  bootstrap_context: string | null;
  updated_at: number;
}

export async function getProviderSessionRuntime(
  threadId: string,
): Promise<ProviderSessionRuntime | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  return await invoke<ProviderSessionRuntime | null>(
    "get_provider_session_runtime",
    { threadId },
  );
}

export async function switchThreadProvider(
  threadId: string,
  targetProvider: string,
  targetModel?: string | null,
  targetCwd?: string | null,
  bootstrapContext?: string | null,
  expectedUpdatedAt?: number | null,
): Promise<ProviderSessionRuntime> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Provider switching requires Tauri runtime");
  }
  return await invoke<ProviderSessionRuntime>("switch_thread_provider", {
    threadId,
    targetProvider,
    targetModel: targetModel ?? null,
    targetCwd: targetCwd ?? null,
    bootstrapContext: bootstrapContext ?? null,
    expectedUpdatedAt: expectedUpdatedAt ?? null,
  });
}
