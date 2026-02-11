// ABOUTME: Reactive ACP (Agent Client Protocol) state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import { settingsStore } from "@/stores/settings.store";

/** Per-session ready promises — resolved when backend emits "ready" status */
const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

import { isLikelyAuthError } from "@/lib/auth-errors";
import { getSerenApiKey } from "@/lib/tauri-bridge";

import type {
  AcpEvent,
  AcpSessionInfo,
  AgentInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  PlanEntry,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/acp";
import * as acpService from "@/services/acp";

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
  cwd: string;
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
  isLoading: false,
  error: null,
  installStatus: null,
  pendingPermissions: [],
  pendingDiffProposals: [],
  agentModeEnabled: false,
});

let globalUnsubscribe: UnlistenFn | null = null;

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
    return session?.messages ?? [];
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

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Spawn a new agent session.
   */
  async spawnSession(
    cwd: string,
    agentType?: AgentType,
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    setState("isLoading", true);
    setState("error", null);

    console.log("[AcpStore] Spawning session:", {
      agentType: resolvedAgentType,
      cwd,
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
    const readyPromise = new Promise<string>((resolve) => {
      resolveReady = resolve;
    });

    // Listen to all session status events temporarily
    const tempUnsubscribe = await acpService.subscribeToEvent<{
      sessionId: string;
      status: string;
    }>("sessionStatus", (data) => {
      console.log("[AcpStore] Received session status event:", data);
      if (data.status === "ready" && resolveReady) {
        resolveReady(data.sessionId);
      }
    });

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
      const info = await acpService.spawnAgent(
        resolvedAgentType,
        cwd,
        settingsStore.settings.agentSandboxMode,
        apiKey ?? undefined,
        settingsStore.settings.agentApprovalPolicy,
        settingsStore.settings.agentSearchEnabled,
      );
      console.log("[AcpStore] Spawn result:", info);

      // Create session state
      const session: ActiveSession = {
        info,
        messages: [],
        plan: [],
        pendingToolCalls: new Map(),
        streamingContent: "",
        streamingThinking: "",
        cwd,
      };

      setState("sessions", info.id, session);
      setState("activeSessionId", info.id);

      // Create a ready promise that sendPrompt can await
      let readyResolve: () => void;
      const readyPromiseObj = {
        promise: new Promise<void>((resolve) => {
          readyResolve = resolve;
        }),
        resolve: () => readyResolve(),
      };
      sessionReadyPromises.set(info.id, readyPromiseObj);

      // Subscribe once to all ACP events and route by sessionId.
      // This avoids missing chunks due to filtering and scales better across sessions.
      if (!globalUnsubscribe) {
        globalUnsubscribe = await acpService.subscribeToAllEvents((event) => {
          const eventSessionId = event.data.sessionId;
          if (!eventSessionId) return;
          if (!state.sessions[eventSessionId]) return;
          this.handleSessionEvent(eventSessionId, event);
        });
      }

      // Wait for ready event with timeout (agent initialization can take a moment)
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(
          () => reject(new Error("Agent initialization timed out")),
          30000,
        );
      });

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
      } catch (_timeoutError) {
        console.warn("[AcpStore] Timeout waiting for ready, proceeding anyway");
        // Resolve the ready promise so sendPrompt doesn't block forever
        const entry = sessionReadyPromises.get(info.id);
        if (entry) {
          entry.resolve();
          sessionReadyPromises.delete(info.id);
        }
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
    }
  },

  /**
   * Set the active session.
   */
  setActiveSession(sessionId: string | null) {
    setState("activeSessionId", sessionId);
  },

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Send a prompt to the active session.
   * Auto-recovers from dead sessions by restarting and retrying.
   */
  async sendPrompt(prompt: string, context?: Array<{ text?: string }>) {
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

    setState("sessions", sessionId, "messages", (msgs) => [
      ...msgs,
      userMessage,
    ]);
    setState("sessions", sessionId, "streamingContent", "");
    setState("sessions", sessionId, "streamingThinking", "");

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
      await acpService.sendPrompt(sessionId, prompt, context);
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
        const newSessionId = await this.spawnSession(cwd, agentType);
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
    } catch (error) {
      console.error("[AcpStore] Failed to set model:", error);
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
      console.error(
        `[AcpStore] Failed to respond to permission ${requestId}:`,
        error,
      );
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
    switch (event.type) {
      case "messageChunk":
        this.handleMessageChunk(
          sessionId,
          event.data.text,
          event.data.isThought,
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

      case "promptComplete":
        this.finalizeStreamingContent(sessionId);
        this.markPendingToolCallsComplete(sessionId);
        // Transition status back to "ready" so queued messages can be processed
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
        break;

      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status, event.data);
        break;

      case "error":
        // Clean up any in-flight streaming and tool cards
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
        } else {
          this.addErrorMessage(sessionId, event.data.error);
        }
        break;

      case "permissionRequest": {
        const permEvent =
          event.data as import("@/services/acp").PermissionRequestEvent;
        console.info(
          `[AcpStore] Permission request received: requestId=${permEvent.requestId}, session=${permEvent.sessionId}, tool=${JSON.stringify((permEvent.toolCall as Record<string, unknown>)?.name ?? "unknown")}`,
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

  handleMessageChunk(sessionId: string, text: string, isThought?: boolean) {
    console.log("[AcpStore] handleMessageChunk:", {
      sessionId,
      text: `${text.slice(0, 50)}...`,
      isThought,
    });

    if (isThought) {
      // Append to streaming thinking content
      setState(
        "sessions",
        sessionId,
        "streamingThinking",
        (current) => current + text,
      );
    } else {
      // Append to streaming assistant content
      setState(
        "sessions",
        sessionId,
        "streamingContent",
        (current) => current + text,
      );
    }
  },

  handleToolCall(sessionId: string, toolCall: ToolCallEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Flush accumulated streaming content so tool cards appear in correct
    // chronological order relative to assistant text.
    if (session.streamingThinking) {
      const thinkingMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMsg,
      ]);
      setState("sessions", sessionId, "streamingThinking", "");
    }
    if (session.streamingContent) {
      const contentMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        contentMsg,
      ]);
      setState("sessions", sessionId, "streamingContent", "");
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
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "diff",
      content: `Modified: ${diff.path}`,
      timestamp: Date.now(),
      toolCallId: diff.toolCallId,
      diff,
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
  },

  handleStatusChange(
    sessionId: string,
    status: SessionStatus,
    data?: SessionStatusEvent,
  ) {
    setState("sessions", sessionId, "info", "status", status);

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

    if (status === "ready") {
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }
  },

  finalizeStreamingContent(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Finalize thinking content if any
    if (session.streamingThinking) {
      const thinkingMessage: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMessage,
      ]);
      setState("sessions", sessionId, "streamingThinking", "");
    }

    // Finalize assistant content if any
    if (session.streamingContent) {
      // Calculate duration if we have a start time
      const duration = session.promptStartTime
        ? Date.now() - session.promptStartTime
        : undefined;

      const message: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: Date.now(),
        duration,
      };
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);

      // If the agent streamed a short auth error as text, surface it as a session error
      // so the error banner with the Login button appears. Long messages are skipped
      // to avoid false positives when the agent discusses auth topics in normal output.
      if (isLikelyAuthError(session.streamingContent)) {
        setState("sessions", sessionId, "error", session.streamingContent);
      }

      setState("sessions", sessionId, "streamingContent", "");
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
