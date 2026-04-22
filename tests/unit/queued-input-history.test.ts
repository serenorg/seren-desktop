// ABOUTME: Regression test for #1624 — queued prompts must be persisted to
// ABOUTME: input history so up-arrow recall works.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);
const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);

/**
 * Return the queued-message branch of a sendMessage handler — the block that
 * runs when the user submits while the agent is still mid-turn (AgentChat) or
 * the conversation is still streaming (ChatContent). Bounded to 40 lines so
 * we don't accidentally match the direct-send path below it.
 */
function extractQueueBranch(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return "";
  const lines = source.slice(start).split("\n").slice(0, 40);
  return lines.join("\n");
}

describe("#1624 — queued prompts appear in up-arrow input history", () => {
  it("AgentChat queue branch calls appendInputHistory", () => {
    const branch = extractQueueBranch(
      agentChatSource,
      "if (isPrompting()) {",
    );
    expect(branch, "agent queued branch must exist").toContain(
      "agentStore.enqueuePrompt",
    );
    // The fix: persist to input history even when the prompt is queued.
    expect(branch).toContain("appendInputHistory");
    expect(branch).toContain("setPersistedInputs");
  });

  it("ChatContent queue branch calls appendInputHistory", () => {
    const branch = extractQueueBranch(
      chatContentSource,
      "if (conversationStore.isLoading) {",
    );
    expect(branch, "chat queued branch must exist").toContain(
      "setMessageQueue",
    );
    expect(branch).toContain("appendInputHistory");
    expect(branch).toContain("setPersistedInputs");
  });

  it("both queued branches cap history at 200 entries like the direct path", () => {
    // Prevents the queued path from growing history unbounded while the direct
    // path caps — silent divergence in behavior would be a regression.
    const agentBranch = extractQueueBranch(
      agentChatSource,
      "if (isPrompting()) {",
    );
    const chatBranch = extractQueueBranch(
      chatContentSource,
      "if (conversationStore.isLoading) {",
    );
    expect(agentBranch).toContain("next.length > 200");
    expect(chatBranch).toContain("next.length > 200");
  });
});
