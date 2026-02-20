// ABOUTME: Reactive ACP (Agent Client Protocol) state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import { settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

/** Per-session ready promises — resolved when backend emits "ready" status */
const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

import { isLikelyAuthError } from "@/lib/auth-errors";
import {
  isPromptTooLongError,
  isRateLimitError,
  isTimeoutAssistantContent,
  isTimeoutError,
  performAgentFallback,
} from "@/lib/rate-limit-fallback";
import {
  createAgentConversation,
  type AgentConversation as DbAgentConversation,
  getAgentConversation,
  getAgentConversations,
  getSerenApiKey,
  setAgentConversationModelId as setAgentConversationModelIdDb,
  setAgentConversationSessionId as setAgentConversationSessionIdDb,
} from "@/lib/tauri-bridge";
import type {
  AcpEvent,
  AcpSessionInfo,
  AgentInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  PlanEntry,
  RemoteSessionInfo,
  SessionConfigOption,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/acp";
import * as acpService from "@/services/acp";
import { telemetry } from "@/services/telemetry";

// ============================================================================
// Types
// ============================================================================

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
}

export interface AgentModelInfo {
  modelId: string;
  name: string;
}

export interface AgentModeInfo {
  modeId: string;
  name: string;
  description?: string;
}

export interface ActiveSession {
  info: AcpSessionInfo;
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
  /** Remote ACP session id (e.g., Codex thread id). */
  agentSessionId?: string;
  /** Session configuration options reported by the agent (unstable ACP surface). */
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
}

interface AcpState {
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
  /** Remote sessions listed from the agent's underlying session store (ACP listSessions). */
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
  pendingPermissions: import("@/services/acp").PermissionRequestEvent[];
  /** Pending diff proposals awaiting user accept/reject */
  pendingDiffProposals: DiffProposalEvent[];
  /** Whether agent mode is active (vs chat mode) */
  agentModeEnabled: boolean;
}

const [state, setState] = createStore<AcpState>({
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
const pendingSessionEvents = new Map<string, AcpEvent[]>();
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
    setState("sessions", sessionId, "streamingThinking", (c) => c + buf.thinking);
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
const PENDING_SESSION_EVENT_LIMIT = 500;
const CLAUDE_INIT_RETRY_DELAY_MS = 350;
const MAX_CLAUDE_INIT_RETRIES = 3;

function isRetryableClaudeInitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("server shut down unexpectedly") ||
    lower.includes("signal: 9") ||
    lower.includes("sigkill")
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

export const acpStore = {
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

  /**
   * Get messages for the active session.
   */
  get messages(): AgentMessage[] {
    const session = this.activeSession;
    console.log(
      "[ACP] messages getter - activeSessionId:",
      state.activeSessionId,
      "session:",
      session?.info.id,
      "messageCount:",
      session?.messages.length ?? 0,
    );
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
    console.log(
      "[ACP] getMessagesForConversation - conversationId:",
      conversationId,
      "found session:",
      session?.info.id,
      "messageCount:",
      session?.messages.length ?? 0,
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
   * Initialize the ACP store by loading available agents.
   */
  async initialize() {
    try {
      const agents = await acpService.getAvailableAgents();
      setState("availableAgents", agents);
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
        acpService.listRemoteSessions(resolvedAgentType, cwd),
        getAgentConversations(200, cwd),
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
      const page = await acpService.listRemoteSessions(
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

    setState("isLoading", true);
    setState("error", null);

    console.log("[AcpStore] Spawning session:", {
      agentType: resolvedAgentType,
      cwd,
      localSessionId,
      resumeAgentSessionId,
    });

    const agentAvailable =
      await acpService.checkAgentAvailable(resolvedAgentType);
    if (!agentAvailable) {
      const helper =
        resolvedAgentType === "codex"
          ? "Codex agent binary not found. Run `pnpm build:sidecar seren-acp-codex` (or reinstall Seren Desktop) and try again."
          : "Claude Code agent binary not found. Run `pnpm build:sidecar seren-acp-claude` and try again.";
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
      await acpService.subscribeToEvent<SessionStatusEvent>(
        "sessionStatus",
        (data) => {
          console.log("[AcpStore] Received session status event:", data);
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
          }
        },
      );

    // Subscribe once to all ACP events before spawning, so early replay events
    // from load_session are buffered instead of dropped.
    if (!globalUnsubscribe) {
      globalUnsubscribe = await acpService.subscribeToAllEvents((event) => {
        const eventSessionId = event.data.sessionId;
        if (!eventSessionId) return;
        console.log(
          "[ACP] Event received - type:",
          event.type,
          "sessionId:",
          eventSessionId,
          "conversationId:",
          state.sessions[eventSessionId]?.conversationId,
        );
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
      });
    }

    try {
      // Ensure the underlying CLI is installed and up-to-date before spawning
      const ensureFn =
        resolvedAgentType === "claude-code"
          ? acpService.ensureClaudeCli
          : resolvedAgentType === "codex"
            ? acpService.ensureCodexCli
            : null;

      if (ensureFn) {
        const { listen } = await import("@tauri-apps/api/event");
        const progressUnsub = await listen<{ stage: string; message: string }>(
          "acp://cli-install-progress",
          (event) => {
            setState("installStatus", event.payload.message);
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

      // Get Seren API key to enable MCP tools for the agent
      const apiKey = await getSerenApiKey();

      // Determine timeout based on enabled skills:
      // - Long-running skills (polymarket-trader) get unlimited timeout
      // - Other sessions get default 300s timeout
      const longRunningSkills = ["polymarket-trader"];
      const hasLongRunningSkill = skillsStore.installed.some(
        (skill) => skill.enabled && longRunningSkills.includes(skill.slug),
      );
      const timeoutSecs = hasLongRunningSkill ? undefined : 300;

      // Codex defaults to "on-failure" (auto-approve safe ops) regardless of
      // the global agentApprovalPolicy setting, which applies to Claude Code.
      const approvalPolicy =
        resolvedAgentType === "codex"
          ? "on-failure"
          : settingsStore.settings.agentApprovalPolicy;

      const info = await acpService.spawnAgent(
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
      );
      console.log("[AcpStore] Spawn result:", info);

      // Persist an agent conversation record (safe to call repeatedly via INSERT OR IGNORE).
      try {
        await createAgentConversation(
          info.id,
          conversationTitle,
          resolvedAgentType,
          cwd,
          cwd,
          resumeAgentSessionId ?? undefined,
        );
      } catch (error) {
        console.warn("Failed to persist agent conversation", error);
      }

      // Create session state
      const session: ActiveSession = {
        info,
        messages: [],
        plan: [],
        pendingToolCalls: new Map(),
        streamingContent: "",
        streamingThinking: "",
        pendingUserMessage: "",
        cwd,
        conversationId: info.id,
      };

      setState("sessions", info.id, session);
      setState("activeSessionId", info.id);

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
        console.log("[AcpStore] Session ready:", readySessionId);

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
        if (message.includes("timed out")) {
          console.warn(
            "[AcpStore] Timeout waiting for ready, proceeding anyway",
          );
          // Resolve the ready promise so sendPrompt doesn't block forever
          const entry = sessionReadyPromises.get(info.id);
          if (entry) {
            entry.resolve();
            sessionReadyPromises.delete(info.id);
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
          console.warn("[AcpStore] Claude init failed, retrying:", initFailure);
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
              "[AcpStore] Claude init failed under pressure; reclaiming idle Claude session and retrying:",
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
            "[AcpStore] Claude session exited during init, retrying.",
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
              "[AcpStore] Claude init exited early; reclaiming idle Claude session and retrying:",
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
      console.error("[AcpStore] Spawn error:", error);
      tempUnsubscribe();
      const message = error instanceof Error ? error.message : String(error);
      setState("error", message);
      setState("isLoading", false);
      return null;
    }
  },

  /**
   * Resume a persisted agent conversation by loading its remote ACP session.
   *
   * This relies on the agent sidecar supporting `load_session` and having access
   * to the underlying session store (e.g., local Codex threads).
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

    setState("error", null);

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

    const remoteSessionId = convo.agent_session_id?.trim();
    if (!remoteSessionId) {
      console.warn(
        "[AcpStore] Conversation has no stored remote session id; creating a fresh session.",
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
      });
      if (freshSessionId) {
        void this.refreshRecentAgentConversations(200).catch(() => {});
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
    });

    // Legacy Claude conversations can reference session IDs that no longer
    // exist on disk. In that case, fall back to a fresh session for the same
    // persisted conversation instead of failing hard.
    if (!sessionId && agentType === "claude-code") {
      console.warn(
        "[AcpStore] Claude resume failed, starting a fresh session for conversation",
        conversationId,
        state.error,
      );
      const fallbackSessionId = await this.spawnSession(resumeCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
      });
      if (fallbackSessionId) {
        void this.refreshRecentAgentConversations(200).catch(() => {});
      }
      return fallbackSessionId;
    }

    if (sessionId) {
      void this.refreshRecentAgentConversations(200).catch(() => {});
    }
    return sessionId;
  },
  /**
   * Resume a remote agent session (ACP session id from listSessions).
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

  /**
   * Terminate a session.
   */
  async terminateSession(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    try {
      await acpService.terminateSession(sessionId);
    } catch (error) {
      console.error("Failed to terminate session:", error);
    }

    // Clean up ready promise if still pending
    sessionReadyPromises.delete(sessionId);
    pendingSessionEvents.delete(sessionId);

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
    }
  },

  /**
   * Set the active session.
   */
  setActiveSession(sessionId: string | null) {
    console.log(
      "[ACP] setActiveSession - old:",
      state.activeSessionId,
      "new:",
      sessionId,
    );
    setState("activeSessionId", sessionId);
  },

  /**
   * Clear all messages in a session.
   */
  clearSessionMessages(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    setState("sessions", sessionId, "messages", []);
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
  async sendPrompt(prompt: string, context?: Array<Record<string, string>>) {
    const sessionId = state.activeSessionId;
    console.log("[AcpStore] sendPrompt called:", {
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

    // Wait for session to be ready before sending prompt
    const readyEntry = sessionReadyPromises.get(sessionId);
    if (readyEntry) {
      console.info(
        `[AcpStore] sendPrompt: waiting for session ${sessionId} to be ready...`,
      );
      await readyEntry.promise;
      console.info("[AcpStore] sendPrompt: session is now ready");
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

    // Add user message
    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: prompt,
      timestamp: Date.now(),
    };

    console.log(
      "[ACP] Adding user message to session:",
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
    }

    console.log("[AcpStore] Calling acpService.sendPrompt...");
    try {
      let mergedContext = context ? [...context] : [];
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
        console.warn("[AcpStore] Failed to load skills for ACP prompt:", error);
      }

      await acpService.sendPrompt(
        sessionId,
        prompt,
        mergedContext.length > 0 ? mergedContext : undefined,
      );
      console.log("[AcpStore] sendPrompt completed successfully");
    } catch (error) {
      console.error("[AcpStore] sendPrompt error:", error);
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
        console.info(
          "[AcpStore] Session appears dead, attempting auto-recovery...",
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

        // Clean up the dead session
        await this.terminateSession(sessionId);

        // Spawn a fresh session
        const newSessionId = await this.spawnSession(cwd, agentType, {
          localSessionId: session.conversationId,
        });
        if (newSessionId) {
          // Restore conversation history to the new session
          if (existingMessages.length > 0) {
            setState("sessions", newSessionId, "messages", existingMessages);
          }

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

          // Retry the prompt on the new session
          console.info(
            `[AcpStore] Retrying prompt on new session ${newSessionId}`,
          );
          try {
            await acpService.sendPrompt(newSessionId, prompt, context);
            console.log("[AcpStore] Retry succeeded on new session");
            return;
          } catch (retryError) {
            console.error("[AcpStore] Retry failed:", retryError);
            const retryMessage =
              retryError instanceof Error
                ? retryError.message
                : String(retryError);
            this.addErrorMessage(
              newSessionId,
              `Recovery failed: ${retryMessage}. Please try sending your message again.`,
            );
            return;
          }
        }

        // Spawn failed, show original error
        setState("error", "Session died and could not be restarted.");
        return;
      }

      // Skip addErrorMessage for cancellation — the error event handler
      // already recorded it in chat history. Adding it again here would
      // create a duplicate banner.
      if (!message.includes("Task cancelled")) {
        this.addErrorMessage(sessionId, message);
      }
    }
  },

  /**
   * Cancel the current prompt in the active session.
   */
  async cancelPrompt() {
    const sessionId = state.activeSessionId;
    if (!sessionId) {
      console.warn("[AcpStore] cancelPrompt: no active session");
      return;
    }

    const session = state.sessions[sessionId];
    console.info(
      `[AcpStore] cancelPrompt: session=${sessionId}, status=${session?.info.status}`,
    );

    try {
      await acpService.cancelPrompt(sessionId);
      console.info("[AcpStore] cancelPrompt: backend acknowledged cancel");
    } catch (error) {
      console.error("[AcpStore] cancelPrompt failed:", error);
    }
  },

  /**
   * Set permission mode for the active session.
   */
  async setPermissionMode(modeId: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await acpService.setPermissionMode(sessionId, modeId);
      // Optimistic update — the authoritative update arrives via
      // CurrentModeUpdate notification handled in handleStatusChange.
      setState("sessions", sessionId, "currentModeId", modeId);
    } catch (error) {
      console.error(
        `[AcpStore] Failed to set permission mode to "${modeId}":`,
        error,
      );
    }
  },

  /**
   * Set the AI model for the active session.
   */
  async setModel(modelId: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await acpService.setModel(sessionId, modelId);
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
      console.error("[AcpStore] Failed to set model:", error);
    }
  },

  /**
   * Set a session configuration option (e.g., reasoning effort).
   */
  async setConfigOption(configId: string, valueId: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await acpService.setConfigOption(sessionId, configId, valueId);
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
      console.error("[AcpStore] Failed to set config option:", error);
    }
  },

  async respondToPermission(requestId: string, optionId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (!permission) {
      console.warn(
        `[AcpStore] respondToPermission: request ${requestId} not found in pending list`,
      );
      return;
    }

    console.info(
      `[AcpStore] Responding to permission ${requestId}: session=${permission.sessionId}, option=${optionId}`,
    );

    try {
      await acpService.respondToPermission(
        permission.sessionId,
        requestId,
        optionId,
      );
      console.info(
        `[AcpStore] Permission ${requestId} response delivered to backend`,
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("not found") || errorMsg.includes("timed out")) {
        // Permission already timed out or was cleaned up on backend
        console.warn(
          `[AcpStore] Permission ${requestId} no longer valid (likely timed out)`,
        );
        // User was already notified by the timeout error handler above
      } else {
        console.error(
          `[AcpStore] Failed to respond to permission ${requestId}:`,
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
        `[AcpStore] Dismissing permission ${requestId}: session=${permission.sessionId}`,
      );
      try {
        await acpService.respondToPermission(
          permission.sessionId,
          requestId,
          "deny",
        );
      } catch (error) {
        console.error(
          `[AcpStore] Failed to send deny for permission ${requestId}:`,
          error,
        );
      }
    } else {
      console.warn(
        `[AcpStore] dismissPermission: request ${requestId} not found in pending list`,
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
      await acpService.respondToDiffProposal(
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
    setState("agentModeEnabled", enabled);
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

  handleSessionEvent(sessionId: string, event: AcpEvent) {
    console.log("[AcpStore] handleSessionEvent:", event.type, sessionId);

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
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        if (!isHistoryReplay) {
          this.markPendingToolCallsComplete(sessionId);
        }
        // Transition status back to "ready" so queued messages can be processed
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
        break;
      }

      case "configOptionsUpdate":
        setState(
          "sessions",
          sessionId,
          "configOptions",
          event.data.configOptions,
        );
        break;
      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status, event.data);
        break;

      case "error":
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
        } else if (String(event.data.error).includes("unresponsive")) {
          // "Agent unresponsive" errors are handled by the sendPrompt catch
          // block which spawns a fresh session and retries. Adding the error
          // here would create duplicate banners when the recovery code
          // restores message history to the new session.
          console.info(
            "[AcpStore] Skipping error message for unresponsive agent — sendPrompt handles recovery",
          );
        } else if (
          String(event.data.error).includes("Permission request timed out")
        ) {
          // Permission timeout: clean up stale permission dialogs and notify user
          console.warn(
            "[AcpStore] Permission request timed out for session:",
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
          }
        } else if (isTimeoutError(String(event.data.error))) {
          // Other timeout errors are often spurious race conditions where the error
          // event is emitted but the operation completes successfully. Skip
          // displaying these errors to avoid confusing the user with false
          // error messages when their request actually succeeded.
          console.info(
            "[AcpStore] Skipping non-permission timeout error — likely spurious race condition",
          );
        } else if (isPromptTooLongError(String(event.data.error))) {
          // Context window full — automatically switch to chat mode
          console.info(
            "[AcpStore] Prompt too long detected, automatically switching to chat mode",
          );
          setState("sessions", sessionId, "promptTooLong", true);
          this.addErrorMessage(sessionId, event.data.error);

          // Automatically trigger failover without user interaction
          this.acceptRateLimitFallback().catch((err) => {
            console.error("[AcpStore] Auto-failover failed:", err);
          });
        } else if (isRateLimitError(String(event.data.error))) {
          // Rate limit detected — automatically switch to chat mode
          console.info(
            "[AcpStore] Rate limit detected, automatically switching to chat mode",
          );
          setState("sessions", sessionId, "rateLimitHit", true);
          this.addErrorMessage(sessionId, event.data.error);

          // Automatically trigger failover without user interaction
          this.acceptRateLimitFallback().catch((err) => {
            console.error("[AcpStore] Auto-failover failed:", err);
          });
        } else {
          this.addErrorMessage(sessionId, event.data.error);
        }
        break;

      case "permissionRequest": {
        const permEvent =
          event.data as import("@/services/acp").PermissionRequestEvent;
        console.info(
          "[AcpStore] Permission request received: requestId=" +
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

    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: session.pendingUserMessage,
      timestamp: session.pendingUserMessageTimestamp ?? Date.now(),
    };
    setState("sessions", sessionId, "messages", (msgs) => [...msgs, userMsg]);
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

    // Clear pending map
    session.pendingToolCalls.clear();
  },

  handleDiff(sessionId: string, diff: DiffEvent) {
    setState("sessions", sessionId, "messages", (msgs) => {
      // If we already have a diff message for this tool call + path, update it in place
      // so streaming diff updates don't spam the timeline.
      const existingIndex = msgs.findIndex(
        (m) =>
          m.type === "diff" &&
          m.toolCallId === diff.toolCallId &&
          m.diff?.path === diff.path,
      );

      const nextMessage: AgentMessage = {
        id: crypto.randomUUID(),
        type: "diff",
        content: `Modified: ${diff.path}`,
        timestamp: Date.now(),
        toolCallId: diff.toolCallId,
        diff,
      };

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
  },

  handleStatusChange(
    sessionId: string,
    status: SessionStatus,
    data?: SessionStatusEvent,
  ) {
    setState("sessions", sessionId, "info", "status", status);

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
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }

    // Finalize assistant content if any
    if (session.streamingContent) {
      if (isTimeoutAssistantContent(session.streamingContent)) {
        // Some agents emit a timeout string as assistant content even when the
        // prompt completes successfully. Surface this as a session error banner
        // instead of adding a misleading assistant message.
        console.info(
          "[AcpStore] Suppressing timeout assistant message — surfacing banner instead",
        );
        telemetry.captureError(new Error("ACP assistant timeout content"), {
          type: "acp_timeout_assistant_content",
          agentType: session.info.agentType,
          sessionId,
          agentSessionId: session.agentSessionId,
          conversationId: session.conversationId,
          timeoutSecs: session.info.timeoutSecs,
        });
        setState("sessions", sessionId, "error", session.streamingContent);
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
        "[ACP] Adding assistant message to session:",
        sessionId,
        "conversationId:",
        session.conversationId,
        "content:",
        session.streamingContent.slice(0, 50),
      );
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);

      // If the agent streamed a short auth error as text, surface it as a session error
      // so the error banner with the Login button appears. Long messages are skipped
      // to avoid false positives when the agent discusses auth topics in normal output.
      if (isLikelyAuthError(session.streamingContent)) {
        setState("sessions", sessionId, "error", session.streamingContent);
      }

      // If the agent's response is a prompt-too-long error (context window full),
      // flag the session so the UI shows the "Continue in Chat" fallback banner.
      if (isPromptTooLongError(session.streamingContent)) {
        console.info(
          "[AcpStore] Prompt too long detected in streamed content, flagging session for chat fallback",
        );
        setState("sessions", sessionId, "promptTooLong", true);
      }

      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
      // Clear the start time
      setState("sessions", sessionId, "promptStartTime", undefined);
    }
  },

  addErrorMessage(sessionId: string, error: string) {
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "error",
      content: error,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    // Set session-specific error instead of global error
    setState("sessions", sessionId, "error", error);
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
  AgentType,
  SessionStatus,
  AcpSessionInfo,
  AgentInfo,
  DiffEvent,
  DiffProposalEvent,
};
