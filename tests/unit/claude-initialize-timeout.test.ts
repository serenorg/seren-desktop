// ABOUTME: Regression test for #2454 — claude-code initialize handshake must
// ABOUTME: tolerate cold first-run latency (wide timeout + one retry) and resolve .local\bin.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#2454 — claude initialize handshake tolerates cold first-run", () => {
  it("defines a wide initialize timeout (>= 60s, not the old 20s)", () => {
    const match = runtimeSource.match(/INITIALIZE_TIMEOUT_MS\s*=\s*([0-9_]+)/);
    expect(match, "INITIALIZE_TIMEOUT_MS constant must exist").not.toBeNull();
    const ms = Number((match?.[1] ?? "0").replaceAll("_", ""));
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it("retries the initialize handshake once before abandoning the spawn", () => {
    const start = runtimeSource.indexOf("async function sendInitializeWithRetry");
    expect(start, "sendInitializeWithRetry must exist").toBeGreaterThan(0);
    const body = runtimeSource.slice(start, start + 700);
    // Two sendControlRequest calls = initial attempt + one retry.
    const calls = body.match(/sendControlRequest\(/g) ?? [];
    expect(calls.length, "must call sendControlRequest twice (attempt + retry)").toBe(2);
    expect(body).toContain("subtype: \"initialize\"");
    expect(body).toMatch(/catch\s*\(/);
  });

  it("spawn drives initialize through the retry helper, not a bare 20s control request", () => {
    expect(runtimeSource).toContain("await sendInitializeWithRetry(session)");
    // The old tight inline initialize timeout must be gone.
    expect(runtimeSource).not.toMatch(/subtype:\s*"initialize"[\s\S]{0,80}20_000/);
  });
});

describe("#2454 — resolveClaudeBinary finds the native installer location", () => {
  it("includes %USERPROFILE%\\.local\\bin\\claude.exe in the Windows candidates", () => {
    const start = runtimeSource.indexOf("function resolveClaudeBinary");
    const body = runtimeSource.slice(start, start + 700);
    expect(body).toMatch(/\.join\(home,\s*"\.local",\s*"bin",\s*"claude\.exe"\)/);
  });
});
