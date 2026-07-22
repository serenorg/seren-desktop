// ABOUTME: Critical regression guards for project-scoped local-agent file access (#3091).
// ABOUTME: Preserves promptless in-project work while preventing silent boundary escapes.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path, { resolve } from "node:path";
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

  it("keeps the agent startable and $HOME toolchains usable", () => {
    const settings = buildClaudePolicySettings({
      cwd: tempProject(),
      sandboxMode: "workspace-write",
      networkEnabled: false,
    });
    if (process.platform === "win32") return;

    // A missing bubblewrap/socat must block the Claude Code launch instead of
    // warning and continuing without an OS boundary. #3138, #3192
    expect(settings.sandbox.failIfUnavailable).toBe(true);

    // Denying all of ~/ also hides ~/.gitconfig and $HOME toolchains, which
    // breaks git commit and most build commands. #3139
    const denyRead: string[] = settings.sandbox.filesystem.denyRead;
    expect(denyRead).not.toContain("~/");
    expect(denyRead).toContain("~/.aws");
    expect(denyRead).toContain("~/.ssh");
    for (const readable of ["~/.gitconfig", "~/.nvm", "~/.cargo", "~/.pyenv"]) {
      expect(denyRead).not.toContain(readable);
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

describe("Windows shell boundary is denied until Full Access (#3149, #3192)", () => {
  const settingsPanel = readFileSync(
    resolve("src/components/settings/SettingsPanel.tsx"),
    "utf8",
  );
  const claudeRuntime = readFileSync(
    resolve("bin/browser-local/claude-runtime.mjs"),
    "utf8",
  );

  it("keeps Bash out of the hook matcher, which cannot bound a shell string", () => {
    // The hook intentionally covers built-in file tools only. Native Windows
    // uses the policy deny rule below rather than pretending to parse paths
    // out of arbitrary shell strings.
    const settings = buildClaudePolicySettings({
      cwd: tempProject(),
      sandboxMode: "workspace-write",
      networkEnabled: false,
    });
    expect(settings.hooks.PreToolUse[0].matcher).not.toContain("Bash");
    expect(claudeRuntime).toContain("#3192");
  });

  it("denies Bash for bounded native-Windows modes but not Full Access", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      for (const sandboxMode of ["read-only", "workspace-write"] as const) {
        const settings = buildClaudePolicySettings({
          cwd: tempProject(),
          sandboxMode,
          networkEnabled: false,
        });
        expect(settings.permissions.deny).toContain("Bash");
        expect(settings.sandbox).toBeUndefined();
      }

      expect(
        buildClaudePolicySettings({
          cwd: tempProject(),
          sandboxMode: "full-access",
          networkEnabled: false,
        }),
      ).toEqual({});
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("tells Windows users shell commands are disabled unless Full Access", () => {
    expect(settingsPanel).toContain("isWindowsPlatform");
    const noteAt = settingsPanel.indexOf("shell commands are disabled unless Full");
    expect(noteAt).toBeGreaterThan(-1);
    const gateAt = settingsPanel.lastIndexOf("isWindowsPlatform()", noteAt);
    expect(gateAt).toBeGreaterThan(-1);
    expect(settingsPanel.slice(gateAt, noteAt)).not.toContain("</Show>");
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
