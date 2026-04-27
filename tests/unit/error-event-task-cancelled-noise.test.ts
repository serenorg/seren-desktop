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
  it("the case 'error' branch detects 'Task cancelled' before the diagnostic console.error fires", () => {
    // The cancel-detection check must precede the diagnostic console.error
    // so the call site can pick the string-only signature for graceful
    // cancels. Otherwise the support hook captures the Error instance
    // before our existing graceful-cancel handler runs.
    const detectIdx = errorCaseBody.indexOf('"Task cancelled"');
    const consoleIdx = errorCaseBody.indexOf("console.error(");
    expect(detectIdx, "Task cancelled string must exist").toBeGreaterThan(0);
    expect(consoleIdx, "console.error must exist").toBeGreaterThan(0);
    expect(detectIdx).toBeLessThan(consoleIdx);
  });

  it("the graceful-cancel branch calls console.error WITHOUT forwarding event.data.error", () => {
    // Mirror #1699: log strings only so the support hook's capture filter
    // (Error instance / stack-bearing object) does not forward this to
    // the Gateway. Real errors continue to forward the Error instance.
    const cancelBranchIdx = errorCaseBody.indexOf("isGracefulCancel");
    expect(
      cancelBranchIdx,
      "isGracefulCancel guard must exist in case 'error'",
    ).toBeGreaterThan(0);
    // First console.error after the guard must NOT pass event.data.error
    // as a forwarded Error candidate. Bound the search so we don't bleed
    // into the non-cancel branch.
    const region = errorCaseBody.slice(
      cancelBranchIdx,
      cancelBranchIdx + 600,
    );
    const firstConsoleErr = region.indexOf("console.error(");
    expect(firstConsoleErr).toBeGreaterThan(0);
    const elseIdx = region.indexOf("} else {");
    expect(elseIdx).toBeGreaterThan(firstConsoleErr);
    const cancelBranchOnly = region.slice(firstConsoleErr, elseIdx);
    expect(cancelBranchOnly).not.toMatch(/event\.data\.error/);
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
