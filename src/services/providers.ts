// ABOUTME: Provider runtime service for spawning and communicating with coding agents.
// ABOUTME: Resolves the active runtime transport dynamically so browser modes can degrade cleanly.

import { invoke } from "@tauri-apps/api/core";
import {
  isLocalProviderRuntime,
  onRuntimeEvent,
  runtimeInvoke,
} from "@/lib/browser-local-runtime";
import type { McpServerConfig } from "@/lib/mcp/types";
import { runtimeHasCapability } from "@/lib/runtime";
import { isTauriRuntime } from "@/lib/tauri-bridge";

// ============================================================================
// Types
// ============================================================================

// Adding a new agent here REQUIRES a matching entry in the Rust
// `NATIVE_AGENT_PROVIDERS` array at
// `src-tauri/src/commands/provider_runtime.rs` (and the paired
// `DERIVED_KIND_CASE_SQL` constant a Rust test pins to it). Those
// drive the `kind` flip and `agent_type` mirror in
// `switch_thread_provider` plus the derived-kind SQL in
// `commands::chat`. The two language sides drift silently otherwise: a
// thread bound to the new agent stays `kind='chat'` in the DB and
// routes to the chat shell.
export type AgentType =
  | "claude-code"
  | "codex"
  | "gemini"
  | "grok"
  | "claude-codex"
  | "lmstudio";
export type UnlistenFn = () => void;

export type ProviderOrigin = "desktop" | "remote";

/** Roles inside a paired `claude-codex` thread (#2368). */
export type PairedRole = "planner" | "executor";

export interface AgentOAuthRouting {
  publishers: Record<string, string>;
  ambiguous: Record<string, string>;
  /** False when account discovery failed, so runtimes can refuse default-account fallback. */
  available?: boolean;
}

export function supportsConversationFork(agentType: AgentType): boolean {
  // Provider-native forking is narrower (Claude only), but every agent can
  // branch through the fresh-session transcript bootstrap. Paired threads use
  // that path to start a new coordinated planner/executor pair.
  return (
    agentType === "claude-code" ||
    agentType === "codex" ||
    agentType === "gemini" ||
    agentType === "grok" ||
    agentType === "claude-codex" ||
    agentType === "lmstudio"
  );
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
  /**
   * OS PID of the agent child process. Lets the Rust core force-kill this one
   * session when the provider-runtime WebSocket is unreachable. Null when the
   * runtime could not report a PID. #2313
   */
  pid?: number | null;
  /** Runtime-authoritative model id for a live session. */
  currentModelId?: string | null;
  /** Runtime-authoritative permission/mode id for a live session. */
  currentModeId?: string | null;
  /** Pending approval dialogs that must be re-surfaced after UI re-attach. */
  pendingPermissions?: PermissionRequestEvent[];
}

export interface AgentInfo {
  type: AgentType;
  name: string;
  description: string;
  command: string;
  available: boolean;
  authenticated?: boolean;
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

export interface LmStudioModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface LmStudioConnectionResult {
  ok: boolean;
  baseUrl: string;
  message: string;
  models?: LmStudioModelInfo[];
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
  /** True when replay repairs output recovered from provider sidecar history. */
  recoveryReplay?: boolean;
  /** Producing agent inside a paired thread (claude-code | codex). */
  agentProvider?: string;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  title: string;
  /** Raw provider/runtime tool name, e.g. gateway__gmail__get_messages. */
  name?: string;
  kind: string;
  status: string;
  parameters?: Record<string, unknown>;
  result?: string;
  error?: string;
  /**
   * Live stdout/stderr accumulated while a streaming tool is running (#2100).
   * Populated by the `shell://progress` listener for the in-process Bash
   * `execute_command` tool. Cleared when the final `result` lands. UI
   * surfaces it via the LIVE pane in `ToolCallCard` while `status` is
   * "running"; for tools that don't stream it stays undefined.
   */
  partialResult?: string;
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

export interface PermissionResolvedEvent {
  sessionId: string;
  requestId: string;
  resolution: {
    optionId: string;
    source: ProviderOrigin;
  };
  origin?: ProviderOrigin;
}

/** Paired workflow stage shown in the thread header (#2368). */
export type PairedState =
  | "idle"
  | "planning"
  | "executing"
  | "reviewing"
  | "waiting-approval";

export interface PairedRoleStatus {
  role: PairedRole;
  /** Plain-language agent name shown to the user: "Claude" or "Codex". */
  label: string;
  agentType: AgentType;
  /** Stable float-forward label, e.g. "Claude Default" / "Codex Recommended". */
  defaultModelLabel: string;
  models?: {
    currentModelId: string;
    availableModels: Array<{
      modelId: string;
      name: string;
      description?: string;
      supportsFastMode?: boolean;
      supportsAutoMode?: boolean;
      supportsAdaptiveThinking?: boolean;
    }>;
  };
  configOptions?: SessionConfigOption[];
  /** Explicit user pick; null while floating on the provider default. */
  pinnedModelId?: string | null;
  pinnedEffort?: string | null;
  pinnedServiceTier?: string | null;
  /** Inline status, e.g. pinned-model fallback or next-session effort timing. */
  notice?: string | null;
}

export interface PairedStatus {
  state: PairedState;
  activeRole: PairedRole | null;
  planner: PairedRoleStatus;
  executor: PairedRoleStatus;
}

/** Transcript-level paired workflow event: setup declaration or handoff. */
export interface PairedTranscriptEvent {
  sessionId: string;
  kind: "declaration" | "handoff";
  messageId: string;
  text: string;
  from?: string;
  to?: string;
  /** Update the existing declaration message instead of appending. */
  replace?: boolean;
}

/** Per-role spawn configuration restored from the conversation row. */
export interface PairedSpawnConfig {
  planner?: { modelId?: string; effort?: string; serviceTier?: string };
  executor?: { modelId?: string; effort?: string; serviceTier?: string };
}

/** Capture only explicit paired role pins that a fresh session can restore. */
export function pairedSpawnConfigFromStatus(
  paired?: PairedStatus,
): PairedSpawnConfig | undefined {
  if (!paired) return undefined;

  const roleConfig = (
    role: PairedRoleStatus,
  ):
    | { modelId?: string; effort?: string; serviceTier?: string }
    | undefined => {
    const config = {
      ...(role.pinnedModelId ? { modelId: role.pinnedModelId } : {}),
      ...(role.pinnedEffort ? { effort: role.pinnedEffort } : {}),
      ...(role.pinnedServiceTier
        ? { serviceTier: role.pinnedServiceTier }
        : {}),
    };
    return Object.keys(config).length > 0 ? config : undefined;
  };

  const planner = roleConfig(paired.planner);
  const executor = roleConfig(paired.executor);
  return planner || executor
    ? {
        ...(planner ? { planner } : {}),
        ...(executor ? { executor } : {}),
      }
    : undefined;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  /** Remote agent runtime session id (e.g., Codex thread id). */
  agentSessionId?: string;
  /** Session configuration options (e.g., reasoning effort). */
  configOptions?: SessionConfigOption[];
  /** Paired Claude + Codex workflow status, present on paired sessions. */
  paired?: PairedStatus;
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
      supportsFastMode?: boolean;
      supportsAutoMode?: boolean;
      supportsAdaptiveThinking?: boolean;
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

export interface DiffProposalResolvedEvent {
  sessionId: string;
  proposalId: string;
  resolution: {
    accepted: boolean;
    source: ProviderOrigin;
  };
  origin?: ProviderOrigin;
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
  origin?: ProviderOrigin;
}

export interface ErrorEvent {
  sessionId: string;
  error: string;
}

/**
 * Emitted by an agent runtime when a spawn fails
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

/**
 * Emitted by an agent runtime when the Seren MCP gateway was configured for a
 * session but failed to register any tools after bounded in-place reconnect
 * attempts (the gateway connected — its instructions loaded — but its
 * `tools/list` kept failing). Lets the desktop surface a degraded state instead
 * of letting the session run instruction-only and silently. (#2802)
 */
export interface McpDegradedEvent {
  sessionId: string;
  serverName: string;
}

// Union type for all provider runtime events
export type AgentEvent =
  | { type: "pairedEvent"; data: PairedTranscriptEvent }
  | { type: "messageChunk"; data: MessageChunkEvent }
  | { type: "toolCall"; data: ToolCallEvent }
  | { type: "toolResult"; data: ToolResultEvent }
  | { type: "diff"; data: DiffEvent }
  | { type: "planUpdate"; data: PlanUpdateEvent }
  | { type: "promptComplete"; data: PromptCompleteEvent }
  | { type: "permissionRequest"; data: PermissionRequestEvent }
  | { type: "permissionResolved"; data: PermissionResolvedEvent }
  | { type: "diffProposal"; data: DiffProposalEvent }
  | { type: "diffProposalResolved"; data: DiffProposalResolvedEvent }
  | { type: "configOptionsUpdate"; data: ConfigOptionsUpdateEvent }
  | { type: "sessionStatus"; data: SessionStatusEvent }
  | { type: "userMessage"; data: UserMessageEvent }
  | { type: "error"; data: ErrorEvent }
  | { type: "loginRequired"; data: LoginRequiredEvent }
  | { type: "mcpDegraded"; data: McpDegradedEvent };

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
 * @param networkEnabled - Optional flag to enable direct network access
 * @param autoApproveReads - Automatically allow reads that stay inside the active project
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
  initialModelId?: string,
  paired?: PairedSpawnConfig,
  lmStudioBaseUrl?: string,
  lmStudioApiKey?: string,
  autoApproveReads?: boolean,
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
      initialModelId: initialModelId ?? null,
      paired: paired ?? null,
      lmStudioBaseUrl: lmStudioBaseUrl ?? null,
      lmStudioApiKey: lmStudioApiKey ?? null,
      autoApproveReads: autoApproveReads ?? null,
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
  origin?: ProviderOrigin,
): Promise<void> {
  return invokeProvider(
    "provider_prompt",
    { sessionId, prompt, context, ...(origin ? { origin } : {}) },
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
 * Force-kill a single agent session's child process by PID via the Rust core,
 * bypassing the (possibly unreachable) provider-runtime WebSocket. This is the
 * last-resort Stop escalation: it is the only path that lands when the runtime
 * itself can no longer process RPCs. Rust applies a descendant-of-runtime guard
 * so a stale/reused PID is never killed. Returns true if the process was
 * killed, false if refused or unavailable. No-op outside the native runtime.
 */
export async function forceKillSession(pid: number): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("provider_force_kill_session", { pid });
}

/**
 * Use a provider-native fork primitive when the agent runtime exposes one.
 * Returns the new remote agent session ID.
 */
export async function nativeForkSession(sessionId: string): Promise<string> {
  return invokeProvider<string>("provider_native_fork_session", { sessionId });
}

/**
 * Build a synthetic Claude transcript on disk that splices a structured
 * compaction summary in front of the parent session's preserved tail (#1713).
 * Returns the synthetic remote agent session ID, ready to be passed as
 * `resumeAgentSessionId` to a fresh standby spawn.
 */
export async function buildSyntheticTranscript(
  sessionId: string,
  summaryText: string,
  preserveCount: number,
): Promise<string> {
  return invokeProvider<string>("provider_build_synthetic_transcript", {
    sessionId,
    summaryText,
    preserveCount,
  });
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
 * Set the AI model for an agent runtime session. Paired sessions require a
 * role so only that role's inner session is touched.
 */
export async function setModel(
  sessionId: string,
  modelId: string,
  role?: PairedRole,
): Promise<void> {
  return invokeProvider("provider_set_session_model", {
    sessionId,
    modelId,
    role: role ?? null,
  });
}

/**
 * Set a session configuration option (e.g., reasoning effort). Paired
 * sessions require a role so only that role's inner session is touched.
 */
export async function setConfigOption(
  sessionId: string,
  configId: string,
  valueId: string,
  role?: PairedRole,
): Promise<void> {
  return invokeProvider("provider_update_session_config_option", {
    sessionId,
    configId,
    valueId,
    role: role ?? null,
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

export async function setOAuthRouting(
  sessionId: string,
  routing: AgentOAuthRouting,
): Promise<void> {
  return invokeProvider("provider_set_oauth_routing", { sessionId, routing });
}

/**
 * Respond to a permission request from the agent.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
  origin?: ProviderOrigin,
): Promise<void> {
  return invokeProvider("provider_respond_to_permission", {
    sessionId,
    requestId,
    optionId,
    ...(origin ? { origin } : {}),
  });
}

/**
 * Respond to a diff proposal (accept or reject a file edit).
 */
export async function respondToDiffProposal(
  sessionId: string,
  proposalId: string,
  accepted: boolean,
  origin?: ProviderOrigin,
): Promise<void> {
  return invokeProvider("provider_respond_to_diff_proposal", {
    sessionId,
    proposalId,
    accepted,
    ...(origin ? { origin } : {}),
  });
}

/**
 * Get list of available agents and their status.
 */
export async function getAvailableAgents(): Promise<AgentInfo[]> {
  return invokeProvider<AgentInfo[]>("provider_get_available_agents");
}

/**
 * Ensure Claude Code CLI is installed. Missing installs surface an explicit
 * official-instructions recovery action instead of running a remote script.
 */
export async function ensureClaudeCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "claude-code",
  });
}

/**
 * Ensure Codex CLI (`@openai/codex`) is installed and meets the minimum version.
 * Missing installs require official manual setup; upgrades are verified before
 * success is reported.
 */
export async function ensureCodexCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "codex",
  });
}

export type CliUpdateOutcome = {
  outcome: string;
  packageName: string;
  bareCommand: string;
  label: string;
  from?: string | null;
  to?: string;
};

export type CliUpdateActionRequired = {
  label: string;
  bareCommand: "claude" | "codex";
  packageName: string;
  from?: string | null;
  to?: string | null;
  reason: string;
  officialInstructionsUrl: string;
  at?: number;
};

/** Retry one supported CLI update through the verified runtime path. */
export async function retryCliUpdate(
  bareCommand: "claude" | "codex",
): Promise<CliUpdateOutcome> {
  return invokeProvider<CliUpdateOutcome>("provider_retry_cli_update", {
    bareCommand,
  });
}

/** Read an updater action that may have fired before the UI subscribed. */
export async function getPendingCliUpdateAction(): Promise<CliUpdateActionRequired | null> {
  return invokeProvider<CliUpdateActionRequired | null>(
    "provider_get_pending_cli_update_action",
  );
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

/** Ensure the official Grok Build CLI is installed in the embedded runtime. */
export async function ensureGrokCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "grok",
  });
}

/**
 * Ensure both CLIs backing the paired Claude + Codex workflow are installed.
 * Returns the bin directory path containing the claude binary.
 */
export async function ensurePairedCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "claude-codex",
  });
}

/**
 * Ensure LM Studio's `lms` helper is installed. Seren cannot install LM Studio;
 * this validates local availability and otherwise surfaces the download path.
 */
export async function ensureLmStudioCli(): Promise<string> {
  return invokeProvider<string>("provider_ensure_agent_cli", {
    agentType: "lmstudio",
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
 * Check whether a specific agent has local subscription credentials available.
 */
export async function checkAgentAuthenticated(
  agentType: AgentType,
): Promise<boolean> {
  return invokeProvider<boolean>("provider_check_agent_authenticated", {
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

export async function testLmStudioConnection(
  baseUrl: string,
  apiKey?: string,
): Promise<LmStudioConnectionResult> {
  return invokeProvider<LmStudioConnectionResult>(
    "provider_lmstudio_test_connection",
    {
      baseUrl,
      apiKey: apiKey ?? null,
    },
    { timeoutMs: 20_000 },
  );
}

export async function startLmStudioServer(
  baseUrl: string,
  apiKey?: string,
): Promise<{ ok: boolean }> {
  return invokeProvider<{ ok: boolean }>(
    "provider_lmstudio_start_server",
    {
      baseUrl,
      apiKey: apiKey ?? null,
    },
    { timeoutMs: 45_000 },
  );
}

export async function stopLmStudioServer(
  baseUrl: string,
): Promise<{ ok: boolean }> {
  return invokeProvider<{ ok: boolean }>(
    "provider_lmstudio_stop_server",
    { baseUrl },
    { timeoutMs: 30_000 },
  );
}

// ============================================================================
// Event Subscription
// ============================================================================

const EVENT_SUFFIXES = {
  pairedEvent: "paired-event",
  messageChunk: "message-chunk",
  toolCall: "tool-call",
  toolResult: "tool-result",
  diff: "diff",
  planUpdate: "plan-update",
  promptComplete: "prompt-complete",
  permissionRequest: "permission-request",
  permissionResolved: "permission-resolved",
  diffProposal: "diff-proposal",
  diffProposalResolved: "diff-proposal-resolved",
  sessionStatus: "session-status",
  configOptionsUpdate: "config-options-update",
  userMessage: "user-message",
  error: "error",
  loginRequired: "login-required",
  mcpDegraded: "mcp-degraded",
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

async function collectRuntimeSubscriptions(
  subscriptions: Array<Promise<UnlistenFn>>,
): Promise<UnlistenFn> {
  const results = await Promise.allSettled(subscriptions);
  const unlisteners: UnlistenFn[] = [];
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      unlisteners.push(result.value);
    } else {
      errors.push(result.reason);
    }
  }

  if (errors.length > 0) {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    throw new AggregateError(errors, "Failed to subscribe to runtime events");
  }

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

/**
 * Subscribe to all agent runtime events for a session.
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToSession(
  sessionId: string,
  callback: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
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

  return collectRuntimeSubscriptions([
    subscribeToEvent<PairedTranscriptEvent>(
      "pairedEvent",
      createHandler<{ type: "pairedEvent"; data: PairedTranscriptEvent }>(
        "pairedEvent",
      ),
    ),
    subscribeToEvent<MessageChunkEvent>(
      "messageChunk",
      createHandler<{ type: "messageChunk"; data: MessageChunkEvent }>(
        "messageChunk",
      ),
    ),
    subscribeToEvent<ToolCallEvent>(
      "toolCall",
      createHandler<{ type: "toolCall"; data: ToolCallEvent }>("toolCall"),
    ),
    subscribeToEvent<ToolResultEvent>(
      "toolResult",
      createHandler<{ type: "toolResult"; data: ToolResultEvent }>(
        "toolResult",
      ),
    ),
    subscribeToEvent<DiffEvent>(
      "diff",
      createHandler<{ type: "diff"; data: DiffEvent }>("diff"),
    ),
    subscribeToEvent<PlanUpdateEvent>(
      "planUpdate",
      createHandler<{ type: "planUpdate"; data: PlanUpdateEvent }>(
        "planUpdate",
      ),
    ),
    subscribeToEvent<PromptCompleteEvent>(
      "promptComplete",
      createHandler<{ type: "promptComplete"; data: PromptCompleteEvent }>(
        "promptComplete",
      ),
    ),
    subscribeToEvent<PermissionRequestEvent>(
      "permissionRequest",
      createHandler<{
        type: "permissionRequest";
        data: PermissionRequestEvent;
      }>("permissionRequest"),
    ),
    subscribeToEvent<PermissionResolvedEvent>(
      "permissionResolved",
      createHandler<{
        type: "permissionResolved";
        data: PermissionResolvedEvent;
      }>("permissionResolved"),
    ),
    subscribeToEvent<DiffProposalEvent>(
      "diffProposal",
      createHandler<{ type: "diffProposal"; data: DiffProposalEvent }>(
        "diffProposal",
      ),
    ),
    subscribeToEvent<DiffProposalResolvedEvent>(
      "diffProposalResolved",
      createHandler<{
        type: "diffProposalResolved";
        data: DiffProposalResolvedEvent;
      }>("diffProposalResolved"),
    ),
    subscribeToEvent<SessionStatusEvent>(
      "sessionStatus",
      createHandler<{ type: "sessionStatus"; data: SessionStatusEvent }>(
        "sessionStatus",
      ),
    ),
    subscribeToEvent<ConfigOptionsUpdateEvent>(
      "configOptionsUpdate",
      createHandler<{
        type: "configOptionsUpdate";
        data: ConfigOptionsUpdateEvent;
      }>("configOptionsUpdate"),
    ),
    subscribeToEvent<UserMessageEvent>(
      "userMessage",
      createHandler<{ type: "userMessage"; data: UserMessageEvent }>(
        "userMessage",
      ),
    ),
    subscribeToEvent<ErrorEvent>(
      "error",
      createHandler<{ type: "error"; data: ErrorEvent }>("error"),
    ),
    subscribeToEvent<McpDegradedEvent>(
      "mcpDegraded",
      createHandler<{ type: "mcpDegraded"; data: McpDegradedEvent }>(
        "mcpDegraded",
      ),
    ),
  ]);
}

/**
 * Subscribe to all agent runtime events (not filtered by session).
 * Returns an unlisten function to clean up all subscriptions.
 */
export async function subscribeToAllEvents(
  callback: (event: AgentEvent) => void,
): Promise<UnlistenFn> {
  return collectRuntimeSubscriptions([
    subscribeToEvent<PairedTranscriptEvent>("pairedEvent", (data) =>
      callback({ type: "pairedEvent", data }),
    ),
    subscribeToEvent<MessageChunkEvent>("messageChunk", (data) =>
      callback({ type: "messageChunk", data }),
    ),
    subscribeToEvent<ToolCallEvent>("toolCall", (data) =>
      callback({ type: "toolCall", data }),
    ),
    subscribeToEvent<ToolResultEvent>("toolResult", (data) =>
      callback({ type: "toolResult", data }),
    ),
    subscribeToEvent<DiffEvent>("diff", (data) =>
      callback({ type: "diff", data }),
    ),
    subscribeToEvent<PlanUpdateEvent>("planUpdate", (data) =>
      callback({ type: "planUpdate", data }),
    ),
    subscribeToEvent<PromptCompleteEvent>("promptComplete", (data) =>
      callback({ type: "promptComplete", data }),
    ),
    subscribeToEvent<PermissionRequestEvent>("permissionRequest", (data) =>
      callback({ type: "permissionRequest", data }),
    ),
    subscribeToEvent<PermissionResolvedEvent>("permissionResolved", (data) =>
      callback({ type: "permissionResolved", data }),
    ),
    subscribeToEvent<DiffProposalEvent>("diffProposal", (data) =>
      callback({ type: "diffProposal", data }),
    ),
    subscribeToEvent<DiffProposalResolvedEvent>(
      "diffProposalResolved",
      (data) => callback({ type: "diffProposalResolved", data }),
    ),
    subscribeToEvent<SessionStatusEvent>("sessionStatus", (data) =>
      callback({ type: "sessionStatus", data }),
    ),
    subscribeToEvent<ConfigOptionsUpdateEvent>("configOptionsUpdate", (data) =>
      callback({ type: "configOptionsUpdate", data }),
    ),
    subscribeToEvent<UserMessageEvent>("userMessage", (data) =>
      callback({ type: "userMessage", data }),
    ),
    subscribeToEvent<ErrorEvent>("error", (data) =>
      callback({ type: "error", data }),
    ),
    subscribeToEvent<LoginRequiredEvent>("loginRequired", (data) =>
      callback({ type: "loginRequired", data }),
    ),
    subscribeToEvent<McpDegradedEvent>("mcpDegraded", (data) =>
      callback({ type: "mcpDegraded", data }),
    ),
  ]);
}
