// ABOUTME: Regression guard for #3252 — keeps the three fixed src files tsc-clean.
// ABOUTME: The render crash in GatewayToolApproval was a type error no other gate catches.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const TSC = resolve(REPO_ROOT, "node_modules/.bin/tsc");

// The three production files fixed in #3252. Biome (not type-aware), vite build
// (esbuild strips types), and Vitest (esbuild) all shipped these type errors
// unnoticed — only tsc catches them, so this guard runs the real compiler.
const GUARDED_FILES = [
  "src/components/gateway/GatewayToolApproval.tsx",
  "src/services/publisher-oauth.ts",
  "src/stores/agent.store.ts",
];

function runTsc(): string {
  try {
    return execFileSync(TSC, ["--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // tsc exits non-zero when ANY file has errors — including the ~104
    // out-of-scope test-file errors #3252 explicitly deferred. Diagnostics
    // still land on stdout, so read them back and filter to the guarded files.
    return (err as { stdout?: Buffer | string }).stdout?.toString() ?? "";
  }
}

describe("#3252 — shipped src/ type errors (render crash + latent defects)", () => {
  it("reports zero tsc errors in the three fixed files", () => {
    const offending = runTsc()
      .split("\n")
      .filter((line) => GUARDED_FILES.some((file) => line.startsWith(file)));

    expect(
      offending,
      `tsc reported errors in files fixed by #3252:\n${offending.join("\n")}`,
    ).toEqual([]);
  }, 120_000);
});
