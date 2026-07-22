// ABOUTME: Critical guard for #2810 — fresh Claude threads default to Bypass Permissions.
// ABOUTME: Verifies the approval-policy → permission-mode seed so new threads land on bypass.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _DEFAULT_PREFERRED_MODE: DEFAULT_PREFERRED_MODE,
  _claudeModeFromApprovalPolicy: claudeModeFromApprovalPolicy,
} = await import(/* @vite-ignore */ modulePath);

describe("DEFAULT_PREFERRED_MODE — fresh-session out-of-box permission mode (#2810)", () => {
  it("is bypassPermissions so new Claude threads auto-approve without re-selection", () => {
    expect(DEFAULT_PREFERRED_MODE).toBe("bypassPermissions");
  });
});

describe("claudeModeFromApprovalPolicy — fresh-session seed (#2810)", () => {
  it("keeps the default 'on-request' policy in the normal prompt mode (#3192)", () => {
    // 'on-request' is the shipped default agentApprovalPolicy. It must not
    // inherit the bypassPermissions seed, because that silently removes the
    // approval boundary from fresh sessions.
    expect(claudeModeFromApprovalPolicy("on-request")).toBe("default");
  });

  it("keeps 'never' on bypassPermissions", () => {
    expect(claudeModeFromApprovalPolicy("never")).toBe("bypassPermissions");
  });

  it("falls back to bypassPermissions for unknown / unset policies", () => {
    expect(claudeModeFromApprovalPolicy(undefined)).toBe("bypassPermissions");
    expect(claudeModeFromApprovalPolicy("something-else")).toBe(
      "bypassPermissions",
    );
  });

  it("honors an explicitly stricter policy by downgrading to acceptEdits", () => {
    expect(claudeModeFromApprovalPolicy("untrusted")).toBe("acceptEdits");
    expect(claudeModeFromApprovalPolicy("on-failure")).toBe("acceptEdits");
  });
});
