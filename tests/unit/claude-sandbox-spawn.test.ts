// ABOUTME: Critical guard for #3192 — bounded macOS Claude sessions cannot spawn without Seatbelt.
// ABOUTME: Verifies the wrapper shape and the fail-closed missing-profile path without spawning a process.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _buildClaudeSpawnInvocation: buildClaudeSpawnInvocation,
} = await import(/* @vite-ignore */ modulePath);

describe("Claude macOS Seatbelt spawn boundary (#3192)", () => {
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
          sandboxProfile: "(version 1)",
        }),
      ).toEqual({
        command: "/usr/bin/sandbox-exec",
        args: ["-p", "(version 1)", "/usr/local/bin/claude", "--version"],
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
});
