// ABOUTME: Unified thread facade over conversation and agent runtime stores.
// ABOUTME: Presents chats and agent sessions as a single sorted thread list filtered by project.

import { createStore } from "solid-js/store";
import { PROVIDER_CONFIGS, type ProviderId } from "@/lib/providers/types";
import { type InstalledSkill, parseSkillMd } from "@/lib/skills";
import { archiveAgentConversation } from "@/lib/tauri-bridge";
import {
  type AgentType,
  listSessions,
  type SessionStatus,
} from "@/services/providers";
import { skills as skillsService } from "@/services/skills";
import {
  agentStore,
  registerActiveNavigationThreadIdGetter,
} from "@/stores/agent.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { editorSessionStore } from "@/stores/editor.sessions";
import { employeeStore } from "@/stores/employees.store";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";
import { skillsStore } from "@/stores/skills.store";
import { closeTab } from "@/stores/tabs";
import { terminalStore } from "@/stores/terminal.store";

const LAST_ACTIVE_THREAD_KEY = "seren:lastActiveThread";
const PROJECT_ORDER_KEY = "seren:projectOrder";

export type ThreadKind = "chat" | "agent" | "terminal" | "editor";

function isChatProvider(provider: string | null): provider is ProviderId {
  return !!provider && provider in PROVIDER_CONFIGS;
}

function persistLastActiveThread(id: string, kind: ThreadKind): void {
  try {
    localStorage.setItem(LAST_ACTIVE_THREAD_KEY, JSON.stringify({ id, kind }));
  } catch {
    // Non-fatal
  }
}

function loadProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed;
    }
  } catch {
    // Ignore
  }
  return [];
}

function persistProjectOrder(order: string[]): void {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Non-fatal
  }
}

function loadLastActiveThread(): {
  id: string;
  kind: ThreadKind;
} | null {
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_THREAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.id === "string" &&
      (parsed?.kind === "chat" ||
        parsed?.kind === "agent" ||
        parsed?.kind === "terminal" ||
        parsed?.kind === "editor")
    ) {
      return parsed as { id: string; kind: ThreadKind };
    }
  } catch {
    // Ignore
  }
  return null;
}

// ============================================================================
// Types
// ============================================================================

export type ThreadStatus = "idle" | "running" | "waiting-input" | "error";

export interface Thread {
  id: string;
  title: string;
  kind: ThreadKind;
  provider?: string | null;
  agentType?: AgentType;
  status: ThreadStatus;
  projectRoot: string | null;
  /**
   * When set, the thread is linked to a deployed virtual employee. Threads
   * with employeeId are grouped under that employee in the sidebar instead
   * of under their projectRoot.
   */
  employeeId: string | null;
  timestamp: number;
  /** Whether this thread has an active in-memory agent runtime session. */
  isLive: boolean;
}

export interface ThreadGroup {
  projectRoot: string | null;
  folderName: string;
  threads: Thread[];
}

interface ThreadState {
  activeThreadId: string | null;
  activeThreadKind: ThreadKind | null;
  /** When true, new threads prefer Seren Chat over any available agent. */
  preferChat: boolean;
  /**
   * User-set order of project groups in the sidebar. Project roots in this
   * list appear first in the rendered order; any project not in the list
   * falls through to recency sort. Persisted across sessions.
   */
  projectOrder: string[];
}

export type SkillLaunchMode = "replace" | "add";

export interface SkillLaunchOptions {
  mode?: SkillLaunchMode;
  includeDependencies?: boolean;
}

// ============================================================================
// State
// ============================================================================

const [state, setState] = createStore<ThreadState>({
  activeThreadId: null,
  activeThreadKind: null,
  preferChat: false,
  projectOrder: loadProjectOrder(),
});

// Expose the user's current navigation target to agent.store's idle-reclaim
// filter without forming a circular import. The getter is invoked lazily by
// getIdleClaudeSessionIds, so referencing `state` here is safe even though
// thread.store has only just begun evaluating. #1852.
registerActiveNavigationThreadIdGetter(() => state.activeThreadId);

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
 * Otherwise respects `agentStore.selectedAgentType` as the user's preference,
 * then falls back to availability order: claude-code > codex > gemini > chat.
 */
function getBestAgent():
  | { kind: "agent"; agentType: AgentType }
  | { kind: "chat" } {
  if (state.preferChat) return { kind: "chat" };

  const agents = agentStore.availableAgents;

  // Prefer the user's selected agent type if available
  const preferred = agents.find(
    (a) => a.type === agentStore.selectedAgentType && a.available,
  );
  if (preferred) {
    return { kind: "agent", agentType: preferred.type as AgentType };
  }

  // Fall back to availability order
  const claude = agents.find((a) => a.type === "claude-code" && a.available);
  if (claude) return { kind: "agent", agentType: "claude-code" };

  const codex = agents.find((a) => a.type === "codex" && a.available);
  if (codex) return { kind: "agent", agentType: "codex" };

  const gemini = agents.find((a) => a.type === "gemini" && a.available);
  if (gemini) return { kind: "agent", agentType: "gemini" };

  return { kind: "chat" };
}

/**
 * Cross-store conversation row used by `threadStore.allConversations`.
 * Captures every field today's read sites consult on either side of the
 * chat/agent partition, plus an explicit `kind` discriminator so callers
 * can branch without inspecting which underlying store the row came
 * from. When the dual-store partition retires, this becomes the
 * authoritative in-memory conversation shape.
 *
 * `provider` is the same value `switch_thread_provider` writes to the
 * runtime row and mirrors to `conversations.selected_provider`. For
 * legacy agent rows that pre-date the binding migration it falls back
 * to `agent_type` so the discriminator stays accurate.
 */
export interface UnifiedConversation {
  id: string;
  title: string;
  createdAt: number;
  kind: "chat" | "agent";
  projectRoot: string | null;
  isArchived: boolean;
  provider: string | null;
  model: string | null;
  /** Chat-side: the linked virtual employee, if any. Null on agent rows. */
  employeeId: string | null;
  /** Agent-side: the bound external agent runtime. Null on chat rows. */
  agentType: AgentType | null;
  /** Agent-side: the live or last-known native session id. Null on chat rows. */
  agentSessionId: string | null;
  /** Agent-side: the spawn cwd. Null on chat rows. */
  agentCwd: string | null;
  /** Agent-side: the explicit per-thread model override (distinct from `model`
   *  during the dual-column transition). Null on chat rows. */
  agentModelId: string | null;
}

function collectUnifiedConversations(): UnifiedConversation[] {
  const out: UnifiedConversation[] = [];
  for (const c of conversationStore.conversations) {
    out.push({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      kind: "chat",
      projectRoot: c.projectRoot,
      isArchived: c.isArchived,
      provider: c.selectedProvider ?? null,
      model: c.selectedModel ?? null,
      employeeId: c.employeeId,
      agentType: null,
      agentSessionId: null,
      agentCwd: null,
      agentModelId: null,
    });
  }
  for (const a of agentStore.recentAgentConversations) {
    out.push({
      id: a.id,
      title: a.title,
      createdAt: a.created_at,
      kind: "agent",
      projectRoot: a.project_root ?? a.agent_cwd ?? null,
      isArchived: a.is_archived,
      provider: (a.agent_type as string | null) ?? null,
      model: a.agent_model_id ?? null,
      employeeId: null,
      agentType: (a.agent_type as AgentType | null) ?? null,
      agentSessionId: a.agent_session_id ?? null,
      agentCwd: a.agent_cwd ?? null,
      agentModelId: a.agent_model_id ?? null,
    });
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

function skillRef(skill: Pick<InstalledSkill, "scope" | "slug">): string {
  return `${skill.scope}:${skill.slug}`;
}

function uniqRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
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

  get activeThreadKind(): ThreadKind | null {
    return state.activeThreadKind;
  },

  get preferChat(): boolean {
    return state.preferChat;
  },

  setPreferChat(prefer: boolean) {
    setState("preferChat", prefer);
  },

  /**
   * Move a project group so it lands before/after a target group in the
   * sidebar. Both operands must be real project roots (not null). Persists
   * the new order. No-op if source equals target.
   */
  reorderProjectGroup(
    sourceRoot: string,
    targetRoot: string,
    position: "before" | "after",
  ): void {
    if (sourceRoot === targetRoot) return;

    // Build the current displayed order so dragging an unranked project
    // anchors at its currently-visible position rather than jumping.
    const displayed = this.groupedThreads
      .map((g) => g.projectRoot)
      .filter((root): root is string => root !== null);

    const next = displayed.filter((root) => root !== sourceRoot);
    const targetIndex = next.indexOf(targetRoot);
    if (targetIndex === -1) return;
    const insertAt = position === "before" ? targetIndex : targetIndex + 1;
    next.splice(insertAt, 0, sourceRoot);

    setState("projectOrder", next);
    persistProjectOrder(next);
  },

  /**
   * Unified conversation view across the chat and agent stores. Includes
   * archived rows so downstream callers can apply their own filters; the
   * canonical `threads` getter below filters them out for the sidebar.
   *
   * This is the single read surface that the rest of the app should use
   * for "what conversations exist" — the partition between
   * `conversationStore.conversations` and `agentStore.recentAgentConversations`
   * is bookkeeping detail of the current dual-store model and goes away
   * once kind stops being a stored attribute. Consumers should not key
   * behavior on which underlying store a row came from; key on the
   * `kind` field of the unified row instead.
   */
  get allConversations(): UnifiedConversation[] {
    return collectUnifiedConversations();
  },

  /**
   * Look up a single conversation by id across both stores. Returns
   * undefined when no row is found in either side. Callers should
   * branch on the returned row's `kind` rather than trying to guess
   * which store owns the id.
   */
  findConversation(id: string): UnifiedConversation | undefined {
    return collectUnifiedConversations().find((c) => c.id === id);
  },

  /**
   * All threads, sorted by most recent first.
   * Combines chat conversations from conversationStore and agent conversations
   * from agentStore into a single unified list.
   */
  get threads(): Thread[] {
    // Chat conversations -> Thread. A chat is "running" while the
    // orchestrator is waiting on the model (loading[id]) or streaming
    // tokens back (streamingContent[id] non-empty). The sidebar's green
    // active dot keys off `status === "running"`, so this is what
    // surfaces it for Seren chat and Private chat. (#1915)
    const chatThreads: Thread[] = conversationStore.conversations
      .filter((c) => !c.isArchived)
      .map((c) => {
        const isActive =
          conversationStore.getLoadingFor(c.id) ||
          conversationStore.getStreamingContentFor(c.id) !== "";
        return {
          id: c.id,
          title: c.title,
          kind: "chat" as const,
          provider: c.selectedProvider ?? null,
          status: (isActive ? "running" : "idle") as ThreadStatus,
          projectRoot: c.projectRoot,
          employeeId: c.employeeId,
          timestamp: c.createdAt,
          isLive: isActive,
        };
      });

    // Agent conversations -> Thread
    const agentThreads: Thread[] = agentStore.recentAgentConversations
      .filter((a) => !a.is_archived)
      .map((a) => {
        const liveSession = Object.values(agentStore.sessions).find(
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
          employeeId: null,
          timestamp: a.created_at,
          isLive: !!liveSession,
        };
      });

    const terminalThreads: Thread[] = terminalStore.buffers.map((buffer) => ({
      id: buffer.id,
      title: buffer.title,
      kind: "terminal" as const,
      status:
        buffer.status === "running"
          ? ("running" as ThreadStatus)
          : ("idle" as ThreadStatus),
      projectRoot: buffer.cwd ?? null,
      employeeId: null,
      timestamp: buffer.createdAt,
      isLive: buffer.status === "running",
    }));

    const editorThreads: Thread[] = editorSessionStore.sessions.map(
      (session) => ({
        id: session.id,
        title: session.label,
        kind: "editor" as const,
        status: "idle" as ThreadStatus,
        projectRoot: session.cwd,
        employeeId: null,
        // Sessions never bump above any real thread by accident: the recency
        // signal here is `lastActiveAt`, which only changes when the user
        // activates the session.
        timestamp: session.lastActiveAt,
        isLive: false,
      }),
    );

    // Merge and sort by recency
    const all = [
      ...chatThreads,
      ...agentThreads,
      ...terminalThreads,
      ...editorThreads,
    ];

    return all.sort((a, b) => b.timestamp - a.timestamp);
  },

  /**
   * Threads grouped by project directory.
   *
   * Order: any project roots in `projectOrder` appear first in that exact
   * order; remaining projects fall through to most-recent-activity sort.
   * The "No project" bucket is always pinned to the bottom.
   *
   * We deliberately do NOT float the current project (`fileTreeState.rootPath`)
   * to the top: doing so meant every thread click reordered the sidebar,
   * which felt like the layout was jumping around. The "you are here"
   * signal is carried by the highlight on the active group's header.
   */
  /**
   * Threads keyed by their owning employee. Employee-linked threads are
   * rendered under the employee row in the sidebar instead of in the
   * project group list, so they are filtered out of `groupedThreads`.
   */
  get threadsByEmployee(): Record<string, Thread[]> {
    const out: Record<string, Thread[]> = {};
    for (const t of this.threads) {
      if (!t.employeeId) continue;
      const list = out[t.employeeId] ?? [];
      list.push(t);
      out[t.employeeId] = list;
    }
    return out;
  },

  get groupedThreads(): ThreadGroup[] {
    // Employee-linked threads are surfaced under the employee in the sidebar.
    // Live employees parent their threads; archived employees do too (the
    // sidebar still renders the parent row in a greyed state). A thread
    // whose employeeId resolves to neither falls through to its project
    // group so the conversation does not silently disappear from the UI.
    const employeesLoaded = employeeStore.lastLoadedAt !== null;
    const threads = this.threads.filter((t) => {
      if (!t.employeeId) return true;
      if (!employeesLoaded) return false;
      if (employeeStore.byId(t.employeeId) !== undefined) return false;
      if (employeeStore.archivedById(t.employeeId) !== undefined) return false;
      return true;
    });

    // Group by projectRoot.
    const groups = new Map<string | null, Thread[]>();
    for (const t of threads) {
      const key = t.projectRoot;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(t);
    }

    const result: ThreadGroup[] = [];
    const realRoots = [...groups.keys()].filter(
      (key): key is string => key !== null,
    );

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const root of state.projectOrder) {
      if (groups.has(root) && !seen.has(root)) {
        ordered.push(root);
        seen.add(root);
      }
    }

    const unranked = realRoots
      .filter((root) => !seen.has(root))
      .sort((a, b) => {
        const aMax = Math.max(...(groups.get(a) ?? []).map((t) => t.timestamp));
        const bMax = Math.max(...(groups.get(b) ?? []).map((t) => t.timestamp));
        return bMax - aMax;
      });

    for (const root of [...ordered, ...unranked]) {
      const rootThreads = groups.get(root) ?? [];
      result.push({
        projectRoot: root,
        folderName: root.split("/").pop() || root,
        threads: rootThreads,
      });
    }

    // Ungrouped threads (no project) always pinned to the bottom so the
    // groupless bucket doesn't compete with real projects for prime space.
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
   * Select a thread by ID. Updates the underlying store (conversation or agent)
   * to match.
   */
  selectThread(id: string, kind: ThreadKind) {
    setState({ activeThreadId: id, activeThreadKind: kind });
    persistLastActiveThread(id, kind);

    // Keep the project context aligned with the selected thread.
    const thread = this.threads.find((t) => t.id === id);
    if (thread?.projectRoot && thread.projectRoot !== fileTreeState.rootPath) {
      setRootPath(thread.projectRoot);
    }

    if (kind === "chat") {
      conversationStore.setActiveConversation(id);
      // Look up through the unified view so the source of truth is the
      // same regardless of which underlying store the row lives in.
      // Once shell selection becomes binding-driven (Option C-3) the
      // `kind` argument here is informational and may disagree with the
      // row's actual kind; treat the row as authoritative for the
      // provider/model picker mirror.
      const conversation = this.findConversation(id);
      if (conversation) {
        providerStore.setActiveProvider(
          isChatProvider(conversation.provider)
            ? conversation.provider
            : "seren",
        );
        providerStore.setActiveModel(conversation.model || AUTO_MODEL_ID);
        chatStore.setModel(conversation.model || AUTO_MODEL_ID);
      }
    } else if (kind === "agent") {
      if (
        thread?.agentType &&
        thread.agentType !== agentStore.selectedAgentType
      ) {
        agentStore.setSelectedAgentType(thread.agentType);
      }

      // For agent threads, set active session if one exists
      const liveSession = Object.values(agentStore.sessions).find(
        (s) => s.conversationId === id,
      );
      console.log(
        "[Thread] selectThread - looking for session with conversationId:",
        id,
        "found:",
        liveSession?.info.id,
      );
      if (liveSession) {
        // Mark active synchronously so a parallel spawn's preemptive
        // idle-reclaim cannot kill the session the user just clicked.
        // Without this, state.activeSessionId still points at the previous
        // thread until listSessions resolves, and getIdleClaudeSessionIds
        // sees the just-clicked session as "idle and not active". #1852.
        agentStore.setActiveSession(liveSession.info.id);

        // Verify the session actually exists in the Rust backend.
        // After an app restart the JS store may hold stale sessions
        // whose backend process is gone.
        void listSessions().then(async (backendSessions) => {
          if (state.activeThreadId !== id || state.activeThreadKind !== kind) {
            return;
          }

          const alive = backendSessions.some(
            (s) => s.id === liveSession.info.id,
          );
          if (alive) return;

          console.warn(
            "[Thread] Session",
            liveSession.info.id,
            "exists in store but not in backend - resuming",
          );
          agentStore.setActiveSession(null);
          await agentStore.terminateSession(liveSession.info.id);
          if (state.activeThreadId !== id || state.activeThreadKind !== kind) {
            return;
          }
          const cwd = thread?.projectRoot || fileTreeState.rootPath;
          if (cwd) {
            void agentStore.resumeAgentConversation(id, cwd);
          }
        });
      } else {
        // No live session - clear active and auto-resume the agent conversation.
        // The spawn lock in the Rust backend prevents SIGKILL collisions.
        agentStore.setActiveSession(null);
        const cwd = thread?.projectRoot || fileTreeState.rootPath;
        if (cwd) {
          void agentStore.resumeAgentConversation(id, cwd);
        }
      }
    } else if (kind === "editor") {
      // Editor sessions live in the tab store; activating one swaps the
      // visible tabs to that session's cwd. The conversation/agent stores
      // intentionally stay where they are - editing a file shouldn't drop
      // the user out of the chat or agent they had open.
      editorSessionStore.activate(id);
    } else {
      conversationStore.setActiveConversation(null);
      agentStore.setActiveSession(null);
    }
  },

  /** Select by id alone; resolves kind from the unified list. */
  setActiveThread(id: string | null): void {
    if (id === null) {
      setState({ activeThreadId: null, activeThreadKind: null });
      conversationStore.setActiveConversation(null);
      agentStore.setActiveSession(null);
      return;
    }
    const thread = this.threads.find((t) => t.id === id);
    if (!thread) {
      // Stale id - clear so downstream stores don't keep dangling pointers.
      setState({ activeThreadId: null, activeThreadKind: null });
      conversationStore.setActiveConversation(null);
      agentStore.setActiveSession(null);
      return;
    }
    this.selectThread(id, thread.kind);
  },

  /**
   * Create a new chat thread.
   */
  async createChatThread(title = "New Chat"): Promise<string> {
    return this.createChatThreadWithOptions(title, {});
  },

  async createChatThreadWithOptions(
    title = "New Chat",
    options: {
      provider?: ProviderId | null;
      model?: string;
      employeeId?: string;
    },
  ): Promise<string> {
    // Employee-linked threads are not bound to a project folder.
    const projectRoot = options.employeeId
      ? undefined
      : fileTreeState.rootPath || undefined;
    const provider =
      options.provider ??
      (providerStore.activeProvider === "seren-private"
        ? "seren"
        : providerStore.activeProvider);
    const model =
      options.model ??
      (provider === "seren-private"
        ? "organization/private-model"
        : providerStore.activeModel || AUTO_MODEL_ID);
    const conversation = await conversationStore.createConversationWithModel(
      title,
      model,
      projectRoot,
      provider,
      options.employeeId ?? null,
    );
    this.selectThread(conversation.id, "chat");
    return conversation.id;
  },

  /**
   * Create a new agent thread by spawning an agent session.
   */
  async createAgentThread(
    agentType: AgentType,
    cwd: string,
  ): Promise<string | null> {
    const sessionId = await agentStore.spawnSession(cwd, agentType);
    if (sessionId) {
      // Refresh conversation list so the new thread appears in the tab bar
      await agentStore.refreshRecentAgentConversations(200);
      const session = agentStore.sessions[sessionId];
      if (session) {
        this.selectThread(session.conversationId, "agent");
        return session.conversationId;
      }
    }
    return null;
  },

  async createTerminalThread(
    options: { title?: string; command?: string } = {},
  ): Promise<string | null> {
    const buffer = await terminalStore.createBuffer({
      title: options.title,
      command: options.command,
      cwd: fileTreeState.rootPath,
    });
    this.selectThread(buffer.id, "terminal");
    terminalStore.requestFocus(buffer.id);
    return buffer.id;
  },

  /**
   * Create a thread pre-configured with a single skill.
   * Auto-detects the best agent (claude > codex > chat).
   * Sets a thread-level skill override so only the chosen skill is active.
   */
  async createSkillThread(skill: InstalledSkill): Promise<string | null> {
    return this.createSkillThreadWithSkills([skill], { mode: "replace" });
  },

  /**
   * Create a thread pre-configured with one or more skills.
   * - `replace`: thread uses only selected skills (+required dependencies).
   * - `add`: thread uses current context skills plus selected skills (+deps).
   */
  async createSkillThreadWithSkills(
    selectedSkills: InstalledSkill[],
    options: SkillLaunchOptions = {},
  ): Promise<string | null> {
    if (selectedSkills.length === 0) return null;

    const mode = options.mode ?? "replace";
    const includeDependencies = options.includeDependencies ?? true;
    const best = getBestAgent();
    const cwd = fileTreeState.rootPath;
    const installedBySlug = new Map(
      skillsStore.installed.map((installed) => [installed.slug, installed]),
    );

    const selectedByRef = new Map<string, InstalledSkill>();
    const queue = [...selectedSkills];
    for (const skill of selectedSkills) {
      selectedByRef.set(skillRef(skill), skill);
    }

    while (includeDependencies && queue.length > 0) {
      const current = queue.shift() as InstalledSkill;
      const content = await skillsService.readContent(current);
      if (!content) continue;

      const parsed = parseSkillMd(content);
      const requires = parsed.metadata.requires ?? [];
      for (const requiredSlug of requires) {
        const dep = installedBySlug.get(requiredSlug);
        if (!dep) continue;
        const depRef = skillRef(dep);
        if (selectedByRef.has(depRef)) continue;
        selectedByRef.set(depRef, dep);
        queue.push(dep);
      }
    }

    const selectedRefs = [...selectedByRef.keys()];
    const baseRefs =
      mode === "add" && cwd
        ? skillsStore
            .getThreadSkills(cwd, state.activeThreadId)
            .map((activeSkill) => skillRef(activeSkill))
        : [];

    const targetRefs = uniqRefs([...baseRefs, ...selectedRefs]);

    if (best.kind === "agent" && cwd) {
      const threadId = await this.createAgentThread(best.agentType, cwd);
      if (threadId) {
        await skillsService.setThreadSkills(cwd, threadId, targetRefs);
        await skillsStore.loadThreadSkills(cwd, threadId, true);
      }
      return threadId;
    }

    // Fallback to chat
    const first = selectedSkills[0];
    const threadId = await this.createChatThread(first?.name || "Skill");
    const projectRoot = cwd || undefined;
    if (projectRoot) {
      await skillsService.setThreadSkills(projectRoot, threadId, targetRefs);
      await skillsStore.loadThreadSkills(projectRoot, threadId, true);
    }
    return threadId;
  },

  /**
   * Archive a thread.
   */
  async archiveThread(id: string, kind: ThreadKind) {
    if (kind === "chat") {
      await conversationStore.archiveConversation(id);
    } else if (kind === "agent") {
      await archiveAgentConversation(id);
      await agentStore.refreshRecentAgentConversations(200);
    } else if (kind === "terminal") {
      await terminalStore.kill(id);
      terminalStore.removeLocal(id);
    } else {
      // Editor sessions: close every tab in the session. The session
      // disappears from the sidebar automatically because it's derived from
      // the open tab list. Prompt before discarding unsaved tabs so a stray
      // close click can't silently drop work in progress.
      const session = editorSessionStore.findById(id);
      if (!session) return;
      if (session.isDirty) {
        const dirtyCount = session.tabs.filter((t) => t.isDirty).length;
        const { confirm } = await import("@tauri-apps/plugin-dialog");
        const ok = await confirm(
          `${session.label} has ${dirtyCount} unsaved file${dirtyCount === 1 ? "" : "s"}. Close anyway? Changes will be lost.`,
          { title: "Close editor session", kind: "warning" },
        );
        if (!ok) return;
      }
      for (const tab of session.tabs) closeTab(tab.id);
    }

    // Clear selection if this was active
    if (state.activeThreadId === id) {
      setState({ activeThreadId: null, activeThreadKind: null });
    }
  },

  /**
   * Fork an agent thread from a specific message.
   * Creates a new conversation with the forked CLI session and switches to it.
   */
  async forkAgentThread(
    fromConversationId: string,
    fromMessageId: string,
  ): Promise<string | null> {
    const newConversationId = await agentStore.forkConversation(
      fromConversationId,
      fromMessageId,
    );
    if (!newConversationId) return null;

    await agentStore.refreshRecentAgentConversations(200);
    this.selectThread(newConversationId, "agent");
    return newConversationId;
  },

  /**
   * Sync thread state from underlying stores. Call after auth or on mount.
   * Restores the last-active thread after loading so the user sees the same
   * thread they had open before an upgrade restart.
   */
  async refresh() {
    await conversationStore.loadHistory();
    await agentStore.refreshRecentAgentConversations(200);
    await terminalStore.init();

    // Only restore if no thread is already active (e.g. deep-linked navigation).
    if (state.activeThreadId) return;

    const last = loadLastActiveThread();
    if (!last) return;

    // Verify the thread still exists in the loaded list before selecting it.
    const exists = this.threads.some((t) => t.id === last.id);
    if (exists) {
      this.selectThread(last.id, last.kind);
    }
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
    try {
      localStorage.removeItem(LAST_ACTIVE_THREAD_KEY);
    } catch {
      // Non-fatal
    }
  },
};
