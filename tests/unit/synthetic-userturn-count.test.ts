// ABOUTME: Regression test for #2111 synthetic-transcript user-turn counting.
// ABOUTME: Keeps the synthetic boundary aligned with the token-budgeted tail.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStore = readFileSync(resolve("src/stores/agent.store.ts"), "utf-8");

describe("#2111 synthetic-transcript boundary matches the token-budgeted tail", () => {
  it("derives userTurnCount from the real user turns in toPreserve, not length/2", () => {
    // findCutIndex (synthetic-transcript.mjs) treats this as a count of REAL
    // user turns; under #2104's token-budgeted tail, length/2 diverges.
    expect(agentStore).toContain(
      'toPreserve.filter((m) => m.type === "user").length',
    );
    expect(agentStore).not.toContain("Math.ceil(toPreserve.length / 2)");
  });
});
