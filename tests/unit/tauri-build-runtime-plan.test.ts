// ABOUTME: Regression coverage for Windows bundles requiring embedded Python.
// ABOUTME: Keeps Tauri build preparation from omitting python.exe again.

import { describe, expect, it } from "vitest";

import {
  buildTauriPreparationCommands,
  resolveRuntimeTarget,
  shouldSkipPreparation,
  spawnOptionsForPlatform,
} from "../../build/prepare-tauri-build";

function scriptNames(commands: ReturnType<typeof buildTauriPreparationCommands>) {
  return commands.map((command) => command.args[0]);
}

describe("Tauri build runtime preparation", () => {
  it("prepares bundled Python for Windows x64 builds before packaging", () => {
    const target = resolveRuntimeTarget({
      env: {
        TAURI_ENV_PLATFORM: "windows",
        TAURI_ENV_ARCH: "x86_64",
      },
      hostPlatform: "linux",
      hostArch: "x64",
    });

    expect(target).toEqual({ platform: "win32", arch: "x64" });
    expect(scriptNames(buildTauriPreparationCommands(target))).toEqual([
      "prepare:mcp-servers",
      "build:provider-runtime",
      "prepare:runtime:win32-x64",
      "prepare:python:win32-x64",
      "sign:embedded-runtime",
    ]);
  });

  it("does not run the Windows Python prep step for non-Windows builds", () => {
    const target = resolveRuntimeTarget({
      targetTriple: "aarch64-apple-darwin",
      hostPlatform: "linux",
      hostArch: "x64",
    });

    expect(target).toEqual({ platform: "darwin", arch: "arm64" });
    expect(scriptNames(buildTauriPreparationCommands(target))).toEqual([
      "prepare:mcp-servers",
      "build:provider-runtime",
      "prepare:runtime:darwin-arm64",
      "sign:embedded-runtime",
    ]);
  });

  it("runs pnpm through a shell on Windows so .cmd shims can spawn", () => {
    expect(spawnOptionsForPlatform("win32").shell).toBe(true);
    expect(spawnOptionsForPlatform("darwin").shell).toBe(false);
    expect(spawnOptionsForPlatform("linux").shell).toBe(false);
  });

  it("skips preparation when SEREN_TAURI_SKIP_PREP is set so the signed runtime survives pass two (#2235)", () => {
    expect(shouldSkipPreparation({ SEREN_TAURI_SKIP_PREP: "1" })).toBe(true);
    expect(shouldSkipPreparation({ SEREN_TAURI_SKIP_PREP: "true" })).toBe(true);
    expect(shouldSkipPreparation({ SEREN_TAURI_SKIP_PREP: "TRUE" })).toBe(true);
    expect(shouldSkipPreparation({ SEREN_TAURI_SKIP_PREP: "0" })).toBe(false);
    expect(shouldSkipPreparation({ SEREN_TAURI_SKIP_PREP: "" })).toBe(false);
    expect(shouldSkipPreparation({})).toBe(false);
  });
});
