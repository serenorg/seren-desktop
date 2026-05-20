// ABOUTME: Regression coverage for chat logout cleanup.
// ABOUTME: Session reset clears user data without wiping provider model choice.

import { describe, expect, it, vi } from "vitest";

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

describe("chatStore.resetSessionState", () => {
  it("preserves the current model selection mirror", () => {
    chatStore.setModel("anthropic/claude-opus-4-7");

    chatStore.resetSessionState();

    expect(chatStore.selectedModel).toBe("anthropic/claude-opus-4-7");
    expect(chatStore.conversations).toEqual([]);
    expect(chatStore.activeConversationId).toBeNull();
    expect(chatStore.messages).toEqual([]);
  });
});
