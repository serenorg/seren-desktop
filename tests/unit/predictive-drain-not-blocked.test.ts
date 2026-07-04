// ABOUTME: Regression guards for #1673 — predictive compaction must not flip
// ABOUTME: isCompacting on the serving session and block the drain queue.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const agentStoreSource = readSource("src/stores/agent.store.ts");

describe("#1673 — predictive compaction does not block drain", () => {
  it("compactAgentConversation flips isCompacting=true only inside the reactive branch", () => {
    // The buggy version had `setState("sessions", sessionId, "isCompacting", true)`
    // unconditionally before the mode branch. The fix gates the flip on
    // mode === "reactive". Predictive mode runs alongside the live serving
    // session and must not signal teardown.
    const fnStart = agentStoreSource.indexOf(
      "async compactAgentConversation(",
    );
    expect(fnStart, "compactAgentConversation must exist").toBeGreaterThan(0);
    const fnEnd = agentStoreSource.indexOf(
      "async compactAndRetry(",
      fnStart,
    );
    const fnBody = agentStoreSource.slice(fnStart, fnEnd);

    // Every true-flip on isCompacting in this function must be reactive-gated.
    // Tail-relief compaction has a second reactive-only respawn path; predictive
    // mode still must not signal teardown on the serving session.
    const flips = [...fnBody.matchAll(
      /setState\("sessions",\s*sessionId,\s*"isCompacting",\s*true\)/g,
    )];
    expect(flips.length, "at least one isCompacting=true flip").toBeGreaterThan(
      0,
    );
    for (const flip of flips) {
      const flipIdx = flip.index ?? 0;
      const reactiveGateIdx = fnBody.lastIndexOf(
        'mode === "reactive"',
        flipIdx,
      );
      const predictiveBranchIdx = fnBody.lastIndexOf(
        'if (mode === "predictive")',
        flipIdx,
      );
      expect(reactiveGateIdx).toBeGreaterThan(predictiveBranchIdx);
    }
  });

  it("predictive branch does not write isCompacting on the serving session", () => {
    const branchStart = agentStoreSource.indexOf('if (mode === "predictive")');
    expect(branchStart).toBeGreaterThan(0);
    // Reactive branch follows immediately after the predictive block returns;
    // capture the predictive body up to its terminal "succeeded" return.
    // Post-#1757 returns the structured result shape so we anchor on the
    // standby-id field that the predictive path always carries.
    const branchEnd = agentStoreSource.indexOf(
      'newSessionId: standbyId',
      branchStart,
    );
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branchBody = agentStoreSource.slice(branchStart, branchEnd);

    expect(
      branchBody,
      "predictive branch must not flip isCompacting on the serving session",
    ).not.toContain('"isCompacting"');
  });

  it("drain-guard comment in promptComplete documents the predictive carve-out", () => {
    // The pre-#1673 comment claimed the guard was correct because compaction
    // would always transfer the queue to the new session. That contract only
    // holds for reactive mode. The updated comment must mention predictive
    // mode explicitly so the next reader does not regress the design.
    expect(agentStoreSource).toContain(
      "Predictive compaction (#1631)\n        // does NOT set isCompacting on the serving session (#1673)",
    );
  });
});
