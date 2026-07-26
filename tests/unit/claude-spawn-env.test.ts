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

  it("forwards Anthropic auth/model env so the CLI is not left 'Not logged in'", () => {
    const keys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-or-test-token";
    process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
    process.env.ANTHROPIC_API_KEY = ""; // must survive as an empty string
    try {
      const env = buildClaudeSpawnEnv({
        childEnv: {},
        extendedPath: "/runtime/bin",
        cwd: "/workspace/project",
        sandboxMode: "workspace-write",
        sandboxProfile: null,
        approvalPolicy: "on-request",
        autoApproveReads: true,
        networkEnabled: true,
      });
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test-token");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
      expect(env.ANTHROPIC_API_KEY).toBe("");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
