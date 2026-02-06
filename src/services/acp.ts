// ABOUTME: ACP (Agent Client Protocol) service for spawning and communicating with AI coding agents.
// ABOUTME: Wraps Tauri commands and provides event subscriptions for agent interactions.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ============================================================================
// Types
// ============================================================================

export type AgentType = "claude-code" | "codex";

export type SessionStatus =
  | "initializing"
  | "ready"
  | "prompting"
  | "error"
  | "terminated";

export interface AcpSessionInfo {
  id: string;
  agentType: AgentType;
  cwd: string;
  status: SessionStatus;
  createdAt: string;
}

export interface AgentInfo {
  type: AgentType;
  name: string;
  description: string;
  command: string;
  available: boolean;
  unavailableReason?: string;
}

// Event payloads
export interface MessageChunkEvent {
  sessionId: string;
  text: string;
  isThought?: boolean;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
}

export interface ToolResultEvent {
  sessionId: string;
  toolCallId: string;
  status: string;
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

export interface PlanUpdateEvent {
  sessionId: string;
  entries: PlanEntry[];
}

export interface PromptCompleteEvent {
  sessionId: string;
  stopReason: string;
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
  agentInfo?: {
    name: string;
    version: string;
  };
  models?: {
    currentModelId: string;
    availableModels: Array<{ modelId: string; name: string }>;
  };
}

export interface DiffProposalEvent {
  sessionId: string;
  proposalId: string;
  path: string;
  oldText: string;
  newText: string;
}

export interface ErrorEvent {
  sessionId: string;
  error: string;
}

// Union type for all ACP events
export type AcpEvent =
  | { type: "messageChunk"; data: MessageChunkEvent }
  | { type: "toolCall"; data: ToolCallEvent }
  | { type: "toolResult"; data: ToolResultEvent }
  | { type: "diff"; data: DiffEvent }
  | { type: "planUpdate"; data: PlanUpdateEvent }
  | { type: "promptComplete"; data: PromptCompleteEvent }
  | { type: "permissionRequest"; data: PermissionRequestEvent }
  | { type: "diffProposal"; data: DiffProposalEvent }
  | { type: "sessionStatus"; data: SessionStatusEvent }
  | { type: "error"; data: ErrorEvent };

// ============================================================================
// Tauri Command Wrappers
// ============================================================================

/**
 * Spawn a new ACP agent session.
 *
 * @param agentType - The type of agent to spawn (claude-code or codex)
 * @param cwd - Working directory for the agent session
 * @param sandboxMode - Optional sandbox mode for restricting agent capabilities
 * @param apiKey - Optional API key to enable Seren MCP tools for the agent
 */
export async function spawnAgent(
  agentType: AgentType,
  cwd: string,
  sandboxMode?: string,
  apiKey?: string,
): Promise<AcpSessionInfo> {
  return invoke<AcpSessionInfo>("acp_spawn", {
    agentType,
    cwd,
    sandboxMode: sandboxMode ?? null,
    apiKey: apiKey ?? null,
  });
}

/**
 * Send a prompt to an ACP agent session.
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  context?: Array<{ text?: string }>,
): Promise<void> {
  return invoke("acp_prompt", { sessionId, prompt, context });
}

/**
 * Cancel an ongoing prompt in an ACP session.
 */
export async function cancelPrompt(sessionId: string): Promise<void> {
  return invoke("acp_cancel", { sessionId });
}

/**
 * Terminate an ACP session.
 */
export async function terminateSession(sessionId: string): Promise<void> {
  return invoke("acp_terminate", { sessionId });
}

/**
 * List all active ACP sessions.
 */
export async function listSessions(): Promise<AcpSessionInfo[]> {
  return invoke<AcpSessionInfo[]>("acp_list_sessions");
}

/**
 * Set the AI model for an ACP session.
 */
export async function setModel(
  sessionId: string,
  modelId: string,
): Promise<void> {
  return invoke("acp_set_model", { sessionId, modelId });
}

/**
 * Set the permission mode for an ACP session.
 */
export async function setPermissionMode(
  sessionId: string,
  mode: string,
): Promise<void> {
  return invoke("acp_set_permission_mode", { sessionId, mode });
}

/**
 * Respond to a permission request from the agent.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<void> {
  return invoke("acp_respond_to_permission", {
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
  return invoke("acp_respond_to_diff_proposal", {
    sessionId,
    proposalId,
    accepted,
  });
}

/**
 * Get list of available agents and their status.
 */
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>("acp_get_available_agents");
}

/**
 * Ensure Claude Code CLI is installed, auto-installing via npm if needed.
 * Returns the bin directory path containing the claude binary.
 */
export async function ensureClaudeCli(): Promise<string> {
  return invoke<string>("acp_ensure_claude_cli");
}

/**
 * Check if a specific agent binary is available in PATH.
 */
export async function checkAgentAvailable(
  agentType: AgentType,
): Promise<boolean> {
  return invoke<boolean>("acp_check_agent_available", {
    agentType,
  });
}

/**
 * Launch the authentication flow for an agent.
 * For Claude, this opens a terminal running `claude login`.
 */
export async function launchLogin(agentType: AgentType): Promise<void> {
  return invoke("acp_launch_login", { agentType });
}

// ============================================================================
// Event Subscription
// ============================================================================

const EVENT_CHANNELS = {
  messageChunk: "acp://message-chunk",
  toolCall: "acp://tool-call",
  toolResult: "acp://tool-result",
  diff: "acp://diff",
  planUpdate: "acp://plan-update",
  promptComplete: "acp://prompt-complete",
  permissionRequest: "acp://permission-request",
  diffProposal: "acp://diff-proposal",
  sessionStatus: "acp://session-status",
  error: "acp://error",
} as const;

type EventType = keyof typeof EVENT_CHANNELS;

/**
 * Subscribe to a specific ACP event type.
 * Returns an unlisten function to clean up the subscription.
 */
export async function subscribeToEvent<T extends { sessionId: string }>(
  eventType: EventType,
  callback: (data: T) => void,
): Promise<UnlistenFn> {
  const channel = EVENT_CHANNELS[eventType];
  console.log(`[AcpService] Subscribing to ${channel}`);
  return listen<T>(channel, (event) => {
    console.log(`[AcpService] Received event on ${channel}:`, event.payload);
    callback(event.payload);
  });
}

/**
 * Subscribe to all ACP events for a session.
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToSession(
  sessionId: string,
  callback: (event: AcpEvent) => void,
): Promise<UnlistenFn> {
  console.log(
    `[AcpService] subscribeToSession called for sessionId: ${sessionId}`,
  );
  const unlisteners: UnlistenFn[] = [];

  // Helper to filter events by sessionId and create properly typed events
  function createHandler<E extends AcpEvent>(
    type: E["type"],
  ): (data: E["data"]) => void {
    return (data) => {
      console.log(
        `[AcpService] createHandler received ${type}: sessionId=${data.sessionId}, expected=${sessionId}, match=${data.sessionId === sessionId}`,
      );
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
    await subscribeToEvent<SessionStatusEvent>(
      "sessionStatus",
      createHandler<{ type: "sessionStatus"; data: SessionStatusEvent }>(
        "sessionStatus",
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
 * Subscribe to all ACP events (not filtered by session).
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToAllEvents(
  callback: (event: AcpEvent) => void,
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
    await subscribeToEvent<ErrorEvent>("error", (data) =>
      callback({ type: "error", data }),
    ),
  );

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}
