// ABOUTME: Regression guard for #1665 — CLI resolvers must include system npm + Homebrew + Windows MSI paths.
// ABOUTME: Source-text tests because resolvers run against real fs.existsSync; mocking the filesystem here is more brittle than the value of the test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const registrySource = readFileSync(
  resolve("bin/browser-local/agent-registry.mjs"),
  "utf-8",
);
const antigravitySource = readFileSync(
  resolve("bin/browser-local/antigravity-binary.mjs"),
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

describe("#3648 — Antigravity resolver covers Google's documented install paths", () => {
  it("prefers the official per-user install and covers common managed paths", () => {
    expect(antigravitySource).toContain('path.join(home, ".local", "bin", "agy")');
    expect(antigravitySource).toContain('path.join(localAppData, "agy", "bin", "agy.exe")');
    expect(antigravitySource).toContain('"/opt/homebrew/bin/agy"');
    expect(antigravitySource).toContain('"/usr/local/bin/agy"');
  });

  it("also searches inherited PATH without using a shell", () => {
    expect(antigravitySource).toContain("process.env.PATH");
    expect(antigravitySource).toContain("path.delimiter");
    expect(antigravitySource).toContain("shell: false");
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

describe("#3377 — resolvers fall back to the dynamic npm global prefix", () => {
  it.each([
    "resolveInstalledCodexBinary",
    "resolveInstalledClaudeBinary",
  ])(
    "%s consults the dynamic prefix for custom / version-manager installs",
    (name) => {
      // Static candidate lists miss nvm/fnm/volta/portable-Node prefixes; the
      // resolver must fall back to `npm prefix -g` before returning the bare
      // command name.
      expect(sliceFn(name)).toContain("resolveViaNpmGlobalPrefix");
    },
  );
});
