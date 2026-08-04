// ABOUTME: Protects the validation launcher's hermetic child environment.
// ABOUTME: Covers worktree state roots while keeping toolchain caches stable.

import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureValidationKeychain,
  validationChildEnv,
  validationHomeForSlot,
  validationTauriCliCommand,
} from "../../scripts/validation-env";
import { shouldSkipValidationBuild } from "../../scripts/validation-dev-args";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  stat: mocks.stat,
}));

function resolveExecFile(
  _command: string,
  _args: string[],
  optionsOrCallback: unknown,
  maybeCallback?: unknown,
): void {
  const callback =
    typeof maybeCallback === "function" ? maybeCallback : optionsOrCallback;
  if (typeof callback === "function") {
    callback(null, { stdout: "", stderr: "" });
  }
}

beforeEach(() => {
  mocks.execFile.mockReset().mockImplementation(resolveExecFile);
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
  mocks.stat.mockReset().mockRejectedValue(new Error("missing"));
});

describe("validation environment", () => {
  it("selects no-build mode from the flag or environment", () => {
    expect(shouldSkipValidationBuild(["--no-build"], {})).toBe(true);
    expect(
      shouldSkipValidationBuild([], { SEREN_VALIDATION_SKIP_BUILD: "1" }),
    ).toBe(true);
    expect(shouldSkipValidationBuild([], {})).toBe(false);
  });

  it("roots HOME in the repo-local slot directory", () => {
    const repoRoot = "/repo";
    const env = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot,
      realHome: "/real-home",
    });

    expect(env.HOME).toBe(
      path.join(repoRoot, "artifacts", "validation-home", "slot1422"),
    );
    if (process.platform === "darwin") {
      expect(env.CFFIXED_USER_HOME).toBe(env.HOME);
    }
    expect(env.SEREN_VALIDATION_DISCOVERY_PATH).toBe(
      path.join(
        env.HOME as string,
        "Library",
        "Application Support",
        "com.serendb.desktop.validation.slot1422",
        "validation-control.json",
      ),
    );
    expect(validationHomeForSlot(repoRoot, 1422)).toBe(
      path.join(repoRoot, "artifacts", "validation-home", "slot1422"),
    );
  });

  it("preserves configured toolchain homes and defaults missing ones", () => {
    const configured = validationChildEnv({
      baseEnv: {
        CARGO_HOME: "/custom/cargo",
        RUSTUP_HOME: "/custom/rustup",
      },
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });
    const defaults = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(configured.CARGO_HOME).toBe("/custom/cargo");
    expect(configured.RUSTUP_HOME).toBe("/custom/rustup");
    expect(defaults.CARGO_HOME).toBe(path.join("/real-home", ".cargo"));
    expect(defaults.RUSTUP_HOME).toBe(path.join("/real-home", ".rustup"));
  });

  it("isolates Windows profile and app-data roots for clean CLI provisioning", () => {
    const env = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
      platform: "win32",
    });

    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.APPDATA).toBe(
      path.join(env.HOME as string, "AppData", "Roaming"),
    );
    expect(env.LOCALAPPDATA).toBe(
      path.join(env.HOME as string, "AppData", "Local"),
    );
  });

  it("launches the Tauri CLI through Node instead of a Windows command shim", () => {
    expect(
      validationTauriCliCommand({
        repoRoot: "D:\\a\\seren-desktop",
        execPath: "C:\\hostedtoolcache\\node.exe",
        platform: "win32",
      }),
    ).toEqual({
      command: "C:\\hostedtoolcache\\node.exe",
      cliScript:
        "D:\\a\\seren-desktop\\node_modules\\@tauri-apps\\cli\\tauri.js",
    });
  });

  it("keeps disposable validation profiles outside Vite's file watcher", () => {
    const viteConfig = readFileSync(path.resolve("vite.config.ts"), "utf8");

    expect(viteConfig).toContain('"**/artifacts/validation-home/**"');
  });

  it("sets the pnpm store only when one is provided", () => {
    const withStore = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
      pnpmStoreDir: "/pnpm/store",
    });
    const withoutStore = validationChildEnv({
      baseEnv: {},
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(withStore.npm_config_store_dir).toBe("/pnpm/store");
    expect(withoutStore.npm_config_store_dir).toBeUndefined();
  });

  it("passes unrelated environment variables through unchanged", () => {
    const env = validationChildEnv({
      baseEnv: { SEREN_TEST_VALUE: "preserved" },
      port: 1422,
      repoRoot: "/repo",
      realHome: "/real-home",
    });

    expect(env.SEREN_TEST_VALUE).toBe("preserved");
  });

  it("rejects invalid ports", () => {
    expect(() => validationHomeForSlot("/repo", 65_536)).toThrow(
      "validation port must be an integer from 1 to 65535",
    );
  });

  it("configures the slot keychain in order with the slot HOME", async () => {
    const consoleLog = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    const slotHome = validationHomeForSlot("/repo", 1422);

    await ensureValidationKeychain(slotHome, "/repo");

    const securityCalls = mocks.execFile.mock.calls.filter(
      ([command]) => command === "security",
    );
    const keychainPath = path.join(
      slotHome,
      "Library",
      "Keychains",
      "login.keychain-db",
    );
    expect(securityCalls.map(([, args]) => args)).toEqual([
      [
        "create-keychain",
        "-p",
        expect.any(String),
        keychainPath,
      ],
      ["set-keychain-settings", keychainPath],
      [
        "unlock-keychain",
        "-p",
        expect.any(String),
        keychainPath,
      ],
      ["default-keychain", "-d", "user", "-s", keychainPath],
      ["list-keychains", "-d", "user", "-s", keychainPath],
    ]);
    for (const [, , options] of securityCalls) {
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({ HOME: slotHome }),
        }),
      );
    }
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "scratch keychain password for slot 1422",
      ),
    );
    consoleLog.mockRestore();
  });

  it("rejects security mutations outside the validation HOME", async () => {
    await expect(
      ensureValidationKeychain("/Users/taariqlewis", "/repo"),
    ).rejects.toThrow("refusing security mutation outside validation HOME");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
