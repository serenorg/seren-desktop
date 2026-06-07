// ABOUTME: Regression test for #1616 — compaction must preserve pre-compaction
// ABOUTME: user/assistant scrollback on the CompactedSummary so the UI can expand it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => "GOAL: test\nKEY_POINTS: -\n"),
}));

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

vi.mock("@/services/chat", async () => {
  const actual = await vi.importActual<typeof import("@/services/chat")>(
    "@/services/chat",
  );
  return {
    ...actual,
    sendMessage: sendMessageMock,
  };
});

import type { Message } from "@/services/chat";
import { chatStore } from "@/stores/chat.store";

// Large enough that one message alone exceeds the default-model tail budget
// (100k window × 0.35 ≈ 35k tokens ≈ 140k chars), forcing the token-budgeted
// selector to push it into the compacted half. #2104.
const BIG = "x".repeat(150_000);

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

  it("stores compacted user+assistant messages on the summary and filters system", async () => {
    const convo = await chatStore.createConversation("Compaction test");
    const base = 1_700_000_000_000;
    // a2 is oversized, so the token-budgeted boundary lands right after it:
    // u1,a1,s1,u2,a2 are compacted and u3,a3 are preserved (#2104).
    const msgs: Message[] = [
      makeMessage("u1", "user", "How do I deploy?", base),
      makeMessage("a1", "assistant", "Use the release workflow.", base + 1),
      makeMessage("s1", "system", "system note", base + 2),
      makeMessage("u2", "user", "What about rollbacks?", base + 3),
      makeMessage("a2", "assistant", BIG, base + 4),
      makeMessage("u3", "user", "Latest?", base + 5),
      makeMessage("a3", "assistant", "On main.", base + 6),
    ];
    chatStore.setMessages(convo.id, msgs);

    await chatStore.compactConversation(2);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    const summary = chatStore.activeConversation?.compactedSummary;
    expect(summary).toBeDefined();
    expect(summary?.originalMessageCount).toBe(5);

    // Pre-compaction scrollback contains every user+assistant message that was
    // compacted, in original order. The system message is intentionally
    // filtered out — we only preserve conversational text.
    const preserved = summary?.preCompactionMessages ?? [];
    expect(preserved.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(preserved.map((m) => m.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(preserved[0].content).toBe("How do I deploy?");

    // The latest user message is anchored into the preserved tail (#2104).
    expect(chatStore.messages).toHaveLength(2);
    expect(chatStore.messages[0].id).toBe("u3");
    expect(chatStore.messages[1].id).toBe("a3");
  });

  it("a second compaction replaces the prior preCompactionMessages (bounded memory)", async () => {
    const convo = await chatStore.createConversation("Second compaction");
    const base = 1_700_000_000_000;

    // Round 1 — a1 is oversized, so u1,a1 are compacted and u2,a2 preserved.
    chatStore.setMessages(convo.id, [
      makeMessage("u1", "user", "old q", base),
      makeMessage("a1", "assistant", BIG, base + 1),
      makeMessage("u2", "user", "old q2", base + 2),
      makeMessage("a2", "assistant", "old a2", base + 3),
    ]);
    await chatStore.compactConversation(1);

    const firstRound = chatStore.activeConversation?.compactedSummary;
    const firstIds = firstRound?.preCompactionMessages?.map((m) => m.id) ?? [];
    expect(firstIds).toContain("u1");
    expect(firstIds).toContain("a1");

    // Round 2 — append a fresh batch; a4 is oversized, so u2,a2,u3,a3 compact
    // and a4,u5 stay anchored in the tail.
    chatStore.setMessages(convo.id, [
      ...(chatStore.messages ?? []),
      makeMessage("u3", "user", "mid q", base + 10),
      makeMessage("a3", "assistant", "mid a", base + 11),
      makeMessage("u4", "user", "more q", base + 12),
      makeMessage("a4", "assistant", BIG, base + 13),
      makeMessage("u5", "user", "new q", base + 14),
    ]);
    await chatStore.compactConversation(1);

    const secondRound = chatStore.activeConversation?.compactedSummary;
    // Prior compactedSummary is overwritten — only the most-recent batch is
    // retained, so scrollback memory does not accumulate across compactions.
    const ids = secondRound?.preCompactionMessages?.map((m) => m.id) ?? [];
    expect(ids).not.toContain("u1");
    expect(ids).not.toContain("a1");
    expect(ids).toContain("u3");
    expect(ids).toContain("a3");
  });
});
