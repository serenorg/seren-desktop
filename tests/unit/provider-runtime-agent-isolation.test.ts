// ABOUTME: Regression tests for #2457/#2456 — one agent runtime's load failure
// ABOUTME: must not crash the provider runtime or disable the other agents.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - providers.mjs is a plain ESM harness without type declarations
import { createUnavailableRuntime } from "../../bin/browser-local/providers.mjs";

const providersSource = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);
const registrySource = readFileSync(
  resolve("bin/browser-local/agent-registry.mjs"),
  "utf-8",
);
const bundlerSource = readFileSync(
  resolve("scripts/build-provider-runtime.ts"),
  "utf-8",
);

describe("#2457 — unavailable agent runtime is isolated", () => {
  it("owns no sessions and never forces a load via sync predicates", () => {
    const runtime = createUnavailableRuntime("lmstudio", "boom");
    expect(runtime.hasSession("any-session")).toBe(false);
    expect(runtime.interceptEmit("provider://event", {})).toBe(false);
  });

  it("lists no sessions so aggregation across runtimes still works", async () => {
    const runtime = createUnavailableRuntime("lmstudio", "boom");
    await expect(runtime.listSessions()).resolves.toEqual([]);
  });

  it("throws a clear per-agent error only when the agent is invoked", async () => {
    const runtime = createUnavailableRuntime("lmstudio", "missing dep");
    await expect(runtime.spawnSession({})).rejects.toThrow(
      /The lmstudio agent is unavailable: missing dep/,
    );
    await expect(runtime.testConnection()).rejects.toThrow(/unavailable/);
  });
});

describe("#2457 — agent runtimes are not statically imported at startup", () => {
  it("providers.mjs loads each agent runtime via dynamic import, not a top-level static import", () => {
    for (const mod of [
      "claude-runtime.mjs",
      "gemini-runtime.mjs",
      "lmstudio-runtime.mjs",
      "paired-runtime.mjs",
    ]) {
      expect(
        providersSource,
        `${mod} must not be statically imported at top level`,
      ).not.toMatch(new RegExp(`^import\\s.*from\\s+"\\./${mod.replace(".", "\\.")}"`, "m"));
      expect(
        providersSource,
        `${mod} must be loaded via dynamic import()`,
      ).toContain(`import("./${mod}")`);
    }
  });

  it("agent-registry.mjs does not statically import lmstudio-runtime (it is needed by every agent)", () => {
    expect(registrySource).not.toMatch(
      /^import\s[\s\S]*?from\s+"\.\/lmstudio-runtime\.mjs"/m,
    );
    expect(registrySource).toContain('import("./lmstudio-runtime.mjs")');
  });
});

describe("#2456 — LM Studio SDK is bundled into the packaged provider runtime", () => {
  it("build-provider-runtime.ts ships @lmstudio/sdk in the embedded bundle deps", () => {
    expect(bundlerSource).toContain('"@lmstudio/sdk": lmstudioSdkVersion');
  });
});
