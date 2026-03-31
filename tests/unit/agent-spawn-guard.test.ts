// ABOUTME: Tests that agent spawn has a double-spawn guard and Codex aborts on dead process.
// ABOUTME: Prevents regression where selectThread firing twice caused a race condition.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("agent spawn double-spawn guard", () => {
  const agentStoreSource = readFileSync(
    resolve("src/stores/agent.store.ts"),
    "utf-8",
  );

  it("spawnSession guards against double-spawn with cleanup", () => {
    expect(agentStoreSource).toContain("spawningConversations");
    // Must add before spawn in spawnSession
    expect(agentStoreSource).toContain("spawningConversations.add(spawnKey)");
    // Must check before proceeding in spawnSession
    expect(agentStoreSource).toContain("spawningConversations.has(spawnKey)");
    // Must clean up in finally in spawnSession
    expect(agentStoreSource).toContain("spawningConversations.delete(spawnKey)");
  });

  it("resumeAgentConversation does NOT hold spawn guard (avoids blocking retries)", () => {
    // The guard must only live in spawnSession. If resumeAgentConversation
    // also holds it, its own retry fallback gets blocked.
    const resumeFn = agentStoreSource.slice(
      agentStoreSource.indexOf("async resumeAgentConversation("),
      agentStoreSource.indexOf("async resumeRemoteSession("),
    );
    expect(resumeFn).not.toContain("spawningConversations.add(conversationId)");
    expect(resumeFn).not.toContain("spawningConversations.delete(conversationId)");
  });
});

describe("Codex spawnSession dead-process guard", () => {
  const providersSource = readFileSync(
    resolve("bin/browser-local/providers.mjs"),
    "utf-8",
  );

  it("aborts before thread/start if model/list fails with termination error", () => {
    // After model/list fails with "terminated" or "stopped", the code
    // must throw instead of continuing to thread/start on a dead process.
    expect(providersSource).toContain('errMsg.includes("terminated")');
    expect(providersSource).toContain('errMsg.includes("stopped")');
  });

  it("checks session is still tracked before thread/start", () => {
    expect(providersSource).toContain("sessions.has(sessionId)");
    expect(providersSource).toContain(
      "Codex session was terminated during initialization",
    );
  });
});
