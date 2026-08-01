// ABOUTME: Critical guard for #3192 — bounded Claude sessions cannot spawn without an OS launcher.
// ABOUTME: Verifies the wrapper shape and the fail-closed missing-profile path without spawning a process.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _buildClaudeSpawnInvocation: buildClaudeSpawnInvocation,
} = await import(/* @vite-ignore */ modulePath);

describe("Claude bounded spawn boundary (#3192)", () => {
  const withDarwin = (callback: () => void) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    try {
      callback();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  };

  it("wraps a bounded session with sandbox-exec and the supplied profile", () => {
    withDarwin(() => {
      expect(
        buildClaudeSpawnInvocation({
          claudeBin: "/usr/local/bin/claude",
          claudeArgs: ["--version"],
          sandboxMode: "workspace-write",
          sandboxProfile: { kind: "seatbelt", profile: "(version 1)" },
        }),
      ).toEqual({
        command: "/usr/bin/sandbox-exec",
        args: ["-p", "(version 1)", "/usr/local/bin/claude", "--version"],
        shell: false,
      });
    });
  });

  const withLinux = (callback: () => void) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      callback();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  };

  it("wraps Linux bounded sessions with the app-binary launcher", () => {
    withLinux(() => {
      expect(
        buildClaudeSpawnInvocation({
          claudeBin: "/usr/local/bin/claude",
          claudeArgs: ["--version"],
          sandboxMode: "workspace-write",
          sandboxProfile: {
            kind: "linux-launcher",
            launcherPath: "/opt/Seren",
            policyBase64: "encoded-policy",
          },
        }),
      ).toEqual({
        command: "/opt/Seren",
        args: [
          "__seren-sandbox-run",
          "encoded-policy",
          "--",
          "/usr/local/bin/claude",
          "--version",
        ],
        shell: false,
      });
    });
  });

  it("throws before spawning when a bounded session has no profile", () => {
    withDarwin(() => {
      expect(() =>
        buildClaudeSpawnInvocation({
          claudeBin: "/usr/local/bin/claude",
          claudeArgs: [],
          sandboxMode: "read-only",
          sandboxProfile: null,
        }),
      ).toThrow(/verified macOS sandbox profile is missing/);
    });
  });

  it("throws before spawning when a Linux bounded session has no launcher", () => {
    withLinux(() => {
      expect(() =>
        buildClaudeSpawnInvocation({
          claudeBin: "/usr/local/bin/claude",
          claudeArgs: [],
          sandboxMode: "read-only",
          sandboxProfile: null,
        }),
      ).toThrow(/verified Linux sandbox launcher is missing/);
    });
  });

  const withWindows = (callback: () => void) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      callback();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  };

  it("wraps Windows bounded sessions with the app-binary launcher", () => {
    withWindows(() => {
      expect(
        buildClaudeSpawnInvocation({
          claudeBin: "C:\\Program Files\\Claude\\claude.exe",
          claudeArgs: ["--version"],
          sandboxMode: "workspace-write",
          sandboxProfile: {
            kind: "windows-launcher",
            launcherPath: "C:\\Program Files\\Seren\\Seren.exe",
            policyBase64: "encoded-policy",
          },
        }),
      ).toEqual({
        command: "C:\\Program Files\\Seren\\Seren.exe",
        args: [
          "__seren-sandbox-run",
          "encoded-policy",
          "--",
          "C:\\Program Files\\Claude\\claude.exe",
          "--version",
        ],
        shell: false,
      });
    });
  });

  it("throws before spawning when a Windows bounded session has no launcher", () => {
    withWindows(() => {
      expect(() =>
        buildClaudeSpawnInvocation({
          claudeBin: "C:\\Program Files\\Claude\\claude.exe",
          claudeArgs: [],
          sandboxMode: "read-only",
          sandboxProfile: null,
        }),
      ).toThrow(/verified Windows sandbox launcher is missing/);
    });
  });

  it("leaves full-access sessions unwrapped", () => {
    withDarwin(() => {
      expect(
        buildClaudeSpawnInvocation({
          claudeBin: "/usr/local/bin/claude",
          claudeArgs: ["--version"],
          sandboxMode: "full-access",
          sandboxProfile: null,
        }),
      ).toEqual({
        command: "/usr/local/bin/claude",
        args: ["--version"],
        shell: false,
      });
    });
  });

  it("quotes every argument when Windows launches a .cmd shim through cmd.exe", () => {
    withWindows(() => {
      const invocation = buildClaudeSpawnInvocation({
        claudeBin: "C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd",
        claudeArgs: [
          "--mcp-config",
          "C:\\Users\\First Last\\AppData\\Local\\Temp\\seren-mcp-1.json",
          "--strict-mcp-config",
        ],
        sandboxMode: "full-access",
        sandboxProfile: null,
      });

      expect(invocation.shell).toBe("cmd.exe");
      expect(invocation.args).toEqual([]);
      // cmd.exe joins on spaces, so each argument carries its own quotes or a
      // path containing a space splits into two arguments.
      expect(invocation.command).toBe(
        '"C:\\Users\\First Last\\AppData\\Roaming\\npm\\claude.cmd" ' +
          '"--mcp-config" ' +
          '"C:\\Users\\First Last\\AppData\\Local\\Temp\\seren-mcp-1.json" ' +
          '"--strict-mcp-config"',
      );
    });
  });

  it("launches a native Windows executable without a shell", () => {
    withWindows(() => {
      expect(
        buildClaudeSpawnInvocation({
          claudeBin: "C:\\Program Files\\claude\\claude.exe",
          claudeArgs: ["--version"],
          sandboxMode: "full-access",
          sandboxProfile: null,
        }),
      ).toEqual({
        command: "C:\\Program Files\\claude\\claude.exe",
        args: ["--version"],
        shell: false,
      });
    });
  });
});
