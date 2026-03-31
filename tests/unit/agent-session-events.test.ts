// ABOUTME: Tests that agent session event routing handles stale events, spawn context, and terminated sessions.
// ABOUTME: Prevents regression where dead session errors leaked into live sessions.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("stale event filtering for terminated sessions", () => {
  it("maintains a terminatedSessionIds set", () => {
    expect(agentStoreSource).toContain(
      "const terminatedSessionIds = new Set<string>()",
    );
  });

  it("adds session ID to terminated set before IPC terminate call", () => {
    // The add must come before providerService.terminateSession to catch
    // events that arrive during the async IPC call.
    const addIndex = agentStoreSource.indexOf(
      "terminatedSessionIds.add(sessionId)",
    );
    const ipcIndex = agentStoreSource.indexOf(
      "await providerService.terminateSession(sessionId)",
    );
    expect(addIndex).toBeGreaterThan(-1);
    expect(ipcIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeLessThan(ipcIndex);
  });

  it("drops events for terminated session IDs unless spawn is in progress", () => {
    expect(agentStoreSource).toContain("terminatedSessionIds.has(eventSessionId)");
    // Must also check spawnContextMap so respawned sessions get config events
    expect(agentStoreSource).toContain("!spawnContextMap.has(eventSessionId)");
  });

  it("clears terminated session on new session registration", () => {
    // When a conversation ID is reused, the new session must not be blocked.
    expect(agentStoreSource).toContain("terminatedSessionIds.delete(info.id)");
  });

  it("clears terminated set on global subscriber teardown", () => {
    // When no sessions remain and the global subscriber is torn down,
    // the terminated set must be cleared to prevent unbounded growth.
    const teardownBlock = agentStoreSource.slice(
      agentStoreSource.indexOf("// Stop global event subscription when no sessions remain"),
    );
    expect(teardownBlock).toContain("terminatedSessionIds.clear()");
  });
});

describe("spawn context map for diagnostic logging", () => {
  it("maintains a spawnContextMap with agent type and conversation ID", () => {
    expect(agentStoreSource).toContain("const spawnContextMap = new Map<");
    expect(agentStoreSource).toContain(
      "{ agentType: string; conversationId?: string }",
    );
  });

  it("populates spawn context before the IPC spawnAgent call", () => {
    const setIndex = agentStoreSource.indexOf("spawnContextMap.set(localSessionId");
    const spawnIndex = agentStoreSource.indexOf(
      "await providerService.spawnAgent(",
    );
    expect(setIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(setIndex).toBeLessThan(spawnIndex);
  });

  it("cleans up spawn context after session registration", () => {
    expect(agentStoreSource).toContain("spawnContextMap.delete(info.id)");
  });

  it("uses spawn context in the global event logger fallback", () => {
    expect(agentStoreSource).toContain("spawnContextMap.get(eventSessionId)");
    expect(agentStoreSource).toContain("spawnCtx?.agentType");
    expect(agentStoreSource).toContain("spawnCtx?.conversationId");
  });
});

describe("spawnSession double-spawn guard", () => {
  it("checks spawningConversations before proceeding in spawnSession", () => {
    // The guard must be inside spawnSession itself, not just resumeAgentConversation.
    const spawnSessionBody = agentStoreSource.slice(
      agentStoreSource.indexOf("async spawnSession("),
      agentStoreSource.indexOf("async resumeAgentConversation("),
    );
    expect(spawnSessionBody).toContain("spawningConversations.has(spawnKey)");
    expect(spawnSessionBody).toContain("spawningConversations.add(spawnKey)");
  });

  it("allows internal retries to bypass the guard", () => {
    expect(agentStoreSource).toContain(
      "initRetryAttempt === 0 && spawningConversations.has(spawnKey)",
    );
  });

  it("cleans up the guard in a finally block", () => {
    expect(agentStoreSource).toContain("spawningConversations.delete(spawnKey)");
  });
});
