// ABOUTME: Locks the #2106 resilient-summarizer wiring in both stores.
// ABOUTME: Both paths run the policy, no-drop on abort, and gate auto-compact on cooldown.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatStore = readFileSync(resolve("src/stores/chat.store.ts"), "utf-8");
const agentStore = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");

describe("#2106 agent compaction runs the resilient summarizer policy", () => {
  it("drives the summary through runSummarizerWithPolicy with a fallback model", () => {
    expect(agentStore).toContain("runSummarizerWithPolicy({");
    expect(agentStore).toContain("fallbackModels: SUMMARY_FALLBACK_MODELS");
    expect(agentStore).toContain("deterministicFallback: () =>");
  });

  it("no-drop on abort: returns without terminating, enters cooldown", () => {
    expect(agentStore).toContain('summaryOutcome.status === "aborted"');
    expect(agentStore).toContain("compactionCooldown.enter(conversationId");
    expect(agentStore).toContain("history kept intact");
  });

  it("gates auto-compaction on the cooldown in kickPredictiveCompact", () => {
    expect(agentStore).toContain(
      "compactionCooldown.isCoolingDown(session.conversationId",
    );
  });
});

describe("#2106 chat compaction runs the resilient summarizer policy", () => {
  it("drives the summary through runSummarizerWithPolicy with a deterministic fallback", () => {
    expect(chatStore).toContain("runSummarizerWithPolicy({");
    expect(chatStore).toContain("deterministicFallback:");
    expect(chatStore).toContain("buildDeterministicFallbackSummary(prunable)");
  });

  it("no-drop on abort: returns before replacing messages, enters cooldown", () => {
    expect(chatStore).toContain('summaryOutcome.status === "aborted"');
    expect(chatStore).toContain("compactionCooldown.enter(conversationId");
    // The abort branch must return before the message-replacement setState.
    const abortIdx = chatStore.indexOf('summaryOutcome.status === "aborted"');
    const replaceIdx = chatStore.indexOf(
      'setState("messages", conversationId, toPreserve)',
    );
    expect(abortIdx).toBeGreaterThan(0);
    expect(replaceIdx).toBeGreaterThan(abortIdx);
  });

  it("gates auto-compaction on the cooldown in checkAutoCompact", () => {
    expect(chatStore).toContain("compactionCooldown.isCoolingDown(conversationId");
  });
});
