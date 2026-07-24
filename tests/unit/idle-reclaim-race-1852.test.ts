// ABOUTME: Source-level regression tests for #1852 — post-promptComplete idle-reclaim race.
// ABOUTME: Pins navigation-intent getter, expectedTerminate suppression, and ready-subscriber filter.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const agentRuntimeSource = readFileSync(
  resolve("src/lib/agent/runtime.ts"),
  "utf-8",
);
const threadStoreSource = readFileSync(
  resolve("src/stores/thread.store.ts"),
  "utf-8",
);

describe("#1852 — Fix 2: idle-reclaim honours navigation intent", () => {
  it("agent.store exports a registration hook for the navigation-intent getter", () => {
    expect(agentStoreSource).toContain(
      "export function registerActiveNavigationThreadIdGetter",
    );
  });

  it("thread.store registers its activeThreadId as the navigation-intent getter", () => {
    expect(threadStoreSource).toContain(
      "registerActiveNavigationThreadIdGetter",
    );
    const idx = threadStoreSource.indexOf(
      "registerActiveNavigationThreadIdGetter(",
    );
    // The registration call (not the import) must reference state.activeThreadId.
    const callBlock = threadStoreSource.slice(idx, idx + 200);
    expect(callBlock).toContain("state.activeThreadId");
  });

  it("getIdleClaudeSessionIds excludes sessions whose conversationId matches the navigation target", () => {
    const idx = agentStoreSource.indexOf("function getIdleClaudeSessionIds");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1500);
    expect(body).toContain("activeNavigationThreadIdGetter");
    expect(body).toMatch(/session\.conversationId\s*===\s*navTarget/);
  });
});

describe("#1852 — Fix 3: self-inflicted terminates do not surface in chat", () => {
  it("declares an expectedTerminateSessionIds set", () => {
    expect(agentRuntimeSource).toMatch(
      /const expectedTerminateSessionIds\s*=\s*new Set<string>\(\)/,
    );
  });

  it("agentStore.terminateSession adds the session id BEFORE the provider IPC kill", () => {
    const idx = agentStoreSource.indexOf("async terminateSession(");
    expect(idx).toBeGreaterThan(0);
    // Credential teardown now happens between the existing self-inflicted
    // marker and provider kill. Keep asserting their order without making the
    // source-window size part of the lifecycle contract.
    const body = agentStoreSource.slice(idx, idx + 3200);
    const addIdx = body.indexOf("expectedTerminateSessionIds.add(sessionId)");
    const ipcIdx = body.indexOf("providerService.terminateSession(sessionId)");
    expect(addIdx).toBeGreaterThan(0);
    expect(ipcIdx).toBeGreaterThan(0);
    expect(addIdx).toBeLessThan(ipcIdx);
  });

  it("agentStore.terminateSession deletes the flag after cleanup", () => {
    const idx = agentStoreSource.indexOf("async terminateSession(");
    // The function body spans cleanup of permissions/diffs, the IPC kill,
    // session-state removal, active-session reassignment, and global-
    // subscriber teardown — keep the window wide enough to cover all of it.
    const body = agentStoreSource.slice(idx, idx + 5000);
    expect(body).toContain(
      "expectedTerminateSessionIds.delete(sessionId)",
    );
  });

  it("the error handler short-circuits death-string events for expected terminates BEFORE addErrorMessage", () => {
    const idx = agentStoreSource.indexOf(
      "const isSessionDeath = isSessionDeathMessage(errStr)",
    );
    expect(idx).toBeGreaterThan(0);
    // Walk backwards to the enclosing `case "error"` block, then forward to
    // make sure the expectedTerminate guard sits ahead of the addErrorMessage
    // call. We assert the relative order so a refactor cannot silently
    // re-introduce the chat-noise regression.
    const caseIdx = agentStoreSource.lastIndexOf('case "error"', idx);
    expect(caseIdx).toBeGreaterThan(0);
    const block = agentStoreSource.slice(caseIdx, idx + 2000);
    const guardIdx = block.indexOf(
      "expectedTerminateSessionIds.has(sessionId)",
    );
    const addErrIdx = block.lastIndexOf(
      "this.addErrorMessage(sessionId, event.data.error)",
    );
    expect(guardIdx).toBeGreaterThan(0);
    expect(addErrIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(addErrIdx);
  });
});

describe("#1852 — Fix 4: temp ready-subscriber filters by the spawn's own session id", () => {
  it("declares an expectedReadySessionId variable seeded from localSessionId", () => {
    expect(agentStoreSource).toMatch(
      /let expectedReadySessionId[^=]*=\s*localSessionId\s*\?\?\s*null/,
    );
  });

  it("the temp subscriber gates resolveReady/rejectReady on session-id equality", () => {
    const idx = agentStoreSource.indexOf("Received session status event:");
    expect(idx).toBeGreaterThan(0);
    const block = agentStoreSource.slice(idx, idx + 1500);
    expect(block).toMatch(
      /data\.sessionId\s*!==\s*expectedReadySessionId/,
    );
  });

  it("expectedReadySessionId is updated to info.id after spawnAgent returns", () => {
    const idx = agentStoreSource.indexOf("[AgentStore] Spawn result:");
    expect(idx).toBeGreaterThan(0);
    const block = agentStoreSource.slice(idx, idx + 500);
    expect(block).toContain("expectedReadySessionId = info.id");
  });
});
