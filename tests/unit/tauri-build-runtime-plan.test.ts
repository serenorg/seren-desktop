// ABOUTME: Regression coverage for Windows bundles requiring embedded Python.
// ABOUTME: Keeps Tauri build preparation from omitting python.exe again.

import { describe, expect, it } from "vitest";

import {
  buildTauriPreparationCommands,
  resolveRuntimeTarget,
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
});
