// ABOUTME: Critical guard for #1769 — kickPredictiveCompact's non-success and catch
// ABOUTME: branches must drain pendingPrompts so #1749-enqueued prompts never strand.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1769 — kickPredictiveCompact drains pendingPrompts on abort", () => {
  it("non-success and catch branches both call drainAfterPredictiveAbort", () => {
    // Without this, the #1749 race-guard queue (pendingPrompts populated when
    // the user submits while a standby is being warmed) is stranded forever
    // when the standby's seed prompt fails — e.g. the Gateway 504 in the
    // user-reported transcript. The standby-success drain at promptComplete
    // only fires when the seed completes; abort needs its own dispatch path.
    const fnStart = agentStoreSource.indexOf("async kickPredictiveCompact(");
    expect(fnStart, "kickPredictiveCompact must exist").toBeGreaterThan(0);
    // The drain helper is declared on the same object literal, immediately
    // after kickPredictiveCompact — slice past it so the assertions below
    // count the call sites inside kickPredictiveCompact, not the helper body.
    const drainHelperStart = agentStoreSource.indexOf(
      "drainAfterPredictiveAbort(sessionId: string)",
      fnStart,
    );
    expect(drainHelperStart, "drain helper must follow kick").toBeGreaterThan(
      fnStart,
    );
    const kickBody = agentStoreSource.slice(fnStart, drainHelperStart);

    const drainCalls = kickBody.match(
      /this\.drainAfterPredictiveAbort\(sessionId\)/g,
    );
    expect(
      drainCalls,
      "kickPredictiveCompact must call drainAfterPredictiveAbort in both abort branches",
    ).toHaveLength(2);

    // Each drain call must run AFTER the predictiveCompactInFlight flag is
    // cleared on the same branch. Otherwise the drained sendPrompt re-enters
    // and trips the #1749 enqueue guard, restranding the prompt.
    const nonSuccessFlagClear = kickBody.indexOf(
      'setState("sessions", sessionId, "predictiveCompactInFlight", false)',
    );
    const firstDrain = kickBody.indexOf(
      "this.drainAfterPredictiveAbort(sessionId)",
    );
    expect(nonSuccessFlagClear).toBeGreaterThan(0);
    expect(firstDrain).toBeGreaterThan(nonSuccessFlagClear);
  });

  it("drainAfterPredictiveAbort dispatches the head of pendingPrompts via setTimeout", () => {
    // Mirrors the standard drain shape used at the bottom of the
    // promptComplete handler and in the standby-success drain. Synchronous
    // dispatch would re-enter sendPrompt before the current call stack
    // unwinds, which has caused store-update reentrancy bugs in the past.
    const helperStart = agentStoreSource.indexOf(
      "drainAfterPredictiveAbort(sessionId: string)",
    );
    expect(helperStart).toBeGreaterThan(0);
    const helperEnd = agentStoreSource.indexOf("\n  },", helperStart);
    const helperBody = agentStoreSource.slice(helperStart, helperEnd);

    expect(helperBody).toContain("pendingPrompts");
    expect(helperBody).toMatch(
      /setState\("sessions",\s*sessionId,\s*"pendingPrompts",\s*remaining\)/,
    );
    expect(helperBody).toContain("setTimeout(");
    expect(helperBody).toContain(
      "this.sendPrompt(nextPrompt, undefined, undefined, sessionId)",
    );
  });
});
