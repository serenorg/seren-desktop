// ABOUTME: Tests for the per-thread provider-runtime switching service.
// ABOUTME: Verifies the safe-turn-boundary guard and the in-memory sync.

import { beforeEach, describe, expect, it, vi } from "vitest";

const switchThreadProviderBridge = vi.hoisted(() => vi.fn());
type RuntimeRow = {
  thread_id: string;
  provider: string;
  model: string | null;
  native_session_id: string | null;
  resume_cursor_json: string | null;
  status: string;
  bootstrap_context: string | null;
  updated_at: number;
};
const getProviderSessionRuntimeBridge = vi.hoisted(() =>
  vi.fn<(threadId: string) => Promise<RuntimeRow | null>>(async () => null),
);
type TestMessage = {
  id: string;
  role: "user" | "assistant";
  type?: string;
  content: string;
  timestamp: number;
  provider?: string;
};
type TestAgentMessage = {
  id: string;
  type: "user" | "assistant" | "thought" | "tool" | "diff" | "error";
  content: string;
  timestamp: number;
  provider?: string;
};
const conversationStoreMock = vi.hoisted(() => ({
  activeConversationId: null as string | null,
  conversations: [] as Array<{
    id: string;
    title: string;
    createdAt: number;
    selectedModel: string;
    selectedProvider: string | null;
    projectRoot: string | null;
    isArchived: boolean;
    employeeId: string | null;
  }>,
  getLoadingFor: vi.fn(() => false),
  getStreamingContentFor: vi.fn(() => ""),
  getRLMProcessingFor: vi.fn(() => false),
  getMessagesFor: vi.fn(() => [] as TestMessage[]),
  applyRuntimeBindingSync: vi.fn(),
  dropFromCache: vi.fn(),
  upsertFromDb: vi.fn(),
  loadMessagesFor: vi.fn(async (_id: string) => {}),
}));
const chatStoreMock = vi.hoisted(() => ({
  messages: [] as TestMessage[],
  activeConversationId: null as string | null,
  isCompacting: false,
  retryingMessageId: null as string | null,
  getMessagesFor: vi.fn((_id: string) => [] as TestMessage[]),
  applyRuntimeBindingSync: vi.fn(),
}));
const providerStoreMock = vi.hoisted(() => ({
  setActiveProvider: vi.fn(),
  setActiveModel: vi.fn(),
}));
const agentStoreMock = vi.hoisted(() => ({
  recentAgentConversations: [] as Array<{
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
  }>,
  sessions: {} as Record<
    string,
    {
      info: { id: string };
      conversationId: string;
      streamingContent?: string;
      streamingThinking?: string;
    }
  >,
  getSessionForConversation: vi.fn((conversationId: string) =>
    Object.values(agentStoreMock.sessions).find(
      (session) => session.conversationId === conversationId,
    ),
  ),
  getMessagesForConversation: vi.fn(
    (_conversationId: string) => [] as TestAgentMessage[],
  ),
  isTurnInFlight: vi.fn(() => false),
  hasPendingApprovals: vi.fn(() => false),
  spawnSession: vi.fn(async () => "new-session-id"),
  terminateSession: vi.fn(async () => {}),
  dropAgentConversationFromCache: vi.fn(),
  upsertAgentConversationFromDb: vi.fn(),
}));
const fileTreeStateMock = vi.hoisted(() => ({
  rootPath: null as string | null,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  switchThreadProvider: switchThreadProviderBridge,
  getProviderSessionRuntime: getProviderSessionRuntimeBridge,
  getAgentConversation: vi.fn(async () => null),
  getConversation: vi.fn(async () => null),
}));
vi.mock("@/stores/conversation.store", () => ({
  conversationStore: conversationStoreMock,
}));
vi.mock("@/stores/chat.store", () => ({
  chatStore: chatStoreMock,
}));
vi.mock("@/stores/provider.store", () => ({
  providerStore: providerStoreMock,
}));
vi.mock("@/stores/agent.store", () => ({
  agentStore: agentStoreMock,
}));
vi.mock("@/stores/fileTree", () => ({
  fileTreeState: fileTreeStateMock,
}));
// threadStore.findConversation re-collects from the two underlying
// stores. The real merge logic is tested separately in
// thread-store.test.ts; here we just need a working surface.
vi.mock("@/stores/thread.store", () => ({
  threadStore: {
    findConversation: vi.fn((id: string) => {
      const chat = conversationStoreMock.conversations.find((c) => c.id === id);
      if (chat) {
        return {
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          kind: "chat" as const,
          projectRoot: chat.projectRoot,
          isArchived: chat.isArchived,
          provider: chat.selectedProvider,
          model: chat.selectedModel,
          employeeId: chat.employeeId,
          agentType: null,
          agentSessionId: null,
          agentCwd: null,
          agentModelId: null,
        };
      }
      const agent = agentStoreMock.recentAgentConversations.find(
        (a) => a.id === id,
      );
      if (agent) {
        return {
          id: agent.id,
          title: agent.title,
          createdAt: agent.created_at,
          kind: "agent" as const,
          projectRoot: agent.project_root ?? agent.agent_cwd ?? null,
          isArchived: agent.is_archived,
          provider: agent.agent_type,
          model: agent.agent_model_id,
          employeeId: null,
          agentType: agent.agent_type,
          agentSessionId: agent.agent_session_id,
          agentCwd: agent.agent_cwd,
          agentModelId: agent.agent_model_id,
        };
      }
      return undefined;
    }),
  },
}));

import {
  evaluateChatSwitchGuard,
  switchChatProvider,
} from "@/services/provider-bindings";

beforeEach(() => {
  vi.clearAllMocks();
  conversationStoreMock.activeConversationId = null;
  conversationStoreMock.conversations = [];
  conversationStoreMock.getLoadingFor.mockReturnValue(false);
  conversationStoreMock.getStreamingContentFor.mockReturnValue("");
  conversationStoreMock.getRLMProcessingFor.mockReturnValue(false);
  conversationStoreMock.getMessagesFor.mockReturnValue([]);
  chatStoreMock.isCompacting = false;
  chatStoreMock.retryingMessageId = null;
  chatStoreMock.activeConversationId = null;
  chatStoreMock.getMessagesFor.mockReturnValue([]);
  agentStoreMock.recentAgentConversations = [];
  agentStoreMock.sessions = {};
  agentStoreMock.getSessionForConversation.mockImplementation(
    (conversationId: string) =>
      Object.values(agentStoreMock.sessions).find(
        (session) => session.conversationId === conversationId,
      ),
  );
  agentStoreMock.getMessagesForConversation.mockReturnValue([]);
  agentStoreMock.isTurnInFlight.mockReturnValue(false);
  agentStoreMock.hasPendingApprovals.mockReturnValue(false);
  fileTreeStateMock.rootPath = null;
  getProviderSessionRuntimeBridge.mockResolvedValue(null);
});

describe("evaluateChatSwitchGuard", () => {
  it("returns null when the thread is idle", () => {
    expect(evaluateChatSwitchGuard("t1")).toBeNull();
  });

  it("blocks when there is no active thread id", () => {
    expect(evaluateChatSwitchGuard("")).toEqual({ kind: "no-active-thread" });
  });

  it("blocks while the thread is loading a turn", () => {
    conversationStoreMock.getLoadingFor.mockReturnValueOnce(true);
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "loading" });
  });

  it("blocks while the thread has streaming content in flight", () => {
    conversationStoreMock.getStreamingContentFor.mockReturnValueOnce("partial");
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "streaming" });
  });

  it("blocks while RLM is processing for the thread", () => {
    conversationStoreMock.getRLMProcessingFor.mockReturnValueOnce(true);
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "rlm-processing" });
  });

  it("blocks while the active thread is being compacted", () => {
    chatStoreMock.activeConversationId = "t1";
    chatStoreMock.isCompacting = true;
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "compacting" });
  });

  it("blocks while a message retry is in flight on the active thread", () => {
    chatStoreMock.activeConversationId = "t1";
    chatStoreMock.retryingMessageId = "m1";
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "retrying" });
  });

  it("ignores chatStore busy flags for non-active threads (multi-pane)", () => {
    chatStoreMock.activeConversationId = "t-other";
    chatStoreMock.isCompacting = true;
    chatStoreMock.retryingMessageId = "m1";
    expect(evaluateChatSwitchGuard("t1")).toBeNull();
  });

  it("blocks while a native-agent turn is in flight", () => {
    agentStoreMock.isTurnInFlight.mockReturnValueOnce(true);
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "agent-turn" });
  });

  it("blocks while a native-agent stream buffer is non-empty", () => {
    agentStoreMock.sessions = {
      "agent-session": {
        info: { id: "agent-session" },
        conversationId: "t1",
        streamingContent: "partial",
      },
    };
    expect(evaluateChatSwitchGuard("t1")).toEqual({ kind: "agent-turn" });
  });

  it("blocks while native-agent approvals are pending", () => {
    agentStoreMock.hasPendingApprovals.mockReturnValueOnce(true);
    expect(evaluateChatSwitchGuard("t1")).toEqual({
      kind: "agent-approval",
    });
  });
});

describe("switchChatProvider", () => {
  it("invokes the Rust bridge and syncs in-memory caches on success", async () => {
    chatStoreMock.activeConversationId = "t1";
    const runtimeRow = {
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 1000,
    };
    switchThreadProviderBridge.mockResolvedValueOnce(runtimeRow);

    const result = await switchChatProvider("t1", "seren-private", "private-mid");

    expect(switchThreadProviderBridge).toHaveBeenCalledWith(
      "t1",
      "seren-private",
      "private-mid",
      null,
      null,
      null,
    );
    expect(conversationStoreMock.applyRuntimeBindingSync).toHaveBeenCalledWith(
      "t1",
      "seren-private",
      "private-mid",
    );
    expect(chatStoreMock.applyRuntimeBindingSync).toHaveBeenCalledWith(
      "t1",
      "seren-private",
      "private-mid",
    );
    expect(providerStoreMock.setActiveProvider).toHaveBeenCalledWith(
      "seren-private",
    );
    expect(providerStoreMock.setActiveModel).toHaveBeenCalledWith(
      "private-mid",
    );
    expect(result.runtime).toBe(runtimeRow);
  });

  it("does not mutate the global picker when switching a non-active thread", async () => {
    chatStoreMock.activeConversationId = "t-other";
    conversationStoreMock.activeConversationId = "t-other";
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 1000,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    expect(providerStoreMock.setActiveProvider).not.toHaveBeenCalled();
    expect(providerStoreMock.setActiveModel).not.toHaveBeenCalled();
  });

  it("syncs the visible picker when only conversationStore marks the thread active", async () => {
    conversationStoreMock.activeConversationId = "t1";
    chatStoreMock.activeConversationId = null;
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 1000,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    expect(providerStoreMock.setActiveProvider).toHaveBeenCalledWith(
      "seren-private",
    );
    expect(providerStoreMock.setActiveModel).toHaveBeenCalledWith(
      "private-mid",
    );
  });

  it("refuses to switch while the thread is busy", async () => {
    conversationStoreMock.getStreamingContentFor.mockReturnValueOnce("partial");

    await expect(
      switchChatProvider("t1", "seren-private", "m"),
    ).rejects.toThrow(/switch provider while thread is streaming/);
    expect(switchThreadProviderBridge).not.toHaveBeenCalled();
  });

  it("builds and forwards a deterministic bootstrap when switching to a native agent", async () => {
    conversationStoreMock.getMessagesFor.mockReturnValue([
      {
        id: "m1",
        role: "user",
        content: "what is the eu capital",
        timestamp: 1000,
      },
      {
        id: "m2",
        role: "assistant",
        content: "Brussels for the EU institutions.",
        timestamp: 1001,
      },
    ]);
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "claude-code",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: "stub",
      updated_at: 2000,
    });

    await switchChatProvider("t1", "claude-code", "claude-sonnet-4");

    const [, , , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
    expect(typeof bootstrap).toBe("string");
    expect(bootstrap).toContain("[USER]: what is the eu capital");
    expect(bootstrap).toContain("[ASSISTANT]: Brussels for the EU institutions.");
  });

  it("merges chat-store messages for non-active threads (multi-pane)", async () => {
    // Switch is fired on a thread that is NOT the active chat-store
    // conversation. The collector must still read chatStore via
    // getMessagesFor(threadId) instead of falling back to the active id.
    chatStoreMock.activeConversationId = "t-other";
    chatStoreMock.getMessagesFor.mockImplementation((id: string) =>
      id === "t1"
        ? [
            {
              id: "c1",
              role: "user",
              content: "only-in-chat-store",
              timestamp: 1500,
            },
          ]
        : [],
    );
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "claude-code",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: "stub",
      updated_at: 2000,
    });

    await switchChatProvider("t1", "claude-code", "claude-sonnet-4");

    const [, , , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
    expect(bootstrap).toContain("[USER]: only-in-chat-store");
  });

  it("does not send a bootstrap when the new binding is another chat provider", async () => {
    conversationStoreMock.getMessagesFor.mockReturnValue([
      { id: "m1", role: "user", content: "hi", timestamp: 1000 },
    ]);
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 2000,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    const [, , , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
    expect(bootstrap).toBeNull();
  });

  it("passes the current runtime updated_at as the optimistic-concurrency token", async () => {
    // Mid-conversation switch: the existing runtime row was last written
    // at updated_at=4242, so we must pass that as the expected token so
    // the Rust command can reject if a peer window has rewritten it.
    getProviderSessionRuntimeBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 4242,
    });
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 5555,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    expect(getProviderSessionRuntimeBridge).toHaveBeenCalledWith("t1");
    expect(switchThreadProviderBridge).toHaveBeenCalledWith(
      "t1",
      "seren-private",
      "private-mid",
      null,
      null,
      4242,
    );
  });

  it("passes null expected_updated_at on a first-time switch (no runtime row yet)", async () => {
    getProviderSessionRuntimeBridge.mockResolvedValueOnce(null);
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 1000,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    expect(switchThreadProviderBridge).toHaveBeenCalledWith(
      "t1",
      "seren-private",
      "private-mid",
      null,
      null,
      null,
    );
  });

  it("moves the row from the chat cache and spawns an agent session on chat→agent", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    conversationStoreMock.getMessagesFor.mockReturnValue([
      {
        id: "m1",
        role: "user",
        content: "start here",
        timestamp: 1000,
      },
      {
        id: "tool-1",
        role: "assistant",
        type: "tool_call",
        content: "tool internals",
        timestamp: 1001,
      },
      {
        id: "m2",
        role: "assistant",
        type: "assistant",
        content: "prior answer",
        timestamp: 1002,
        provider: "seren",
      },
    ]);
    conversationStoreMock.conversations = [
      {
        id: "t1",
        title: "My thread",
        createdAt: 100,
        selectedModel: "claude-sonnet-4",
        selectedProvider: "seren",
        projectRoot: "/Users/dev/my-project",
        isArchived: false,
        employeeId: null,
      },
    ];
    fileTreeStateMock.rootPath = "/Users/dev/fallback";
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "claude-code",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: "previous transcript here",
      updated_at: 5000,
    });
    vi.mocked(bridge.getAgentConversation).mockResolvedValueOnce({
      id: "t1",
      title: "My thread",
      created_at: 100,
      agent_type: "claude-code",
      agent_session_id: null,
      agent_cwd: "/Users/dev/my-project",
      agent_model_id: "claude-sonnet-4",
      agent_permission_mode: null,
      agent_metadata: null,
      project_id: null,
      project_root: "/Users/dev/my-project",
      is_archived: false,
    });

    await switchChatProvider("t1", "claude-code", "claude-sonnet-4");

    // Bridge received the resolved cwd so the Rust mirror could stamp
    // `conversations.agent_cwd` atomically with the kind flip.
    const [, , , targetCwd] = switchThreadProviderBridge.mock.calls[0];
    expect(targetCwd).toBe("/Users/dev/my-project");

    // Chat cache dropped the row so the unified view can re-resolve.
    expect(conversationStoreMock.dropFromCache).toHaveBeenCalledWith("t1");
    // Agent cache picked up the fresh DB row.
    expect(agentStoreMock.upsertAgentConversationFromDb).toHaveBeenCalledTimes(1);
    // Spawn fired with the prior chat thread's projectRoot as cwd and
    // the persisted bootstrap context.
    expect(agentStoreMock.spawnSession).toHaveBeenCalledWith(
      "/Users/dev/my-project",
      "claude-code",
      expect.objectContaining({
        bootstrapPromptContext: "previous transcript here",
        conversationTitle: "My thread",
        localSessionId: "t1",
        restoredMessages: [
          {
            id: "m1",
            type: "user",
            content: "start here",
            timestamp: 1000,
            provider: undefined,
          },
          {
            id: "m2",
            type: "assistant",
            content: "prior answer",
            timestamp: 1002,
            provider: "seren",
          },
        ],
      }),
    );
  });

  it("keeps the chat cache intact when the agent row cannot be prefetched", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    conversationStoreMock.conversations = [
      {
        id: "t1",
        title: "My thread",
        createdAt: 100,
        selectedModel: "claude-sonnet-4",
        selectedProvider: "seren",
        projectRoot: "/Users/dev/my-project",
        isArchived: false,
        employeeId: null,
      },
    ];
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "claude-code",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: "previous transcript here",
      updated_at: 5000,
    });
    vi.mocked(bridge.getAgentConversation).mockRejectedValueOnce(
      new Error("DB unreachable"),
    );

    await switchChatProvider("t1", "claude-code", "claude-sonnet-4");

    expect(conversationStoreMock.dropFromCache).not.toHaveBeenCalled();
    expect(agentStoreMock.upsertAgentConversationFromDb).not.toHaveBeenCalled();
    expect(agentStoreMock.spawnSession).not.toHaveBeenCalled();
  });

  it("tears down the live native session and surfaces the chat row on agent→chat", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    agentStoreMock.recentAgentConversations = [
      {
        id: "t1",
        title: "My agent",
        created_at: 100,
        agent_type: "claude-code",
        agent_session_id: "remote-sess",
        agent_cwd: "/Users/dev/my-project",
        agent_model_id: "claude-sonnet-4",
        project_id: null,
        project_root: "/Users/dev/my-project",
        is_archived: false,
      },
    ];
    agentStoreMock.sessions = {
      "live-1": {
        info: { id: "live-1" },
        conversationId: "t1",
      },
    };
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 6000,
    });
    vi.mocked(bridge.getConversation).mockResolvedValueOnce({
      id: "t1",
      title: "My agent",
      created_at: 100,
      selected_model: "claude-sonnet-4",
      selected_provider: "seren",
      project_root: "/Users/dev/my-project",
      is_archived: false,
      employee_id: null,
    });

    await switchChatProvider("t1", "seren", "claude-sonnet-4");

    expect(agentStoreMock.terminateSession).toHaveBeenCalledWith(
      "live-1",
      expect.objectContaining({ nextActiveSessionId: null }),
    );
    expect(agentStoreMock.dropAgentConversationFromCache).toHaveBeenCalledWith(
      "t1",
    );
    expect(conversationStoreMock.upsertFromDb).toHaveBeenCalledTimes(1);
    // Pre-hydrate the chat shell so the prior agent transcript is
    // visible immediately instead of an empty pane.
    expect(conversationStoreMock.loadMessagesFor).toHaveBeenCalledWith("t1");
    // No spawn on agent→chat — chat threads route through the
    // orchestrator, not a native session.
    expect(agentStoreMock.spawnSession).not.toHaveBeenCalled();
  });

  it("keeps the agent cache intact when the chat row cannot be prefetched", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    agentStoreMock.recentAgentConversations = [
      {
        id: "t1",
        title: "My agent",
        created_at: 100,
        agent_type: "claude-code",
        agent_session_id: "remote-sess",
        agent_cwd: "/Users/dev/my-project",
        agent_model_id: "claude-sonnet-4",
        project_id: null,
        project_root: "/Users/dev/my-project",
        is_archived: false,
      },
    ];
    agentStoreMock.sessions = {
      "live-1": {
        info: { id: "live-1" },
        conversationId: "t1",
      },
    };
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 6000,
    });
    vi.mocked(bridge.getConversation).mockRejectedValueOnce(
      new Error("DB unreachable"),
    );

    await expect(
      switchChatProvider("t1", "seren", "claude-sonnet-4"),
    ).resolves.toBeDefined();

    expect(agentStoreMock.terminateSession).not.toHaveBeenCalled();
    expect(agentStoreMock.dropAgentConversationFromCache).not.toHaveBeenCalled();
    expect(conversationStoreMock.upsertFromDb).not.toHaveBeenCalled();
    expect(conversationStoreMock.loadMessagesFor).not.toHaveBeenCalled();
  });

  it("tears down and respawns on same-category agent provider switches", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    agentStoreMock.recentAgentConversations = [
      {
        id: "t1",
        title: "My agent",
        created_at: 100,
        agent_type: "codex",
        agent_session_id: "codex-remote",
        agent_cwd: "/Users/dev/my-project",
        agent_model_id: "gpt-5.1-codex",
        project_id: null,
        project_root: "/Users/dev/my-project",
        is_archived: false,
      },
    ];
    agentStoreMock.sessions = {
      "live-codex": {
        info: { id: "live-codex" },
        conversationId: "t1",
      },
    };
    agentStoreMock.getMessagesForConversation.mockReturnValue([
      {
        id: "a1",
        type: "user",
        content: "continue this work",
        timestamp: 1000,
      },
      {
        id: "tool-1",
        type: "tool",
        content: "tool internals",
        timestamp: 1001,
      },
      {
        id: "a2",
        type: "assistant",
        content: "prior agent answer",
        timestamp: 1002,
        provider: "codex",
      },
    ]);
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "claude-code",
      model: null,
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: "agent transcript here",
      updated_at: 7000,
    });
    vi.mocked(bridge.getAgentConversation).mockResolvedValueOnce({
      id: "t1",
      title: "My agent",
      created_at: 100,
      agent_type: "claude-code",
      agent_session_id: null,
      agent_cwd: "/Users/dev/my-project",
      agent_model_id: "gpt-5.1-codex",
      agent_permission_mode: null,
      agent_metadata: null,
      project_id: null,
      project_root: "/Users/dev/my-project",
      is_archived: false,
    });

    await switchChatProvider("t1", "claude-code", null);

    const [, , , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
    expect(bootstrap).toContain("[USER]: continue this work");
    expect(bootstrap).toContain("[ASSISTANT]: prior agent answer");
    expect(agentStoreMock.terminateSession).toHaveBeenCalledWith(
      "live-codex",
      expect.objectContaining({ nextActiveSessionId: null }),
    );
    expect(agentStoreMock.upsertAgentConversationFromDb).toHaveBeenCalledTimes(
      1,
    );
    expect(agentStoreMock.spawnSession).toHaveBeenCalledWith(
      "/Users/dev/my-project",
      "claude-code",
      expect.objectContaining({
        bootstrapPromptContext: "agent transcript here",
        conversationTitle: "My agent",
        localSessionId: "t1",
        restoredMessages: [
          {
            id: "a1",
            type: "user",
            content: "continue this work",
            timestamp: 1000,
            provider: undefined,
          },
          {
            id: "a2",
            type: "assistant",
            content: "prior agent answer",
            timestamp: 1002,
            provider: "codex",
          },
        ],
      }),
    );
  });

  it("does not move caches on a same-category (chat→chat) switch", async () => {
    conversationStoreMock.conversations = [
      {
        id: "t1",
        title: "T",
        createdAt: 100,
        selectedModel: "m",
        selectedProvider: "seren",
        projectRoot: null,
        isArchived: false,
        employeeId: null,
      },
    ];
    switchThreadProviderBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren-private",
      model: "private-mid",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 5000,
    });

    await switchChatProvider("t1", "seren-private", "private-mid");

    expect(conversationStoreMock.dropFromCache).not.toHaveBeenCalled();
    expect(agentStoreMock.upsertAgentConversationFromDb).not.toHaveBeenCalled();
    expect(agentStoreMock.spawnSession).not.toHaveBeenCalled();
    expect(agentStoreMock.terminateSession).not.toHaveBeenCalled();
  });

  it("propagates the stale-binding error from the Rust command so the UI can surface it", async () => {
    getProviderSessionRuntimeBridge.mockResolvedValueOnce({
      thread_id: "t1",
      provider: "seren",
      model: "claude-sonnet-4",
      native_session_id: null,
      resume_cursor_json: null,
      status: "active",
      bootstrap_context: null,
      updated_at: 4242,
    });
    switchThreadProviderBridge.mockRejectedValueOnce(
      new Error(
        "stale runtime binding for thread t1: another window changed the provider; refresh and retry",
      ),
    );

    await expect(
      switchChatProvider("t1", "seren-private", "private-mid"),
    ).rejects.toThrow(/stale runtime binding/);
    // No in-memory state should have been touched on a rejected switch.
    expect(conversationStoreMock.applyRuntimeBindingSync).not.toHaveBeenCalled();
    expect(chatStoreMock.applyRuntimeBindingSync).not.toHaveBeenCalled();
    expect(providerStoreMock.setActiveProvider).not.toHaveBeenCalled();
  });
});
