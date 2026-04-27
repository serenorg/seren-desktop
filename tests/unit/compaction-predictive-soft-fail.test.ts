// ABOUTME: Source-level regression tests for #152 — predictive standby
// ABOUTME: failures must not trigger the catastrophic-error capture path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const compactStart = agentStoreSource.indexOf(
  "async compactAgentConversation(",
);
const compactEnd = agentStoreSource.indexOf(
  "async compactAndRetry(",
  compactStart,
);
const compactBody = agentStoreSource.slice(compactStart, compactEnd);

describe("#152 — predictive standby spawn null is non-catastrophic", () => {
  it("predictive null-spawn branch does NOT throw 'CompactionFailure: predictive standby spawn returned null'", () => {
    // Throwing routed through the catastrophic catch which logs
    // console.error(string, errorObj) — captured as a support report. The
    // serving session is still healthy on a predictive null-spawn, so the
    // user-visible failure was pure noise.
    expect(compactBody).not.toContain(
      'throw new Error(\n            "CompactionFailure: predictive standby spawn returned null"',
    );
    expect(compactBody).not.toContain(
      '"CompactionFailure: predictive standby spawn returned null"',
    );
  });

  it("predictive null-spawn branch warns (not errors) and returns failed_catastrophic", () => {
    const predictiveIdx = compactBody.indexOf('if (mode === "predictive")');
    expect(predictiveIdx, "predictive branch must exist").toBeGreaterThan(0);
    const nullCheckIdx = compactBody.indexOf("!standbyId", predictiveIdx);
    expect(nullCheckIdx, "null-standby check must exist").toBeGreaterThan(
      predictiveIdx,
    );
    // The block after the null check should warn, not error, and must return
    // an outcome (not throw).
    const block = compactBody.slice(nullCheckIdx, nullCheckIdx + 600);
    expect(block).toMatch(/console\.warn\(/);
    expect(block).toContain('return "failed_catastrophic"');
  });

  it("catch block treats predictive mode as non-fatal", () => {
    // Errors thrown after the null-spawn check (e.g. setState on a standby
    // killed mid-compaction) must also warn rather than fire console.error
    // with the Error instance.
    const catchIdx = compactBody.indexOf("} catch (error) {");
    expect(catchIdx, "catch block must exist").toBeGreaterThan(0);
    const catchBody = compactBody.slice(catchIdx, catchIdx + 1500);
    // Guard: predictive branch is checked first
    const predictiveCatchIdx = catchBody.indexOf('if (mode === "predictive")');
    const catastrophicLogIdx = catchBody.indexOf(
      "Failed to compact agent conversation (catastrophic)",
    );
    expect(
      predictiveCatchIdx,
      "predictive branch must be inside catch",
    ).toBeGreaterThan(0);
    expect(
      predictiveCatchIdx,
      "predictive branch must run BEFORE the catastrophic console.error",
    ).toBeLessThan(catastrophicLogIdx);
  });

  it("catch block clears standbySessionId pointer when predictive fails after wiring", () => {
    // Without this, the next sendPrompt's standby-promotion path would try
    // to promote a session id that is gone or unreachable.
    const catchIdx = compactBody.indexOf("} catch (error) {");
    const catchBody = compactBody.slice(catchIdx, catchIdx + 1500);
    expect(catchBody).toMatch(/standbySessionId/);
    expect(catchBody).toMatch(/setState\([^)]*standbySessionId[^)]*null/);
  });
});
