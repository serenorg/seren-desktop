// ABOUTME: Regression guard for #1665 — CLI resolvers must include system npm + Homebrew + Windows MSI paths.
// ABOUTME: Source-text tests because resolvers run against real fs.existsSync; mocking the filesystem here is more brittle than the value of the test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const registrySource = readFileSync(
  resolve("bin/browser-local/agent-registry.mjs"),
  "utf-8",
);

function sliceFn(name: string): string {
  const start = registrySource.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`Function not found: ${name}`);
  // Bound the slice to the next top-level `function ` declaration. Falls back
  // to a generous window so a slight refactor doesn't make the test silently
  // skip detection.
  const next = registrySource.indexOf("\nfunction ", start + 10);
  const exportNext = registrySource.indexOf("\nexport function ", start + 10);
  const ends = [next, exportNext].filter((n) => n > 0);
  const end = ends.length > 0 ? Math.min(...ends) : start + 4000;
  return registrySource.slice(start, end);
}

describe("#1665 — Claude + Codex Unix resolvers cover system npm + Homebrew", () => {
  it.each([
    "resolveInstalledClaudeBinary",
    "resolveInstalledCodexBinary",
  ])("%s includes /usr/local/bin (system npm prefix)", (name) => {
    const fn = sliceFn(name);
    const cmd = name
      .replace("resolveInstalled", "")
      .replace("Binary", "")
      .toLowerCase();
    expect(fn).toContain(`/usr/local/bin/${cmd}`);
  });

  it.each([
    "resolveInstalledClaudeBinary",
    "resolveInstalledCodexBinary",
  ])("%s includes /opt/homebrew/bin (Homebrew on Apple Silicon)", (name) => {
    const fn = sliceFn(name);
    const cmd = name
      .replace("resolveInstalled", "")
      .replace("Binary", "")
      .toLowerCase();
    expect(fn).toContain(`/opt/homebrew/bin/${cmd}`);
  });
});

describe("#1665 — Claude + Codex Windows resolvers cover MSI + user prefix", () => {
  it.each([
    "resolveInstalledClaudeBinary",
    "resolveInstalledCodexBinary",
  ])("%s reads ProgramFiles env for the system MSI install", (name) => {
    const fn = sliceFn(name);
    expect(fn).toContain("process.env.ProgramFiles");
    expect(fn).toContain('"nodejs"');
  });

  it.each([
    "resolveInstalledClaudeBinary",
    "resolveInstalledCodexBinary",
  ])("%s includes <HOME>/.npm-global for explicit user prefix", (name) => {
    const fn = sliceFn(name);
    expect(fn).toContain('".npm-global"');
  });
});

describe("#1665 follow-up — Gemini resolver INTENTIONALLY excludes system + Homebrew paths (#1476 keytar)", () => {
  // The Homebrew gemini-cli formula skips the keytar postinstall, so a
  // system-installed gemini cannot read its own keychain when spawned from
  // a GUI app and silently fails first-run auth. Mirroring the deliberate
  // exclusion in resolveGeminiBinary at gemini-runtime.mjs.
  it("does NOT include /usr/local/bin/gemini", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).not.toContain("/usr/local/bin/gemini");
  });

  it("does NOT include /opt/homebrew/bin/gemini", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).not.toContain("/opt/homebrew/bin/gemini");
  });

  it("does NOT include /usr/bin/gemini", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).not.toContain("/usr/bin/gemini");
  });

  it("does NOT read ProgramFiles\\nodejs (Windows MSI install)", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).not.toContain("process.env.ProgramFiles");
  });

  it("does NOT include <HOME>\\.npm-global on Windows", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).not.toContain('".npm-global"');
  });

  it("DOES include the bundled-runtime prefix and ~/.local/bin (the safe channels)", () => {
    const fn = sliceFn("resolveInstalledGeminiBinary");
    expect(fn).toContain('path.join(prefix, "bin", "gemini")');
    expect(fn).toContain('path.join(home, ".local", "bin", "gemini")');
  });
});

describe("#1665 — preference order preserved for Claude + Codex (regression guard)", () => {
  it("Claude resolver still checks ~/.claude/bin BEFORE /usr/local/bin (native installer wins over system npm)", () => {
    const fn = sliceFn("resolveInstalledClaudeBinary");
    const claudeBinIdx = fn.indexOf('".claude"');
    const usrLocalIdx = fn.indexOf("/usr/local/bin/claude");
    expect(claudeBinIdx).toBeGreaterThan(0);
    expect(usrLocalIdx).toBeGreaterThan(0);
    expect(claudeBinIdx).toBeLessThan(usrLocalIdx);
  });

  it("Codex resolver still checks the embedded-prefix BEFORE /usr/local/bin (bundled wins over system)", () => {
    const fn = sliceFn("resolveInstalledCodexBinary");
    const prefixIdx = fn.indexOf('path.join(prefix, "bin", "codex")');
    const usrLocalIdx = fn.indexOf("/usr/local/bin/codex");
    expect(prefixIdx).toBeGreaterThan(0);
    expect(usrLocalIdx).toBeGreaterThan(0);
    expect(prefixIdx).toBeLessThan(usrLocalIdx);
  });
});
