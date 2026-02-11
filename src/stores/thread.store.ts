// ABOUTME: Unified thread facade over conversation and ACP stores.
// ABOUTME: Presents chats and agent sessions as a single sorted thread list filtered by project.

import { createStore } from "solid-js/store";
import type { AgentType, SessionStatus } from "@/services/acp";
import { acpStore } from "@/stores/acp.store";
import { conversationStore } from "@/stores/conversation.store";
import { fileTreeState } from "@/stores/fileTree";

// ============================================================================
// Types
// ============================================================================

export type ThreadStatus = "idle" | "running" | "waiting-input" | "error";

export interface Thread {
  id: string;
  title: string;
  kind: "chat" | "agent";
  agentType?: AgentType;
  status: ThreadStatus;
  projectRoot: string | null;
  timestamp: number;
  /** Whether this thread has an active in-memory ACP session. */
  isLive: boolean;
}

interface ThreadState {
  activeThreadId: string | null;
  activeThreadKind: "chat" | "agent" | null;
}

// ============================================================================
// State
// ============================================================================

const [state, setState] = createStore<ThreadState>({
  activeThreadId: null,
  activeThreadKind: null,
});

// ============================================================================
// Helpers
// ============================================================================

function mapSessionStatusToThread(status: SessionStatus): ThreadStatus {
  switch (status) {
    case "prompting":
      return "running";
    case "initializing":
      return "running";
    case "ready":
      return "idle";
    case "error":
      return "error";
    case "terminated":
      return "idle";
    default:
      return "idle";
  }
}

// ============================================================================
// Store
// ============================================================================

export const threadStore = {
  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get activeThreadId(): string | null {
    return state.activeThreadId;
  },

  get activeThreadKind(): "chat" | "agent" | null {
    return state.activeThreadKind;
  },

  /**
   * All threads for the current project, sorted by most recent first.
   * Combines chat conversations from conversationStore and agent conversations
   * from acpStore into a single unified list.
   */
  get threads(): Thread[] {
    const projectRoot = fileTreeState.rootPath;

    // Chat conversations → Thread
    const chatThreads: Thread[] = conversationStore.conversations
      .filter((c) => !c.isArchived)
      .map((c) => ({
        id: c.id,
        title: c.title,
        kind: "chat" as const,
        status: "idle" as ThreadStatus,
        projectRoot: (c as { projectRoot?: string | null }).projectRoot ?? null,
        timestamp: c.createdAt,
        isLive: false,
      }));

    // Agent conversations → Thread
    const agentThreads: Thread[] = acpStore.recentAgentConversations
      .filter((a) => !a.is_archived)
      .map((a) => {
        const liveSession = Object.values(acpStore.sessions).find(
          (s) => s.conversationId === a.id,
        );
        return {
          id: a.id,
          title: a.title,
          kind: "agent" as const,
          agentType: (a.agent_type as AgentType) || "claude-code",
          status: liveSession
            ? mapSessionStatusToThread(liveSession.info.status)
            : ("idle" as ThreadStatus),
          projectRoot: a.project_root ?? a.agent_cwd ?? null,
          timestamp: a.created_at,
          isLive: !!liveSession,
        };
      });

    // Merge and sort by recency
    const all = [...chatThreads, ...agentThreads];

    // Filter by project if a folder is open
    const filtered = projectRoot
      ? all.filter(
          (t) => t.projectRoot === null || t.projectRoot === projectRoot,
        )
      : all;

    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  },

  /**
   * The currently selected thread object.
   */
  get activeThread(): Thread | null {
    if (!state.activeThreadId) return null;
    return this.threads.find((t) => t.id === state.activeThreadId) ?? null;
  },

  /**
   * Count of threads with running agents.
   */
  get runningCount(): number {
    return this.threads.filter((t) => t.status === "running").length;
  },

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  /**
   * Select a thread by ID. Updates the underlying store (conversation or ACP)
   * to match.
   */
  selectThread(id: string, kind: "chat" | "agent") {
    setState({ activeThreadId: id, activeThreadKind: kind });

    if (kind === "chat") {
      conversationStore.setActiveConversation(id);
    } else {
      // For agent threads, set active session if one exists
      const liveSession = Object.values(acpStore.sessions).find(
        (s) => s.conversationId === id,
      );
      if (liveSession) {
        acpStore.setActiveSession(liveSession.info.id);
      }
    }
  },

  /**
   * Create a new chat thread.
   */
  async createChatThread(title = "New Chat"): Promise<string> {
    const conversation = await conversationStore.createConversation(title);
    this.selectThread(conversation.id, "chat");
    return conversation.id;
  },

  /**
   * Create a new agent thread by spawning an ACP session.
   */
  async createAgentThread(
    agentType: AgentType,
    cwd: string,
  ): Promise<string | null> {
    const sessionId = await acpStore.spawnSession(cwd, agentType);
    if (sessionId) {
      const session = acpStore.sessions[sessionId];
      if (session) {
        this.selectThread(session.conversationId, "agent");
        return session.conversationId;
      }
    }
    return null;
  },

  /**
   * Archive a thread.
   */
  async archiveThread(id: string, kind: "chat" | "agent") {
    if (kind === "chat") {
      await conversationStore.archiveConversation(id);
    }
    // Agent conversations don't have archive yet — could add later

    // Clear selection if this was active
    if (state.activeThreadId === id) {
      setState({ activeThreadId: null, activeThreadKind: null });
    }
  },

  /**
   * Sync thread state from underlying stores. Call after auth or on mount.
   */
  async refresh() {
    await conversationStore.loadHistory();
    await acpStore.refreshRecentAgentConversations();
  },

  /**
   * Clear all state (e.g., on logout).
   */
  clear() {
    setState({ activeThreadId: null, activeThreadKind: null });
  },
};
