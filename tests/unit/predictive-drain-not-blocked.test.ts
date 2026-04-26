// ABOUTME: Regression guards for #1673 — predictive compaction must not flip
// ABOUTME: isCompacting on the serving session and block the drain queue.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

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

    // Exactly one true-flip on isCompacting in this function.
    const flips = fnBody.match(
      /setState\("sessions",\s*sessionId,\s*"isCompacting",\s*true\)/g,
    );
    expect(flips, "exactly one isCompacting=true flip").toHaveLength(1);

    // That flip must be reactive-gated. We assert by string adjacency: the
    // `if (mode === "reactive") {` opener must precede the flip with no
    // intervening close-brace at the same scope.
    const reactiveGateIdx = fnBody.indexOf('if (mode === "reactive")');
    const flipIdx = fnBody.indexOf(
      'setState("sessions", sessionId, "isCompacting", true)',
    );
    expect(reactiveGateIdx, "reactive gate must exist").toBeGreaterThan(0);
    expect(flipIdx).toBeGreaterThan(reactiveGateIdx);

    // The slice between gate and flip must contain only whitespace + "{".
    const between = fnBody.slice(
      reactiveGateIdx + 'if (mode === "reactive")'.length,
      flipIdx,
    );
    expect(between.trim()).toBe("{");
  });

  it("predictive branch does not write isCompacting on the serving session", () => {
    const branchStart = agentStoreSource.indexOf('if (mode === "predictive")');
    expect(branchStart).toBeGreaterThan(0);
    // Reactive branch follows immediately after the predictive block returns;
    // capture the predictive body up to its `return "succeeded";`.
    const branchEnd = agentStoreSource.indexOf(
      'return "succeeded";',
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
