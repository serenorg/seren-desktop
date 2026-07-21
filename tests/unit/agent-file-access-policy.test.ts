// ABOUTME: Critical regression guards for project-scoped local-agent file access (#3091).
// ABOUTME: Preserves promptless in-project work while preventing silent boundary escapes.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-ignore - browser-local runtime is plain ESM.
import { evaluateFileAccess } from "../../bin/browser-local/file-access-policy.mjs";

const claudeModulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const { _buildClaudePolicySettings: buildClaudePolicySettings } = await import(
  /* @vite-ignore */ claudeModulePath
);
const geminiModulePath = new URL(
  "../../bin/browser-local/gemini-runtime.mjs",
  import.meta.url,
).href;
const { _geminiSandboxEnv: geminiSandboxEnv } = await import(
  /* @vite-ignore */ geminiModulePath
);
const claudeHookPath = fileURLToPath(
  new URL("../../bin/browser-local/claude-file-policy-hook.mjs", import.meta.url),
);

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), "seren-file-policy-"));
}

describe("local-agent file access policy (#3091)", () => {
  it("keeps reads and writes inside the active project automatic", () => {
    const root = tempProject();
    mkdirSync(path.join(root, "src"));

    for (const kind of ["read", "write"] as const) {
      const result = evaluateFileAccess({
        requestedPath: path.join(root, "src", "new-file.ts"),
        projectRoot: root,
        kind,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        autoApproveReads: true,
      });
      expect(result.decision).toBe("allow");
    }
  });

  it("canonicalizes symlinks and does not treat sibling prefixes as project paths", () => {
    const root = tempProject();
    const outside = tempProject();
    const link = path.join(root, "outside-link");
    symlinkSync(outside, link, "dir");

    for (const requestedPath of [
      path.join(link, "secret.txt"),
      `${root}-sibling/secret.txt`,
    ]) {
      const result = evaluateFileAccess({
        requestedPath,
        projectRoot: root,
        kind: "read",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      });
      expect(result.decision).toBe("deny");
    }
  });

  it("keeps Full Access as the explicit escape hatch", () => {
    const root = tempProject();
    const outside = tempProject();
    const result = evaluateFileAccess({
      requestedPath: path.join(outside, "file.txt"),
      projectRoot: root,
      kind: "write",
      sandboxMode: "full-access",
      approvalPolicy: "never",
    });
    expect(result.decision).toBe("allow");
  });
});

describe("Claude promptless containment (#3091)", () => {
  it("adds a mandatory file hook and Bash sandbox without changing permission mode", () => {
    const root = tempProject();
    const settings = buildClaudePolicySettings({
      cwd: root,
      sandboxMode: "workspace-write",
      networkEnabled: false,
    });

    expect(settings.hooks.PreToolUse[0].matcher).toContain("Read");
    expect(settings.hooks.PreToolUse[0].matcher).toContain("Write");
    if (process.platform !== "win32") {
      expect(settings.sandbox.enabled).toBe(true);
      expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
      expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
      expect(settings.sandbox.filesystem.allowRead).toEqual([root]);
    }
  });

  it("stays silent in-project and asks only for exceptional external access", () => {
    const root = tempProject();
    const outside = tempProject();
    const runHook = (filePath: string) =>
      spawnSync(process.execPath, [claudeHookPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          SEREN_AGENT_PROJECT_ROOT: root,
          SEREN_AGENT_SANDBOX_MODE: "workspace-write",
          SEREN_AGENT_APPROVAL_POLICY: "on-request",
          SEREN_AGENT_AUTO_APPROVE_READS: "true",
          SEREN_AGENT_NETWORK_ENABLED: "true",
        },
        input: JSON.stringify({
          tool_name: "Read",
          tool_input: { file_path: filePath },
        }),
      });

    expect(runHook(path.join(root, "README.md")).stdout).toBe("");
    const exceptional = JSON.parse(
      runHook(path.join(outside, "outside.txt")).stdout,
    );
    expect(
      exceptional.hookSpecificOutput.permissionDecision,
    ).toBe("ask");
  });
});

describe("Gemini ACP containment (#3091)", () => {
  it("enables Gemini's project sandbox except for explicit Full Access", () => {
    expect(
      geminiSandboxEnv({
        sandboxMode: "workspace-write",
        networkEnabled: true,
      }).GEMINI_SANDBOX,
    ).toBe("true");
    expect(
      geminiSandboxEnv({
        sandboxMode: "full-access",
        networkEnabled: true,
      }).GEMINI_SANDBOX,
    ).toBe("false");
  });
});
