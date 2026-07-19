// ABOUTME: Critical regression guards for #2971 — paired threads can fork.
// ABOUTME: The fresh pair keeps its declaration identity and explicit role pins.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const forkStart = agentStoreSource.indexOf("async forkConversation(");
const forkEnd = agentStoreSource.indexOf(
  "addErrorMessage(sessionId: string",
  forkStart,
);
const forkBody = agentStoreSource.slice(forkStart, forkEnd);
const spawnStart = agentStoreSource.indexOf("async spawnSession(");
const spawnEnd = agentStoreSource.indexOf(
  "async resumeAgentConversation(",
  spawnStart,
);
const spawnBody = agentStoreSource.slice(spawnStart, spawnEnd);

describe("#2971 — paired agent conversation fork", () => {
  it("carries paired role pins through conversation metadata and spawn", () => {
    expect(forkStart).toBeGreaterThan(0);
    expect(forkBody).toContain("pairedSpawnConfigFromStatus(");
    expect(forkBody).toContain("session.paired");
    expect(forkBody).toMatch(/pendingBootstrapMessages:[\s\S]*pairedConfig,/);
    expect(forkBody).toMatch(/spawnSession\([\s\S]*paired: pairedConfig,/);
  });

  it("remaps the setup declaration to the forked conversation", () => {
    expect(forkBody).toContain(
      "message.id === `paired-declaration-${session.conversationId}`",
    );
    expect(forkBody).toContain(
      "id: `paired-declaration-${newConversationId}`",
    );
  });

  it("does not erase paired role pins when bootstrap context is consumed", () => {
    const setterStart = agentStoreSource.indexOf(
      "setBootstrapPromptContext(\n",
    );
    const setterEnd = agentStoreSource.indexOf(
      "clearBootstrapPromptContext(sessionId: string)",
      setterStart,
    );
    const setterBody = agentStoreSource.slice(setterStart, setterEnd);

    expect(setterStart).toBeGreaterThan(0);
    expect(setterBody).toContain("pairedSpawnConfigFromStatus(");
    expect(setterBody).toContain("session.paired");
  });

  it("preserves the explicit fork title in the live session", () => {
    expect(spawnStart).toBeGreaterThan(0);
    expect(forkBody).toContain("conversationTitle: forkTitle");
    expect(spawnBody).toContain("title: opts?.conversationTitle,");
    expect(spawnBody).not.toContain("title: conversationTitle,");
  });
});
