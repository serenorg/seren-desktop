// ABOUTME: Source-level regression tests for #150 — reactive compaction
// ABOUTME: must guard against a session removed between spawn and setState.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const compactStart = agentStoreSource.indexOf(
  "async compactAgentConversation(",
);
const compactEnd = agentStoreSource.indexOf(
  "async compactAndRetry(",
  compactStart,
);
const compactBody = agentStoreSource.slice(compactStart, compactEnd);

describe("#150 — reactive compaction guards against session removal mid-flight", () => {
  it("checks state.sessions[newSessionId] exists BEFORE the first setState write", () => {
    // The provider-runtime restart listener drops every session entry; an
    // external terminateSession call does the same. Without this guard the
    // first setState path-traversal threw a raw TypeError ("undefined is
    // not an object (evaluating 'e[r]')") which the support hook captured
    // as a public bug report.
    const guardIdx = compactBody.indexOf("!state.sessions[newSessionId]");
    expect(
      guardIdx,
      "session-removal guard must exist after spawnSession",
    ).toBeGreaterThan(0);

    const firstSetStateIdx = compactBody.indexOf(
      'setState("sessions", newSessionId, "compactedSummary"',
    );
    expect(firstSetStateIdx).toBeGreaterThan(0);
    expect(
      guardIdx,
      "guard must precede the first setState that writes to the new session",
    ).toBeLessThan(firstSetStateIdx);
  });

  it("guard throws a clean Error so the recovery branch fires with a meaningful message", () => {
    const guardIdx = compactBody.indexOf("!state.sessions[newSessionId]");
    const region = compactBody.slice(guardIdx, guardIdx + 500);
    expect(region).toContain("throw new Error(");
    // The error message must be specific enough that the support pipeline
    // does not flatten it into another TypeError-shaped report.
    expect(region).toMatch(/CompactionFailure:[^"]*removed/);
  });

  it("guard runs AFTER the null-spawn check so we don't shadow that error", () => {
    const nullSpawnIdx = compactBody.indexOf(
      'CompactionFailure: new session spawn returned null',
    );
    const removalGuardIdx = compactBody.indexOf("!state.sessions[newSessionId]");
    expect(nullSpawnIdx).toBeGreaterThan(0);
    expect(removalGuardIdx).toBeGreaterThan(nullSpawnIdx);
  });
});
