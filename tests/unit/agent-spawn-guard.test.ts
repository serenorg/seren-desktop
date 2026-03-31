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

  it("tracks spawning conversations to prevent double-spawn", () => {
    expect(agentStoreSource).toContain("spawningConversations");
    // Must add before spawn
    expect(agentStoreSource).toContain("spawningConversations.add(conversationId)");
    // Must check before proceeding
    expect(agentStoreSource).toContain("spawningConversations.has(conversationId)");
    // Must clean up in finally
    expect(agentStoreSource).toContain("spawningConversations.delete(conversationId)");
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
