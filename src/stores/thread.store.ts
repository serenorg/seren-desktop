// ABOUTME: Unified thread facade over conversation and ACP stores.
// ABOUTME: Presents chats and agent sessions as a single sorted thread list filtered by project.

import { createStore } from "solid-js/store";
import type { InstalledSkill } from "@/lib/skills";
import { archiveAgentConversation } from "@/lib/tauri-bridge";
import type { AgentType, SessionStatus } from "@/services/acp";
import { skills as skillsService } from "@/services/skills";
import { acpStore } from "@/stores/acp.store";
import { conversationStore } from "@/stores/conversation.store";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { skillsStore } from "@/stores/skills.store";

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

export interface ThreadGroup {
  projectRoot: string | null;
  folderName: string;
  threads: Thread[];
}

interface ThreadState {
  activeThreadId: string | null;
  activeThreadKind: "chat" | "agent" | null;
  /** When true, new threads prefer Seren Chat over any available agent. */
  preferChat: boolean;
}

// ============================================================================
// State
// ============================================================================

const [state, setState] = createStore<ThreadState>({
  activeThreadId: null,
  activeThreadKind: null,
  preferChat: false,
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

/**
 * Auto-detect the best available agent.
 * If preferChat is set, always returns chat.
 * Otherwise respects `acpStore.selectedAgentType` as the user's preference,
 * then falls back to availability order: claude-code > codex > chat.
 */
function getBestAgent():
  | { kind: "agent"; agentType: AgentType }
  | { kind: "chat" } {
  if (state.preferChat) return { kind: "chat" };

  const agents = acpStore.availableAgents;

  // Prefer the user's selected agent type if available
  const preferred = agents.find(
    (a) => a.type === acpStore.selectedAgentType && a.available,
  );
  if (preferred) {
    return { kind: "agent", agentType: preferred.type as AgentType };
  }

  // Fall back to availability order
  const claude = agents.find((a) => a.type === "claude-code" && a.available);
  if (claude) return { kind: "agent", agentType: "claude-code" };

  const codex = agents.find((a) => a.type === "codex" && a.available);
  if (codex) return { kind: "agent", agentType: "codex" };

  return { kind: "chat" };
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

  get preferChat(): boolean {
    return state.preferChat;
  },

  setPreferChat(prefer: boolean) {
    setState("preferChat", prefer);
  },

  /**
   * All threads, sorted by most recent first.
   * Combines chat conversations from conversationStore and agent conversations
   * from acpStore into a single unified list.
   */
  get threads(): Thread[] {
    // Chat conversations → Thread
    const chatThreads: Thread[] = conversationStore.conversations
      .filter((c) => !c.isArchived)
      .map((c) => ({
        id: c.id,
        title: c.title,
        kind: "chat" as const,
        status: "idle" as ThreadStatus,
        projectRoot: c.projectRoot,
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
          title: liveSession?.title || a.title,
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

    return all.sort((a, b) => b.timestamp - a.timestamp);
  },

  /**
   * Threads grouped by project directory.
   * The current project's group comes first, then others, then ungrouped.
   */
  get groupedThreads(): ThreadGroup[] {
    const threads = this.threads;
    const currentRoot = fileTreeState.rootPath;

    // Group by projectRoot
    const groups = new Map<string | null, Thread[]>();
    for (const t of threads) {
      const key = t.projectRoot;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(t);
    }

    const result: ThreadGroup[] = [];

    // Current project first
    if (currentRoot && groups.has(currentRoot)) {
      result.push({
        projectRoot: currentRoot,
        folderName: currentRoot.split("/").pop() || currentRoot,
        threads: groups.get(currentRoot) || [],
      });
      groups.delete(currentRoot);
    }

    // Other projects (sorted by most recent thread)
    const otherRoots = [...groups.entries()]
      .filter(([key]) => key !== null)
      .sort(
        ([, a], [, b]) =>
          Math.max(...b.map((t) => t.timestamp)) -
          Math.max(...a.map((t) => t.timestamp)),
      );

    for (const [root, rootThreads] of otherRoots) {
      result.push({
        projectRoot: root,
        folderName: (root as string).split("/").pop() || (root as string),
        threads: rootThreads,
      });
    }

    // Ungrouped threads (no project)
    const ungrouped = groups.get(null);
    if (ungrouped && ungrouped.length > 0) {
      result.push({
        projectRoot: null,
        folderName: "No project",
        threads: ungrouped,
      });
    }

    return result;
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

    // Keep the project context aligned with the selected thread.
    const thread = this.threads.find((t) => t.id === id);
    if (thread?.projectRoot && thread.projectRoot !== fileTreeState.rootPath) {
      setRootPath(thread.projectRoot);
    }

    if (kind === "chat") {
      conversationStore.setActiveConversation(id);
    } else {
      if (
        thread?.agentType &&
        thread.agentType !== acpStore.selectedAgentType
      ) {
        acpStore.setSelectedAgentType(thread.agentType);
      }

      // For agent threads, set active session if one exists
      const liveSession = Object.values(acpStore.sessions).find(
        (s) => s.conversationId === id,
      );
      console.log(
        "[Thread] selectThread - looking for session with conversationId:",
        id,
        "found:",
        liveSession?.info.id,
      );
      if (liveSession) {
        acpStore.setActiveSession(liveSession.info.id);
      } else {
        // No live session — clear active and auto-resume the agent conversation.
        // The spawn lock in the Rust backend prevents SIGKILL collisions.
        acpStore.setActiveSession(null);
        const cwd = thread?.projectRoot || fileTreeState.rootPath;
        if (cwd) {
          void acpStore.resumeAgentConversation(id, cwd);
        }
      }
    }
  },

  /**
   * Create a new chat thread.
   */
  async createChatThread(title = "New Chat"): Promise<string> {
    const projectRoot = fileTreeState.rootPath || undefined;
    const conversation = await conversationStore.createConversation(
      title,
      projectRoot,
    );
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
      // Refresh conversation list so the new thread appears in the tab bar
      await acpStore.refreshRecentAgentConversations(200);
      const session = acpStore.sessions[sessionId];
      if (session) {
        this.selectThread(session.conversationId, "agent");
        return session.conversationId;
      }
    }
    return null;
  },

  /**
   * Create a thread pre-configured with a single skill.
   * Auto-detects the best agent (claude > codex > chat).
   * Sets a thread-level skill override so only the chosen skill is active.
   */
  async createSkillThread(skill: InstalledSkill): Promise<string | null> {
    const best = getBestAgent();
    const cwd = fileTreeState.rootPath;
    const skillRef = `${skill.scope}:${skill.slug}`;

    if (best.kind === "agent" && cwd) {
      const threadId = await this.createAgentThread(best.agentType, cwd);
      if (threadId) {
        await skillsService.setThreadSkills(cwd, threadId, [skillRef]);
        await skillsStore.loadThreadSkills(cwd, threadId, true);
      }
      return threadId;
    }

    // Fallback to chat
    const threadId = await this.createChatThread(skill.name);
    const projectRoot = cwd || undefined;
    if (projectRoot) {
      await skillsService.setThreadSkills(projectRoot, threadId, [skillRef]);
      await skillsStore.loadThreadSkills(projectRoot, threadId, true);
    }
    return threadId;
  },

  /**
   * Archive a thread.
   */
  async archiveThread(id: string, kind: "chat" | "agent") {
    if (kind === "chat") {
      await conversationStore.archiveConversation(id);
    } else {
      await archiveAgentConversation(id);
      await acpStore.refreshRecentAgentConversations(200);
    }

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
    await acpStore.refreshRecentAgentConversations(200);
  },

  /**
   * Clear all state (e.g., on logout).
   */
  clear() {
    setState({
      activeThreadId: null,
      activeThreadKind: null,
      preferChat: false,
    });
  },
};
