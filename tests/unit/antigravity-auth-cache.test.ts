// ABOUTME: Regression coverage for #3663: the Antigravity auth probe must not
// ABOUTME: run per roster query, nor report a network failure as signed out.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — browser-local runtime is plain ESM without declarations.
import {
  checkAntigravityAuthenticated,
  clearAntigravityAuthCache,
  isAntigravityAuthError,
} from "../../bin/browser-local/antigravity-binary.mjs";

const workDir = mkdtempSync(path.join(tmpdir(), "seren-agy-auth-"));
const callLog = path.join(workDir, "calls.log");
const stubBinary = path.join(workDir, "agy-stub.mjs");

// A real executable whose behavior is switched by a file on disk, so the
// caching and failure-classification logic runs against actual process
// execution rather than a stubbed function.
writeFileSync(
  stubBinary,
  `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callLog)}, "call\\n");
const mode = readFileSync(${JSON.stringify(path.join(workDir, "mode"))}, "utf8").trim();
if (mode === "ok") { console.log("gemini-3.1-pro-high"); process.exit(0); }
if (mode === "network") { console.error("dial tcp: i/o timeout"); process.exit(1); }
console.error("Please sign in to continue");
process.exit(1);
`,
);
chmodSync(stubBinary, 0o755);

function setMode(mode: "ok" | "network" | "signed-out") {
  writeFileSync(path.join(workDir, "mode"), mode);
}

function callCount() {
  try {
    return readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

describe("Antigravity auth probe caching (#3663)", () => {
  beforeEach(() => {
    clearAntigravityAuthCache();
    writeFileSync(callLog, "");
  });

  it("does not re-run the probe for every roster query", async () => {
    setMode("ok");

    const results = await Promise.all([
      checkAntigravityAuthenticated(stubBinary),
      checkAntigravityAuthenticated(stubBinary),
      checkAntigravityAuthenticated(stubBinary),
    ]);

    expect(results).toEqual([true, true, true]);
    // Concurrent calls may all miss the cold cache; what matters is that a
    // later query is served from cache rather than spawning again.
    const afterConcurrent = callCount();
    expect(await checkAntigravityAuthenticated(stubBinary)).toBe(true);
    expect(callCount()).toBe(afterConcurrent);
  });

  it("keeps the known verdict when the probe fails for a network reason", async () => {
    setMode("ok");
    expect(await checkAntigravityAuthenticated(stubBinary)).toBe(true);

    setMode("network");
    const pastTtl = { now: () => Date.now() + 120_000 };

    expect(await checkAntigravityAuthenticated(stubBinary, pastTtl)).toBe(true);
  });

  it("reports signed out when the CLI says authentication is required", async () => {
    setMode("ok");
    expect(await checkAntigravityAuthenticated(stubBinary)).toBe(true);

    setMode("signed-out");
    const pastTtl = { now: () => Date.now() + 120_000 };

    expect(await checkAntigravityAuthenticated(stubBinary, pastTtl)).toBe(
      false,
    );
  });

  it("classifies a network failure as something other than an auth error", () => {
    expect(isAntigravityAuthError("dial tcp: i/o timeout")).toBe(false);
    expect(isAntigravityAuthError("Please sign in to continue")).toBe(true);
  });
});
