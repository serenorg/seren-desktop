// ABOUTME: Regression test for #2452/#2454 — claude-code initialize handshake uses a wide
// ABOUTME: timeout and recovers a wedged spawn by killing+respawning, not a same-process retry.

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
});

describe("#2452 — a wedged initialize handshake recovers by respawning, not re-asking", () => {
  it("sends initialize as a single-attempt request (no same-process retry helper)", () => {
    expect(
      runtimeSource.includes("function sendInitialize("),
      "sendInitialize helper must exist",
    ).toBe(true);
    expect(
      runtimeSource.includes("sendInitializeWithRetry"),
      "the same-process retry helper must be gone",
    ).toBe(false);
    const start = runtimeSource.indexOf("function sendInitialize(");
    const body = runtimeSource.slice(start, start + 300);
    // Exactly one control request — recovery now respawns a fresh process.
    expect((body.match(/sendControlRequest\(/g) ?? []).length).toBe(1);
    expect(body).toContain('subtype: "initialize"');
  });

  it("bounds the attempts and kills+respawns a fresh process on timeout", () => {
    const max = runtimeSource.match(/INITIALIZE_MAX_ATTEMPTS\s*=\s*([0-9_]+)/);
    expect(max, "INITIALIZE_MAX_ATTEMPTS constant must exist").not.toBeNull();
    expect(Number((max?.[1] ?? "0").replaceAll("_", ""))).toBeGreaterThanOrEqual(2);

    const start = runtimeSource.indexOf("let initResult;");
    expect(start, "initialize loop must exist").toBeGreaterThan(0);
    const body = runtimeSource.slice(start, start + 1600);
    expect(body).toContain("await sendInitialize(session)");
    expect(body).toMatch(/attempt\s*>=\s*INITIALIZE_MAX_ATTEMPTS/);
    // On timeout: detach the wedged session, kill its tree, relaunch fresh.
    expect(body).toContain("sessions.delete(sessionId)");
    expect(body).toContain("killChildTree(processHandle)");
    expect(body).toContain("launchClaudeProcess()");
  });

  it("gates the spawn error listener so an orphaned handle can't clobber the live session (#2470)", () => {
    const start = runtimeSource.indexOf('processHandle.on("error"');
    expect(start, "spawn error listener must exist").toBeGreaterThan(0);
    const body = runtimeSource.slice(start, start + 800);
    // The listener must early-return unless its own launch's session is still
    // the registered one, so a late error from a respawned-over handle is inert.
    expect(body).toMatch(/sessions\.get\(sessionId\)\s*!==\s*launchedSession/);
    expect(body).toMatch(/return;/);
  });

  it("does not drive initialize through a bare 20s control request", () => {
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
