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
  content: string;
  timestamp: number;
};
const conversationStoreMock = vi.hoisted(() => ({
  getLoadingFor: vi.fn(() => false),
  getStreamingContentFor: vi.fn(() => ""),
  getRLMProcessingFor: vi.fn(() => false),
  getMessagesFor: vi.fn(() => [] as TestMessage[]),
  applyRuntimeBindingSync: vi.fn(),
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

vi.mock("@/lib/tauri-bridge", () => ({
  switchThreadProvider: switchThreadProviderBridge,
  getProviderSessionRuntime: getProviderSessionRuntimeBridge,
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

import {
  evaluateChatSwitchGuard,
  switchChatProvider,
} from "@/services/provider-bindings";

beforeEach(() => {
  vi.clearAllMocks();
  conversationStoreMock.getLoadingFor.mockReturnValue(false);
  conversationStoreMock.getStreamingContentFor.mockReturnValue("");
  conversationStoreMock.getRLMProcessingFor.mockReturnValue(false);
  chatStoreMock.isCompacting = false;
  chatStoreMock.retryingMessageId = null;
  chatStoreMock.activeConversationId = null;
  chatStoreMock.getMessagesFor.mockReturnValue([]);
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

  it("refuses to switch while the thread is busy", async () => {
    conversationStoreMock.getStreamingContentFor.mockReturnValueOnce("partial");

    await expect(
      switchChatProvider("t1", "seren-private", "m"),
    ).rejects.toThrow(/switch provider while thread is streaming/);
    expect(switchThreadProviderBridge).not.toHaveBeenCalled();
  });

  it("builds and forwards a deterministic bootstrap when switching to a native agent", async () => {
    conversationStoreMock.getMessagesFor.mockReturnValueOnce([
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

    const [, , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
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

    const [, , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
    expect(bootstrap).toContain("[USER]: only-in-chat-store");
  });

  it("does not send a bootstrap when the new binding is another chat provider", async () => {
    conversationStoreMock.getMessagesFor.mockReturnValueOnce([
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

    const [, , , bootstrap] = switchThreadProviderBridge.mock.calls[0];
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
    );
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
