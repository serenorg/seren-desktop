// ABOUTME: Regression coverage for #3665: a first-run Antigravity spawn must
// ABOUTME: tolerate a healthy binary whose version probe cannot answer.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — browser-local runtime is plain ESM without declarations.
import {
  ensureAntigravityCli,
  resolveAntigravityBinary,
} from "../../bin/browser-local/antigravity-binary.mjs";

// A real executable that never answers --version, standing in for a healthy
// install on an IO-starved machine whose probe times out. It is placed at the
// location the production resolver looks in first, under a temporary home, so
// the real resolver runs unmodified.
const fakeHome = mkdtempSync(path.join(tmpdir(), "seren-agy-home-"));
const binDir = path.join(fakeHome, ".local", "bin");
mkdirSync(binDir, { recursive: true });
const stubBinary = path.join(binDir, "agy");
writeFileSync(stubBinary, "#!/bin/sh\nsleep 60\n");
chmodSync(stubBinary, 0o755);

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
process.env.HOME = fakeHome;
process.env.PATH = binDir;

afterAll(() => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
});

describe("Antigravity first-run install robustness (#3665)", () => {
  it("spawns a resolved binary whose version probe never answers", async () => {
    expect(resolveAntigravityBinary()).toBe(stubBinary);

    // Without the tolerance this re-downloads, and fails outright offline.
    await expect(ensureAntigravityCli({})).resolves.toBe(stubBinary);
  }, 30_000);
});
