// ABOUTME: Source-level regression tests for #151 — Runtime RPC timeouts on
// ABOUTME: spawn must not be captured by the support pipeline as a bug.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const supportHookSource = readFileSync(
  resolve("src/lib/support/hook.ts"),
  "utf-8",
);

describe("#151 — RPC timeout in spawn catch is logged without firing capture", () => {
  it("the spawn catch branches on 'Runtime RPC timed out' and logs strings only", () => {
    // The support hook captures console.error only when an Error instance (or
    // an object with a stack) is in the args. Passing the message as a
    // string skips the capture path. Verify the branch exists and uses a
    // string-only call.
    const catchIdx = agentStoreSource.indexOf("Spawn error (");
    expect(catchIdx, "spawn catch must exist").toBeGreaterThan(0);
    // The branch should pivot on the timeout substring.
    const branchIdx = agentStoreSource.indexOf(
      'message.includes("Runtime RPC timed out")',
    );
    expect(
      branchIdx,
      "RPC-timeout branch must exist in spawn catch",
    ).toBeGreaterThan(0);
    // The timeout branch must call console.error WITHOUT passing the Error
    // object (string-only signature).
    const region = agentStoreSource.slice(branchIdx, branchIdx + 600);
    expect(region).toMatch(
      /console\.error\(\s*`\[AgentStore\] Spawn error[^`]*runtime unresponsive: \$\{message\}`,?\s*\)/,
    );
    // No Error instance forwarded in the timeout branch.
    const timeoutBranchEnd = region.indexOf("} else {");
    expect(timeoutBranchEnd).toBeGreaterThan(0);
    const timeoutBranchOnly = region.slice(0, timeoutBranchEnd);
    expect(timeoutBranchOnly).not.toMatch(/console\.error\([^)]*,\s*error\b/);
  });

  it("the non-timeout branch still forwards the Error so support capture fires", () => {
    // Real spawn defects (not a wedged runtime) must continue to be
    // captured. Guard against a regression that silences ALL spawn errors.
    const branchIdx = agentStoreSource.indexOf(
      'message.includes("Runtime RPC timed out")',
    );
    const region = agentStoreSource.slice(branchIdx, branchIdx + 800);
    const elseIdx = region.indexOf("} else {");
    expect(elseIdx).toBeGreaterThan(0);
    const elseBranch = region.slice(elseIdx, elseIdx + 400);
    // The else branch must call console.error and forward the raw `error`
    // object as a separate arg.
    expect(elseBranch).toContain("console.error(");
    expect(elseBranch).toMatch(/,\s*error,?\s*\)/);
  });
});

describe("#151 — support hook capture contract is what we are exploiting", () => {
  it("captures only when args include an Error instance or object with stack", () => {
    // Encode the contract the spawn catch relies on. If this guard breaks
    // (e.g. the hook starts capturing string-only console.error), we need
    // to switch to console.warn in spawn instead.
    expect(supportHookSource).toContain(
      "arg instanceof Error ||",
    );
    expect(supportHookSource).toMatch(
      /const candidate = args\.find\([\s\S]*?\);[\s\S]*?if \(!candidate\) return;/,
    );
  });
});
