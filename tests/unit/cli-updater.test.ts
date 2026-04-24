// ABOUTME: Critical tests for #1637 — background CLI updater pure logic.
// ABOUTME: Guards TTL gate, semver compare, and same-channel classification.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/cli-updater.mjs",
  import.meta.url,
).href;
const {
  UPDATE_CHECK_TTL_MS,
  isNewer,
  classifyInstallChannel,
  backgroundUpdateCli,
} = await import(/* @vite-ignore */ modulePath);

describe("isNewer", () => {
  it("returns true when latest > installed on any semver component", () => {
    expect(isNewer("1.4.2", "1.5.0")).toBe(true);
    expect(isNewer("1.5.0", "1.5.1")).toBe(true);
    expect(isNewer("1.5.0", "2.0.0")).toBe(true);
  });

  it("returns false when installed >= latest — avoids downgrades", () => {
    expect(isNewer("1.5.0", "1.5.0")).toBe(false);
    expect(isNewer("1.5.1", "1.5.0")).toBe(false);
    expect(isNewer("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns false when either version has a pre-release suffix — conservative by design", () => {
    expect(isNewer("1.5.0-beta.1", "1.5.0")).toBe(false);
    expect(isNewer("1.5.0", "1.5.1-rc.1")).toBe(false);
    expect(isNewer("1.5.0", "1.5.0")).toBe(false);
  });

  it("returns false on malformed or non-string input — silent fail, not throw", () => {
    expect(isNewer("not-a-version", "1.5.0")).toBe(false);
    expect(isNewer("", "1.5.0")).toBe(false);
    expect(isNewer(null as unknown as string, "1.5.0")).toBe(false);
    expect(isNewer("1.5.0", undefined as unknown as string)).toBe(false);
  });
});

describe("classifyInstallChannel", () => {
  it("flags bare command fallback as unresolved so we skip the update entirely", () => {
    expect(classifyInstallChannel("codex", "codex")).toBe("unresolved");
    expect(classifyInstallChannel("claude", "claude")).toBe("unresolved");
  });

  it.each([
    ["/Users/u/.claude/bin/claude", "claude"],
    ["/Users/u/.local/bin/claude", "claude"],
    ["C:\\Users\\u\\.claude\\bin\\claude.exe", "claude"],
    ["C:\\Users\\u\\.local\\bin\\claude.exe", "claude"],
  ])("recognizes %s as native so we use the native updater", (p, cmd) => {
    expect(classifyInstallChannel(p, cmd)).toBe("native");
  });

  it.each([
    ["C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd", "codex"],
    ["/usr/local/bin/codex", "codex"],
    ["/opt/homebrew/bin/claude", "claude"],
  ])("recognizes %s as npm so we use npm install -g", (p, cmd) => {
    expect(classifyInstallChannel(p, cmd)).toBe("npm");
  });
});

describe("backgroundUpdateCli TTL gate", () => {
  it("skips when lastUpdateCheck is within 24h — no npm calls, no state mutation timing", async () => {
    const state = {
      "lastUpdateCheck:codex": Date.now() - 1000, // 1s ago
    };
    const result = await backgroundUpdateCli({
      label: "Codex",
      bareCommand: "codex",
      resolvedPath: "/usr/local/bin/codex",
      packageName: "@openai/codex",
      state,
      now: Date.now(),
    });
    expect(result).toEqual({ skipped: "ttl" });
  });

  it("proceeds past TTL when last check is older than 24h", async () => {
    const state = {
      "lastUpdateCheck:codex": Date.now() - (UPDATE_CHECK_TTL_MS + 1),
    };
    // No `onUpdated` wired and the binary path does not exist, so
    // runInstalledVersion will return null and we record a "up_to_date"
    // skip once npm view also fails (offline / no package). The important
    // assertion is that we DIDN'T short-circuit on TTL.
    const result = await backgroundUpdateCli({
      label: "Codex",
      bareCommand: "codex",
      resolvedPath: "/nonexistent/codex",
      packageName: "@seren-test/definitely-not-a-real-package-xyz",
      state,
      now: Date.now(),
    });
    expect(result.skipped).not.toBe("ttl");
  });

  it("skips when resolver returned the bare command — never creates a shadow install", async () => {
    const result = await backgroundUpdateCli({
      label: "Codex",
      bareCommand: "codex",
      resolvedPath: "codex", // resolver fell through to bare
      packageName: "@openai/codex",
      state: {},
      now: Date.now(),
    });
    expect(result).toEqual({ skipped: "unresolved" });
  });
});
