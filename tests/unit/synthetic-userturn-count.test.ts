// ABOUTME: Regression test for #2111 — synthetic-transcript user-turn count must
// ABOUTME: align with the token-budgeted tail, and the fallback model must be in-catalog.

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

describe("#2111 fallback summarizer model is in the seren catalog", () => {
  it("uses a recognized fallback model id, not the unlisted claude-3-5-sonnet", () => {
    expect(agentStore).toContain(
      'SUMMARY_FALLBACK_MODELS = ["anthropic/claude-haiku-4.5"]',
    );
    expect(agentStore).not.toContain("anthropic/claude-3-5-sonnet");
  });
});
