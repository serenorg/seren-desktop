// ABOUTME: Regression test for #1624 — queued prompts must be persisted to
// ABOUTME: input history so up-arrow recall works. Reaffirmed after #1813.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
 *
 * Throws on miss: a stale anchor caused by a rename would otherwise mask a
 * real regression like #1813. Loud failure naming the missing anchor is the
 * only acceptable behavior here.
 */
function extractQueueBranch(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) {
    throw new Error(
      `extractQueueBranch: anchor not found in source: ${JSON.stringify(anchor)}. ` +
        `If the source was renamed (e.g. conversationStore.isLoading → conversationIsLoading()), ` +
        `update this test's anchor — silent miss would mask a real regression like #1813.`,
    );
  }
  const lines = source.slice(start).split("\n").slice(0, 40);
  return lines.join("\n");
}

/**
 * Return the index of the first character of `anchor` in `source`, or throw.
 * Used to assert one block appears upstream of another in the same function.
 */
function indexOrThrow(source: string, anchor: string): number {
  const i = source.indexOf(anchor);
  if (i < 0) {
    throw new Error(`anchor not found in source: ${JSON.stringify(anchor)}`);
  }
  return i;
}

describe("#1624 — queued prompts appear in up-arrow input history", () => {
  it("AgentChat persists inside its queued branch (per-thread state design)", () => {
    const branch = extractQueueBranch(
      agentChatSource,
      "if (isPrompting()) {",
    );
    expect(branch, "agent queued branch must exist").toContain(
      "agentStore.enqueuePrompt",
    );
    expect(branch).toContain("appendInputHistory");
    expect(branch).toContain("setPersistedInputs");
    expect(branch).toContain("next.length > 200");
  });

  // ChatContent's design (post-#1810 / post-b48ecd3e) consolidated the
  // duplicated persist blocks into a single unconditional persist at the top
  // of sendMessage. Asserting persist lives INSIDE the queue branch (the old
  // shape) is wrong for this surface — the contract is "persist runs before
  // the queue branch returns," so queued prompts can't bypass history. This
  // test locks ordering, not location.
  it("ChatContent persists before reaching the queued return (#1813)", () => {
    const persistIdx = indexOrThrow(
      chatContentSource,
      "appendInputHistory(convId, trimmed)",
    );
    const queueBranchIdx = indexOrThrow(
      chatContentSource,
      "if (conversationIsLoading()) {",
    );
    expect(
      persistIdx,
      "persist block must appear before the queued return so queued prompts hit history",
    ).toBeLessThan(queueBranchIdx);

    // The queued branch itself must still be reached for queueing to happen,
    // and must contain setMessageQueue.
    const branch = extractQueueBranch(
      chatContentSource,
      "if (conversationIsLoading()) {",
    );
    expect(branch).toContain("setMessageQueue");
  });

  it("ChatContent's upstream persist enforces the 200-entry cap", () => {
    // Slice from sendMessage start (function declaration) up to the queue
    // branch — that span is the single persist block. Ensures the unconditional
    // persist hasn't silently dropped its bound while the rest of the function
    // grew around it.
    const sendMessageIdx = indexOrThrow(
      chatContentSource,
      "const sendMessage = async (",
    );
    const queueBranchIdx = indexOrThrow(
      chatContentSource,
      "if (conversationIsLoading()) {",
    );
    const span = chatContentSource.slice(sendMessageIdx, queueBranchIdx);
    expect(span).toContain("appendInputHistory");
    expect(span).toContain("setPersistedInputs");
    expect(span).toContain("next.length > 200");
  });
});
