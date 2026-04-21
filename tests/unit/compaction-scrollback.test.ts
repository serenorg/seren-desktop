// ABOUTME: Regression test for #1616 — compaction must preserve pre-compaction
// ABOUTME: user/assistant scrollback on the CompactedSummary so the UI can expand it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => "GOAL: test\nKEY_POINTS: -\n"),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  createConversation: vi.fn(async () => {}),
  getConversations: vi.fn(async () => []),
  getMessages: vi.fn(async () => []),
  saveMessage: vi.fn(async () => {}),
  updateConversation: vi.fn(async () => {}),
  archiveConversation: vi.fn(async () => {}),
  clearConversationHistory: vi.fn(async () => {}),
  clearAllHistory: vi.fn(async () => {}),
}));

vi.mock("@/services/chat", async () => {
  const actual = await vi.importActual<typeof import("@/services/chat")>(
    "@/services/chat",
  );
  return {
    ...actual,
    sendMessage: sendMessageMock,
  };
});

import { chatStore } from "@/stores/chat.store";
import type { Message } from "@/services/chat";

function makeMessage(
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
  ts: number,
): Message {
  return {
    id,
    role,
    content,
    timestamp: ts,
    status: "complete",
  };
}

describe("chat.store compaction #1616 — preCompactionMessages are preserved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores pre-compaction user+assistant messages on the summary", async () => {
    const convo = await chatStore.createConversation("Compaction test");
    const base = 1_700_000_000_000;
    const msgs: Message[] = [
      makeMessage("u1", "user", "How do I deploy?", base),
      makeMessage("a1", "assistant", "Use the release workflow.", base + 1),
      makeMessage("s1", "system", "system note", base + 2),
      makeMessage("u2", "user", "What about rollbacks?", base + 3),
      makeMessage("a2", "assistant", "Cherry-pick the fix.", base + 4),
      makeMessage("u3", "user", "Latest?", base + 5),
      makeMessage("a3", "assistant", "On main.", base + 6),
    ];
    chatStore.setMessages(convo.id, msgs);

    // Preserve 2 most recent — compact the other 5 (3 user, 2 assistant, 1 system).
    await chatStore.compactConversation(2);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const summary = chatStore.activeConversation?.compactedSummary;
    expect(summary).toBeDefined();
    expect(summary?.originalMessageCount).toBe(5);

    // Pre-compaction scrollback contains every user+assistant message that was
    // compacted, in original order, with content intact. The system message is
    // intentionally filtered out — we only preserve conversational text.
    const preserved = summary?.preCompactionMessages ?? [];
    expect(preserved.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(preserved.map((m) => m.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(preserved[0].content).toBe("How do I deploy?");
    expect(preserved[3].content).toBe("Cherry-pick the fix.");

    // The 2 preserved messages remain on the conversation.
    expect(chatStore.messages).toHaveLength(2);
    expect(chatStore.messages[0].id).toBe("u3");
    expect(chatStore.messages[1].id).toBe("a3");
  });

  it("a second compaction replaces the prior preCompactionMessages (bounded memory)", async () => {
    const convo = await chatStore.createConversation("Second compaction");
    const base = 1_700_000_000_000;

    // Round 1 — 4 messages, preserve 1.
    chatStore.setMessages(convo.id, [
      makeMessage("u1", "user", "old q", base),
      makeMessage("a1", "assistant", "old a", base + 1),
      makeMessage("u2", "user", "old q2", base + 2),
      makeMessage("a2", "assistant", "old a2", base + 3),
    ]);
    await chatStore.compactConversation(1);

    const firstRound = chatStore.activeConversation?.compactedSummary;
    expect(firstRound?.preCompactionMessages?.map((m) => m.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);

    // Round 2 — append 3 more, compact again preserving 1.
    chatStore.setMessages(convo.id, [
      ...(chatStore.messages ?? []),
      makeMessage("u3", "user", "mid q", base + 10),
      makeMessage("a3", "assistant", "mid a", base + 11),
      makeMessage("u4", "user", "new q", base + 12),
    ]);
    await chatStore.compactConversation(1);

    const secondRound = chatStore.activeConversation?.compactedSummary;
    // Prior compactedSummary is overwritten — only the most-recent batch is
    // retained, so memory does not accumulate across compactions.
    const ids = secondRound?.preCompactionMessages?.map((m) => m.id) ?? [];
    expect(ids).not.toContain("u1");
    expect(ids).not.toContain("a1");
    expect(ids).toContain("u3");
    expect(ids).toContain("a3");
  });
});
