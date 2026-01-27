// ABOUTME: Reactive ACP (Agent Client Protocol) state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import type {
  AcpEvent,
  AcpSessionInfo,
  AgentInfo,
  AgentType,
  DiffEvent,
  PlanEntry,
  SessionStatus,
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
}

export interface ActiveSession {
  info: AcpSessionInfo;
  messages: AgentMessage[];
  plan: PlanEntry[];
  pendingToolCalls: Map<string, ToolCallEvent>;
  streamingContent: string;
  unsubscribe?: UnlistenFn;
}

interface AcpState {
  /** Available agents and their status */
  availableAgents: AgentInfo[];
  /** Active sessions keyed by session ID */
  sessions: Record<string, ActiveSession>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Whether agent mode is enabled in the chat */
  agentModeEnabled: boolean;
  /** Selected agent type for new sessions */
  selectedAgentType: AgentType;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
}

const [state, setState] = createStore<AcpState>({
  availableAgents: [],
  sessions: {},
  activeSessionId: null,
  agentModeEnabled: false,
  selectedAgentType: "claude-code",
  isLoading: false,
  error: null,
});

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

  get agentModeEnabled() {
    return state.agentModeEnabled;
  },

  get selectedAgentType() {
    return state.selectedAgentType;
  },

  get isLoading() {
    return state.isLoading;
  },

  get error() {
    return state.error;
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
  async spawnSession(cwd: string): Promise<string | null> {
    setState("isLoading", true);
    setState("error", null);

    console.log("[AcpStore] Spawning session:", {
      agentType: state.selectedAgentType,
      cwd,
    });

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
      const info = await acpService.spawnAgent(state.selectedAgentType, cwd);
      console.log("[AcpStore] Spawn result:", info);

      // Create session state
      const session: ActiveSession = {
        info,
        messages: [],
        plan: [],
        pendingToolCalls: new Map(),
        streamingContent: "",
      };

      setState("sessions", info.id, session);
      setState("activeSessionId", info.id);

      // Subscribe to session events for future updates
      const unsubscribe = await acpService.subscribeToSession(
        info.id,
        (event) => this.handleSessionEvent(info.id, event),
      );

      setState("sessions", info.id, "unsubscribe", unsubscribe);

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
        // The session might still work, just proceed
      }

      setState("isLoading", false);
      tempUnsubscribe();

      return info.id;
    } catch (error) {
      console.error("[AcpStore] Spawn error:", error);
      tempUnsubscribe();
      const message =
        error instanceof Error ? error.message : "Failed to spawn agent";
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

    // Unsubscribe from events
    if (session.unsubscribe) {
      session.unsubscribe();
    }

    try {
      await acpService.terminateSession(sessionId);
    } catch (error) {
      console.error("Failed to terminate session:", error);
    }

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
   */
  async sendPrompt(prompt: string, context?: Array<{ text?: string }>) {
    const sessionId = state.activeSessionId;
    console.log("[AcpStore] sendPrompt called:", { sessionId, prompt: prompt.slice(0, 50) });
    if (!sessionId) {
      setState("error", "No active session");
      return;
    }

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

    console.log("[AcpStore] Calling acpService.sendPrompt...");
    try {
      await acpService.sendPrompt(sessionId, prompt, context);
      console.log("[AcpStore] sendPrompt completed successfully");
    } catch (error) {
      console.error("[AcpStore] sendPrompt error:", error);
      const message =
        error instanceof Error ? error.message : "Failed to send prompt";
      this.addErrorMessage(sessionId, message);
    }
  },

  /**
   * Cancel the current prompt in the active session.
   */
  async cancelPrompt() {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await acpService.cancelPrompt(sessionId);
    } catch (error) {
      console.error("Failed to cancel prompt:", error);
    }
  },

  /**
   * Set permission mode for the active session.
   */
  async setPermissionMode(mode: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    try {
      await acpService.setPermissionMode(sessionId, mode);
    } catch (error) {
      console.error("Failed to set permission mode:", error);
    }
  },

  // ============================================================================
  // UI State
  // ============================================================================

  /**
   * Toggle agent mode on/off.
   */
  setAgentModeEnabled(enabled: boolean) {
    setState("agentModeEnabled", enabled);
  },

  /**
   * Set the selected agent type for new sessions.
   */
  setSelectedAgentType(agentType: AgentType) {
    setState("selectedAgentType", agentType);
  },

  /**
   * Clear error state.
   */
  clearError() {
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
        break;

      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status);
        break;

      case "error":
        this.addErrorMessage(sessionId, event.data.error);
        break;

      case "permissionRequest":
        // For now, permissions are auto-approved in the backend
        // In the future, we could show a UI prompt here
        console.log("Permission requested:", event.data);
        break;
    }
  },

  handleMessageChunk(sessionId: string, text: string, _isThought?: boolean) {
    console.log("[AcpStore] handleMessageChunk:", { sessionId, text: text.slice(0, 50) + "...", isThought: _isThought });
    // Append to streaming content
    // Note: isThought could be used to style thought messages differently
    setState(
      "sessions",
      sessionId,
      "streamingContent",
      (current) => current + text,
    );
  },

  handleToolCall(sessionId: string, toolCall: ToolCallEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

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

  handleToolResult(sessionId: string, toolCallId: string, status: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Update the tool message status
    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (msg.toolCallId === toolCallId && msg.toolCall) {
          return {
            ...msg,
            toolCall: { ...msg.toolCall, status },
          };
        }
        return msg;
      }),
    );

    // Remove from pending
    session.pendingToolCalls.delete(toolCallId);
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

  handleStatusChange(sessionId: string, status: SessionStatus) {
    setState("sessions", sessionId, "info", "status", status);
  },

  finalizeStreamingContent(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session || !session.streamingContent) return;

    // Convert accumulated streaming content to a message
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "assistant",
      content: session.streamingContent,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    setState("sessions", sessionId, "streamingContent", "");
  },

  addErrorMessage(sessionId: string, error: string) {
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "error",
      content: error,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    setState("error", error);
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

export type { AgentType, SessionStatus, AcpSessionInfo, AgentInfo, DiffEvent };
