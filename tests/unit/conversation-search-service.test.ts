// ABOUTME: Tests for conversation search service merge/degrade behavior.
// ABOUTME: Mocks IPC and embeddings to keep coverage focused on local logic.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, embedTextMock, embedTextsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  embedTextMock: vi.fn(),
  embedTextsMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/services/seren-embed", () => ({
  embedText: embedTextMock,
  embedTexts: embedTextsMock,
}));

import {
  searchConversations,
  type ConversationHit,
} from "@/services/conversation-search";

function hit(messageId: string): Omit<ConversationHit, "matchType"> {
  return {
    messageId,
    conversationId: "c1",
    title: "Thread",
    kind: "chat",
    role: "assistant",
    agentType: null,
    projectRoot: "/tmp/project",
    timestamp: 1000,
    seq: 0,
    text: `text ${messageId}`,
    distance: 0,
  };
}

describe("searchConversations", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    embedTextMock.mockReset();
    embedTextsMock.mockReset();
  });

  it("returns exact hits with a semantic-unavailable flag when embedding fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "search_conversations_fts") {
        return Promise.resolve([hit("m1")]);
      }
      return Promise.resolve([]);
    });
    embedTextMock.mockRejectedValue(new Error("Not authenticated"));

    const result = await searchConversations("updater", { limit: 10 });

    expect(result.hits.map((item) => item.messageId)).toEqual(["m1"]);
    expect(result.hits[0].matchType).toBe("exact");
    expect(result.semanticUnavailable).toBe(true);
    expect(result.semanticUnavailableReason).toBe("sign in is required");
  });

  it("does not let semantic hits crowd out exact matches", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "search_conversations_fts") {
        return Promise.resolve([hit("m1"), hit("m2")]);
      }
      return Promise.resolve([hit("m3"), hit("m4")]);
    });
    embedTextMock.mockResolvedValue([0.1, 0.2]);

    const result = await searchConversations("updater", { limit: 2 });

    expect(result.hits.map((item) => item.messageId)).toEqual(["m1", "m2"]);
    expect(result.semanticUnavailable).toBe(false);
  });

  it("dedupes the same chunk returned by exact and semantic paths", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "search_conversations_fts") {
        return Promise.resolve([hit("m1")]);
      }
      return Promise.resolve([hit("m1"), hit("m2")]);
    });
    embedTextMock.mockResolvedValue([0.1, 0.2]);

    const result = await searchConversations("updater", { limit: 10 });

    expect(result.hits.map((item) => item.messageId)).toEqual(["m1", "m2"]);
    expect(result.hits.map((item) => item.matchType)).toEqual([
      "exact",
      "semantic",
    ]);
  });
});
