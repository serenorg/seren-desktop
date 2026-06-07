// ABOUTME: Locks the #2104 token-budgeted boundary wiring in both stores.
// ABOUTME: Predictive, reactive, and retry compaction must all use the shared selector.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatStore = readFileSync(resolve("src/stores/chat.store.ts"), "utf-8");
const agentStore = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");

describe("#2104 chat compaction uses the token-budgeted selector", () => {
  it("splits on the selector's cut index, not a fixed preserve count", () => {
    expect(chatStore).toContain("selectCompactionWindow(");
    expect(chatStore).toContain("messages.slice(0, tailWindow.cutIndex)");
    expect(chatStore).not.toContain(
      "messages.slice(0, messages.length - preserveCount)",
    );
  });
});

describe("#2104 agent compaction uses the token-budgeted selector", () => {
  it("splits on the selector's cut index for predictive and reactive paths", () => {
    expect(agentStore).toContain("selectCompactionWindow(");
    expect(agentStore).toContain("messages.slice(0, tailWindow.cutIndex)");
    expect(agentStore).not.toContain(
      "messages.slice(0, messages.length - preserveCount)",
    );
  });

  it("groups tool results into their turn so a tool result is never split off", () => {
    // groupId is keyed per user-led turn; the selector keeps groups whole.
    expect(agentStore).toContain("groupId: `t${compactTurn}`");
  });

  it("the prompt-too-long retry uses a tighter tail budget, not a magic count", () => {
    expect(agentStore).toContain("tailRatio: AGGRESSIVE_RETRY_TAIL_RATIO");
  });
});
