// ABOUTME: Tests for the per-thread provider-runtime switching service.
// ABOUTME: Verifies the safe-turn-boundary guard and the in-memory sync.

import { beforeEach, describe, expect, it, vi } from "vitest";

const switchThreadProviderBridge = vi.hoisted(() => vi.fn());
const conversationStoreMock = vi.hoisted(() => ({
  getLoadingFor: vi.fn(() => false),
  getStreamingContentFor: vi.fn(() => ""),
  getRLMProcessingFor: vi.fn(() => false),
  getMessagesFor: vi.fn(() => []),
  applyRuntimeBindingSync: vi.fn(),
}));
const chatStoreMock = vi.hoisted(() => ({
  messages: [],
  activeConversationId: null as string | null,
  applyRuntimeBindingSync: vi.fn(),
}));
const providerStoreMock = vi.hoisted(() => ({
  setActiveProvider: vi.fn(),
  setActiveModel: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  switchThreadProvider: switchThreadProviderBridge,
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
});

describe("switchChatProvider", () => {
  it("invokes the Rust bridge and syncs in-memory caches on success", async () => {
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
});
