// ABOUTME: Pins the routing contract for chat.store::updateConversationModel.
// ABOUTME: Threads with a provider go through switch_thread_provider; legacy
// ABOUTME: threads without one fall back to the direct conversations update.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-bridge", () => ({
  createConversation: vi.fn(async () => {}),
  listConversations: vi.fn(async () => []),
  getMessages: vi.fn(async () => []),
  saveMessage: vi.fn(async () => {}),
  updateConversation: vi.fn(async () => {}),
  switchThreadProvider: vi.fn(async () => ({
    thread_id: "stub",
    provider: "seren",
    model: null,
    native_session_id: null,
    resume_cursor_json: null,
    status: "active",
    bootstrap_context: null,
    updated_at: 0,
  })),
  archiveConversation: vi.fn(async () => {}),
  clearConversationHistory: vi.fn(async () => {}),
  clearAllHistory: vi.fn(async () => {}),
}));

import { chatStore } from "@/stores/chat.store";

beforeEach(() => {
  vi.clearAllMocks();
});

async function seedConversationWithProvider(
  title: string,
  provider: "seren" | "seren-private",
  model: string,
): Promise<string> {
  const convo = await chatStore.createConversation(title);
  chatStore.applyRuntimeBindingSync(convo.id, provider, model);
  return convo.id;
}

describe("chatStore.updateConversationModel routes through the atomic switch", () => {
  it("uses switch_thread_provider when an explicit provider is supplied", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    const id = await seedConversationWithProvider(
      "Explicit",
      "seren",
      "claude-sonnet-4",
    );
    vi.mocked(bridge.switchThreadProvider).mockClear();
    vi.mocked(bridge.updateConversation).mockClear();

    await chatStore.updateConversationModel(
      id,
      "anthropic/claude-opus-4-7",
      "seren-private",
    );

    expect(bridge.switchThreadProvider).toHaveBeenCalledWith(
      id,
      "seren-private",
      "anthropic/claude-opus-4-7",
    );
    expect(bridge.updateConversation).not.toHaveBeenCalled();
  });

  it("inherits the conversation's bound provider when none is supplied", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    const id = await seedConversationWithProvider(
      "Implicit",
      "seren-private",
      "claude-sonnet-4",
    );
    vi.mocked(bridge.switchThreadProvider).mockClear();
    vi.mocked(bridge.updateConversation).mockClear();

    await chatStore.updateConversationModel(id, "anthropic/claude-opus-4-7");

    expect(bridge.switchThreadProvider).toHaveBeenCalledWith(
      id,
      "seren-private",
      "anthropic/claude-opus-4-7",
    );
    expect(bridge.updateConversation).not.toHaveBeenCalled();
  });

  it("falls back to the direct conversation update for legacy threads with no provider", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    const convo = await chatStore.createConversation("Legacy");
    vi.mocked(bridge.switchThreadProvider).mockClear();
    vi.mocked(bridge.updateConversation).mockClear();

    await chatStore.updateConversationModel(convo.id, "claude-sonnet-4");

    expect(bridge.switchThreadProvider).not.toHaveBeenCalled();
    expect(bridge.updateConversation).toHaveBeenCalledWith(
      convo.id,
      undefined,
      "claude-sonnet-4",
      undefined,
    );
  });

  it("leaves the in-memory row unchanged when the bridge rejects", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    const id = await seedConversationWithProvider(
      "Stale",
      "seren",
      "claude-sonnet-4",
    );
    vi.mocked(bridge.switchThreadProvider).mockRejectedValueOnce(
      new Error("stale runtime binding"),
    );

    await chatStore.updateConversationModel(
      id,
      "anthropic/claude-opus-4-7",
      "seren-private",
    );

    const after = chatStore.conversations.find((c) => c.id === id);
    expect(after?.selectedProvider).toBe("seren");
    expect(after?.selectedModel).toBe("claude-sonnet-4");
  });

  it("leaves the in-memory row unchanged when the direct update rejects", async () => {
    const bridge = await import("@/lib/tauri-bridge");
    const convo = await chatStore.createConversation("LegacyStale");
    const initialModel = convo.selectedModel;
    vi.mocked(bridge.updateConversation).mockRejectedValueOnce(
      new Error("db unavailable"),
    );

    await chatStore.updateConversationModel(convo.id, "anthropic/claude-opus-4-7");

    const after = chatStore.conversations.find((c) => c.id === convo.id);
    expect(after?.selectedModel).toBe(initialModel);
    expect(after?.selectedProvider).toBeNull();
  });
});
