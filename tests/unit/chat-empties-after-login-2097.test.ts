// ABOUTME: #2097 regression — Login / Restart Session must resume the active
// ABOUTME: thread from SQLite instead of cold-spawning a fresh bare session.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("#2097 — startSession resumes the active thread", () => {
  const startSessionIdx = agentChatSource.indexOf("const startSession = async");
  const startSessionBody = agentChatSource.slice(
    startSessionIdx,
    startSessionIdx + 1500,
  );

  it("delegates to resumeAgentConversation so SQLite history is reloaded", () => {
    expect(startSessionIdx).toBeGreaterThan(0);
    expect(startSessionBody).toContain("agentStore.resumeAgentConversation(");
  });

  it("passes the active thread id so the new session inherits the thread's conversationId binding", () => {
    expect(startSessionBody).toMatch(
      /resumeAgentConversation\(\s*thread\.id\s*\)/,
    );
  });

  it("does not fall through to a bare spawnSession (the #2097 regression path)", () => {
    // Pre-fix the body unconditionally called agentStore.spawnSession(cwd, agentType),
    // which dropped the thread binding and left messages stranded in SQLite.
    expect(startSessionBody).not.toContain("agentStore.spawnSession(");
  });
});
