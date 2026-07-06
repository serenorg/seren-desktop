// ABOUTME: Source-level regression for #1708 — graceful "Task cancelled"
// ABOUTME: events must not be captured by the support pipeline as bug reports.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

// Slice the body of the `case "error":` branch in handleSessionEvent so
// substring assertions are scoped to just this branch. There's an
// unrelated `case "error":` in another switch — anchor on the block-open
// brace to disambiguate, and on the next case clause to bound the slice.
const errorCaseStart = agentStoreSource.indexOf('case "error": {');
const errorCaseEnd = agentStoreSource.indexOf(
  'case "permissionRequest":',
  errorCaseStart,
);
const errorCaseBody = agentStoreSource.slice(errorCaseStart, errorCaseEnd);

describe("#1708 — graceful 'Task cancelled' is logged without firing capture", () => {
  it("the case 'error' branch detects 'Task cancelled' before the benign suppression fires", () => {
    // The cancel-detection check must precede the diagnostic log so the call
    // site can route graceful cancels through benignConsoleError. Otherwise a
    // real reporting path could fire before our graceful-cancel handler runs.
    const detectIdx = errorCaseBody.indexOf('"Task cancelled"');
    const suppressIdx = errorCaseBody.indexOf("benignConsoleError(");
    expect(detectIdx, "Task cancelled string must exist").toBeGreaterThan(0);
    expect(suppressIdx, "benignConsoleError must exist").toBeGreaterThan(0);
    expect(detectIdx).toBeLessThan(suppressIdx);
  });

  it("the graceful-cancel branch suppresses via benignConsoleError without forwarding event.data.error", () => {
    // Post-#2864: route graceful cancels through the explicit benign helper so
    // they never report, and never forward event.data.error. Real errors
    // continue to forward the Error instance in the else branch below.
    const cancelBranchIdx = errorCaseBody.indexOf("if (isGracefulCancel) {");
    expect(
      cancelBranchIdx,
      "isGracefulCancel branch must exist in case 'error'",
    ).toBeGreaterThan(0);
    // Bound the slice to just the cancel branch (up to the else-if).
    const region = errorCaseBody.slice(cancelBranchIdx, cancelBranchIdx + 400);
    const branchEnd = region.indexOf("} else");
    expect(branchEnd).toBeGreaterThan(0);
    const cancelBranchOnly = region.slice(0, branchEnd);
    expect(cancelBranchOnly).toMatch(
      /benignConsoleError\(\s*"agent\.graceful_cancel"/,
    );
    expect(cancelBranchOnly).not.toMatch(/event\.data\.error/);
    expect(cancelBranchOnly).not.toMatch(/console\.error\(/);
    expect(cancelBranchOnly).not.toMatch(/reportError\(/);
  });

  it("the non-cancel branch still forwards event.data.error so real defects are captured", () => {
    // Guard against a regression that silences ALL "error" events.
    const cancelBranchIdx = errorCaseBody.indexOf("isGracefulCancel");
    const region = errorCaseBody.slice(
      cancelBranchIdx,
      cancelBranchIdx + 800,
    );
    const elseIdx = region.indexOf("} else {");
    expect(elseIdx).toBeGreaterThan(0);
    const elseBranch = region.slice(elseIdx, elseIdx + 400);
    expect(elseBranch).toContain("console.error(");
    expect(elseBranch).toContain("event.data.error");
  });
});
