// ABOUTME: Critical tests for #1637 — background CLI updater pure logic.
// ABOUTME: Guards TTL gate, semver compare, and same-channel classification.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/cli-updater.mjs",
  import.meta.url,
).href;
const {
  UPDATE_CHECK_TTL_MS,
  isNewer,
  classifyInstallChannel,
  backgroundUpdateCli,
  loadState,
  saveState,
  _formatOutcomeLog,
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
    expect(result).toMatchObject({ outcome: "skipped:ttl", skipped: "ttl" });
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
    expect(result).toMatchObject({
      outcome: "skipped:unresolved",
      skipped: "unresolved",
    });
  });
});

describe("outcome logging (#1646)", () => {
  it("formats one structured line per outcome with cli + outcome + transition + flags", () => {
    expect(
      _formatOutcomeLog({
        packageName: "@anthropic-ai/claude-code",
        outcome: "success",
        details: { from: "1.5.2", to: "1.5.3", tarballSha512: "abc" },
      }),
    ).toBe(
      "[cli-updater] cli=@anthropic-ai/claude-code outcome=success from=1.5.2 to=1.5.3 tarballSha512=abc",
    );
  });

  it("includes the flag list on scan_rejected so the user-facing log says WHY", () => {
    const line = _formatOutcomeLog({
      packageName: "@anthropic-ai/claude-code",
      outcome: "skipped:scan_rejected",
      details: {
        version: "1.5.4",
        flags: ["new_install_script:postinstall", "new_dependency:plain-crypto-js"],
      },
    });
    expect(line).toContain("outcome=skipped:scan_rejected");
    expect(line).toContain("version=1.5.4");
    expect(line).toContain(
      "flags=new_install_script:postinstall,new_dependency:plain-crypto-js",
    );
  });

  it("emits a single line for the cheapest outcomes — no version, no flags, just the enum", () => {
    expect(
      _formatOutcomeLog({
        packageName: "@openai/codex",
        outcome: "skipped:ttl",
        details: {},
      }),
    ).toBe("[cli-updater] cli=@openai/codex outcome=skipped:ttl");
  });
});

describe("atomic state writes (#1644)", () => {
  let tempDir: string;
  let stateFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "seren-cli-updater-test-"));
    stateFile = path.join(tempDir, "cli-update-state.json");
    originalEnv = process.env.SEREN_CLI_UPDATER_STATE_PATH;
    process.env.SEREN_CLI_UPDATER_STATE_PATH = stateFile;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEREN_CLI_UPDATER_STATE_PATH;
    } else {
      process.env.SEREN_CLI_UPDATER_STATE_PATH = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips state across save+load — basic correctness", () => {
    const written = { "lastUpdateCheck:codex": 1234567890 };
    saveState(written);
    expect(loadState()).toEqual(written);
  });

  it("does not leave a .tmp file behind on a successful save — temp rename completed", () => {
    saveState({ ok: 1 });
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
  });

  it("preserves the prior known-good state when a partial .tmp from a prior crash exists — the rename is atomic, the tmp from the failed run does not corrupt loadState", () => {
    saveState({ "lastUpdateCheck:codex": 100 });
    // Simulate a prior crash mid-write: a stale .tmp exists with garbage,
    // and the real state file is untouched. loadState must still read the
    // good file, not the .tmp.
    writeFileSync(`${stateFile}.tmp`, "{ this is not valid json", "utf8");
    expect(loadState()).toEqual({ "lastUpdateCheck:codex": 100 });
  });

  it("returns {} on a corrupted state file rather than throwing — silent recovery", () => {
    writeFileSync(stateFile, "{ corrupt", "utf8");
    expect(loadState()).toEqual({});
  });

  // Regression for #1655. Two backgroundUpdateCli calls (Codex + Claude) run
  // concurrently from agent-registry; each does loadState → mutate → saveState.
  // Before the merge-on-write fix the second save clobbered the first save's
  // per-CLI key (last-write-wins), which is what stranded one user's
  // lastUpdateCheck:codex on disk and made the TTL gate misfire.
  it("merges with on-disk keys on save so a partial write does not drop sibling keys (#1655)", () => {
    saveState({
      "lastUpdateCheck:codex": 100,
      "lastUpdateCheck:claude": 200,
    });
    // Simulate the Claude arm saving a snapshot it loaded BEFORE the Codex
    // arm's :codex write landed — i.e. the in-memory object only has :claude.
    saveState({ "lastUpdateCheck:claude": 999 });
    expect(loadState()).toEqual({
      "lastUpdateCheck:codex": 100,
      "lastUpdateCheck:claude": 999,
    });
  });
});

describe("failure paths (#1645)", () => {
  let tempDir: string;
  let stateFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "seren-failpath-test-"));
    stateFile = path.join(tempDir, "cli-update-state.json");
    originalEnv = process.env.SEREN_CLI_UPDATER_STATE_PATH;
    process.env.SEREN_CLI_UPDATER_STATE_PATH = stateFile;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEREN_CLI_UPDATER_STATE_PATH;
    } else {
      process.env.SEREN_CLI_UPDATER_STATE_PATH = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Fresh state per test — spreading baseInvocation otherwise leaks the
  // mutated state object between tests (TTL gets seeded by run #1 and
  // every subsequent run short-circuits on TTL).
  function freshInvocation() {
    return {
      label: "Codex",
      bareCommand: "codex",
      resolvedPath: "/usr/local/bin/codex",
      packageName: "@openai/codex",
      state: {} as Record<string, unknown>,
      now: Date.now(),
    };
  }

  it("registry unreachable returns skipped:network distinct from up_to_date — operator can tell the registry is down", async () => {
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.0",
        runNpmView: async () => null, // network/timeout/registry error
      },
    });
    expect(result).toMatchObject({
      outcome: "skipped:network",
      installed: "1.5.0",
    });
  });

  it("malformed npm view response (non-semver string) does not crash — graceful skip", async () => {
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.0",
        runNpmView: async () => "not-a-version",
      },
    });
    // isNewer returns false on non-semver strings, so we land in up_to_date.
    // Crucially: no throw, no scan attempt, nothing installed.
    expect(result.outcome).toBe("skipped:up_to_date");
  });

  it("missing CLI binary on disk does not trigger an install — no installed version means we cannot compare safely", async () => {
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      resolvedPath: "/this/path/definitely/does/not/exist",
      _versionOverrides: {
        // Production runInstalledVersion returns null when the path is absent;
        // the override mirrors that behavior explicitly.
        runInstalledVersion: async () => null,
        runNpmView: async () => "1.5.3",
      },
    });
    // No install path was taken because we never resolved an installed
    // version to diff against. up_to_date is the safe outcome here.
    expect(result.outcome).toBe("skipped:up_to_date");
  });

  it("install_failed when the install subprocess throws — bookkeeping persisted, not silent", async () => {
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.0",
        runNpmView: async () => "1.5.3",
      },
      _scannerOverrides: {
        npmPackToDirectory: async () => "/tmp/fake.tgz",
        scanTarball: async () => ({
          verdict: "pass",
          flags: [],
          candidate: {
            version: "1.5.3",
            tarballSha512: "abc",
            installScripts: {},
            declaredDependencies: [],
            files: [],
            fileHashes: {},
          },
        }),
        runNpmInstallFromTarball: async () => {
          throw new Error("network error");
        },
      },
    });
    expect(result).toMatchObject({
      outcome: "skipped:install_failed",
      from: "1.5.0",
      to: "1.5.3",
    });
  });

  it("scan_rejected with the actual flag list propagates — the user-facing log will say WHY", async () => {
    const flags = ["new_install_script:postinstall", "new_dependency:plain-crypto-js"];
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.3",
        runNpmView: async () => "1.5.4",
      },
      _scannerOverrides: {
        npmPackToDirectory: async () => "/tmp/fake.tgz",
        scanTarball: async () => ({ verdict: "reject", flags, candidate: null }),
        runNpmInstallFromTarball: async () => {
          throw new Error("must NOT install when scan rejects");
        },
      },
    });
    expect(result).toMatchObject({
      outcome: "skipped:scan_rejected",
      from: "1.5.3",
      to: "1.5.4",
      flags,
    });
  });

  it("scan_error fails closed when the scanner itself throws — never installs on scanner crash", async () => {
    let installCalled = false;
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.0",
        runNpmView: async () => "1.5.3",
      },
      _scannerOverrides: {
        npmPackToDirectory: async () => "/tmp/fake.tgz",
        scanTarball: async () => {
          throw new Error("scanner exploded");
        },
        runNpmInstallFromTarball: async () => {
          installCalled = true;
        },
      },
    });
    expect(installCalled).toBe(false);
    expect(result.outcome).toBe("skipped:scan_error");
  });

  it("first install (no_baseline) proceeds with the install but seeds the baseline — subsequent updates ARE scanned", async () => {
    const candidate = {
      version: "1.5.3",
      tarballSha512: "abc",
      installScripts: {},
      declaredDependencies: ["foo"],
      files: ["package.json"],
      fileHashes: { "package.json": "h" },
    };
    let installCalled = false;
    const result = await backgroundUpdateCli({
      ...freshInvocation(),
      _versionOverrides: {
        runInstalledVersion: async () => "1.5.0",
        runNpmView: async () => "1.5.3",
      },
      _scannerOverrides: {
        npmPackToDirectory: async () => "/tmp/fake.tgz",
        scanTarball: async () => ({
          verdict: "no_baseline",
          flags: [],
          candidate,
        }),
        runNpmInstallFromTarball: async () => {
          installCalled = true;
        },
      },
    });
    expect(installCalled).toBe(true);
    expect(result).toMatchObject({
      outcome: "success",
      firstInstall: true,
      tarballSha512: "abc",
    });
  });

  it("loadState returns {} on a missing file — first launch never throws", () => {
    // No state file exists yet (beforeEach made an empty tempDir).
    expect(loadState()).toEqual({});
  });

  it("saveState swallows write errors when the parent directory is read-only — we will retry next launch, not crash now", () => {
    // Simulate a write failure by pointing the env var at a path whose
    // parent is a regular file. mkdir -p will fail; saveState catches.
    const blockedFile = path.join(tempDir, "blocker");
    writeFileSync(blockedFile, "x", "utf8");
    process.env.SEREN_CLI_UPDATER_STATE_PATH = path.join(blockedFile, "child.json");
    // Should not throw.
    expect(() => saveState({ a: 1 })).not.toThrow();
  });
});
