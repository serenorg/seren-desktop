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
    selectedProvider: null;
    projectRoot: string | null;
    isArchived: boolean;
  }>,
  activeConversationId: null as string | null,
};

vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    get conversations() {
      return mockConversations.conversations;
    },
    get activeConversationId() {
      return mockConversations.activeConversationId;
    },
    setActiveConversation: vi.fn((id: string | null) => {
      mockConversations.activeConversationId = id;
    }),
    createConversation: vi.fn(async (title: string, _projectRoot?: string) => {
      const convo = {
        id: `chat-${mockConversations.conversations.length + 1}`,
        title,
        createdAt: Date.now(),
        selectedModel: "anthropic/claude-sonnet-4",
        selectedProvider: null,
        projectRoot: _projectRoot ?? null,
        isArchived: false,
      };
      mockConversations.conversations.unshift(convo);
      return convo;
    }),
    archiveConversation: vi.fn(),
    loadHistory: vi.fn(),
  },
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

vi.mock("@/stores/acp.store", () => ({
  acpStore: {
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
    spawnSession: vi.fn(),
    refreshRecentAgentConversations: vi.fn(),
  },
}));

// Import after mocks are set up
import { threadStore } from "@/stores/thread.store";
import { setRootPath } from "@/stores/fileTree";
import { conversationStore } from "@/stores/conversation.store";
import { acpStore } from "@/stores/acp.store";

describe("threadStore", () => {
  beforeEach(() => {
    // Reset mock state
    mockConversations.conversations = [];
    mockConversations.activeConversationId = null;
    mockFileTreeState.rootPath = "/Users/dev/project-a";
    Object.keys(mockSessions).forEach((k) => delete mockSessions[k]);
    mockAgentConversations.length = 0;

    // Reset thread store internal state
    threadStore.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
      // Current project first
      expect(groups[0].projectRoot).toBe("/Users/dev/project-a");
      // Other projects next
      expect(groups[1].projectRoot).toBe("/Users/dev/project-b");
      // Ungrouped last
      expect(groups[2].projectRoot).toBeNull();
      expect(groups[2].folderName).toBe("No project");
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

    it("selects an agent thread with live session", () => {
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

      threadStore.selectThread("agent-1", "agent");

      expect(threadStore.activeThreadKind).toBe("agent");
      expect(acpStore.setActiveSession).toHaveBeenCalledWith("sess-1");
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

      expect(acpStore.setActiveSession).toHaveBeenCalledWith(null);
      expect(acpStore.resumeAgentConversation).toHaveBeenCalledWith(
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

      expect(conversationStore.createConversation).toHaveBeenCalledWith(
        "My Chat",
        "/Users/dev/project-a",
      );
      expect(id).toBe("chat-1");
      expect(threadStore.activeThreadId).toBe("chat-1");
      expect(threadStore.activeThreadKind).toBe("chat");
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
