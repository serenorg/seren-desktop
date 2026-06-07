// ABOUTME: Locks the #2105 pruning + request-accounting wiring in both stores.
// ABOUTME: Compacted history is pruned before summarization; the gauge counts media.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatStore = readFileSync(resolve("src/stores/chat.store.ts"), "utf-8");
const agentStore = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");

describe("#2105 agent compaction prunes history and accounts tool tokens", () => {
  it("pre-prunes the compacted window before building summarizer input", () => {
    expect(agentStore).toContain("pruneCompactedHistory(");
    expect(agentStore).toContain("protectedFromIndex: prunable.length");
  });

  it("feeds tool results into the summarizer via the pruned history", () => {
    expect(agentStore).toContain("TOOL(${m.toolName ?? \"tool\"}): ${m.toolResult}");
  });

  it("counts tool-call arguments and results in the boundary token cost", () => {
    expect(agentStore).toContain("estimateAccountedMessageTokens({");
    expect(agentStore).toContain("toolArgs: m.toolCall?.parameters");
  });
});

describe("#2105 chat compaction prunes history and counts media in the gauge", () => {
  it("pre-prunes the compacted window before building summarizer input", () => {
    expect(chatStore).toContain("pruneCompactedHistory(");
  });

  it("the gauge and the trigger count attached images via request accounting", () => {
    expect(chatStore).toContain("estimateRequestTokens(");
    expect(chatStore).toContain("accountedChatMessage");
    // The content-only counter is no longer the source of truth for the gauge.
    expect(chatStore).not.toContain("estimateConversationTokens(this.messages)");
  });
});
