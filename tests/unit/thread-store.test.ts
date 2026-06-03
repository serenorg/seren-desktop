// ABOUTME: Tests for the unified thread store facade.
// ABOUTME: Verifies thread merging, grouping, selection, and delegation to underlying stores.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted ensures these are available in vi.mock factories (which are hoisted)
const { mockStoreState, mockFileTreeState } = vi.hoisted(() => ({
  mockStoreState: {} as Record<string, unknown>,
  mockFileTreeState: { rootPath: "/Users/dev/project-a" as string | null },
}));

// Mock solid-js/store to provide a minimal reactive store for testing
vi.mock("solid-js/store", () => ({
  createStore: <T extends Record<string, unknown>>(initial: T) => {
    Object.assign(mockStoreState, initial);
    const setState = (update: Partial<T> | string, value?: unknown) => {
      if (typeof update === "string") {
        (mockStoreState as Record<string, unknown>)[update] = value;
      } else {
        Object.assign(mockStoreState, update);
      }
    };
    return [mockStoreState, setState];
  },
}));

// Mock fileTree store
vi.mock("@/stores/fileTree", () => ({
  get fileTreeState() {
    return mockFileTreeState;
  },
  setRootPath: vi.fn(),
}));

// Mock conversation store
const mockConversations = {
  conversations: [] as Array<{
    id: string;
    title: string;
    createdAt: number;
    selectedModel: string;
    selectedProvider: string | null;
    projectRoot: string | null;
    isArchived: boolean;
    employeeId?: string | null;
  }>,
  activeConversationId: null as string | null,
  streamingContent: {} as Record<string, string>,
  loading: {} as Record<string, boolean>,
};

vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    get conversations() {
      return mockConversations.conversations;
    },
    get activeConversationId() {
      return mockConversations.activeConversationId;
    },
    getStreamingContentFor: (id: string) =>
      mockConversations.streamingContent[id] ?? "",
    getLoadingFor: (id: string) =>
      mockConversations.loading[id] ?? false,
    setActiveConversation: vi.fn((id: string | null) => {
      mockConversations.activeConversationId = id;
    }),
    createConversationWithModel: vi.fn(
      async (
        title: string,
        selectedModel: string,
        projectRoot?: string,
        selectedProvider?: string | null,
        employeeId?: string | null,
      ) => {
        const convo = {
          id: `chat-${mockConversations.conversations.length + 1}`,
          title,
          createdAt: Date.now(),
          selectedModel,
          selectedProvider: selectedProvider ?? null,
          projectRoot: projectRoot ?? null,
          isArchived: false,
          employeeId: employeeId ?? null,
        };
        mockConversations.conversations.unshift(convo);
        return convo;
      },
    ),
    createConversation: vi.fn(async (title: string, _projectRoot?: string) => {
      const convo = {
        id: `chat-${mockConversations.conversations.length + 1}`,
        title,
        createdAt: Date.now(),
        selectedModel: "arcee-ai/trinity-large-thinking",
        selectedProvider: null,
        projectRoot: _projectRoot ?? null,
        isArchived: false,
        employeeId: null,
      };
      mockConversations.conversations.unshift(convo);
      return convo;
    }),
    archiveConversation: vi.fn(),
    loadHistory: vi.fn(),
  },
}));

// Mock provider service (listSessions)
const mockBackendSessions: Array<{ id: string }> = [];
vi.mock("@/services/providers", () => ({
  listSessions: vi.fn(async () => mockBackendSessions),
  invokeProvider: vi.fn(),
}));

// Mock ACP store
const mockSessions: Record<
  string,
  {
    conversationId: string;
    info: { id: string; status: string; agentType: string };
  }
> = {};
const mockAgentConversations: Array<{
  id: string;
  title: string;
  created_at: number;
  agent_type: string;
  agent_session_id: string | null;
  agent_cwd: string | null;
  agent_model_id: string | null;
  project_id: string | null;
  project_root: string | null;
  is_archived: boolean;
}> = [];

vi.mock("@/stores/agent.store", () => ({
  agentStore: {
    selectedAgentType: "claude-code",
    get sessions() {
      return mockSessions;
    },
    get recentAgentConversations() {
      return mockAgentConversations;
    },
    setActiveSession: vi.fn(),
    setSelectedAgentType: vi.fn(),
    resumeAgentConversation: vi.fn(),
    terminateSession: vi.fn(),
    spawnSession: vi.fn(),
    refreshRecentAgentConversations: vi.fn(),
  },
  registerActiveNavigationThreadIdGetter: vi.fn(),
}));

// Import after mocks are set up
import { threadStore } from "@/stores/thread.store";
import { setRootPath } from "@/stores/fileTree";
import { conversationStore } from "@/stores/conversation.store";
import { agentStore } from "@/stores/agent.store";
import { type AgentSessionInfo, listSessions } from "@/services/providers";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";

describe("threadStore", () => {
  beforeEach(() => {
    // Reset mock state
    mockConversations.conversations = [];
    mockConversations.activeConversationId = null;
    mockConversations.streamingContent = {};
    mockConversations.loading = {};
    mockFileTreeState.rootPath = "/Users/dev/project-a";
    Object.keys(mockSessions).forEach((k) => delete mockSessions[k]);
    mockAgentConversations.length = 0;
    mockBackendSessions.length = 0;

    // Reset thread store internal state
    threadStore.clear();

    // Keep provider-dependent thread creation deterministic in unit tests.
    providerStore.setActiveProvider("seren");
    providerStore.setActiveModel(AUTO_MODEL_ID);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("allConversations getter", () => {
    it("merges both stores into a single sorted list with explicit kind", () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Chat One",
          createdAt: 1000,
          selectedModel: "gpt-4",
          selectedProvider: "openai",
          projectRoot: "/Users/dev/project-a",
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent One",
        created_at: 2000,
        agent_type: "claude-code",
        agent_session_id: "live-sess",
        agent_cwd: "/Users/dev/project-a",
        agent_model_id: "claude-sonnet-4",
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });

      const all = threadStore.allConversations;
      expect(all).toHaveLength(2);
      // Most recent first.
      expect(all[0].id).toBe("agent-1");
      expect(all[1].id).toBe("chat-1");

      // Discriminator carries through.
      expect(all[0].kind).toBe("agent");
      expect(all[1].kind).toBe("chat");

      // Agent-side fields carry across.
      expect(all[0].agentType).toBe("claude-code");
      expect(all[0].agentSessionId).toBe("live-sess");
      expect(all[0].agentCwd).toBe("/Users/dev/project-a");
      expect(all[0].agentModelId).toBe("claude-sonnet-4");
      expect(all[0].provider).toBe("claude-code");
      expect(all[0].model).toBe("claude-sonnet-4");

      // Chat-side fields carry across; agent-only fields are null.
      expect(all[1].provider).toBe("openai");
      expect(all[1].model).toBe("gpt-4");
      expect(all[1].agentType).toBeNull();
      expect(all[1].agentSessionId).toBeNull();
    });

    it("preserves archived rows so callers can apply their own filters", () => {
      // The `threads` getter filters archives out for the sidebar; the
      // raw `allConversations` view must keep them so other surfaces
      // (history, recovery, audit) can opt in.
      mockConversations.conversations = [
        {
          id: "chat-archived",
          title: "Old",
          createdAt: 100,
          selectedModel: "x",
          selectedProvider: null,
          projectRoot: null,
          isArchived: true,
        },
      ];
      mockAgentConversations.push({
        id: "agent-archived",
        title: "Old agent",
        created_at: 50,
        agent_type: "codex",
        agent_session_id: null,
        agent_cwd: null,
        agent_model_id: null,
        project_id: null,
        project_root: null,
        is_archived: true,
      });

      const all = threadStore.allConversations;
      expect(all.map((c) => c.id).sort()).toEqual([
        "agent-archived",
        "chat-archived",
      ]);
      expect(all.every((c) => c.isArchived)).toBe(true);
    });

    it("findConversation locates rows from either store by id", () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Chat",
          createdAt: 1000,
          selectedModel: "m",
          selectedProvider: "seren",
          projectRoot: null,
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent",
        created_at: 2000,
        agent_type: "claude-code",
        agent_session_id: null,
        agent_cwd: null,
        agent_model_id: null,
        project_id: null,
        project_root: null,
        is_archived: false,
      });

      expect(threadStore.findConversation("chat-1")?.kind).toBe("chat");
      expect(threadStore.findConversation("agent-1")?.kind).toBe("agent");
      expect(threadStore.findConversation("missing")).toBeUndefined();
    });

    it("falls back agent projectRoot to agent_cwd when project_root is null", () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "A",
        created_at: 100,
        agent_type: "codex",
        agent_session_id: null,
        agent_cwd: "/Users/dev/from-cwd",
        agent_model_id: null,
        project_id: null,
        project_root: null,
        is_archived: false,
      });

      const all = threadStore.allConversations;
      expect(all[0].projectRoot).toBe("/Users/dev/from-cwd");
    });
  });

  describe("threads getter", () => {
    it("merges chat and agent conversations sorted by timestamp desc", () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Chat One",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-a",
          isArchived: false,
        },
        {
          id: "chat-2",
          title: "Chat Two",
          createdAt: 3000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-a",
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent One",
        created_at: 2000,
        agent_type: "claude-code",
        agent_session_id: null,
        agent_cwd: "/Users/dev/project-a",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });

      const threads = threadStore.threads;
      expect(threads).toHaveLength(3);
      expect(threads[0].id).toBe("chat-2"); // 3000
      expect(threads[1].id).toBe("agent-1"); // 2000
      expect(threads[2].id).toBe("chat-1"); // 1000
    });

    it("excludes archived conversations", () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Active",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: null,
          isArchived: false,
        },
        {
          id: "chat-2",
          title: "Archived",
          createdAt: 2000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: null,
          isArchived: true,
        },
      ];

      const threads = threadStore.threads;
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe("chat-1");
    });

    it("reflects live session status for agent threads", () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "Running Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-1",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/dev",
        is_archived: false,
      });
      mockSessions["sess-1"] = {
        conversationId: "agent-1",
        info: { id: "sess-1", status: "prompting", agentType: "claude-code" },
      };

      const threads = threadStore.threads;
      expect(threads[0].status).toBe("running");
      expect(threads[0].isLive).toBe(true);
    });

    it("carries chat provider provenance without leaking onto agent threads", () => {
      mockConversations.conversations = [
        {
          id: "chat-public",
          title: "Public chat",
          createdAt: 3000,
          selectedModel: "test",
          selectedProvider: "seren",
          projectRoot: null,
          isArchived: false,
        },
        {
          id: "chat-private",
          title: "Private chat",
          createdAt: 2000,
          selectedModel: "organization/private-model",
          selectedProvider: "seren-private",
          projectRoot: null,
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-codex",
        title: "Codex agent",
        created_at: 1000,
        agent_type: "codex",
        agent_session_id: null,
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/dev",
        is_archived: false,
      });

      const byId = new Map(
        threadStore.threads.map((thread) => [thread.id, thread]),
      );
      expect(byId.get("chat-public")?.provider).toBe("seren");
      expect(byId.get("chat-private")?.provider).toBe("seren-private");
      expect(byId.get("agent-codex")?.provider).toBeUndefined();
      expect(byId.get("agent-codex")?.agentType).toBe("codex");
    });

    // #1915 — Seren chat and Private chat threads must surface the same
    // green active indicator as agent threads. The sidebar renders the
    // indicator whenever `thread.status === "running"`, so chat threads
    // need to map streaming/loading state from conversationStore into
    // `status` instead of being hardcoded as idle.
    it("reflects streaming/loading state for chat threads", () => {
      mockConversations.conversations = [
        {
          id: "chat-streaming",
          title: "Streaming chat",
          createdAt: 3000,
          selectedModel: "test",
          selectedProvider: "seren",
          projectRoot: null,
          isArchived: false,
        },
        {
          id: "chat-loading",
          title: "Private chat waiting for first token",
          createdAt: 2000,
          selectedModel: "test",
          selectedProvider: "seren-private",
          projectRoot: null,
          isArchived: false,
        },
        {
          id: "chat-idle",
          title: "Idle chat",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: "seren",
          projectRoot: null,
          isArchived: false,
        },
      ];
      mockConversations.streamingContent["chat-streaming"] = "partial tokens";
      mockConversations.loading["chat-loading"] = true;

      const threads = threadStore.threads;
      const byId = new Map(threads.map((t) => [t.id, t]));
      expect(byId.get("chat-streaming")?.status).toBe("running");
      expect(byId.get("chat-loading")?.status).toBe("running");
      expect(byId.get("chat-idle")?.status).toBe("idle");
    });
  });

  describe("groupedThreads getter", () => {
    it("groups current project first, then others, then ungrouped", () => {
      mockConversations.conversations = [
        {
          id: "c-a",
          title: "Project A",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-a",
          isArchived: false,
        },
        {
          id: "c-b",
          title: "Project B",
          createdAt: 2000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-b",
          isArchived: false,
        },
        {
          id: "c-none",
          title: "No Project",
          createdAt: 3000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: null,
          isArchived: false,
        },
      ];

      const groups = threadStore.groupedThreads;
      expect(groups).toHaveLength(3);
      // Sorted by max thread timestamp (project-b=2000, project-a=1000),
      // not by currentRoot. Clicking a thread no longer reorders the list.
      expect(groups[0].projectRoot).toBe("/Users/dev/project-b");
      expect(groups[1].projectRoot).toBe("/Users/dev/project-a");
      // Ungrouped pinned to bottom regardless of timestamp.
      expect(groups[2].projectRoot).toBeNull();
      expect(groups[2].folderName).toBe("No project");
    });

    // #2093 — Closing a thread inside a folder must not push that folder
    // down the sidebar. The folder's sort key is anchored by the last
    // time the user *selected into* it, not by the max creation time of
    // its surviving open threads.
    it("keeps a folder in place after its newest thread is closed", () => {
      mockConversations.conversations = [
        {
          id: "x-old",
          title: "Older in X",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-x",
          isArchived: false,
        },
        {
          id: "x-new",
          title: "Newest in X (about to close)",
          createdAt: 3000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-x",
          isArchived: false,
        },
        {
          id: "y-thread",
          title: "Only thread in Y",
          createdAt: 2000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-y",
          isArchived: false,
        },
      ];

      // User worked in X most recently — that activity anchors the folder.
      threadStore.noteFolderActivity("/Users/dev/project-x", 5000);
      threadStore.noteFolderActivity("/Users/dev/project-y", 4000);

      const before = threadStore.groupedThreads.map((g) => g.projectRoot);
      expect(before).toEqual([
        "/Users/dev/project-x",
        "/Users/dev/project-y",
      ]);

      // Close the newest thread in X (this is the bug repro: pre-fix the
      // sort fell back to max(remaining createdAt) = 1000, dropping X
      // below Y).
      mockConversations.conversations = mockConversations.conversations.filter(
        (c) => c.id !== "x-new",
      );

      const after = threadStore.groupedThreads.map((g) => g.projectRoot);
      expect(after).toEqual([
        "/Users/dev/project-x",
        "/Users/dev/project-y",
      ]);
    });

    // #2093 — Folders that contain a running thread are pinned above
    // idle folders so an active agent always tells the user where their
    // work is happening, even when an idle folder has a newer recorded
    // activity timestamp.
    it("pins folders with running threads above idle folders", () => {
      mockConversations.conversations = [
        {
          id: "idle-recent",
          title: "Idle but most-recent activity",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-idle",
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-running",
        title: "Running agent in another folder",
        created_at: 500,
        agent_type: "claude-code",
        agent_session_id: "sess-running",
        agent_cwd: "/Users/dev/project-running",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-running",
        is_archived: false,
      });
      mockSessions["sess-running"] = {
        conversationId: "agent-running",
        info: {
          id: "sess-running",
          status: "prompting",
          agentType: "claude-code",
        },
      };

      // Idle folder has the more-recent recorded activity timestamp.
      threadStore.noteFolderActivity("/Users/dev/project-idle", 9000);
      threadStore.noteFolderActivity("/Users/dev/project-running", 1000);

      const order = threadStore.groupedThreads.map((g) => g.projectRoot);
      expect(order).toEqual([
        "/Users/dev/project-running",
        "/Users/dev/project-idle",
      ]);
    });
  });

  describe("selectThread", () => {
    it("selects a chat thread and delegates to conversationStore", () => {
      threadStore.selectThread("chat-1", "chat");

      expect(threadStore.activeThreadId).toBe("chat-1");
      expect(threadStore.activeThreadKind).toBe("chat");
      expect(conversationStore.setActiveConversation).toHaveBeenCalledWith(
        "chat-1",
      );
    });

    it("selects an agent thread with live session", async () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-1",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });
      mockSessions["sess-1"] = {
        conversationId: "agent-1",
        info: { id: "sess-1", status: "ready", agentType: "claude-code" },
      };
      // Backend confirms session is alive
      mockBackendSessions.push({ id: "sess-1" });

      threadStore.selectThread("agent-1", "agent");
      // Wait for async listSessions check
      await vi.waitFor(() => {
        expect(agentStore.setActiveSession).toHaveBeenCalledWith("sess-1");
      });

      expect(threadStore.activeThreadKind).toBe("agent");
    });

    // #1852 — Without synchronous active marking, a parallel spawn's
    // preemptive idle-reclaim runs against state.activeSessionId from the
    // *previous* thread and kills the just-clicked session before
    // listSessions resolves.
    it("marks live agent session active synchronously, before listSessions resolves", () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-1",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });
      mockSessions["sess-1"] = {
        conversationId: "agent-1",
        info: { id: "sess-1", status: "ready", agentType: "claude-code" },
      };

      vi.mocked(listSessions).mockImplementationOnce(
        () => new Promise<AgentSessionInfo[]>(() => {}),
      );

      threadStore.selectThread("agent-1", "agent");

      expect(agentStore.setActiveSession).toHaveBeenCalledWith("sess-1");
    });

    it("ignores stale session checks after switching threads", async () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Chat One",
          createdAt: 2000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-a",
          isArchived: false,
        },
      ];
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-1",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });
      mockSessions["sess-1"] = {
        conversationId: "agent-1",
        info: { id: "sess-1", status: "ready", agentType: "claude-code" },
      };

      let resolveBackendSessions:
        | ((value: AgentSessionInfo[]) => void)
        | undefined;
      vi.mocked(listSessions).mockImplementationOnce(
        () =>
          new Promise<AgentSessionInfo[]>((resolve) => {
            resolveBackendSessions = resolve;
          }),
      );

      threadStore.selectThread("agent-1", "agent");
      // Synchronous active marking from #1852 — captured here so we can
      // distinguish it from any (unwanted) call made by the late resolution.
      const callsAfterAgentClick = vi.mocked(agentStore.setActiveSession).mock
        .calls.length;
      threadStore.selectThread("chat-1", "chat");
      resolveBackendSessions?.([
        {
          id: "sess-1",
          agentType: "claude-code",
          cwd: "/test",
          status: "ready",
          createdAt: new Date().toISOString(),
        },
      ]);

      await vi.waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(1);
      });

      expect(threadStore.activeThreadId).toBe("chat-1");
      expect(threadStore.activeThreadKind).toBe("chat");
      expect(conversationStore.setActiveConversation).toHaveBeenCalledWith(
        "chat-1",
      );
      // The late listSessions resolution must not fire any further
      // setActiveSession call — the early-return at the top of the
      // resolution block enforces that. #1852.
      expect(vi.mocked(agentStore.setActiveSession).mock.calls.length).toBe(
        callsAfterAgentClick,
      );
      expect(agentStore.resumeAgentConversation).not.toHaveBeenCalled();
    });

    it("resumes stale session not present in backend", async () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-1",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });
      mockSessions["sess-1"] = {
        conversationId: "agent-1",
        info: { id: "sess-1", status: "ready", agentType: "claude-code" },
      };
      // Backend does NOT have this session (stale after restart)
      // mockBackendSessions is empty

      threadStore.selectThread("agent-1", "agent");
      // Wait for async listSessions check to trigger resume
      await vi.waitFor(() => {
        expect(agentStore.terminateSession).toHaveBeenCalledWith("sess-1");
      });

      expect(agentStore.resumeAgentConversation).toHaveBeenCalledWith(
        "agent-1",
        "/Users/dev/project-a",
      );
    });

    it("auto-resumes agent thread without live session", () => {
      mockAgentConversations.push({
        id: "agent-1",
        title: "Old Agent",
        created_at: 1000,
        agent_type: "claude-code",
        agent_session_id: "sess-old",
        agent_cwd: "/dev",
        agent_model_id: null,
        project_id: null,
        project_root: "/Users/dev/project-a",
        is_archived: false,
      });
      // No live session in mockSessions

      threadStore.selectThread("agent-1", "agent");

      expect(agentStore.setActiveSession).toHaveBeenCalledWith(null);
      expect(agentStore.resumeAgentConversation).toHaveBeenCalledWith(
        "agent-1",
        "/Users/dev/project-a",
      );
    });

    it("updates project root when thread has different project", () => {
      mockConversations.conversations = [
        {
          id: "chat-1",
          title: "Other Project",
          createdAt: 1000,
          selectedModel: "test",
          selectedProvider: null,
          projectRoot: "/Users/dev/project-b",
          isArchived: false,
        },
      ];

      threadStore.selectThread("chat-1", "chat");

      expect(setRootPath).toHaveBeenCalledWith("/Users/dev/project-b");
    });
  });

  describe("createChatThread", () => {
    it("creates conversation with project root and selects it", async () => {
      const id = await threadStore.createChatThread("My Chat");

      expect(conversationStore.createConversationWithModel).toHaveBeenCalledWith(
        "My Chat",
        "auto",
        "/Users/dev/project-a",
        "seren",
        null,
      );
      expect(id).toBe("chat-1");
      expect(threadStore.activeThreadId).toBe("chat-1");
      expect(threadStore.activeThreadKind).toBe("chat");
    });

    it("creates private chat with the private provider binding", async () => {
      const id = await threadStore.createChatThreadWithOptions("Private", {
        provider: "seren-private",
        model: "organization/private-model",
      });

      expect(conversationStore.createConversationWithModel).toHaveBeenCalledWith(
        "Private",
        "organization/private-model",
        "/Users/dev/project-a",
        "seren-private",
        null,
      );
      expect(id).toBe("chat-1");
      expect(threadStore.activeThreadId).toBe("chat-1");
      expect(threadStore.activeThreadKind).toBe("chat");
    });

    it("uses an explicit project root when creating from another thread context", async () => {
      mockFileTreeState.rootPath = "/Users/dev/global-project";

      const id = await threadStore.createChatThreadWithOptions("Bounty", {
        provider: "seren",
        model: "auto",
        projectRoot: "/Users/dev/source-thread-project",
      });

      expect(conversationStore.createConversationWithModel).toHaveBeenCalledWith(
        "Bounty",
        "auto",
        "/Users/dev/source-thread-project",
        "seren",
        null,
      );
      expect(mockConversations.conversations[0]?.projectRoot).toBe(
        "/Users/dev/source-thread-project",
      );
      expect(id).toBe("chat-1");
    });
  });

  describe("archiveThread", () => {
    it("clears selection when archiving active thread", async () => {
      threadStore.selectThread("chat-1", "chat");
      await threadStore.archiveThread("chat-1", "chat");

      expect(conversationStore.archiveConversation).toHaveBeenCalledWith(
        "chat-1",
      );
      expect(threadStore.activeThreadId).toBeNull();
      expect(threadStore.activeThreadKind).toBeNull();
    });

    it("preserves selection when archiving non-active thread", async () => {
      threadStore.selectThread("chat-1", "chat");
      await threadStore.archiveThread("chat-2", "chat");

      expect(threadStore.activeThreadId).toBe("chat-1");
    });
  });

  describe("clear", () => {
    it("resets all state", () => {
      threadStore.selectThread("chat-1", "chat");
      threadStore.clear();

      expect(threadStore.activeThreadId).toBeNull();
      expect(threadStore.activeThreadKind).toBeNull();
    });
  });

  describe("runningCount", () => {
    it("counts threads with running status", () => {
      mockAgentConversations.push(
        {
          id: "agent-1",
          title: "Running",
          created_at: 1000,
          agent_type: "claude-code",
          agent_session_id: "s1",
          agent_cwd: "/dev",
          agent_model_id: null,
          project_id: null,
          project_root: "/dev",
          is_archived: false,
        },
        {
          id: "agent-2",
          title: "Idle",
          created_at: 2000,
          agent_type: "claude-code",
          agent_session_id: "s2",
          agent_cwd: "/dev",
          agent_model_id: null,
          project_id: null,
          project_root: "/dev",
          is_archived: false,
        },
      );
      mockSessions["s1"] = {
        conversationId: "agent-1",
        info: { id: "s1", status: "prompting", agentType: "claude-code" },
      };
      mockSessions["s2"] = {
        conversationId: "agent-2",
        info: { id: "s2", status: "ready", agentType: "claude-code" },
      };

      expect(threadStore.runningCount).toBe(1);
    });
  });

});
