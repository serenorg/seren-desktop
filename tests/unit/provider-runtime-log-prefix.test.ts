// ABOUTME: Regression coverage for #2195 provider runtime log prefixes.
// ABOUTME: Desktop-native logs must not claim they came from browser-local.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - logging.mjs is a plain ESM harness without type declarations
import { providerLogPrefix } from "../../bin/browser-local/logging.mjs";

const runtimeLogFiles = [
  "bin/browser-local/claude-runtime.mjs",
  "bin/browser-local/gemini-runtime.mjs",
  "bin/browser-local/providers.mjs",
];

function readSource(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("#2195 — provider runtime log prefixes", () => {
  it("formats provider logs with the actual runtime mode", () => {
    expect(providerLogPrefix("claude", "desktop-native")).toBe(
      "[desktop-native][claude]",
    );
    expect(providerLogPrefix("codex", "browser-local")).toBe(
      "[browser-local][codex]",
    );
    expect(providerLogPrefix("gemini", "bad mode\n")).toBe(
      "[provider-runtime][gemini]",
    );
  });

  it("does not hard-code browser-local in provider console logs", () => {
    const hardCodedBrowserLocalConsolePrefix =
      /console\.(?:log|warn|error)\s*\([\s\S]{0,160}?(?:`|")\[browser-local\]/g;

    const offenders = runtimeLogFiles.flatMap((path) => {
      const source = readSource(path);
      return Array.from(source.matchAll(hardCodedBrowserLocalConsolePrefix)).map(
        (match) => {
          const line = source.slice(0, match.index).split("\n").length;
          return `${path}:${line}`;
        },
      );
    });

    expect(offenders).toEqual([]);
  });

  it("threads explicit runtime modes from both local runtime entry points", () => {
    const nativeEntry = readSource("bin/provider-runtime.mjs");
    const browserLocalEntry = readSource("bin/seren-desktop.mjs");

    expect(nativeEntry).toContain('const RUNTIME_MODE = "desktop-native"');
    expect(nativeEntry).toContain("runtimeMode: RUNTIME_MODE");
    expect(browserLocalEntry).toContain('const RUNTIME_MODE = "browser-local"');
    expect(browserLocalEntry).toContain("runtimeMode: RUNTIME_MODE");
  });
});
