// ABOUTME: Ensures Claude's child environment is a deliberate allowlist, not a parent-env clone.
// ABOUTME: A canary secret must never cross into the agent process tree.

import { afterEach, describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const { _buildClaudeSpawnEnv: buildClaudeSpawnEnv } = await import(
  /* @vite-ignore */ modulePath
);

const CANARY_ENV_NAME = "SEREN_PARENT_CANARY_SECRET";
const originalCanary = process.env[CANARY_ENV_NAME];

afterEach(() => {
  if (originalCanary === undefined) {
    delete process.env[CANARY_ENV_NAME];
  } else {
    process.env[CANARY_ENV_NAME] = originalCanary;
  }
});

describe("Claude spawn environment (#3194)", () => {
  it("passes the generated PATH and session child values but not parent secrets", () => {
    process.env[CANARY_ENV_NAME] = "canary-parent-secret";

    const env = buildClaudeSpawnEnv({
      childEnv: { SEREN_MCP_CAPABILITY_TOKEN: "session-capability" },
      extendedPath: "/runtime/bin:/usr/bin",
      cwd: "/workspace/project",
      sandboxMode: "workspace-write",
      sandboxProfile: { kind: "seatbelt", profile: "(version 1)" },
      approvalPolicy: "on-request",
      autoApproveReads: true,
      networkEnabled: true,
    });

    expect(env.PATH).toBe("/runtime/bin:/usr/bin");
    expect(env.SEREN_MCP_CAPABILITY_TOKEN).toBe("session-capability");
    expect(env.SEREN_AGENT_PROJECT_ROOT).toBe("/workspace/project");
    expect(env[CANARY_ENV_NAME]).toBeUndefined();
    expect(Object.values(env)).not.toContain("canary-parent-secret");
  });
});
