// ABOUTME: Provider runtime service for spawning and communicating with coding agents.
// ABOUTME: Resolves the active runtime transport dynamically so browser modes can degrade cleanly.

import {
  isLocalProviderRuntime,
  onRuntimeEvent,
  runtimeInvoke,
} from "@/lib/browser-local-runtime";
import type { McpServerConfig } from "@/lib/mcp/types";
import { runtimeHasCapability } from "@/lib/runtime";

// ============================================================================
// Types
// ============================================================================

export type AgentType = "claude-code" | "codex" | "gemini";
export type UnlistenFn = () => void;

export function supportsConversationFork(_agentType: AgentType): boolean {
  return true;
}

export function supportsNativeProviderFork(agentType: AgentType): boolean {
  return agentType === "claude-code";
}

export type SessionStatus =
  | "initializing"
  | "ready"
  | "prompting"
  | "error"
  | "terminated";

export interface AgentSessionInfo {
  id: string;
  agentType: AgentType;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
  /** Remote agent runtime session id (e.g., Codex thread id). Populated after ready. */
  agentSessionId?: string;
  /** Prompt timeout in seconds. Undefined means unlimited (no timeout). */
  timeoutSecs?: number;
}

export interface AgentInfo {
  type: AgentType;
  name: string;
  description: string;
  command: string;
  available: boolean;
  unavailableReason?: string;
}

// Remote sessions (provider runtime listSessions capability)
export interface RemoteSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface RemoteSessionsPage {
  sessions: RemoteSessionInfo[];
  nextCursor?: string | null;
}

// Event payloads
export interface MessageChunkEvent {
  sessionId: string;
  text: string;
  isThought?: boolean;
  /** Stable message id for replay chunks, when provided by the sidecar. */
  messageId?: string;
  /** Source message timestamp (milliseconds since epoch), when available. */
  timestamp?: number;
  /** True when this chunk was emitted from session history replay. */
  replay?: boolean;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  parameters?: Record<string, unknown>;
  result?: string;
  error?: string;
}

export interface ToolResultEvent {
  sessionId: string;
  toolCallId: string;
  status: string;
  result?: string;
  error?: string;
}

export interface DiffEvent {
  sessionId: string;
  toolCallId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface PlanEntry {
  content: string;
  status: string;
}

// Session config options (unstable provider-runtime surface, but used by Codex for reasoning effort)
export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface SessionConfigOptionSelect {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select";
  currentValue: string;
  // We currently only handle ungrouped select options.
  options: SessionConfigSelectOption[];
}

export type SessionConfigOption = SessionConfigOptionSelect;

export interface PlanUpdateEvent {
  sessionId: string;
  entries: PlanEntry[];
}

export interface PromptCompleteEvent {
  sessionId: string;
  stopReason: string;
  /** Synthetic completion emitted after load_session history replay. */
  historyReplay?: boolean;
  /** Agent-forwarded metadata (usage stats, turn count, optional model context window). */
  meta?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    numTurns?: number;
    /** Reported by the agent runtime when the model surfaces a context window
     * size (e.g. Claude/Codex). Used by agent.store to track compaction state. */
    contextWindow?: number;
  };
}

export interface PermissionOption {
  optionId: string;
  label?: string;
  description?: string;
}

export interface PermissionRequestEvent {
  sessionId: string;
  requestId: string;
  toolCall: unknown;
  options: PermissionOption[];
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  /** Remote agent runtime session id (e.g., Codex thread id). */
  agentSessionId?: string;
  /** Session configuration options (e.g., reasoning effort). */
  configOptions?: SessionConfigOption[];
  agentInfo?: {
    name: string;
    version: string;
  };
  models?: {
    currentModelId: string;
    availableModels: Array<{
      modelId: string;
      name: string;
      description?: string;
    }>;
  };
  modes?: {
    currentModeId: string;
    availableModes: Array<{
      modeId: string;
      name: string;
      description?: string;
    }>;
  };
}

export interface DiffProposalEvent {
  sessionId: string;
  proposalId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface ConfigOptionsUpdateEvent {
  sessionId: string;
  configOptions: SessionConfigOption[];
}

export interface UserMessageEvent {
  sessionId: string;
  text: string;
  /** Stable replay message id used to merge chunked user content. */
  messageId?: string;
  /** Source message timestamp (milliseconds since epoch), when available. */
  timestamp?: number;
  /** True when this user message was emitted from session history replay. */
  replay?: boolean;
}

export interface ErrorEvent {
  sessionId: string;
  error: string;
}

/**
 * Emitted by an agent runtime (gemini-runtime today) when a spawn fails
 * because the user has not yet authenticated with the upstream CLI.
 * Triggers the desktop to call `launchLogin(agentType)` automatically so
 * the user finishes sign-in in a Terminal/browser without needing to know
 * the CLI command. (#1476)
 */
export interface LoginRequiredEvent {
  sessionId: string;
  agentType: AgentType;
  reason: string;
}

// Union type for all provider runtime events
export type AgentEvent =
  | { type: "messageChunk"; data: MessageChunkEvent }
  | { type: "toolCall"; data: ToolCallEvent }
  | { type: "toolResult"; data: ToolResultEvent }
  | { type: "diff"; data: DiffEvent }
  | { type: "planUpdate"; data: PlanUpdateEvent }
  | { type: "promptComplete"; data: PromptCompleteEvent }
  | { type: "permissionRequest"; data: PermissionRequestEvent }
  | { type: "diffProposal"; data: DiffProposalEvent }
  | { type: "configOptionsUpdate"; data: ConfigOptionsUpdateEvent }
  | { type: "sessionStatus"; data: SessionStatusEvent }
  | { type: "userMessage"; data: UserMessageEvent }
  | { type: "error"; data: ErrorEvent }
  | { type: "loginRequired"; data: LoginRequiredEvent };

async function invokeProvider<T>(
  command: string,
  args?: Record<string, unknown>,
  options?: { timeoutMs?: number | null },
): Promise<T> {
  if (!runtimeHasCapability("agents")) {
    throw new Error("Agent runtime is not supported in this runtime.");
  }

  if (isLocalProviderRuntime()) {
    return runtimeInvoke<T>(command, args, options);
  }

  throw new Error("Local provider runtime is not configured.");
}

// ============================================================================
// Tauri Command Wrappers
// ============================================================================

/**
 * Spawn a new agent runtime session.
 *
 * @param agentType - The type of agent to spawn (claude-code or codex)
 * @param cwd - Working directory for the agent session
 * @param sandboxMode - Optional sandbox mode for restricting agent capabilities
 * @param apiKey - Optional API key to enable Seren MCP tools for the agent
 * @param approvalPolicy - Optional approval policy for command execution
 * @param searchEnabled - Optional flag to enable web search
 * @param networkEnabled - Optional flag to enable direct network access (uses full-access sandbox)
 * @param timeoutSecs - Optional timeout in seconds for prompts. Undefined means unlimited.
 */
export async function spawnAgent(
  agentType: AgentType,
  cwd: string,
  sandboxMode?: string,
  apiKey?: string,
  approvalPolicy?: string,
  searchEnabled?: boolean,
  networkEnabled?: boolean,
  localSessionId?: string,
  resumeAgentSessionId?: string,
  timeoutSecs?: number,
  mcpServers?: McpServerConfig[],
  reasoningEffort?: string,
): Promise<AgentSessionInfo> {
  return invokeProvider<AgentSessionInfo>(
    "provider_spawn",
    {
      agentType,
      cwd,
      localSessionId: localSessionId ?? null,
      resumeAgentSessionId: resumeAgentSessionId ?? null,
      sandboxMode: sandboxMode ?? null,
      apiKey: apiKey ?? null,
      approvalPolicy: approvalPolicy ?? null,
      searchEnabled: searchEnabled ?? null,
      networkEnabled: networkEnabled ?? null,
      timeoutSecs: timeoutSecs ?? null,
      mcpServers: mcpServers ?? null,
      reasoningEffort: reasoningEffort ?? null,
    },
    { timeoutMs: 120_000 },
  );
}

/**
 * Send a prompt to an agent runtime session.
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  context?: Array<Record<string, string>>,
): Promise<void> {
  return invokeProvider(
    "provider_prompt",
    { sessionId, prompt, context },
    { timeoutMs: null },
  );
}

/**
 * Cancel an ongoing prompt in an agent runtime session.
 */
export async function cancelPrompt(sessionId: string): Promise<void> {
  return invokeProvider("provider_cancel", { sessionId });
}

/**
 * Terminate an agent runtime session.
 */
export async function terminateSession(sessionId: string): Promise<void> {
  return invokeProvider("provider_terminate", { sessionId });
}

/**
 * Use a provider-native fork primitive when the agent runtime exposes one.
 * Returns the new remote agent session ID.
 */
export async function nativeForkSession(sessionId: string): Promise<string> {
  return invokeProvider<string>("provider_native_fork_session", { sessionId });
}

/**
 * List all active agent runtime sessions.
 */
export async function listSessions(): Promise<AgentSessionInfo[]> {
  return invokeProvider<AgentSessionInfo[]>("provider_list_sessions");
}

/**
 * List remote sessions from the agent's underlying session store.
 */
export async function listRemoteSessions(
  agentType: AgentType,
  cwd: string,
  cursor?: string,
): Promise<RemoteSessionsPage> {
  return invokeProvider<RemoteSessionsPage>("provider_list_remote_sessions", {
    agentType,
    cwd,
    cursor: cursor ?? null,
  });
}

/**
 * Set the AI model for an agent runtime session.
 */
export async function setModel(
  sessionId: string,
  modelId: string,
): Promise<void> {
  return invokeProvider("provider_set_session_model", { sessionId, modelId });
}

/**
 * Set a session configuration option (e.g., reasoning effort).
 */
export async function setConfigOption(
  sessionId: string,
  configId: string,
  valueId: string,
): Promise<void> {
  return invokeProvider("provider_update_session_config_option", {
    sessionId,
    configId,
    valueId,
  });
}

/**
 * Set the permission mode for an agent runtime session.
 */
export async function setPermissionMode(
  sessionId: string,
  mode: string,
): Promise<void> {
  return invokeProvider("provider_set_permission_mode", { sessionId, mode });
}

/**
 * Respond to a permission request from the agent.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return invokeProvider("provider_respond_to_permission", {
    sessionId,
    requestId,
    optionId,
  });
}

/**
 * Respond to a diff proposal (accept or reject a file edit).
 */
export async function respondToDiffProposal(
  sessionId: string,
  proposalId: string,
  accepted: boolean,
): Promise<void> {
  return invokeProvider("provider_respond_to_diff_proposal", {
    sessionId,
    proposalId,
    accepted,
  });
}

/**
 * Get list of available agents and their status.
 */
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  return invokeProvider<AgentInfo[]>("provider_get_available_agents");
}

/**
 * Ensure Claude Code CLI is installed, auto-installing via npm if needed.
 * Returns the bin directory path containing the claude binary.
 */
export async function ensureClaudeCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "claude-code",
  });
}

/**
 * Ensure Codex CLI (`@openai/codex`) is installed and meets the minimum version.
 * Installs or upgrades via npm if needed.
 * Returns the bin directory path containing the codex binary.
 */
export async function ensureCodexCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "codex",
  });
}

/**
 * Ensure Gemini CLI (`@google/gemini-cli`) is installed.
 * Installs or upgrades via npm if needed.
 * Returns the bin directory path containing the gemini binary.
 */
export async function ensureGeminiCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "gemini",
  });
}

/**
 * Check if a specific agent binary is available in PATH.
 */
export async function checkAgentAvailable(
  agentType: AgentType,
): Promise<boolean> {
  return invokeProvider<boolean>("provider_check_agent_available", {
    agentType,
  });
}

/**
 * Launch the authentication flow for an agent.
 * For Claude, this opens a terminal running `claude login`.
 */
export async function launchLogin(agentType: AgentType): Promise<void> {
  return invokeProvider("provider_launch_login", { agentType });
}

// ============================================================================
// Event Subscription
// ============================================================================

const EVENT_SUFFIXES = {
  messageChunk: "message-chunk",
  toolCall: "tool-call",
  toolResult: "tool-result",
  diff: "diff",
  planUpdate: "plan-update",
  promptComplete: "prompt-complete",
  permissionRequest: "permission-request",
  diffProposal: "diff-proposal",
  sessionStatus: "session-status",
  configOptionsUpdate: "config-options-update",
  userMessage: "user-message",
  error: "error",
  loginRequired: "login-required",
} as const;

type EventType = keyof typeof EVENT_SUFFIXES;

function eventChannelForRuntime(eventType: EventType): string {
  const suffix = EVENT_SUFFIXES[eventType];
  return `provider://${suffix}`;
}

/**
 * Subscribe to a specific agent runtime event type.
 * Returns an unlisten function to clean up the subscription.
 */
export async function subscribeToEvent<T extends { sessionId: string }>(
  eventType: EventType,
  callback: (data: T) => void,
): Promise<UnlistenFn> {
  if (!isLocalProviderRuntime()) {
    throw new Error("Local provider runtime is not configured.");
  }

  const channel = eventChannelForRuntime(eventType);
  return onRuntimeEvent(channel, (payload) => {
    callback(payload as T);
  });
}

/**
 * Subscribe to all agent runtime events for a session.
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToSession(
  sessionId: string,
  callback: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];

  // Helper to filter events by sessionId and create properly typed events
  function createHandler<E extends AgentEvent>(
    type: E["type"],
  ): (data: E["data"]) => void {
    return (data) => {
      if (data.sessionId === sessionId) {
        callback({ type, data } as E);
      }
    };
  }

  unlisteners.push(
    await subscribeToEvent<MessageChunkEvent>(
      "messageChunk",
      createHandler<{ type: "messageChunk"; data: MessageChunkEvent }>(
        "messageChunk",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ToolCallEvent>(
      "toolCall",
      createHandler<{ type: "toolCall"; data: ToolCallEvent }>("toolCall"),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ToolResultEvent>(
      "toolResult",
      createHandler<{ type: "toolResult"; data: ToolResultEvent }>(
        "toolResult",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<DiffEvent>(
      "diff",
      createHandler<{ type: "diff"; data: DiffEvent }>("diff"),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PlanUpdateEvent>(
      "planUpdate",
      createHandler<{ type: "planUpdate"; data: PlanUpdateEvent }>(
        "planUpdate",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PromptCompleteEvent>(
      "promptComplete",
      createHandler<{ type: "promptComplete"; data: PromptCompleteEvent }>(
        "promptComplete",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PermissionRequestEvent>(
      "permissionRequest",
      createHandler<{
        type: "permissionRequest";
        data: PermissionRequestEvent;
      }>("permissionRequest"),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<DiffProposalEvent>(
      "diffProposal",
      createHandler<{ type: "diffProposal"; data: DiffProposalEvent }>(
        "diffProposal",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<SessionStatusEvent>(
      "sessionStatus",
      createHandler<{ type: "sessionStatus"; data: SessionStatusEvent }>(
        "sessionStatus",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ConfigOptionsUpdateEvent>(
      "configOptionsUpdate",
      createHandler<{
        type: "configOptionsUpdate";
        data: ConfigOptionsUpdateEvent;
      }>("configOptionsUpdate"),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<UserMessageEvent>(
      "userMessage",
      createHandler<{ type: "userMessage"; data: UserMessageEvent }>(
        "userMessage",
      ),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ErrorEvent>(
      "error",
      createHandler<{ type: "error"; data: ErrorEvent }>("error"),
    ),
  );

  // Return a function that unsubscribes from all events
  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

/**
 * Subscribe to all agent runtime events (not filtered by session).
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToAllEvents(
  callback: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(
    await subscribeToEvent<MessageChunkEvent>("messageChunk", (data) =>
      callback({ type: "messageChunk", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ToolCallEvent>("toolCall", (data) =>
      callback({ type: "toolCall", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ToolResultEvent>("toolResult", (data) =>
      callback({ type: "toolResult", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<DiffEvent>("diff", (data) =>
      callback({ type: "diff", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PlanUpdateEvent>("planUpdate", (data) =>
      callback({ type: "planUpdate", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PromptCompleteEvent>("promptComplete", (data) =>
      callback({ type: "promptComplete", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<PermissionRequestEvent>(
      "permissionRequest",
      (data) => callback({ type: "permissionRequest", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<DiffProposalEvent>("diffProposal", (data) =>
      callback({ type: "diffProposal", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<SessionStatusEvent>("sessionStatus", (data) =>
      callback({ type: "sessionStatus", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ConfigOptionsUpdateEvent>(
      "configOptionsUpdate",
      (data) => callback({ type: "configOptionsUpdate", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<UserMessageEvent>("userMessage", (data) =>
      callback({ type: "userMessage", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<ErrorEvent>("error", (data) =>
      callback({ type: "error", data }),
    ),
  );
  unlisteners.push(
    await subscribeToEvent<LoginRequiredEvent>("loginRequired", (data) =>
      callback({ type: "loginRequired", data }),
    ),
  );

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
