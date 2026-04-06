// ABOUTME: Reactive provider-runtime state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import {
  isLocalProviderRuntime,
  onRuntimeEvent,
} from "@/lib/browser-local-runtime";
import { runtimeHasCapability } from "@/lib/runtime";
import { getEnabledMcpServers, settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

/** Per-session ready promises — resolved when backend emits "ready" status */
const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

/** Conversations with a spawn currently in progress. Prevents double-spawn
 *  when selectThread fires twice before the first spawn registers the session. */
const spawningConversations = new Set<string>();

/** Session IDs that have been explicitly terminated. The global event subscriber
 *  drops events for these IDs to prevent stale errors from dead sessions leaking
 *  into new/live sessions. Cleared when the global subscriber is torn down. */
const terminatedSessionIds = new Set<string>();

/** Lightweight context for sessions that are mid-spawn (IPC call in flight).
 *  Populated before providerService.spawnAgent and cleaned up after the session
 *  is registered in state.sessions. The global event logger consults this map
 *  so early events show the correct agent type and conversation ID. */
const spawnContextMap = new Map<
  string,
  { agentType: string; conversationId?: string }
>();

/** Max time to wait for a session to become ready before giving up */
const SESSION_READY_TIMEOUT_MS = 30_000;

/** Await a session ready promise with a timeout to prevent infinite hangs */
function waitForSessionReady(sessionId: string): Promise<void> {
  // Note: this only resolves the initial ready promise set up in spawnSession.
  // Use waitForSessionIdle for post-seed-prompt readiness.
  const entry = sessionReadyPromises.get(sessionId);
  if (!entry) return Promise.resolve();
  return Promise.race([
    entry.promise,
    new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Session ${sessionId} did not become ready within ${SESSION_READY_TIMEOUT_MS}ms`,
            ),
          ),
        SESSION_READY_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** Wait for a session to return to 'ready' (not 'prompting') with a timeout.
 * Used after sending the compaction seed prompt to avoid racing with the retry. */
async function waitForSessionIdle(
  sessionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (state.sessions[sessionId]?.info.status === "prompting") {
    if (Date.now() >= deadline) {
      console.warn(
        `[AgentStore] waitForSessionIdle: timed out after ${timeoutMs}ms for session ${sessionId}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

import { isLikelyAuthError } from "@/lib/auth-errors";
import { buildChatRequest, sendProviderMessage } from "@/lib/providers";
import {
  isPromptTooLongError,
  isRateLimitError,
  isTimeoutError,
  performAgentFallback,
} from "@/lib/rate-limit-fallback";
import {
  clearConversationHistory,
  createAgentConversation,
  type AgentConversation as DbAgentConversation,
  getAgentConversation,
  getAgentConversations,
  getMessages,
  getSerenApiKey,
  saveMessage,
  setAgentConversationMetadata as setAgentConversationMetadataDb,
  setAgentConversationModelId as setAgentConversationModelIdDb,
  setAgentConversationSessionId as setAgentConversationSessionIdDb,
  setAgentConversationTitle as setAgentConversationTitleDb,
} from "@/lib/tauri-bridge";
import { refreshAccessToken } from "@/services/auth";
import { getCallablePublisherSlugs } from "@/services/mcp-gateway";
import type {
  AgentEvent,
  AgentInfo,
  AgentSessionInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  PermissionRequestEvent,
  PlanEntry,
  RemoteSessionInfo,
  SessionConfigOption,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/providers";
import * as providerService from "@/services/providers";

// ============================================================================
// Types
// ============================================================================

export interface AgentCompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
}

interface AgentConversationMetadata {
  pendingBootstrapPromptContext?: string;
  pendingBootstrapMessages?: AgentMessage[];
}

export interface AgentMessage {
  id: string;
  type: "user" | "assistant" | "thought" | "tool" | "diff" | "error";
  content: string;
  timestamp: number;
  toolCallId?: string;
  diff?: DiffEvent;
  toolCall?: ToolCallEvent;
  /** Duration in milliseconds for how long the response took */
  duration?: number;
  /** Total cost in SerenBucks for this message's query, reported by Gateway. */
  cost?: number;
  /** Names of documents processed via DocReader for this message. */
  docNames?: string[];
}

export interface AgentModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export interface AgentModeInfo {
  modeId: string;
  name: string;
  description?: string;
}

export interface ActiveSession {
  info: AgentSessionInfo;
  messages: AgentMessage[];
  plan: PlanEntry[];
  pendingToolCalls: Map<string, ToolCallEvent>;
  streamingContent: string;
  streamingThinking: string;
  /** Timestamp for current streaming assistant chunk buffer (ms epoch). */
  streamingContentTimestamp?: number;
  /** Timestamp for current streaming thinking chunk buffer (ms epoch). */
  streamingThinkingTimestamp?: number;
  /** Buffered replay user text that may arrive as multiple chunks. */
  pendingUserMessage: string;
  /** Stable replay user message id for chunk aggregation. */
  pendingUserMessageId?: string;
  /** Timestamp for buffered replay user message (ms epoch). */
  pendingUserMessageTimestamp?: number;
  cwd: string;
  /** Local persisted conversation id (SQLite). */
  conversationId: string;
  /** Remote agent runtime session id (e.g., Codex thread id). */
  agentSessionId?: string;
  /** Session configuration options reported by the agent runtime. */
  configOptions?: SessionConfigOption[];
  /** Timestamp when the current prompt started */
  promptStartTime?: number;
  /** Currently selected model ID (if agent supports model selection) */
  currentModelId?: string;
  /** Available models reported by the agent */
  availableModels?: AgentModelInfo[];
  /** Currently selected mode ID (if agent supports mode selection) */
  currentModeId?: string;
  /** Available modes reported by the agent */
  availableModes?: AgentModeInfo[];
  /** Session-specific error message */
  error?: string | null;
  /** Title derived from the first user prompt */
  title?: string;
  /** Set when the agent hits a rate limit — triggers the fallback-to-chat prompt. */
  rateLimitHit?: boolean;
  /** Set when the agent's context window is full — triggers the fallback-to-chat prompt. */
  promptTooLong?: boolean;
  /** Guards against duplicate fallback when prompt-too-long is detected in both streamed content and error event. */
  promptTooLongHandled?: boolean;
  /** When true, skip appending/persisting messages during history replay.
   *  Set when the session was spawned with restored messages from SQLite,
   *  cleared when the replay phase ends (promptComplete with historyReplay). */
  skipHistoryReplay?: boolean;
  /** Number of messages restored from SQLite at session start. The message-count
   *  auto-compaction check subtracts this so that display-only history does not
   *  re-trigger compaction on every restart. */
  restoredMessageCount?: number;
  /** Most recent input_tokens from the agent's usage metadata. */
  lastInputTokens?: number;
  /** Context window size for the agent model (tokens). */
  contextWindowSize: number;
  /** When true, a compaction is in progress. */
  isCompacting?: boolean;
  /** Compacted summary from older messages. */
  compactedSummary?: AgentCompactedSummary;
  /** Most recent user prompt text — used to retry after compaction. */
  lastUserPrompt?: string;
  /** Set after a compact-and-retry attempt so we only try once per prompt. */
  compactRetryAttempted?: boolean;
  /** In-flight compactAndRetry promise — awaited by sendPrompt catch block
   *  so compaction completes before the error handler gives up. */
  compactRetryPromise?: Promise<boolean>;
  /** Transcript bootstrap injected into the first real prompt of a forked branch. */
  bootstrapPromptContext?: string;
  /** Set when the user explicitly requested a cancel — suppresses auto-retry
   *  in the unresponsive-agent recovery path. */
  cancelRequested?: boolean;
  /** Config option values queued for restoration after the next configOptionsUpdate
   *  event from the new session. Prevents the agent's initial announcement from
   *  overwriting values restored during compaction or recovery. */
  pendingConfigRestore?: Record<string, string>;
  /** When true, keep discarding streaming content until the current turn ends
   *  (promptComplete). Set when the first chunk of skill context is filtered so
   *  that subsequent chunks of the same skill block — which arrive without the
   *  '# Active Skills' header — are also suppressed. */
  isSkippingSkillContext?: boolean;
  /** Queued prompts awaiting dispatch when the session returns to ready.
   *  Lives in the store (not the component) so background threads still drain. */
  pendingPrompts: string[];
}

// ============================================================================
// Agent message persistence helpers
// ============================================================================

const FORK_BOOTSTRAP_MAX_MSG_CHARS = 2_000;

function agentDisplayName(agentType?: string): string {
  switch (agentType) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    default:
      return agentType ?? "Agent";
  }
}

function truncateBootstrapText(content: string): string {
  return content.length > FORK_BOOTSTRAP_MAX_MSG_CHARS
    ? `${content.slice(0, FORK_BOOTSTRAP_MAX_MSG_CHARS)}... [truncated]`
    : content;
}

function formatForkBootstrapMessage(message: AgentMessage): string | null {
  const content = message.content.trim();

  switch (message.type) {
    case "user":
      return content ? `USER: ${truncateBootstrapText(content)}` : null;
    case "assistant":
      return content ? `ASSISTANT: ${truncateBootstrapText(content)}` : null;
    case "error":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "tool": {
      const label = message.toolCall?.status
        ? `TOOL (${message.toolCall.status})`
        : "TOOL";
      return content ? `${label}: ${truncateBootstrapText(content)}` : null;
    }
    case "diff": {
      const path = message.diff?.path;
      const summary = path ? `Modified ${path}` : content;
      return summary ? `DIFF: ${truncateBootstrapText(summary)}` : null;
    }
    case "thought":
      return null;
  }
}

function buildForkBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript) {
    return null;
  }

  const sections = [
    "This prompt continues a forked branch of an earlier coding-agent conversation.",
    "Treat the summary and transcript below as the authoritative history for this branch.",
    "Anything that happened after the branch point is not part of this branch.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Branch transcript:\n${transcript}`);
  }

  sections.push(
    "Continue from the branch transcript's final message. Do not mention this bootstrap unless it helps answer the user.",
  );

  return sections.join("\n\n");
}

function parseAgentConversationMetadata(
  raw: string | null | undefined,
): AgentConversationMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AgentConversationMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serializeAgentConversationMetadata(
  metadata: AgentConversationMetadata,
): string | null {
  return metadata.pendingBootstrapPromptContext ||
    (metadata.pendingBootstrapMessages &&
      metadata.pendingBootstrapMessages.length > 0)
    ? JSON.stringify(metadata)
    : null;
}

/**
 * Persist an agent message to SQLite so history survives session restarts.
 * Only user and assistant messages are stored — tool calls, diffs, and
 * internal events are transient and replayed by the provider.
 */
function persistAgentMessage(conversationId: string, msg: AgentMessage): void {
  if (msg.type !== "user" && msg.type !== "assistant") return;
  saveMessage(
    msg.id,
    conversationId,
    msg.type === "user" ? "user" : "assistant",
    msg.content,
    null,
    msg.timestamp,
    null,
  ).catch((error) =>
    console.warn("[AgentStore] Failed to persist agent message:", error),
  );
}

/**
 * Load persisted agent messages from SQLite and build a conversation summary
 * for bootstrapping a fresh session. Returns { messages, context } where
 * messages are AgentMessage[] for the UI and context is a string for the agent.
 */
async function loadPersistedAgentHistory(
  conversationId: string,
): Promise<{ messages: AgentMessage[]; context: string }> {
  try {
    const stored = await getMessages(conversationId, 200);
    if (!stored || stored.length === 0) {
      return { messages: [], context: "" };
    }

    const messages: AgentMessage[] = stored.map((m) => ({
      id: m.id,
      type: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
      timestamp: m.timestamp,
    }));

    // Build a concise conversation summary for the agent's context
    const lines = stored.map(
      (m) =>
        `[${m.role}]: ${m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content}`,
    );
    const context =
      "Here is the conversation history from your previous session. " +
      "Continue from where you left off.\n\n" +
      lines.join("\n\n");

    return { messages, context };
  } catch (error) {
    console.warn("[AgentStore] Failed to load persisted agent history:", error);
    return { messages: [], context: "" };
  }
}

function clearLegacyAgentTranscript(conversationId: string): void {
  clearConversationHistory(conversationId).catch((error) =>
    console.warn(
      "[AgentStore] Failed to clear legacy provider transcript:",
      error,
    ),
  );
}

// ============================================================================
// State
// ============================================================================

interface AgentState {
  /** Available agents and their status */
  availableAgents: AgentInfo[];
  /** Active sessions keyed by session ID */
  sessions: Record<string, ActiveSession>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Selected agent type for new sessions */
  selectedAgentType: AgentType;
  /** Recent persisted agent conversations for resuming. */
  recentAgentConversations: DbAgentConversation[];
  /** Remote sessions listed from the agent's underlying session store. */
  remoteSessions: RemoteSessionInfo[];
  remoteSessionsNextCursor: string | null;
  remoteSessionsLoading: boolean;
  remoteSessionsError: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** CLI install progress message */
  installStatus: string | null;
  /** Pending permission requests awaiting user response */
  pendingPermissions: PermissionRequestEvent[];
  /** Pending diff proposals awaiting user accept/reject */
  pendingDiffProposals: DiffProposalEvent[];
  /** Whether agent mode is active (vs chat mode) */
  agentModeEnabled: boolean;
}

const [state, setState] = createStore<AgentState>({
  availableAgents: [],
  sessions: {},
  activeSessionId: null,
  selectedAgentType: "claude-code",
  recentAgentConversations: [],
  remoteSessions: [],
  remoteSessionsNextCursor: null,
  remoteSessionsLoading: false,
  remoteSessionsError: null,
  isLoading: false,
  error: null,
  installStatus: null,
  pendingPermissions: [],
  pendingDiffProposals: [],
  agentModeEnabled: false,
});

let globalUnsubscribe: UnlistenFn | null = null;
const pendingSessionEvents = new Map<string, AgentEvent[]>();

/** Guard against concurrent auto-recovery spawns in sendPrompt (per-session). */
const recoveryInFlightMap = new Map<string, Promise<string | null>>();
const LEGACY_CLAUDE_LOCAL_SESSION_ID_RE = /^session-\d+$/;

// Chunk accumulation buffers — plain JS, not reactive.
// Flushed to the SolidJS store at CHUNK_FLUSH_MS intervals to reduce
// per-chunk setState calls during high-velocity streaming bursts.
const CHUNK_FLUSH_MS = 50;
const chunkBufs = new Map<string, { content: string; thinking: string }>();
const chunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  const buf = chunkBufs.get(sessionId);
  if (!buf) return;
  if (buf.content) {
    setState("sessions", sessionId, "streamingContent", (c) => c + buf.content);
    buf.content = "";
  }
  if (buf.thinking) {
    setState(
      "sessions",
      sessionId,
      "streamingThinking",
      (c) => c + buf.thinking,
    );
    buf.thinking = "";
  }
}

function clearChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  chunkBufs.delete(sessionId);
}

function disposeAgentStoreRuntimeBindings(): void {
  if (globalUnsubscribe) {
    globalUnsubscribe();
    globalUnsubscribe = null;
  }
  pendingSessionEvents.clear();
  sessionReadyPromises.clear();
  recoveryInFlightMap.clear();
  terminatedSessionIds.clear();
  spawnContextMap.clear();
  for (const timer of chunkFlushTimers.values()) {
    clearTimeout(timer);
  }
  chunkFlushTimers.clear();
  chunkBufs.clear();
}

const agentStoreHot =
  (
    import.meta as ImportMeta & {
      hot?: { dispose: (callback: () => void) => void };
    }
  ).hot ?? null;

if (agentStoreHot) {
  const globalScope = globalThis as typeof globalThis & {
    __serenAgentStoreHmrDispose__?: (() => void) | undefined;
  };

  globalScope.__serenAgentStoreHmrDispose__?.();

  const dispose = () => {
    disposeAgentStoreRuntimeBindings();
    if (globalScope.__serenAgentStoreHmrDispose__ === dispose) {
      delete globalScope.__serenAgentStoreHmrDispose__;
    }
  };

  globalScope.__serenAgentStoreHmrDispose__ = dispose;
  agentStoreHot.dispose(dispose);
}

const PENDING_SESSION_EVENT_LIMIT = 500;
const CLAUDE_INIT_RETRY_DELAY_MS = 350;
const MAX_CLAUDE_INIT_RETRIES = 3;

/** Spawn cascade guard: track recent failures per conversation to prevent infinite loops. */
const SPAWN_CASCADE_WINDOW_MS = 30_000;
const SPAWN_CASCADE_MAX_FAILURES = 3;
const spawnFailureTimestamps = new Map<string, number[]>();

function recordSpawnFailure(conversationId: string): void {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  timestamps.push(now);
  // Keep only failures within the window
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  spawnFailureTimestamps.set(conversationId, recent);
}

function isSpawnCascading(conversationId: string): boolean {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  return recent.length >= SPAWN_CASCADE_MAX_FAILURES;
}

function clearSpawnFailures(conversationId: string): void {
  spawnFailureTimestamps.delete(conversationId);
}

function isRetryableClaudeInitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("server shut down unexpectedly") ||
    lower.includes("signal: 9") ||
    lower.includes("sigkill") ||
    // Claude MCP initialize handshake can time out under load (another session
    // active, slow startup, machine pressure). This is transient — retrying
    // with backoff succeeds without any user intervention needed.
    lower.includes("timed out waiting for claude control request initialize")
  );
}

function getIdleClaudeSessionIds(excludeConversationId?: string): string[] {
  return Object.entries(state.sessions)
    .filter(([, session]) => {
      if (session.info.agentType !== "claude-code") return false;
      if (
        excludeConversationId &&
        session.conversationId === excludeConversationId
      ) {
        return false;
      }
      // Keep actively prompting sessions alive; only reclaim idle/errored ones.
      return (
        session.info.status === "ready" ||
        session.info.status === "error" ||
        session.info.status === "terminated"
      );
    })
    .sort(([, a], [, b]) => a.info.createdAt.localeCompare(b.info.createdAt))
    .map(([id]) => id);
}

// ============================================================================
// Store
// ============================================================================

export const agentStore = {
  // ============================================================================
  // Getters
  // ============================================================================

  get availableAgents() {
    return state.availableAgents;
  },

  get sessions() {
    return state.sessions;
  },

  get activeSessionId() {
    return state.activeSessionId;
  },

  get activeSession(): ActiveSession | null {
    if (!state.activeSessionId) return null;
    return state.sessions[state.activeSessionId] ?? null;
  },

  get selectedAgentType() {
    return state.selectedAgentType;
  },

  get recentAgentConversations() {
    return state.recentAgentConversations;
  },

  get remoteSessions() {
    return state.remoteSessions;
  },

  get remoteSessionsNextCursor() {
    return state.remoteSessionsNextCursor;
  },

  get remoteSessionsLoading() {
    return state.remoteSessionsLoading;
  },

  get remoteSessionsError() {
    return state.remoteSessionsError;
  },

  get isLoading() {
    return state.isLoading;
  },

  get error() {
    // Return session-specific error for active session, fall back to global error
    const session = this.activeSession;
    return session?.error ?? state.error;
  },

  get installStatus() {
    return state.installStatus;
  },

  get pendingPermissions() {
    return state.pendingPermissions;
  },

  get pendingDiffProposals() {
    return state.pendingDiffProposals;
  },

  get agentModeEnabled() {
    return state.agentModeEnabled;
  },

  get supportsAgents() {
    return runtimeHasCapability("agents");
  },

  /**
   * Get messages for the active session.
   */
  get messages(): AgentMessage[] {
    const session = this.activeSession;
    return session?.messages ?? [];
  },

  /**
   * Get messages for a specific conversation ID (thread ID).
   * Use this instead of `messages` getter when you need messages for a specific thread,
   * not just the active session.
   */
  getMessagesForConversation(conversationId: string): AgentMessage[] {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.messages ?? [];
  },

  /**
   * Get streaming content for a specific conversation ID.
   */
  getStreamingContentForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingContent ?? "";
  },

  /**
   * Get streaming thinking for a specific conversation ID.
   */
  getStreamingThinkingForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingThinking ?? "";
  },

  /**
   * Get the active session for a specific conversation ID.
   * Returns null if no session is running for that conversation.
   */
  getSessionForConversation(conversationId: string): ActiveSession | null {
    return (
      Object.values(state.sessions).find(
        (s) => s.conversationId === conversationId,
      ) ?? null
    );
  },

  /**
   * Check if a conversation has pending permission requests or diff proposals.
   * Used by sidebar/tab indicators to show a blinking approval dot.
   */
  hasPendingApprovals(conversationId: string): boolean {
    const session = this.getSessionForConversation(conversationId);
    if (!session) return false;
    const sid = session.info.id;
    return (
      state.pendingPermissions.some((p) => p.sessionId === sid) ||
      state.pendingDiffProposals.some((p) => p.sessionId === sid)
    );
  },

  /** Enqueue a prompt for a session. Dispatched automatically on promptComplete. */
  enqueuePrompt(sessionId: string, prompt: string): void {
    if (!state.sessions[sessionId]) return;
    setState("sessions", sessionId, "pendingPrompts", (q) => [...q, prompt]);
  },

  /** Get the pending prompt queue for a session (reactive). */
  getPendingPrompts(sessionId: string): string[] {
    return state.sessions[sessionId]?.pendingPrompts ?? [];
  },

  /** Clear the prompt queue for a session (e.g. on cancel). */
  clearPromptQueue(sessionId: string): void {
    if (!state.sessions[sessionId]) return;
    setState("sessions", sessionId, "pendingPrompts", []);
  },

  /**
   * Get plan entries for the active session.
   */
  get plan(): PlanEntry[] {
    const session = this.activeSession;
    return session?.plan ?? [];
  },

  /**
   * Get the current streaming content for the active session.
   */
  get streamingContent(): string {
    const session = this.activeSession;
    return session?.streamingContent ?? "";
  },

  /**
   * Get the current streaming thinking content for the active session.
   */
  get streamingThinking(): string {
    const session = this.activeSession;
    return session?.streamingThinking ?? "";
  },

  /**
   * Get the current working directory for the active session.
   */
  get cwd(): string | null {
    const session = this.activeSession;
    return session?.cwd ?? null;
  },

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the agent store by loading available agents.
   */
  async initialize() {
    if (!runtimeHasCapability("agents")) {
      setState("availableAgents", []);
      setState("agentModeEnabled", false);
      setState("remoteSessions", []);
      setState("remoteSessionsNextCursor", null);
      setState("remoteSessionsError", null);
      return;
    }

    try {
      const agents = await providerService.getAvailableAgents();
      setState("availableAgents", agents);
      const currentAgent = agents.find(
        (agent) => agent.type === state.selectedAgentType,
      );
      if (!currentAgent?.available) {
        const fallbackAgent = agents.find((agent) => agent.available);
        if (fallbackAgent) {
          setState("selectedAgentType", fallbackAgent.type);
        }
      }
    } catch (error) {
      console.error("Failed to load available agents:", error);
    }
  },

  /**
   * Load recent persisted agent conversations for resuming.
   */
  async refreshRecentAgentConversations(limit = 10, cwd?: string) {
    try {
      const rows = await getAgentConversations(limit, cwd);
      setState("recentAgentConversations", rows);
    } catch (error) {
      console.error("Failed to load agent conversation history:", error);
    }
  },
  /**
   * List remote sessions from the selected agent's underlying store.
   */
  async refreshRemoteSessions(cwd: string, agentType?: AgentType) {
    if (state.remoteSessionsLoading) {
      return;
    }
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const [page, localRows] = await Promise.all([
        providerService.listRemoteSessions(resolvedAgentType, cwd),
        getAgentConversations(200),
      ]);

      setState("recentAgentConversations", localRows);
      const titleOverrides = new Map(
        localRows
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );

      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));

      setState("remoteSessions", mergedSessions);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Failed to list remote sessions:", msg);
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  async loadMoreRemoteSessions(cwd: string, agentType?: AgentType) {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const cursor = state.remoteSessionsNextCursor;
    if (!cursor) return;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const page = await providerService.listRemoteSessions(
        resolvedAgentType,
        cwd,
        cursor,
      );
      const titleOverrides = new Map(
        state.recentAgentConversations
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );
      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));
      setState("remoteSessions", (prev) => [...prev, ...mergedSessions]);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Failed to list more remote sessions:", msg);
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Spawn a new agent session.
   */
  async spawnSession(
    cwd: string,
    agentType?: AgentType,
    opts?: {
      localSessionId?: string;
      resumeAgentSessionId?: string;
      conversationTitle?: string;
      initRetryAttempt?: number;
      reclaimedIdleClaude?: boolean;
      restoredMessages?: AgentMessage[];
      bootstrapPromptContext?: string;
    },
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const localSessionId = opts?.localSessionId;
    const resumeAgentSessionId = opts?.resumeAgentSessionId;
    const initRetryAttempt = opts?.initRetryAttempt ?? 0;
    const reclaimedIdleClaude = opts?.reclaimedIdleClaude ?? false;
    const conversationTitle =
      opts?.conversationTitle ??
      (resolvedAgentType === "codex" ? "Codex Agent" : "Claude Agent");

    // Prevent concurrent spawns for the same conversation. Internal retries
    // (initRetryAttempt > 0) are allowed through because they are sequential
    // continuations of the same spawn attempt, not independent races.
    const spawnKey = localSessionId ?? `anon-${Date.now()}`;
    if (initRetryAttempt === 0 && spawningConversations.has(spawnKey)) {
      console.log(
        "[AgentStore] spawnSession: spawn already in progress for",
        spawnKey,
        "— skipping duplicate",
      );
      return null;
    }
    if (initRetryAttempt === 0) {
      spawningConversations.add(spawnKey);
    }

    try {
      setState("isLoading", true);
      setState("error", null);

      console.log("[AgentStore] Spawning session:", {
        agentType: resolvedAgentType,
        cwd,
        localSessionId,
        resumeAgentSessionId,
      });

      // Preemptively terminate idle Claude sessions for other conversations
      // before spawning. Claude CLI cannot reliably initialize a second
      // instance while another is alive (see isRetryableClaudeInitError).
      // Without this, the new session times out 3x (60s) before the existing
      // post-failure idle-reclaim logic kicks in.
      if (resolvedAgentType === "claude-code" && initRetryAttempt === 0) {
        const idleSessions = getIdleClaudeSessionIds(localSessionId);
        for (const idleId of idleSessions) {
          console.log(
            "[AgentStore] Reclaiming idle Claude session before spawn:",
            idleId,
          );
          await this.terminateSession(idleId);
        }
      }

      console.log("[AgentStore] Checking agent availability...");
      const agentAvailable =
        await providerService.checkAgentAvailable(resolvedAgentType);
      if (!agentAvailable) {
        const helper =
          state.availableAgents.find(
            (agent) => agent.type === resolvedAgentType,
          )?.unavailableReason ??
          `${resolvedAgentType === "codex" ? "Codex" : "Claude Code"} is not available in this runtime.`;
        setState("error", helper);
        setState("isLoading", false);
        return null;
      }

      // Set up a global listener for session status events BEFORE spawning
      // This ensures we don't miss the "ready" event due to race conditions
      let resolveReady: ((sessionId: string) => void) | null = null;
      let rejectReady: ((error: Error) => void) | null = null;
      const readyPromise = new Promise<string>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      // Listen to session status events temporarily so ready-state resolution does
      // not depend on global event routing order.
      const tempUnsubscribe =
        await providerService.subscribeToEvent<SessionStatusEvent>(
          "sessionStatus",
          (data) => {
            console.log("[AgentStore] Received session status event:", data);
            if (state.sessions[data.sessionId]) {
              this.handleStatusChange(data.sessionId, data.status, data);
            }
            if (data.status === "ready" && resolveReady) {
              resolveReady(data.sessionId);
            } else if (data.status === "error" && rejectReady) {
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                "Agent session failed during initialization.";
              rejectReady(new Error(sessionError));
            } else if (data.status === "terminated" && rejectReady) {
              // Claude process exited before reaching "ready" — typically an
              // auth failure or binary-not-found on Windows.
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                "Agent session terminated before initialization completed. Check that Claude Code is installed and authenticated.";
              rejectReady(new Error(sessionError));
            }
          },
        );

      // Subscribe once to all agent runtime events before spawning, so early replay events
      // from load_session are buffered instead of dropped.
      if (!globalUnsubscribe) {
        globalUnsubscribe = await providerService.subscribeToAllEvents(
          (event) => {
            const eventSessionId = event.data.sessionId;
            if (!eventSessionId) return;

            // Drop events for sessions that have been explicitly terminated —
            // UNLESS a new spawn is in progress for this ID (spawnContextMap).
            // Without the first check, late errors from dead sessions leak in.
            // Without the second check, config events from a respawned session
            // (same ID) are silently dropped, losing model/mode/effort data.
            if (
              terminatedSessionIds.has(eventSessionId) &&
              !spawnContextMap.has(eventSessionId)
            ) {
              return;
            }

            // Skip logging high-frequency messageChunk events to avoid flooding
            // DevTools. Other event types (sessionStatus, toolCall, etc.) are
            // still logged for debugging.
            if (event.type !== "messageChunk") {
              const session = state.sessions[eventSessionId];
              const spawnCtx = session
                ? undefined
                : spawnContextMap.get(eventSessionId);
              console.log(
                "[AgentRuntime] Event received - type:",
                event.type,
                "agent:",
                session?.info?.agentType ?? spawnCtx?.agentType ?? "unknown",
                "sessionId:",
                eventSessionId,
                "conversationId:",
                session?.conversationId ?? spawnCtx?.conversationId,
              );
            }
            if (state.sessions[eventSessionId]) {
              this.handleSessionEvent(eventSessionId, event);
              return;
            }

            const pending = pendingSessionEvents.get(eventSessionId) ?? [];
            pending.push(event);
            if (pending.length > PENDING_SESSION_EVENT_LIMIT) {
              pending.shift();
            }
            pendingSessionEvents.set(eventSessionId, pending);
          },
        );
      }

      try {
        // Ensure the underlying CLI is installed and up-to-date before spawning
        const ensureFn =
          resolvedAgentType === "claude-code"
            ? providerService.ensureClaudeCli
            : resolvedAgentType === "codex"
              ? providerService.ensureCodexCli
              : null;

        if (ensureFn) {
          console.log("[AgentStore] Ensuring CLI is installed...");
          let progressUnsub: UnlistenFn = () => {};

          if (!isLocalProviderRuntime()) {
            setState(
              "error",
              "Local provider runtime is not configured for agent installation.",
            );
            setState("isLoading", false);
            return null;
          }

          progressUnsub = onRuntimeEvent(
            "provider://cli-install-progress",
            (payload) => {
              const event = payload as { stage?: string; message?: string };
              setState("installStatus", event.message ?? null);
            },
          );

          try {
            await ensureFn();
          } catch (error) {
            progressUnsub();
            tempUnsubscribe();
            const message =
              error instanceof Error
                ? error.message
                : `Failed to install ${resolvedAgentType === "codex" ? "Codex" : "Claude Code"} CLI`;
            setState("error", message);
            setState("isLoading", false);
            setState("installStatus", null);
            return null;
          }

          progressUnsub();
          setState("installStatus", null);
        }

        // Get Seren API key to enable MCP tools for the agent.
        // If null, auth may still be initializing — wait briefly and retry
        // so the agent gets publisher access on cold start.
        let apiKey = await getSerenApiKey();
        if (!apiKey) {
          await new Promise((r) => setTimeout(r, 3000));
          apiKey = await getSerenApiKey();
          if (apiKey) {
            console.info(
              "[AgentStore] API key became available after waiting for auth",
            );
          }
        }
        const enabledMcpServers = getEnabledMcpServers();

        // No inactivity timeout — agent sessions wait indefinitely.
        // The agent may be waiting for tool approval, thinking, or the user
        // may have stepped away. Killing the session is never the right call.
        const timeoutSecs = undefined;

        // Codex defaults to "on-failure" (auto-approve safe ops) regardless of
        // the global agentApprovalPolicy setting, which applies to Claude Code.
        const approvalPolicy =
          resolvedAgentType === "codex"
            ? "on-failure"
            : settingsStore.settings.agentApprovalPolicy;

        // Register spawn context so the global event logger can identify
        // early events that arrive before the session is in state.sessions.
        // Also clear the terminated flag — this session ID is being reborn;
        // events from the new process must NOT be dropped by the stale filter.
        if (localSessionId) {
          spawnContextMap.set(localSessionId, {
            agentType: resolvedAgentType,
            conversationId: localSessionId,
          });
          terminatedSessionIds.delete(localSessionId);
        }

        console.log("[AgentStore] Spawning agent process...");
        const info = await providerService.spawnAgent(
          resolvedAgentType,
          cwd,
          settingsStore.settings.agentSandboxMode,
          apiKey ?? undefined,
          approvalPolicy,
          settingsStore.settings.agentSearchEnabled,
          settingsStore.settings.agentNetworkEnabled,
          localSessionId,
          resumeAgentSessionId,
          timeoutSecs,
          enabledMcpServers,
        );
        console.log("[AgentStore] Spawn result:", info);

        // The new session is alive — immediately clear the terminated flag so
        // early events (configOptionsUpdate, sessionStatus with models/modes)
        // are NOT dropped by the global subscriber's terminatedSessionIds guard.
        // Without this, the pre-cleanup terminateSession call marks the ID, and
        // events from the NEW session get silently dropped before registration.
        terminatedSessionIds.delete(info.id);

        // Persist an agent conversation record (safe to call repeatedly via INSERT OR IGNORE).
        try {
          await createAgentConversation(
            info.id,
            conversationTitle,
            resolvedAgentType,
            cwd,
            cwd,
            resumeAgentSessionId ?? undefined,
            serializeAgentConversationMetadata({
              pendingBootstrapPromptContext: opts?.bootstrapPromptContext,
              pendingBootstrapMessages: opts?.bootstrapPromptContext
                ? opts?.restoredMessages
                : undefined,
            }) ?? undefined,
          );
        } catch (error) {
          console.warn("Failed to persist agent conversation", error);
        }

        // Create session state
        const hasRestoredMessages =
          opts?.restoredMessages && opts.restoredMessages.length > 0;
        const session: ActiveSession = {
          info,
          messages: opts?.restoredMessages ?? [],
          plan: [],
          pendingToolCalls: new Map(),
          streamingContent: "",
          streamingThinking: "",
          pendingUserMessage: "",
          cwd,
          conversationId: info.id,
          // When we already have a pending local bootstrap snapshot, skip the
          // provider's replay to avoid duplicates until that bootstrap state is
          // cleared and provider history becomes authoritative.
          skipHistoryReplay: hasRestoredMessages ? true : undefined,
          restoredMessageCount: hasRestoredMessages
            ? opts?.restoredMessages?.length
            : undefined,
          contextWindowSize: resolvedAgentType === "codex" ? 400_000 : 200_000,
          bootstrapPromptContext: opts?.bootstrapPromptContext,
          pendingPrompts: [],
        };

        setState("sessions", info.id, session);

        // Session is now registered — spawn context no longer needed for logging.
        spawnContextMap.delete(info.id);
        // This session is alive — ensure it's not in the terminated set
        // (edge case: reused conversation ID from a prior terminated session).
        terminatedSessionIds.delete(info.id);

        // Only take focus if no session is currently active. Background spawns
        // (e.g. compaction of an inactive thread) must not steal focus from
        // the user's current thread. The caller (threadStore.selectThread,
        // resumeAgentConversation, etc.) is responsible for setting focus
        // after spawn when the user explicitly navigates to the thread.
        if (!state.activeSessionId) {
          setState("activeSessionId", info.id);
        }

        const pendingEvents = pendingSessionEvents.get(info.id);
        if (pendingEvents?.length) {
          for (const pendingEvent of pendingEvents) {
            this.handleSessionEvent(info.id, pendingEvent);
          }
          pendingSessionEvents.delete(info.id);
        }

        // Create a ready promise that sendPrompt can await
        let readyResolve: () => void;
        const readyPromiseObj = {
          promise: new Promise<void>((resolve) => {
            readyResolve = resolve;
          }),
          resolve: () => readyResolve(),
        };
        sessionReadyPromises.set(info.id, readyPromiseObj);

        // Buffered resume events can mark the session ready before this gate is
        // installed. If that already happened, don't leave sendPrompt blocked on
        // a promise that will never resolve.
        if (state.sessions[info.id]?.info.status === "ready") {
          readyPromiseObj.resolve();
          sessionReadyPromises.delete(info.id);
        }

        // Wait for ready event with timeout (agent initialization can take a moment)
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(
            () => reject(new Error("Agent initialization timed out")),
            30000,
          );
        });

        let initFailure: string | null = null;
        try {
          const readySessionId = await Promise.race([
            readyPromise,
            timeoutPromise,
          ]);
          console.log("[AgentStore] Session ready:", readySessionId);

          // Update status to ready
          if (readySessionId === info.id) {
            setState(
              "sessions",
              info.id,
              "info",
              "status",
              "ready" as SessionStatus,
            );
          }
        } catch (raceError) {
          const message =
            raceError instanceof Error ? raceError.message : String(raceError);
          if (message.toLowerCase().includes("timed out")) {
            // Check if the session has an error or was terminated — if so, this
            // is a real failure (e.g. unauthenticated Claude on Windows), not a
            // benign slow start that we can proceed past.
            const sessionState = state.sessions[info.id];
            const sessionDead =
              !sessionState ||
              sessionState.error ||
              sessionState.info.status === "error" ||
              sessionState.info.status === "terminated";

            if (sessionDead) {
              console.error(
                "[AgentStore] Session terminated or errored during init wait:",
                sessionState?.error ?? sessionState?.info.status,
              );
              initFailure =
                sessionState?.error ??
                "Agent session terminated before initialization completed. Check that Claude Code is installed and authenticated.";
            } else {
              console.warn(
                "[AgentStore] Timeout waiting for ready, proceeding anyway",
              );
              // Resolve the ready promise so sendPrompt doesn't block forever
              const entry = sessionReadyPromises.get(info.id);
              if (entry) {
                entry.resolve();
                sessionReadyPromises.delete(info.id);
              }
            }
          } else {
            initFailure = message;
          }
        }

        if (initFailure) {
          if (
            resolvedAgentType === "claude-code" &&
            initRetryAttempt < MAX_CLAUDE_INIT_RETRIES &&
            isRetryableClaudeInitError(initFailure)
          ) {
            console.warn(
              "[AgentStore] Claude init failed, retrying:",
              initFailure,
            );
            await this.terminateSession(info.id);
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            const delayMs =
              CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
              Math.floor(Math.random() * 200);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: initRetryAttempt + 1,
            });
          }
          if (
            resolvedAgentType === "claude-code" &&
            !reclaimedIdleClaude &&
            isRetryableClaudeInitError(initFailure)
          ) {
            const idleClaude = getIdleClaudeSessionIds(localSessionId);
            if (idleClaude.length > 0) {
              const evictedId = idleClaude[0];
              console.warn(
                "[AgentStore] Claude init failed under pressure; reclaiming idle Claude session and retrying:",
                evictedId,
              );
              await this.terminateSession(evictedId);
              await this.terminateSession(info.id);
              sessionReadyPromises.delete(info.id);
              pendingSessionEvents.delete(info.id);
              setState("isLoading", false);
              tempUnsubscribe();
              await new Promise((resolve) => setTimeout(resolve, 300));
              return this.spawnSession(cwd, resolvedAgentType, {
                ...opts,
                initRetryAttempt: 0,
                reclaimedIdleClaude: true,
              });
            }
          }

          setState("error", initFailure);
          await this.terminateSession(info.id);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        // Worker can fail fast and remove the session before timeout handling.
        // Treat that as an initialization failure instead of returning a dead id.
        if (!state.sessions[info.id]) {
          const exitedMsg = "Agent session exited during initialization.";
          if (
            resolvedAgentType === "claude-code" &&
            initRetryAttempt < MAX_CLAUDE_INIT_RETRIES
          ) {
            console.warn(
              "[AgentStore] Claude session exited during init, retrying.",
            );
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            const delayMs =
              CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
              Math.floor(Math.random() * 200);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: initRetryAttempt + 1,
            });
          }
          if (resolvedAgentType === "claude-code" && !reclaimedIdleClaude) {
            const idleClaude = getIdleClaudeSessionIds(localSessionId);
            if (idleClaude.length > 0) {
              const evictedId = idleClaude[0];
              console.warn(
                "[AgentStore] Claude init exited early; reclaiming idle Claude session and retrying:",
                evictedId,
              );
              await this.terminateSession(evictedId);
              sessionReadyPromises.delete(info.id);
              pendingSessionEvents.delete(info.id);
              setState("isLoading", false);
              tempUnsubscribe();
              await new Promise((resolve) => setTimeout(resolve, 300));
              return this.spawnSession(cwd, resolvedAgentType, {
                ...opts,
                initRetryAttempt: 0,
                reclaimedIdleClaude: true,
              });
            }
          }

          setState("error", exitedMsg);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        // If the worker reported an initialization error, treat spawn as failed.
        // This is especially important for resume flows where the sidecar can
        // accept the command but then fail load_session (e.g. missing Claude id).
        const spawned = state.sessions[info.id];
        const initError =
          spawned?.error ??
          (spawned?.info.status === "error"
            ? "Agent session failed during initialization."
            : null);
        if (initError) {
          setState("error", initError);
          await this.terminateSession(info.id);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        setState("isLoading", false);
        tempUnsubscribe();

        return info.id;
      } catch (error) {
        console.error(
          `[AgentStore] Spawn error (${agentDisplayName(resolvedAgentType)}):`,
          error,
        );
        // Mark as terminated so the global event subscriber drops any
        // late-arriving events from this dead session. Without this,
        // stale errors leak into retried sessions that reuse the same ID.
        terminatedSessionIds.add(spawnKey);
        tempUnsubscribe();
        const message = error instanceof Error ? error.message : String(error);
        setState("error", message);
        setState("isLoading", false);
        return null;
      }
    } finally {
      // Release the spawn guard so future spawns for this conversation can proceed.
      // Only the outermost call (attempt 0) holds the guard, so only it cleans up.
      if (initRetryAttempt === 0) {
        spawningConversations.delete(spawnKey);
      }
    }
  },

  /**
   * Resume a persisted agent conversation by loading its remote agent session.
   *
   * Provider sessions own transcript history; Seren only restores local
   * bootstrap snapshots for forks that have not materialized provider history yet.
   */
  async resumeAgentConversation(
    conversationId: string,
    cwd?: string,
  ): Promise<string | null> {
    // If already running, just focus it.
    if (state.sessions[conversationId]) {
      setState("activeSessionId", conversationId);
      return conversationId;
    }

    // Prevent infinite spawn-crash-respawn cascades: if this conversation
    // has failed too many times in a short window, stop retrying.
    if (isSpawnCascading(conversationId)) {
      console.error(
        `[AgentStore] Spawn cascade detected for ${conversationId} — ${SPAWN_CASCADE_MAX_FAILURES} failures in ${SPAWN_CASCADE_WINDOW_MS / 1000}s. Stopping auto-resume.`,
      );
      setState(
        "error",
        "Agent failed to start after multiple attempts. Please try again or check Settings.",
      );
      setState("isLoading", false);
      return null;
    }

    setState("error", null);

    // Pre-emptively clean up any stale backend session with this conversation id.
    // If the frontend lost track of a session (e.g. after a crash or auth error),
    // the backend may still hold it, causing "Session already exists" on re-spawn.
    // Mark as terminated so late-arriving events from the old session are dropped.
    terminatedSessionIds.add(conversationId);
    try {
      await providerService.terminateSession(conversationId);
    } catch {
      // Ignore — session likely doesn't exist in the backend
    }

    let convo: DbAgentConversation | null = null;
    try {
      convo = await getAgentConversation(conversationId);
    } catch (error) {
      console.error("Failed to read agent conversation:", error);
    }
    if (!convo) {
      setState("error", "Agent conversation not found");
      return null;
    }
    const agentType: AgentType =
      convo.agent_type === "codex" || convo.agent_type === "claude-code"
        ? (convo.agent_type as AgentType)
        : state.selectedAgentType;
    const convoMetadata = parseAgentConversationMetadata(convo.agent_metadata);
    const pendingBootstrapPromptContext =
      convoMetadata.pendingBootstrapPromptContext;
    const restoredMessages = Array.isArray(
      convoMetadata.pendingBootstrapMessages,
    )
      ? convoMetadata.pendingBootstrapMessages
      : [];

    const remoteSessionId = convo.agent_session_id?.trim();
    if (!remoteSessionId) {
      console.warn(
        "[AgentStore] Conversation has no stored remote session id; creating a fresh session.",
        conversationId,
      );
      const convoCwd =
        convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
      const freshCwd = convoCwd || cwd;
      if (!freshCwd) {
        setState(
          "error",
          "Unable to determine project path for this conversation.",
        );
        return null;
      }
      const freshSessionId = await this.spawnSession(freshCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
        restoredMessages,
        bootstrapPromptContext: pendingBootstrapPromptContext,
      });
      if (freshSessionId) {
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return freshSessionId;
    }
    if (
      agentType === "claude-code" &&
      LEGACY_CLAUDE_LOCAL_SESSION_ID_RE.test(remoteSessionId)
    ) {
      setState(
        "error",
        "This conversation references a legacy local Claude id. Use Browse Claude Sessions and resume the real remote session.",
      );
      return null;
    }

    const convoCwd =
      convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
    const resumeCwd = convoCwd || cwd;
    if (!resumeCwd) {
      setState(
        "error",
        "Unable to determine project path for this conversation.",
      );
      return null;
    }

    const sessionId = await this.spawnSession(resumeCwd, agentType, {
      localSessionId: conversationId,
      resumeAgentSessionId: remoteSessionId,
      conversationTitle: convo.title,
      restoredMessages,
      bootstrapPromptContext: pendingBootstrapPromptContext,
    });

    // Legacy Claude conversations can reference session IDs that no longer
    // exist on disk. In that case, fall back to a fresh session for the same
    // persisted conversation instead of failing hard.
    if (!sessionId && agentType === "claude-code") {
      console.warn(
        "[AgentStore] Claude resume failed, starting a fresh session for conversation",
        conversationId,
        state.error,
      );
      // Try resuming the remote session (preserves history). If the session
      // file is corrupted, this will also fail — fall through to fresh.
      let fallbackSessionId = await this.spawnSession(resumeCwd, agentType, {
        localSessionId: conversationId,
        resumeAgentSessionId: remoteSessionId,
        conversationTitle: convo.title,
        restoredMessages,
        bootstrapPromptContext: pendingBootstrapPromptContext,
      });

      // If resume-based fallback also failed, the session file is likely
      // corrupted (Claude CLI exits code=1 with no stderr). Start a
      // completely fresh session without --resume. Load persisted messages
      // from SQLite so the user sees their history and the agent gets context.
      if (!fallbackSessionId) {
        console.warn(
          "[AgentStore] Resume fallback also failed — spawning without --resume for",
          conversationId,
        );
        const persisted = await loadPersistedAgentHistory(conversationId);
        fallbackSessionId = await this.spawnSession(resumeCwd, agentType, {
          localSessionId: conversationId,
          conversationTitle: convo.title,
          restoredMessages:
            persisted.messages.length > 0 ? persisted.messages : undefined,
          bootstrapPromptContext: persisted.context || undefined,
        });
      }

      if (fallbackSessionId) {
        // Clear error state and remove stale error messages left by the
        // failed first spawn. Without this, "Claude Code request failed"
        // banners persist even though the retry session is healthy.
        setState("error", null);
        setState("sessions", fallbackSessionId, "error", undefined);
        setState("sessions", fallbackSessionId, "messages", (msgs) =>
          msgs.filter((m) => m.type !== "error"),
        );
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return fallbackSessionId;
    }

    if (sessionId) {
      if (!pendingBootstrapPromptContext) {
        clearLegacyAgentTranscript(conversationId);
      }
      clearSpawnFailures(conversationId);
      void this.refreshRecentAgentConversations(200).catch(() => {});
    } else {
      recordSpawnFailure(conversationId);
    }
    return sessionId;
  },
  /**
   * Resume a remote agent session from the provider's stored session list.
   *
   * If a local persisted conversation already exists for this remote session,
   * we resume that; otherwise we create a new local conversation and resume it.
   */
  async resumeRemoteSession(
    remoteSession: RemoteSessionInfo,
    cwd: string,
    agentType?: AgentType,
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const existing = state.recentAgentConversations.find(
      (c) =>
        c.agent_type === resolvedAgentType &&
        c.agent_session_id === remoteSession.sessionId,
    );
    if (existing && state.sessions[existing.id]) {
      setState("activeSessionId", existing.id);
      return existing.id;
    }

    const title =
      remoteSession.title?.trim() ||
      `${resolvedAgentType === "codex" ? "Codex" : "Claude"} Session ${remoteSession.sessionId.slice(0, 8)}`;
    const sessionId = await this.spawnSession(cwd, resolvedAgentType, {
      localSessionId: existing?.id,
      resumeAgentSessionId: remoteSession.sessionId,
      conversationTitle: existing?.title?.trim() || title,
    });
    if (sessionId) {
      void this.refreshRecentAgentConversations(200).catch(() => {});
    }
    return sessionId;
  },

  async buildPromptContext(
    sessionId: string,
    context?: Array<Record<string, string>>,
  ): Promise<Array<Record<string, string>> | undefined> {
    const session = state.sessions[sessionId];
    if (!session) {
      return context && context.length > 0 ? [...context] : undefined;
    }

    let mergedContext = context ? [...context] : [];

    if (session.bootstrapPromptContext) {
      mergedContext = [
        { type: "text", text: session.bootstrapPromptContext },
        ...mergedContext,
      ];
    }

    try {
      const skillsContent = await skillsStore.getThreadSkillsContent(
        session.cwd,
        session.conversationId,
      );
      if (skillsContent) {
        mergedContext = [
          { type: "text", text: skillsContent },
          ...mergedContext,
        ];
      }
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to load skills for agent prompt:",
        error,
      );
    }

    // Inject publisher inventory so the agent knows which services are
    // available via call_publisher / list_agent_publishers. Without this,
    // the agent checks MCP resources (empty) and concludes services like
    // GitHub are unavailable.
    const publisherSlugs = getCallablePublisherSlugs();
    if (publisherSlugs.length > 0) {
      const publisherList = publisherSlugs.sort().join(", ");
      mergedContext = [
        {
          type: "text",
          text:
            "Available Seren MCP Publishers (callable via your seren-mcp tools): " +
            publisherList +
            ". Use list_agent_publishers to discover tools for a specific publisher, " +
            "then call_publisher to invoke them. Do NOT say a service is unavailable " +
            "without first checking this list.",
        },
        ...mergedContext,
      ];
    }

    return mergedContext.length > 0 ? mergedContext : undefined;
  },

  setBootstrapPromptContext(
    sessionId: string,
    bootstrapPromptContext?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) {
      return;
    }

    setState(
      "sessions",
      sessionId,
      "bootstrapPromptContext",
      bootstrapPromptContext,
    );
    const conversationId = session.conversationId;
    if (conversationId) {
      void setAgentConversationMetadataDb(
        conversationId,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? session.messages
            : undefined,
        }),
      ).catch((error) => {
        console.warn("Failed to persist agent bootstrap context", error);
      });
    }
  },

  clearBootstrapPromptContext(sessionId: string) {
    this.setBootstrapPromptContext(sessionId, undefined);
    const conversationId = state.sessions[sessionId]?.conversationId;
    if (conversationId) {
      clearLegacyAgentTranscript(conversationId);
    }
  },

  async restoreSessionSettings(
    sourceSession: ActiveSession,
    targetSessionId: string,
  ) {
    if (sourceSession.currentModeId) {
      await this.setPermissionMode(
        sourceSession.currentModeId,
        targetSessionId,
      );
    }
    if (sourceSession.currentModelId) {
      await this.setModel(sourceSession.currentModelId, targetSessionId);
    }
    if (sourceSession.configOptions) {
      const restore: Record<string, string> = {};
      for (const opt of sourceSession.configOptions) {
        if (opt.type === "select" && opt.currentValue) {
          restore[opt.id] = opt.currentValue;
        }
      }
      if (Object.keys(restore).length > 0) {
        setState("sessions", targetSessionId, "pendingConfigRestore", restore);
      }
    }
  },

  /**
   * Terminate a session.
   */
  async terminateSession(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Mark as terminated BEFORE the async IPC call so the global event
    // subscriber immediately starts dropping late-arriving events.
    terminatedSessionIds.add(sessionId);

    try {
      await providerService.terminateSession(sessionId);
    } catch (error) {
      console.error("Failed to terminate session:", error);
    }

    // Clean up ready promise if still pending
    sessionReadyPromises.delete(sessionId);
    pendingSessionEvents.delete(sessionId);
    spawnContextMap.delete(sessionId);

    // Remove from state using produce to properly delete the key
    setState(
      produce((draft) => {
        delete draft.sessions[sessionId];
      }),
    );

    // Switch to another session if this was active
    if (state.activeSessionId === sessionId) {
      const remainingIds = Object.keys(state.sessions).filter(
        (id) => id !== sessionId,
      );
      setState("activeSessionId", remainingIds[0] ?? null);
    }

    // Stop global event subscription when no sessions remain.
    if (Object.keys(state.sessions).length === 0 && globalUnsubscribe) {
      globalUnsubscribe();
      globalUnsubscribe = null;
      pendingSessionEvents.clear();
      terminatedSessionIds.clear();
      spawnContextMap.clear();
    }
  },

  /**
   * Set the active session.
   */
  setActiveSession(sessionId: string | null) {
    console.log(
      "[AgentRuntime] setActiveSession - old:",
      state.activeSessionId,
      "new:",
      sessionId,
    );
    setState("activeSessionId", sessionId);
  },

  /**
   * Clear all messages in a session and respawn the CLI process.
   * Clearing UI messages alone is not enough — Claude Code CLI maintains its
   * own internal context, so the old session remains full. We terminate the
   * CLI session and spawn a fresh one to actually free up context.
   */
  clearSessionMessages(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Clear UI messages and persisted history. The CLI session stays alive —
    // its internal context is independent of our message store. Killing and
    // respawning caused an infinite loop: the new session got a different ID,
    // selectThread couldn't find it, triggered resumeAgentConversation on the
    // old conversation, which replayed all old messages and re-triggered clear.
    setState("sessions", sessionId, "messages", []);
    clearConversationHistory(session.conversationId).catch((err) =>
      console.error("[AgentStore] Failed to clear persisted messages:", err),
    );
  },

  /**
   * Compact an agent conversation: generate a summary of older messages via
   * Gateway API, terminate the current agent session, and spawn a fresh one
   * seeded with the summary. The user stays in the same conversation.
   */
  async compactAgentConversation(
    sessionId: string,
    preserveCount: number,
  ): Promise<void> {
    const session = state.sessions[sessionId];
    if (!session || session.isCompacting) return;

    const messages = session.messages;
    if (messages.length <= preserveCount) {
      console.info("[AgentStore] Not enough messages to compact");
      return;
    }

    setState("sessions", sessionId, "isCompacting", true);

    try {
      // Split messages into those to summarize and those to keep
      const toCompact = messages.slice(0, messages.length - preserveCount);
      const toPreserve = messages.slice(-preserveCount);

      // Generate a structured summary via Gateway API (not via the agent —
      // its context is what's overloaded). Uses a hard-capped schema to keep
      // the summary under 200 tokens, down from ~700 with freeform "500 words".
      // This reduces prompt tokens on every subsequent call by ~70%.
      const summaryPrompt = `Summarize this AI agent conversation into EXACTLY this structured format. Each field must be 1-2 short sentences max. Total output must be under 150 tokens.

GOAL: <what the user is trying to accomplish>
FILES: <files created or modified, comma-separated paths only>
DECISIONS: <key technical decisions made>
STATE: <what is done vs in progress>
NEXT: <what the user will likely ask next>

Conversation:
${toCompact.map((m) => `${m.type.toUpperCase()}: ${m.content}`).join("\n\n")}

Structured summary:`;

      // Always route the summary through the public Seren provider.
      // sendMessage() uses providerStore.activeProvider which may be
      // stale from a previous chat thread (e.g. seren-private). The
      // compaction summary is an internal operation — it must not
      // depend on UI provider state.
      const summaryModel = "anthropic/claude-sonnet-4";
      const summaryRequest = buildChatRequest(summaryPrompt, summaryModel);
      let summary: string;
      try {
        summary = await sendProviderMessage("seren", summaryRequest);
      } catch (firstErr) {
        // If auth expired, attempt a token refresh and retry once
        const msg = firstErr instanceof Error ? firstErr.message : "";
        if (msg.includes("Not authenticated") || msg.includes("401")) {
          const refreshed = await refreshAccessToken();
          if (!refreshed) throw firstErr;
          summary = await sendProviderMessage("seren", summaryRequest);
        } else {
          throw firstErr;
        }
      }

      const compactedSummary: AgentCompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: Date.now(),
      };

      // Capture session details and user-configured settings before termination
      const cwd = session.cwd;
      const agentType = session.info.agentType;
      const conversationId = session.conversationId;
      // Preserve the last user prompt so we can retry it after compaction.
      // Without this, the user's message is lost when the old session is
      // terminated and the new session starts with lastUserPrompt = undefined.
      const pendingUserPrompt = session.lastUserPrompt;
      // Terminate the old agent session
      await this.terminateSession(sessionId);

      // Spawn a new agent session with the same conversation
      const newSessionId = await this.spawnSession(cwd, agentType, {
        localSessionId: conversationId,
      });

      if (!newSessionId) {
        console.error(
          "[AgentStore] Failed to spawn new session after compaction",
        );
        return;
      }

      // Store compacted summary and preserved messages on the new session.
      // Mark them as restored so the message-count threshold ignores them.
      setState("sessions", newSessionId, "compactedSummary", compactedSummary);

      // Prepend a visible notice so the user knows compaction occurred and
      // understands why earlier messages are no longer visible.
      const compactionNotice: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: `Context compacted: ${toCompact.length} earlier messages summarized to keep the session active. The ${toPreserve.length} most recent messages are shown below.`,
        timestamp: Date.now(),
      };
      setState("sessions", newSessionId, "messages", [
        compactionNotice,
        ...toPreserve,
      ]);
      setState(
        "sessions",
        newSessionId,
        "restoredMessageCount",
        toPreserve.length + 1, // +1 for the compaction notice
      );

      // Seed the new agent with the summary so it has context
      console.info(
        `[AgentStore] Compacted ${toCompact.length} messages, preserved ${toPreserve.length}. Seeding new session.`,
      );

      // Build a condensed representation of preserved messages so the agent
      // retains awareness of recent work, not just the high-level summary.
      const MAX_MSG_CHARS = 2000;
      const preservedContext = toPreserve
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => {
          const content =
            m.content.length > MAX_MSG_CHARS
              ? `${m.content.slice(0, MAX_MSG_CHARS)}... [truncated]`
              : m.content;
          return `${m.type.toUpperCase()}: ${content}`;
        })
        .join("\n\n");

      const seedPrompt = preservedContext
        ? `Context restored after automatic compaction.\n\nPrior work summary:\n${summary}\n\nRecent messages:\n${preservedContext}\n\nConfirm you have this context in one sentence, then wait for the user's next message. Do not use any tools.`
        : `Context restored after automatic compaction.\n\nPrior work summary:\n${summary}\n\nConfirm you have this context in one sentence, then wait for the user's next message. Do not use any tools.`;

      // Wait for the new session to be ready, then restore settings and seed
      await waitForSessionReady(newSessionId);

      // Restore user-configured settings from the prior session
      await this.restoreSessionSettings(session, newSessionId);

      await providerService.sendPrompt(newSessionId, seedPrompt);

      // Wait for the seed prompt to finish before retrying the user's message.
      await waitForSessionIdle(newSessionId);

      // Retry the user's last prompt if one was in-flight when compaction
      // triggered. This prevents the message from being silently dropped.
      if (pendingUserPrompt) {
        console.info(
          "[AgentStore] Retrying user prompt after auto-compaction:",
          pendingUserPrompt.slice(0, 60),
        );
        setState("sessions", newSessionId, "lastUserPrompt", pendingUserPrompt);
        await providerService.sendPrompt(newSessionId, pendingUserPrompt);
      }
    } catch (error) {
      console.error(
        "[AgentStore] Failed to compact agent conversation:",
        error,
      );
      // If the original session still exists, clear compacting flag
      if (state.sessions[sessionId]) {
        setState("sessions", sessionId, "isCompacting", false);
      }
    }
  },

  /**
   * Compact the conversation and retry the last user prompt.
   * Returns true if compaction + retry succeeded, false if we should fall back.
   */
  async compactAndRetry(sessionId: string): Promise<boolean> {
    const session = state.sessions[sessionId];
    if (!session || session.compactRetryAttempted || session.isCompacting) {
      return false;
    }

    setState("sessions", sessionId, "compactRetryAttempted", true);

    const lastPrompt = session.lastUserPrompt;
    console.info(
      `[AgentStore] Prompt too long — attempting compaction${lastPrompt ? " + retry" : " (no prompt to retry)"}`,
    );

    try {
      await this.compactAgentConversation(
        sessionId,
        settingsStore.settings.autoCompactPreserveMessages,
      );

      // After compaction, the old session is terminated and a new one exists.
      // Find the new session by conversation ID.
      const convoId = session.conversationId;
      const newEntry = Object.entries(state.sessions).find(
        ([, s]) => s.conversationId === convoId && !s.isCompacting,
      );
      if (!newEntry) {
        console.warn(
          "[AgentStore] compactAndRetry: new session not found after compaction",
        );
        return false;
      }

      const [newSessionId] = newEntry;

      // If compaction was skipped (e.g. not enough messages to compact),
      // the search returns the original session — retrying on the same
      // full session would fail again and falsely signal success.
      if (newSessionId === sessionId) {
        console.warn(
          "[AgentStore] compactAndRetry: compaction was skipped, cannot retry",
        );
        return false;
      }

      // compactAgentConversation sends the seed prompt before returning, so the
      // session may still be in 'prompting' state. Wait for it to go idle before
      // sending the user's original prompt to avoid a concurrent-prompt race.
      await waitForSessionIdle(newSessionId);

      // Retry the original prompt if available; otherwise leave the
      // compacted session ready for the user's next input.
      if (lastPrompt) {
        console.info(
          `[AgentStore] Compaction complete, retrying prompt on session ${newSessionId}`,
        );
        await providerService.sendPrompt(newSessionId, lastPrompt);
      } else {
        console.info(
          `[AgentStore] Compaction complete on session ${newSessionId} — no prompt to retry, session ready`,
        );
      }
      return true;
    } catch (error) {
      console.error(
        "[AgentStore] compactAndRetry failed, falling back to Chat:",
        error,
      );
      return false;
    }
  },

  /**
   * Focus an already-running session that belongs to the given project cwd.
   * Returns true when a matching session is found.
   */
  focusProjectSession(cwd: string): boolean {
    const match = Object.entries(state.sessions).find(
      ([, session]) => session.cwd === cwd,
    );
    if (!match) return false;
    const [sessionId] = match;
    if (state.activeSessionId !== sessionId) {
      setState("activeSessionId", sessionId);
    }
    return true;
  },

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Send a prompt to the active session.
   * Auto-recovers from dead sessions by restarting and retrying.
   */
  async sendPrompt(
    prompt: string,
    context?: Array<Record<string, string>>,
    options?: { displayContent?: string; docNames?: string[] },
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    console.log("[AgentStore] sendPrompt called:", {
      sessionId,
      prompt: prompt.slice(0, 50),
    });
    if (!sessionId) {
      setState("error", "No active session");
      return;
    }

    const session = state.sessions[sessionId];
    if (!session || session.info.status === "error") {
      // Set session-specific error if session exists
      if (session) {
        setState(
          "sessions",
          sessionId,
          "error",
          "Session has ended. Please start a new session.",
        );
      } else {
        setState("error", "Session has ended. Please start a new session.");
      }
      return;
    }

    // If auto-recovery is in-flight for THIS session (triggered by another
    // sendPrompt call), wait for it. Recovery already retries the original
    // prompt, so proceeding would race and cause "Another prompt is already
    // active". Recovery on OTHER sessions must NOT block this one.
    const thisRecovery = recoveryInFlightMap.get(sessionId);
    if (thisRecovery) {
      console.info(
        `[AgentStore] sendPrompt: recovery in-flight for ${sessionId}, waiting before proceeding...`,
      );
      await thisRecovery;
      const refreshed = state.sessions[sessionId];
      if (!refreshed) {
        console.info(
          "[AgentStore] sendPrompt: session gone after recovery, aborting",
        );
        return;
      }
      if (refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session already prompting after recovery, aborting duplicate",
        );
        return;
      }
    }

    // Wait for session to be ready before sending prompt
    if (
      sessionReadyPromises.has(sessionId) &&
      state.sessions[sessionId]?.info.status !== "ready"
    ) {
      console.info(
        `[AgentStore] sendPrompt: waiting for session ${sessionId} to be ready...`,
      );
      await waitForSessionReady(sessionId);
      console.info("[AgentStore] sendPrompt: session is now ready");
    }

    // Re-check after async waits — recovery may have started while we waited.
    const thisRecoveryAfterWait = recoveryInFlightMap.get(sessionId);
    if (thisRecoveryAfterWait) {
      console.info(
        `[AgentStore] sendPrompt: recovery started during ready-wait for ${sessionId}, deferring...`,
      );
      await thisRecoveryAfterWait;
      const refreshed = state.sessions[sessionId];
      if (!refreshed || refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session busy after recovery, aborting duplicate",
        );
        return;
      }
    }

    // Optimistically mark as prompting so the UI can show a loading state
    // immediately, even before backend events arrive.
    setState(
      "sessions",
      sessionId,
      "info",
      "status",
      "prompting" as SessionStatus,
    );

    // Track when the prompt started for duration calculation
    setState("sessions", sessionId, "promptStartTime", Date.now());
    // Clear any prior cancel flag — user is submitting a new prompt.
    setState("sessions", sessionId, "cancelRequested", undefined);
    // Store the prompt so we can retry after compaction if needed
    setState("sessions", sessionId, "lastUserPrompt", prompt);
    setState("sessions", sessionId, "compactRetryAttempted", false);

    // Add user message — display only user's typed text, not extracted doc content
    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: options?.displayContent ?? prompt,
      timestamp: Date.now(),
      ...(options?.docNames?.length ? { docNames: options.docNames } : {}),
    };

    console.log(
      "[AgentRuntime] Adding user message to session:",
      sessionId,
      "conversationId:",
      state.sessions[sessionId]?.conversationId,
      "content:",
      prompt.slice(0, 50),
    );
    setState("sessions", sessionId, "messages", (msgs) => [
      ...msgs,
      userMessage,
    ]);
    const convoId = state.sessions[sessionId]?.conversationId;
    if (convoId) persistAgentMessage(convoId, userMessage);
    // Discard any buffered chunks from the previous response
    clearChunkBuf(sessionId);
    setState("sessions", sessionId, "streamingContent", "");
    setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    setState("sessions", sessionId, "streamingThinking", "");
    setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);

    // Derive tab title from the first user prompt
    if (!state.sessions[sessionId]?.title) {
      const maxLen = 30;
      const trimmed = prompt.trim().replace(/\s+/g, " ");
      const title =
        trimmed.length <= maxLen
          ? trimmed
          : (() => {
              const t = trimmed.slice(0, maxLen);
              const sp = t.lastIndexOf(" ");
              return `${sp > 10 ? t.slice(0, sp) : t}\u2026`;
            })();
      setState("sessions", sessionId, "title", title);

      // Persist derived title to DB so it survives app restarts
      const convoId = state.sessions[sessionId]?.conversationId;
      if (convoId) {
        setAgentConversationTitleDb(convoId, title).catch((err) => {
          console.warn("[AgentStore] Failed to persist title:", err);
        });
      }
    }

    console.log("[AgentStore] Calling providerService.sendPrompt...");
    try {
      const mergedContext = await this.buildPromptContext(sessionId, context);
      await providerService.sendPrompt(sessionId, prompt, mergedContext);
      this.clearBootstrapPromptContext(sessionId);
      console.log("[AgentStore] sendPrompt completed successfully");
    } catch (error) {
      const agentLabel = agentDisplayName(
        state.sessions[sessionId]?.info.agentType,
      );
      console.error(`[AgentStore] sendPrompt error (${agentLabel}):`, error);
      const message = error instanceof Error ? error.message : String(error);

      // Auto-recover from dead/zombie sessions.
      // "unresponsive" = agent force-stopped after timeout (prompt or cancel deadline).
      // Other patterns = session died unexpectedly.
      // NOTE: "Task cancelled" (graceful cancel) is excluded — not a dead session.
      const isForceStop = message.includes("unresponsive");
      const isDeadSession =
        message.includes("Worker thread dropped") ||
        message.includes("not found") ||
        message.includes("Session not initialized");
      if (
        isForceStop ||
        (!message.includes("Task cancelled") && isDeadSession)
      ) {
        // If another recovery is already in-flight for this session, wait
        // for it instead of spawning a duplicate session.
        const existingRecovery = recoveryInFlightMap.get(sessionId);
        if (existingRecovery) {
          console.info(
            `[AgentStore] Recovery already in-flight for ${sessionId}, waiting for it...`,
          );
          await existingRecovery;
          return;
        }

        console.info(
          "[AgentStore] Session appears dead, attempting auto-recovery...",
        );

        // Preserve conversation history and cwd before cleanup.
        // Filter out any "unresponsive" error messages that the event handler
        // may have added before this catch block ran — restoring them would
        // create duplicate banners in the new session.
        const existingMessages = [...session.messages].filter(
          (m) =>
            m.id !== userMessage.id &&
            !(m.type === "error" && m.content.includes("unresponsive")),
        );
        const cwd = session.cwd;
        const agentType = session.info.agentType;
        // Snapshot cancel intent before cleanup clears session state.
        const wasUserCancel = session.cancelRequested === true;

        // Clean up the dead session
        await this.terminateSession(sessionId);

        // Guard against concurrent recoveries: set the in-flight promise
        // before spawning so any parallel sendPrompt calls will wait.
        const doRecovery = async (): Promise<string | null> => {
          const newSessionId = await this.spawnSession(cwd, agentType, {
            localSessionId: session.conversationId,
            bootstrapPromptContext: session.bootstrapPromptContext,
          });
          if (newSessionId) {
            await this.restoreSessionSettings(session, newSessionId);

            // Restore conversation history to the new session.
            // Mark as restored so the message-count threshold ignores them.
            if (existingMessages.length > 0) {
              setState("sessions", newSessionId, "messages", existingMessages);
              setState(
                "sessions",
                newSessionId,
                "restoredMessageCount",
                existingMessages.length,
              );
            }

            if (wasUserCancel) {
              // The user explicitly cancelled — don't retry. Just show a
              // neutral message so they know the session was restarted.
              console.info(
                "[AgentStore] Agent unresponsive after cancel — spawned fresh session, skipping retry",
              );
              const cancelMsg: AgentMessage = {
                id: crypto.randomUUID(),
                type: "assistant",
                content: "Session restarted after cancellation.",
                timestamp: Date.now(),
              };
              setState("sessions", newSessionId, "messages", (msgs) => [
                ...msgs,
                cancelMsg,
              ]);
              const newConvoId = state.sessions[newSessionId]?.conversationId;
              if (newConvoId) {
                persistAgentMessage(newConvoId, cancelMsg);
              }
            } else {
              // Show recovery indicator so the user knows what happened
              const recoveryMsg: AgentMessage = {
                id: crypto.randomUUID(),
                type: "assistant",
                content:
                  "Agent session restarted due to inactivity timeout. Retrying your message...",
                timestamp: Date.now(),
              };
              setState("sessions", newSessionId, "messages", (msgs) => [
                ...msgs,
                recoveryMsg,
                userMessage,
              ]);
              const newConvoId = state.sessions[newSessionId]?.conversationId;
              if (newConvoId) {
                persistAgentMessage(newConvoId, recoveryMsg);
                persistAgentMessage(newConvoId, userMessage);
              }

              // Retry the prompt on the new session, rebuilding skills context
              // so skill invocations work on the fresh session.
              console.info(
                `[AgentStore] Retrying prompt on new session ${newSessionId}`,
              );
              try {
                const retryContext = await this.buildPromptContext(
                  newSessionId,
                  context,
                );
                await providerService.sendPrompt(
                  newSessionId,
                  prompt,
                  retryContext,
                );
                this.clearBootstrapPromptContext(newSessionId);
                console.log("[AgentStore] Retry succeeded on new session");
              } catch (retryError) {
                console.error("[AgentStore] Retry failed:", retryError);
                const retryMessage =
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError);
                this.addErrorMessage(
                  newSessionId,
                  `Recovery failed: ${retryMessage}. Please try sending your message again.`,
                );
              }
            }
          }
          return newSessionId;
        };

        const recoveryPromise = doRecovery().finally(() => {
          recoveryInFlightMap.delete(sessionId);
        });
        recoveryInFlightMap.set(sessionId, recoveryPromise);

        const newSessionId = await recoveryPromise;
        if (!newSessionId) {
          setState("error", "Session died and could not be restarted.");
        }
        return;
      }

      // For prompt-too-long errors, wait for the in-flight compactAndRetry
      // to finish before giving up. Without this, sendPrompt rejects while
      // compaction is still running, and the compaction result is lost.
      if (isPromptTooLongError(message)) {
        const compactPromise = state.sessions[sessionId]?.compactRetryPromise;
        if (compactPromise) {
          console.info(
            "[AgentStore] sendPrompt: waiting for in-flight compaction to complete",
          );
          await compactPromise;
        }
        // Don't add error message — compactAndRetry handles fallback
      } else if (!message.includes("Task cancelled")) {
        this.addErrorMessage(sessionId, message);
      }

      // Ensure the session is not stuck in "prompting" after any error —
      // UNLESS it's a transient reconnection attempt where the agent will
      // resume on its own. Setting "ready" during reconnection triggers
      // premature queue drain, injecting pending messages mid-reconnect.
      const isReconnecting = /^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(message);
      if (
        !isReconnecting &&
        state.sessions[sessionId]?.info.status === "prompting"
      ) {
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
      }
    }
  },

  /**
   * Cancel the current prompt in the active session.
   */
  async cancelPrompt(forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) {
      console.warn("[AgentStore] cancelPrompt: no active session");
      return;
    }

    const session = state.sessions[sessionId];
    console.info(
      `[AgentStore] cancelPrompt: session=${sessionId}, status=${session?.info.status}`,
    );

    setState("sessions", sessionId, "cancelRequested", true);

    try {
      await providerService.cancelPrompt(sessionId);
      console.info("[AgentStore] cancelPrompt: backend acknowledged cancel");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        console.warn(
          "[AgentStore] cancelPrompt: stale session, resetting status",
        );
        setState("sessions", sessionId, "info", "status", "ready");
      } else {
        console.error("[AgentStore] cancelPrompt failed:", error);
      }
    }
  },

  /**
   * Set permission mode for the active session.
   */
  async setPermissionMode(modeId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setPermissionMode(sessionId, modeId);
      // Optimistic update — the authoritative update arrives via
      // CurrentModeUpdate notification handled in handleStatusChange.
      setState("sessions", sessionId, "currentModeId", modeId);
    } catch (error) {
      console.error(
        `[AgentStore] Failed to set permission mode to "${modeId}":`,
        error,
      );
    }
  },

  /**
   * Set the AI model for the active session.
   */
  async setModel(modelId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setModel(sessionId, modelId);
      setState("sessions", sessionId, "currentModelId", modelId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationModelIdDb(
          session.conversationId,
          modelId,
        ).catch((error) => {
          console.warn("Failed to persist agent model selection", error);
        });
      }
    } catch (error) {
      console.error("[AgentStore] Failed to set model:", error);
    }
  },

  /**
   * Set a session configuration option (e.g., reasoning effort).
   */
  async setConfigOption(
    configId: string,
    valueId: string,
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setConfigOption(sessionId, configId, valueId);
      // Optimistically update local config option state (if present).
      setState("sessions", sessionId, "configOptions", (opts) => {
        if (!opts) return opts;
        return opts.map((o) => {
          if (o.id === configId && o.type === "select") {
            return { ...o, currentValue: valueId };
          }
          return o;
        });
      });
    } catch (error) {
      console.error("[AgentStore] Failed to set config option:", error);
    }
  },

  async respondToPermission(requestId: string, optionId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (!permission) {
      console.warn(
        `[AgentStore] respondToPermission: request ${requestId} not found in pending list`,
      );
      return;
    }

    console.info(
      `[AgentStore] Responding to permission ${requestId}: session=${permission.sessionId}, option=${optionId}`,
    );

    try {
      await providerService.respondToPermission(
        permission.sessionId,
        requestId,
        optionId,
      );
      console.info(
        `[AgentStore] Permission ${requestId} response delivered to backend`,
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("not found") || errorMsg.includes("timed out")) {
        // Permission already timed out or was cleaned up on backend
        console.warn(
          `[AgentStore] Permission ${requestId} no longer valid (likely timed out)`,
        );
        // User was already notified by the timeout error handler above
      } else {
        console.error(
          `[AgentStore] Failed to respond to permission ${requestId}:`,
          error,
        );
      }
    }

    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async dismissPermission(requestId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (permission) {
      console.info(
        `[AgentStore] Dismissing permission ${requestId}: session=${permission.sessionId}`,
      );
      try {
        await providerService.respondToPermission(
          permission.sessionId,
          requestId,
          "deny",
        );
      } catch (error) {
        console.error(
          `[AgentStore] Failed to send deny for permission ${requestId}:`,
          error,
        );
      }
    } else {
      console.warn(
        `[AgentStore] dismissPermission: request ${requestId} not found in pending list`,
      );
    }
    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async respondToDiffProposal(proposalId: string, accepted: boolean) {
    const proposal = state.pendingDiffProposals.find(
      (p) => p.proposalId === proposalId,
    );
    if (!proposal) return;

    try {
      await providerService.respondToDiffProposal(
        proposal.sessionId,
        proposalId,
        accepted,
      );
    } catch (error) {
      console.error("Failed to respond to diff proposal:", error);
    }

    setState(
      "pendingDiffProposals",
      state.pendingDiffProposals.filter((p) => p.proposalId !== proposalId),
    );
  },

  // ============================================================================
  // UI State
  // ============================================================================

  /**
   * Set the selected agent type for new sessions.
   */
  setAgentModeEnabled(enabled: boolean) {
    setState("agentModeEnabled", runtimeHasCapability("agents") && enabled);
  },

  setSelectedAgentType(agentType: AgentType) {
    setState("selectedAgentType", agentType);
    // Reset remote session listing when switching agents to avoid mixed results.
    setState("remoteSessions", []);
    setState("remoteSessionsNextCursor", null);
    setState("remoteSessionsError", null);
  },

  /**
   * Update the agent's working directory by sending a cd command.
   * Called when the user opens a different folder while a session is active.
   */
  async updateCwd(newCwd: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    const session = state.sessions[sessionId];
    if (!session || session.cwd === newCwd) return;

    // Update stored cwd
    setState("sessions", sessionId, "cwd", newCwd);

    // Send cd instruction to the agent if session is ready
    if (session.info.status === "ready") {
      await this.sendPrompt(
        `Please change your working directory to: ${newCwd}`,
      );
    }
  },

  /**
   * Whether the active session hit a rate limit (triggers chat fallback prompt).
   */
  get rateLimitHit(): boolean {
    const session = this.activeSession;
    return session?.rateLimitHit === true;
  },

  /**
   * Whether the active session's context window is full (triggers chat fallback prompt).
   */
  get promptTooLong(): boolean {
    const session = this.activeSession;
    return session?.promptTooLong === true;
  },

  /**
   * Whether any agent-level fallback banner should be shown (rate limit OR context full).
   */
  get agentFallbackNeeded(): boolean {
    return this.rateLimitHit || this.promptTooLong;
  },

  /**
   * The reason for the current fallback prompt, if any.
   */
  get agentFallbackReason(): "rate_limit" | "prompt_too_long" | null {
    if (this.promptTooLong) return "prompt_too_long";
    if (this.rateLimitHit) return "rate_limit";
    return null;
  },

  /**
   * Dismiss the fallback prompt without switching to Chat.
   */
  dismissRateLimitPrompt() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }
  },

  /**
   * Accept the fallback prompt: switch agent history to a Chat conversation.
   */
  async acceptRateLimitFallback(): Promise<string | null> {
    const session = this.activeSession;
    if (!session) return null;

    const agentType = session.info.agentType;
    const messages = [...session.messages];
    const agentModelId = session.currentModelId;
    const title = session.title;
    const reason = this.agentFallbackReason ?? "rate_limit";

    // Clear the flags first so the banner disappears immediately
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }

    return performAgentFallback(
      agentType,
      messages,
      agentModelId,
      title,
      reason,
    );
  },

  /**
   * Clear error state for the active session.
   */
  clearError() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "error", null);
    }
    // Also clear global error for backwards compatibility
    setState("error", null);
  },

  // ============================================================================
  // Event Handling (Internal)
  // ============================================================================

  handleSessionEvent(sessionId: string, event: AgentEvent) {
    // User replay messages can arrive as multiple chunks; flush buffered user
    // text when the stream transitions to a non-user event.
    if (event.type !== "userMessage") {
      this.flushPendingUserMessage(sessionId);
    }

    switch (event.type) {
      case "messageChunk":
        this.handleMessageChunk(
          sessionId,
          event.data.text,
          event.data.isThought,
          event.data.timestamp,
        );
        break;

      case "toolCall":
        this.handleToolCall(sessionId, event.data);
        break;

      case "toolResult":
        this.handleToolResult(
          sessionId,
          event.data.toolCallId,
          event.data.status,
          event.data.result,
          event.data.error,
        );
        break;

      case "diff":
        this.handleDiff(sessionId, event.data);
        break;

      case "planUpdate":
        setState("sessions", sessionId, "plan", event.data.entries);
        break;

      case "userMessage":
        this.appendReplayUserChunk(
          sessionId,
          event.data.text,
          event.data.messageId,
          event.data.timestamp,
        );
        break;

      case "promptComplete": {
        const isHistoryReplay =
          event.data.historyReplay === true ||
          event.data.stopReason === "HistoryReplay";
        // End the replay-skip window so subsequent real messages are processed.
        if (isHistoryReplay) {
          setState("sessions", sessionId, "skipHistoryReplay", undefined);
        }
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        // Each promptComplete ends a turn; the next turn may have real content.
        setState("sessions", sessionId, "isSkippingSkillContext", undefined);
        if (!isHistoryReplay) {
          this.markPendingToolCallsComplete(sessionId);

          // Mark any remaining in-progress plan entries as completed.
          // Plan entry status is set by planUpdate events from the backend,
          // but a final planUpdate may not arrive after the last tool finishes.
          const plan = state.sessions[sessionId]?.plan;
          const isInProgress = (s: string) =>
            s === "in_progress" || s === "inprogress" || s === "inProgress";
          if (plan?.some((e) => isInProgress(e.status))) {
            setState(
              "sessions",
              sessionId,
              "plan",
              plan.map((e) =>
                isInProgress(e.status) ? { ...e, status: "completed" } : e,
              ),
            );
          }
        }

        // Track agent usage metadata for compaction decisions
        if (!isHistoryReplay && event.data.meta) {
          const inputTokens = event.data.meta.usage?.input_tokens;
          // Update context window size from model metadata when available
          const reportedContextWindow = event.data.meta.contextWindow;
          if (
            typeof reportedContextWindow === "number" &&
            reportedContextWindow > 0
          ) {
            setState(
              "sessions",
              sessionId,
              "contextWindowSize",
              reportedContextWindow,
            );
          }
          if (inputTokens != null) {
            setState("sessions", sessionId, "lastInputTokens", inputTokens);
            const ctxSize =
              state.sessions[sessionId]?.contextWindowSize ?? 200_000;
            console.log(
              `[AgentStore] Agent usage: ${inputTokens} input tokens`,
              `(${Math.round((inputTokens / ctxSize) * 100)}% of ${ctxSize.toLocaleString()} context)`,
            );
          }
        }

        // A successful prompt completion proves the session is healthy.
        // Clear any stale error (e.g. auth-expired banner after re-login).
        if (!isHistoryReplay && state.sessions[sessionId]?.error) {
          setState("sessions", sessionId, "error", null);
          setState("error", null);
        }

        // Transition status back to "ready" so queued messages can be processed
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );

        // Drain the prompt queue for this session. This runs in the store
        // regardless of which thread the UI is showing, so background threads
        // don't stall. Guard against compaction — the session will be
        // terminated and re-spawned, so sendPrompt would fail.
        if (!isHistoryReplay && !state.sessions[sessionId]?.isCompacting) {
          const queue = state.sessions[sessionId]?.pendingPrompts ?? [];
          if (queue.length > 0) {
            const [nextPrompt, ...remaining] = queue;
            setState("sessions", sessionId, "pendingPrompts", remaining);
            console.log(
              "[AgentStore] Draining queued prompt for session",
              sessionId,
              "remaining:",
              remaining.length,
            );
            // Dispatch asynchronously so the promptComplete handler finishes
            // before the next sendPrompt begins.
            setTimeout(() => {
              void this.sendPrompt(nextPrompt, undefined, undefined, sessionId);
            }, 100);
          }
        }

        // Auto-compact check: trigger compaction at 85% of context window,
        // or at 200 messages for agents that don't report token usage at all.
        if (!isHistoryReplay && !state.sessions[sessionId]?.isCompacting) {
          const sess = state.sessions[sessionId];
          if (settingsStore.settings.autoCompactEnabled && sess) {
            let shouldCompact = false;

            if (sess.lastInputTokens && sess.lastInputTokens > 0) {
              const usagePercent =
                sess.lastInputTokens / sess.contextWindowSize;
              const threshold =
                settingsStore.settings.autoCompactThreshold / 100;
              if (usagePercent >= threshold) {
                console.info(
                  `[AgentStore] Context usage at ${Math.round(usagePercent * 100)}% — triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            } else {
              // No token usage data at all — fall back to message count.
              // Only count messages added since session start.
              const activeCount = Math.max(
                0,
                sess.messages.length - (sess.restoredMessageCount ?? 0),
              );
              if (activeCount > 200) {
                console.info(
                  `[AgentStore] ${activeCount} active messages without token usage data — triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            }

            if (shouldCompact) {
              this.compactAgentConversation(
                sessionId,
                settingsStore.settings.autoCompactPreserveMessages,
              );
            }
          }
        }
        break;
      }

      case "configOptionsUpdate": {
        const restore = state.sessions[sessionId]?.pendingConfigRestore;
        const incoming = event.data.configOptions;
        const merged = restore
          ? incoming.map((opt) =>
              opt.type === "select" && restore[opt.id]
                ? { ...opt, currentValue: restore[opt.id] }
                : opt,
            )
          : incoming;
        setState("sessions", sessionId, "configOptions", merged);
        if (restore) {
          setState("sessions", sessionId, "pendingConfigRestore", undefined);
          for (const [id, value] of Object.entries(restore)) {
            void this.setConfigOption(id, value, sessionId);
          }
        }
        break;
      }
      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status, event.data);
        break;

      case "error":
        // Log full error content for diagnostics (helps debug cascade crashes)
        console.error(
          `[AgentStore] Error event for session ${sessionId} (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}):`,
          event.data.error,
        );

        // Clean up any in-flight streaming and tool cards
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        this.markPendingToolCallsComplete(sessionId);

        if (String(event.data.error).includes("Task cancelled")) {
          // User-initiated cancellation: record in chat history but don't
          // show the persistent error banner (it's not a real error).
          const cancelMsg: AgentMessage = {
            id: crypto.randomUUID(),
            type: "error",
            content: event.data.error,
            timestamp: Date.now(),
          };
          setState("sessions", sessionId, "messages", (msgs) => [
            ...msgs,
            cancelMsg,
          ]);
          const cancelConvoId = state.sessions[sessionId]?.conversationId;
          if (cancelConvoId) persistAgentMessage(cancelConvoId, cancelMsg);

          // Transition back to "ready" so the UI unfreezes and the send
          // button reappears.  Without this the session stays stuck in
          // "prompting" forever (the promptComplete event never fires
          // after a cancellation).
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );
        } else if (String(event.data.error).includes("unresponsive")) {
          // "Agent unresponsive" errors are handled by the sendPrompt catch
          // block which spawns a fresh session and retries. Adding the error
          // here would create duplicate banners when the recovery code
          // restores message history to the new session.
          console.info(
            "[AgentStore] Skipping error message for unresponsive agent — sendPrompt handles recovery",
          );
        } else if (
          String(event.data.error).includes("Permission request timed out")
        ) {
          // Permission timeout: clean up stale permission dialogs and notify user
          console.warn(
            "[AgentStore] Permission request timed out for session:",
            sessionId,
          );

          // Remove all pending permissions for this session (they've timed out on backend)
          const timedOutPermissions = state.pendingPermissions.filter(
            (p) => p.sessionId === sessionId,
          );
          setState(
            "pendingPermissions",
            state.pendingPermissions.filter((p) => p.sessionId !== sessionId),
          );

          // Add error message to notify user
          if (timedOutPermissions.length > 0) {
            const timeoutMsg: AgentMessage = {
              id: crypto.randomUUID(),
              type: "error",
              content:
                "Permission request timed out after 5 minutes. " +
                "Please try your request again.",
              timestamp: Date.now(),
            };
            setState("sessions", sessionId, "messages", (msgs) => [
              ...msgs,
              timeoutMsg,
            ]);
            const toConvoId = state.sessions[sessionId]?.conversationId;
            if (toConvoId) persistAgentMessage(toConvoId, timeoutMsg);
          }
        } else if (isTimeoutError(String(event.data.error))) {
          // Other timeout errors are often spurious race conditions where the error
          // event is emitted but the operation completes successfully. Skip
          // displaying these errors to avoid confusing the user with false
          // error messages when their request actually succeeded.
          console.info(
            "[AgentStore] Skipping non-permission timeout error — likely spurious race condition",
          );
        } else if (
          isPromptTooLongError(String(event.data.error)) &&
          !state.sessions[sessionId]?.promptTooLongHandled
        ) {
          // Context window full — try compaction + retry before falling back.
          // Guard with promptTooLongHandled to prevent duplicate fallbacks
          // when the error is also detected in streamed content.
          console.info("[AgentStore] Prompt too long detected in error event");
          setState("sessions", sessionId, "promptTooLongHandled", true);

          // Reset to "ready" so the UI unfreezes — promptComplete never
          // fires after this error so the session would stay stuck in
          // "prompting" forever without this.
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          // Try compact-and-retry first; fall back to Chat only if it fails.
          // Store the promise so sendPrompt catch block can await it.
          const compactPromise = this.compactAndRetry(sessionId).then(
            (retried) => {
              if (!retried) {
                console.info(
                  "[AgentStore] Compact-and-retry not possible, falling back to Chat mode",
                );
                setState("sessions", sessionId, "promptTooLong", true);
                this.addErrorMessage(sessionId, event.data.error);
                this.acceptRateLimitFallback().catch((err) => {
                  console.error("[AgentStore] Auto-failover failed:", err);
                });
              }
              return retried;
            },
          );
          setState(
            "sessions",
            sessionId,
            "compactRetryPromise",
            compactPromise,
          );
        } else if (isRateLimitError(String(event.data.error))) {
          // Rate limit detected — automatically switch to chat mode
          console.info(
            "[AgentStore] Rate limit detected, automatically switching to chat mode",
          );
          setState("sessions", sessionId, "rateLimitHit", true);
          this.addErrorMessage(sessionId, event.data.error);

          // Reset to "ready" so the UI unfreezes (same reason as above).
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          // Automatically trigger failover without user interaction
          this.acceptRateLimitFallback().catch((err) => {
            console.error("[AgentStore] Auto-failover failed:", err);
          });
        } else if (
          /^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(String(event.data.error))
        ) {
          // Transient reconnection attempt — show in chat but keep session
          // in "prompting" state so the queue doesn't drain prematurely.
          // The agent will resume its task after reconnecting.
          console.info(
            `[AgentStore] (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}) Transient reconnection: ${event.data.error}`,
          );
          this.addErrorMessage(sessionId, event.data.error);
        } else {
          this.addErrorMessage(sessionId, event.data.error);
        }
        break;

      case "permissionRequest": {
        const permEvent = event.data as PermissionRequestEvent;
        console.info(
          "[AgentStore] Permission request received: requestId=" +
            permEvent.requestId +
            ", session=" +
            permEvent.sessionId +
            ", tool=" +
            JSON.stringify(
              (permEvent.toolCall as Record<string, unknown>)?.name ??
                "unknown",
            ),
        );
        setState("pendingPermissions", [
          ...state.pendingPermissions,
          permEvent,
        ]);
        break;
      }

      case "diffProposal": {
        const proposalEvent = event.data as DiffProposalEvent;
        setState("pendingDiffProposals", [
          ...state.pendingDiffProposals,
          proposalEvent,
        ]);
        break;
      }
    }
  },

  flushPendingUserMessage(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session || !session.pendingUserMessage) return;

    // During history replay skip mode, discard the buffered replay text
    // instead of appending it (restored SQLite messages are authoritative).
    if (session.skipHistoryReplay) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      return;
    }

    // Skill context can arrive as a userMessage event when the provider stores
    // context items as user turns. Discard it — same as in finalizeStreamingContent.
    if (session.pendingUserMessage.trimStart().startsWith("# Active Skills")) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      return;
    }

    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: session.pendingUserMessage,
      timestamp: session.pendingUserMessageTimestamp ?? Date.now(),
    };
    setState("sessions", sessionId, "messages", (msgs) => [...msgs, userMsg]);
    if (session.conversationId)
      persistAgentMessage(session.conversationId, userMsg);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
  },

  appendReplayUserChunk(
    sessionId: string,
    text: string,
    messageId?: string,
    timestamp?: number,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replay user chunks when we have restored messages from SQLite.
    if (session.skipHistoryReplay) return;

    // Keep assistant/thought replay chunks and user chunks in strict order.
    this.finalizeStreamingContent(sessionId);

    const incomingMessageId = messageId?.trim() || undefined;
    if (
      session.pendingUserMessage &&
      incomingMessageId &&
      session.pendingUserMessageId &&
      session.pendingUserMessageId !== incomingMessageId
    ) {
      this.flushPendingUserMessage(sessionId);
    }

    setState(
      "sessions",
      sessionId,
      "pendingUserMessage",
      (current) => current + text,
    );

    if (!session.pendingUserMessageId && incomingMessageId) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageId",
        incomingMessageId,
      );
    }
    if (session.pendingUserMessageTimestamp === undefined) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageTimestamp",
        timestamp ?? Date.now(),
      );
    }
  },

  handleMessageChunk(
    sessionId: string,
    text: string,
    isThought?: boolean,
    timestamp?: number,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replay assistant/thought chunks when we have restored messages.
    if (session.skipHistoryReplay) return;

    let buf = chunkBufs.get(sessionId);
    if (!buf) {
      buf = { content: "", thinking: "" };
      chunkBufs.set(sessionId, buf);
    }

    if (isThought) {
      // Set timestamp on the very first thinking chunk (cheap — fires once)
      if (!session.streamingThinking && !buf.thinking) {
        setState(
          "sessions",
          sessionId,
          "streamingThinkingTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.thinking += text;
    } else {
      // Set timestamp on the very first content chunk (cheap — fires once)
      if (!session.streamingContent && !buf.content) {
        setState(
          "sessions",
          sessionId,
          "streamingContentTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.content += text;
    }

    // Schedule a flush if one isn't already pending
    if (!chunkFlushTimers.has(sessionId)) {
      chunkFlushTimers.set(
        sessionId,
        setTimeout(() => {
          chunkFlushTimers.delete(sessionId);
          flushChunkBuf(sessionId);
        }, CHUNK_FLUSH_MS),
      );
    }
  },

  handleToolCall(sessionId: string, toolCall: ToolCallEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed tool calls when we have restored messages.
    if (session.skipHistoryReplay) return;

    // Flush buffered chunks before reading streamingContent so tool cards
    // appear in correct chronological order relative to assistant text.
    flushChunkBuf(sessionId);
    if (session.streamingThinking) {
      const thinkingMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMsg,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, thinkingMsg);
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }
    if (session.streamingContent) {
      const contentMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        contentMsg,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, contentMsg);
      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    }

    // Skip duplicate if a message with this toolCallId already exists
    if (session.messages.some((m) => m.toolCallId === toolCall.toolCallId)) {
      return;
    }

    // Store pending tool call
    session.pendingToolCalls.set(toolCall.toolCallId, toolCall);

    // Add tool call message
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "tool",
      content: toolCall.title,
      timestamp: Date.now(),
      toolCallId: toolCall.toolCallId,
      toolCall,
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    if (session.conversationId)
      persistAgentMessage(session.conversationId, message);
  },

  handleToolResult(
    sessionId: string,
    toolCallId: string,
    status: string,
    result?: string,
    error?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed tool results when we have restored messages.
    if (session.skipHistoryReplay) return;

    // Update the tool message status
    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (msg.toolCallId === toolCallId && msg.toolCall) {
          return {
            ...msg,
            toolCall: {
              ...msg.toolCall,
              status,
              ...(result !== undefined && { result }),
              ...(error !== undefined && { error }),
            },
          };
        }
        return msg;
      }),
    );
    // Persist the updated tool message
    const updatedToolMsg = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) => m.toolCallId === toolCallId,
    );
    if (updatedToolMsg && session.conversationId) {
      persistAgentMessage(session.conversationId, updatedToolMsg);
    }

    // Remove from pending
    session.pendingToolCalls.delete(toolCallId);
  },

  /**
   * Mark all tool calls that are still "running" or "pending" as "completed".
   * Called when promptComplete fires — all tool calls must be done by then.
   */
  markPendingToolCallsComplete(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    const runningStatuses = ["running", "pending", "in_progress"];
    const hasRunning = session.messages.some(
      (msg) =>
        msg.toolCall &&
        runningStatuses.includes(msg.toolCall.status.toLowerCase()),
    );

    if (!hasRunning) return;

    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (
          msg.toolCall &&
          runningStatuses.includes(msg.toolCall.status.toLowerCase())
        ) {
          return {
            ...msg,
            toolCall: { ...msg.toolCall, status: "completed" },
          };
        }
        return msg;
      }),
    );
    // Persist all completed tool messages
    if (session.conversationId) {
      for (const msg of state.sessions[sessionId]?.messages ?? []) {
        if (msg.toolCall && msg.toolCall.status === "completed") {
          persistAgentMessage(session.conversationId, msg);
        }
      }
    }

    // Clear pending map
    session.pendingToolCalls.clear();
  },

  handleDiff(sessionId: string, diff: DiffEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed diffs when we have restored messages.
    if (session.skipHistoryReplay) return;

    const nextMessage: AgentMessage = {
      id: crypto.randomUUID(),
      type: "diff",
      content: `Modified: ${diff.path}`,
      timestamp: Date.now(),
      toolCallId: diff.toolCallId,
      diff,
    };

    setState("sessions", sessionId, "messages", (msgs) => {
      // If we already have a diff message for this tool call + path, update it in place
      // so streaming diff updates don't spam the timeline.
      const existingIndex = msgs.findIndex(
        (m) =>
          m.type === "diff" &&
          m.toolCallId === diff.toolCallId &&
          m.diff?.path === diff.path,
      );

      if (existingIndex >= 0) {
        const next = msgs.slice();
        next[existingIndex] = {
          ...next[existingIndex],
          // Keep the existing message id so keyed lists remain stable.
          id: next[existingIndex].id,
          timestamp: next[existingIndex].timestamp,
          content: nextMessage.content,
          diff: nextMessage.diff,
        };
        return next;
      }

      return [...msgs, nextMessage];
    });
    // Persist the diff message (find the actual stored version which may have an existing id)
    const storedDiff = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) =>
        m.type === "diff" &&
        m.toolCallId === diff.toolCallId &&
        m.diff?.path === diff.path,
    );
    if (storedDiff && session.conversationId) {
      persistAgentMessage(session.conversationId, storedDiff);
    }
  },

  handleStatusChange(
    sessionId: string,
    status: SessionStatus,
    data?: SessionStatusEvent,
  ) {
    setState("sessions", sessionId, "info", "status", status);

    // Safety net: clear the replay-skip flag when the session becomes ready,
    // in case no promptComplete(historyReplay) was emitted.
    if (status === "ready") {
      setState("sessions", sessionId, "skipHistoryReplay", undefined);
    }

    if (data?.agentSessionId) {
      setState("sessions", sessionId, "agentSessionId", data.agentSessionId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationSessionIdDb(
          session.conversationId,
          data.agentSessionId,
        ).catch((error) => {
          console.warn("Failed to persist agent session id", error);
        });
      }
    }

    // Extract model state from session status events (e.g. ready with models)
    if (data?.models) {
      const models = data.models as {
        currentModelId: string;
        availableModels: AgentModelInfo[];
      };
      setState("sessions", sessionId, "currentModelId", models.currentModelId);
      setState(
        "sessions",
        sessionId,
        "availableModels",
        models.availableModels,
      );
    }

    // Extract mode state from session status events (e.g. ready with modes,
    // or CurrentModeUpdate notifications which only carry currentModeId)
    if (data?.modes) {
      const modes = data.modes as {
        currentModeId: string;
        availableModes?: AgentModeInfo[];
      };
      setState("sessions", sessionId, "currentModeId", modes.currentModeId);
      if (modes.availableModes) {
        setState("sessions", sessionId, "availableModes", modes.availableModes);
      }
    }

    if (data?.configOptions) {
      setState("sessions", sessionId, "configOptions", data.configOptions);
    }

    if (status === "ready") {
      // Clear stale error banner when session recovers — a ready session has
      // no persistent error to surface. Error messages in chat history remain.
      setState("sessions", sessionId, "error", null);
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }

    // When a session is terminated (force-stopped, permission timeout, etc.),
    // resolve any pending ready promise so sendPrompt unblocks instead of
    // hanging forever. sendPrompt will then detect the dead session and
    // trigger recovery.
    if (status === "terminated") {
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }
  },

  finalizeStreamingContent(sessionId: string) {
    // Flush any buffered chunks before reading store state
    flushChunkBuf(sessionId);

    const session = state.sessions[sessionId];
    if (!session) return;

    // Finalize thinking content if any
    if (session.streamingThinking) {
      const thinkingMessage: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMessage,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, thinkingMessage);
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }

    // Finalize assistant content if any
    if (session.streamingContent) {
      // Skill context is injected into every prompt as additional context and
      // echoed back by the provider as an assistant message during session
      // replay. Discard these — they are system prompts, not conversation
      // content, and should never appear as visible chat messages.
      //
      // The content can arrive split across multiple finalizeStreamingContent
      // calls: the first chunk starts with '# Active Skills' (caught here), but
      // subsequent chunks of the same block start mid-content. The
      // isSkippingSkillContext flag ensures those continuations are also dropped.
      const isSkillContextStart = session.streamingContent
        .trimStart()
        .startsWith("# Active Skills");
      if (isSkillContextStart || session.isSkippingSkillContext) {
        if (isSkillContextStart) {
          setState("sessions", sessionId, "isSkippingSkillContext", true);
        }
        setState("sessions", sessionId, "streamingContent", "");
        setState("sessions", sessionId, "streamingContentTimestamp", undefined);
        setState("sessions", sessionId, "promptStartTime", undefined);
        return;
      }

      // Calculate duration if we have a start time
      const duration = session.promptStartTime
        ? Date.now() - session.promptStartTime
        : undefined;

      const message: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
        duration,
      };
      console.log(
        "[AgentRuntime] Adding assistant message to session:",
        sessionId,
        "conversationId:",
        session.conversationId,
        "content:",
        session.streamingContent.slice(0, 50),
      );
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, message);

      // If the agent streamed a short auth error as text, surface it as a session error
      // so the error banner with the Login button appears. Long messages are skipped
      // to avoid false positives when the agent discusses auth topics in normal output.
      if (isLikelyAuthError(session.streamingContent)) {
        setState("sessions", sessionId, "error", session.streamingContent);
      }

      // If the agent's response is a prompt-too-long error (context window full),
      // try compaction + retry before falling back to Chat mode.
      // Guard with promptTooLongHandled to prevent duplicate fallbacks when
      // the error is detected in both streamed content and the error event.
      if (
        isPromptTooLongError(session.streamingContent) &&
        !session.promptTooLongHandled
      ) {
        console.info(
          "[AgentStore] Prompt too long detected in streamed content",
        );
        setState("sessions", sessionId, "promptTooLongHandled", true);
        const compactPromise = this.compactAndRetry(sessionId).then(
          (retried) => {
            if (!retried) {
              console.info(
                "[AgentStore] Compact-and-retry not possible, falling back to Chat mode",
              );
              setState("sessions", sessionId, "promptTooLong", true);
              this.acceptRateLimitFallback().catch((err) => {
                console.error(
                  "[AgentStore] Auto-failover from streamed content failed:",
                  err,
                );
              });
            }
            return retried;
          },
        );
        setState("sessions", sessionId, "compactRetryPromise", compactPromise);
      }

      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
      // Clear the start time
      setState("sessions", sessionId, "promptStartTime", undefined);
    }
  },

  // ============================================================================
  // Fork
  // ============================================================================

  /**
   * Fork the current agent conversation from a specific message.
   *
   * Creates a new local conversation containing messages up to `fromMessageId`.
   * When the fork point is the latest message in a Claude session, we can use
   * the provider's native session fork. Otherwise we branch to a fresh runtime
   * session and bootstrap the exact transcript on the next prompt so the
   * selected fork point is authoritative.
   */
  async forkConversation(
    conversationId: string,
    fromMessageId: string,
  ): Promise<string | null> {
    const session = state.sessions[conversationId];
    if (!session) {
      console.error("[AgentStore] forkConversation: session not found");
      return null;
    }

    const agentType = session.info.agentType;
    const cwd = session.cwd;

    // 1. Collect messages up to the fork point.
    const allMessages = session.messages;
    const forkIndex = allMessages.findIndex((m) => m.id === fromMessageId);
    if (forkIndex === -1) {
      console.error("[AgentStore] forkConversation: message not found");
      return null;
    }
    const forkedMessages = allMessages.slice(0, forkIndex + 1);
    const isHeadFork = forkIndex === allMessages.length - 1;
    const useNativeFork =
      providerService.supportsNativeProviderFork(agentType) && isHeadFork;

    let newAgentSessionId: string | undefined;
    let bootstrapPromptContext: string | undefined;

    if (useNativeFork) {
      try {
        newAgentSessionId =
          await providerService.nativeForkSession(conversationId);
      } catch (err) {
        console.error(
          "[AgentStore] forkConversation: native fork failed:",
          err,
        );
        this.addErrorMessage(
          conversationId,
          `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    } else {
      bootstrapPromptContext =
        buildForkBootstrapContext(session, forkedMessages) ?? undefined;
    }

    // 2. Create a new local conversation in SQLite.
    const newConversationId = crypto.randomUUID();
    const forkTitle = `Fork of ${session.title ?? "Agent"}`;
    try {
      await createAgentConversation(
        newConversationId,
        forkTitle,
        agentType,
        cwd,
        null,
        newAgentSessionId ?? undefined,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? forkedMessages
            : undefined,
        }) ?? undefined,
      );
    } catch (err) {
      console.error("[AgentStore] forkConversation: DB error:", err);
      return null;
    }

    // 3. Spawn a new local session for the fork.
    const newSessionId = await this.spawnSession(cwd, agentType, {
      localSessionId: newConversationId,
      resumeAgentSessionId: newAgentSessionId,
      conversationTitle: forkTitle,
      restoredMessages: forkedMessages,
      bootstrapPromptContext,
    });

    if (!newSessionId) {
      console.error("[AgentStore] forkConversation: spawn failed");
      return null;
    }

    await this.restoreSessionSettings(session, newSessionId);

    console.info(
      `[AgentStore] Forked conversation ${conversationId} -> ${newConversationId}${newAgentSessionId ? ` (agent session: ${newAgentSessionId})` : " (bootstrap branch)"}`,
    );

    return newConversationId;
  },

  addErrorMessage(sessionId: string, error: string) {
    const session = state.sessions[sessionId];
    const agentLabel = agentDisplayName(session?.info.agentType);
    const prefixedError = `[${agentLabel}] ${error}`;

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "error",
      content: prefixedError,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    const errConvoId = session?.conversationId;
    if (errConvoId) persistAgentMessage(errConvoId, message);
    // Set session-specific error instead of global error
    setState("sessions", sessionId, "error", prefixedError);
  },

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clean up all sessions (call on app unmount).
   */
  async cleanup() {
    for (const sessionId of Object.keys(state.sessions)) {
      await this.terminateSession(sessionId);
    }
  },
};

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  SessionStatus,
};
