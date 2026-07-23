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
  it("non-success and catch both request an owner-guarded abort drain", () => {
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

    const abortRequests = kickBody.match(/shouldDrainAfterAbort = true/g);
    expect(
      abortRequests,
      "both abort branches must request the centralized drain",
    ).toHaveLength(2);
    expect(
      kickBody.match(/this\.drainAfterPredictiveAbort\(sessionId\)/g),
      "the finally block must contain one generation-guarded drain",
    ).toHaveLength(1);

    // The centralized drain must run only after the current lease releases and
    // the predictiveCompactInFlight flag clears. Otherwise a stale archived
    // generation can drain or unlock a newer run on the same session id.
    const leaseRelease = kickBody.indexOf(
      "predictiveCompactMutex.release(predictiveCompactLease)",
    );
    const nonSuccessFlagClear = kickBody.indexOf(
      'setState("sessions", sessionId, "predictiveCompactInFlight", false)',
    );
    const firstDrain = kickBody.indexOf(
      "this.drainAfterPredictiveAbort(sessionId)",
    );
    expect(leaseRelease).toBeGreaterThan(0);
    expect(nonSuccessFlagClear).toBeGreaterThan(leaseRelease);
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
