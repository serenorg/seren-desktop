// ABOUTME: Regression guard for #1878 — launchLogin must resolve the same claude/codex binary as spawnSession.
// ABOUTME: Source-text + behavioral coverage: resolver wiring, shell quoting on darwin/win32/linux, bare-name fallback.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryPath = resolve("bin/browser-local/agent-registry.mjs");
const registrySource = readFileSync(registryPath, "utf-8");

function sliceDefinition(key: string): string {
  // Object literal keys may be quoted ("claude-code") or bare (codex).
  const quoted = registrySource.indexOf(`"${key}": {`);
  const bare = registrySource.indexOf(`\n    ${key}: {`);
  const start = quoted >= 0 ? quoted : bare >= 0 ? bare + 1 : -1;
  if (start < 0) throw new Error(`Definition not found: ${key}`);
  const window = registrySource.slice(start, start + 4000);
  const next = window.indexOf("\n    },\n    ");
  return next > 0 ? window.slice(0, next) : window;
}

describe("#1878 — claude-code.launchLogin uses the spawn-time resolver", () => {
  it("invokes resolveInstalledClaudeBinary before launchLoginCommand", () => {
    const def = sliceDefinition("claude-code");
    const resolverIdx = def.indexOf("resolveInstalledClaudeBinary(");
    const commandIdx = def.indexOf("launchLoginCommand(");
    expect(resolverIdx).toBeGreaterThan(0);
    expect(commandIdx).toBeGreaterThan(resolverIdx);
  });

  it("does NOT call launchLoginCommand with the bare 'claude' literal", () => {
    const def = sliceDefinition("claude-code");
    expect(def).not.toMatch(/launchLoginCommand\(\s*"claude"\s*\)/);
  });
});

describe("#1878 — codex.launchLogin uses the spawn-time resolver", () => {
  it("invokes resolveInstalledCodexBinary before launchLoginCommand", () => {
    const def = sliceDefinition("codex");
    const resolverIdx = def.indexOf("resolveInstalledCodexBinary(");
    const commandIdx = def.indexOf("launchLoginCommand(");
    expect(resolverIdx).toBeGreaterThan(0);
    expect(commandIdx).toBeGreaterThan(resolverIdx);
  });

  it("does NOT call launchLoginCommand with the bare 'codex' literal", () => {
    const def = sliceDefinition("codex");
    expect(def).not.toMatch(/launchLoginCommand\(\s*"codex"\s*\)/);
  });
});

describe("#1878 — launchLoginCommand quotes paths safely on all platforms", () => {
  const spawnMock = vi.fn();
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({
      unref: () => undefined,
    }));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    vi.resetModules();
  });

  function setPlatform(value: NodeJS.Platform) {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
    });
  }

  async function loadLaunchLoginCommand() {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>(
        "node:child_process",
      );
      return { ...actual, spawn: spawnMock };
    });
    // @ts-expect-error — .mjs source is JS; type info isn't generated.
    const mod = await import("../../bin/browser-local/agent-registry.mjs");
    return mod.launchLoginCommand as (command: string) => void;
  }

  it("macOS: single-quotes a path with a space and survives AppleScript layer", async () => {
    setPlatform("darwin");
    const launchLoginCommand = await loadLaunchLoginCommand();
    const pathWithSpace = "/Users/Some User/.local/bin/claude";

    launchLoginCommand(pathWithSpace);

    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("osascript");
    const script = (args as string[]).find((a) => a.includes("do script"));
    expect(script).toBeDefined();
    // The path must appear single-quoted inside the AppleScript so the shell
    // sees one argument, not three space-split words.
    expect(script).toContain(`'${pathWithSpace}' login`);
  });

  it("macOS: bare command passes through unquoted (no regression for PATH installs)", async () => {
    setPlatform("darwin");
    const launchLoginCommand = await loadLaunchLoginCommand();

    launchLoginCommand("claude");

    expect(spawnMock).toHaveBeenCalled();
    const [, args] = spawnMock.mock.calls[0];
    const script = (args as string[]).find((a) => a.includes("do script"));
    expect(script).toContain("claude login");
  });

  it("Windows: emits explicit empty title before quoted path so start does not eat the path", async () => {
    setPlatform("win32");
    const launchLoginCommand = await loadLaunchLoginCommand();
    const pathWithSpace = "C:\\Users\\Some User\\AppData\\Roaming\\npm\\claude.cmd";

    launchLoginCommand(pathWithSpace);

    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("cmd");
    const argv = args as string[];
    // start <title> <command>. Title must be the empty string when the path
    // is quoted, otherwise start consumes the path as the window title.
    const startIdx = argv.indexOf("start");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(argv[startIdx + 1]).toBe("");
    expect(argv.slice(startIdx + 2).join(" ")).toContain(pathWithSpace);
  });

  it("Linux: passes the resolved absolute path as a single argv element", async () => {
    setPlatform("linux");
    const launchLoginCommand = await loadLaunchLoginCommand();
    const pathWithSpace = "/home/some user/.local/bin/claude";

    launchLoginCommand(pathWithSpace);

    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe("x-terminal-emulator");
    const argv = args as string[];
    // The resolved path is one argv element; spaces stay intact across argv.
    expect(argv).toContain(pathWithSpace);
    expect(argv).toContain("login");
  });
});
