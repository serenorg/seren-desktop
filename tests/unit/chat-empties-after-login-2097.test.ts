// ABOUTME: Login recovery must keep agent threads bound to durable history.
// ABOUTME: Guards explicit restart and post-dismiss cold-start paths.

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

describe("#2967 — post-login cold-start resumes the active thread", () => {
  const sendMessageIdx = agentChatSource.indexOf("const sendMessage = async");
  const coldStartEnd = agentChatSource.indexOf(
    "// Require text content even when images are attached",
    sendMessageIdx,
  );
  const coldStartBody = agentChatSource.slice(sendMessageIdx, coldStartEnd);

  it("resumes the persisted conversation instead of bare-spawning without history", () => {
    expect(sendMessageIdx).toBeGreaterThan(0);
    expect(coldStartEnd).toBeGreaterThan(sendMessageIdx);
    expect(coldStartBody).toMatch(
      /resumeAgentConversation\(\s*thread\.id,\s*thread\.projectRoot \|\| fileTreeState\.rootPath,?\s*\)/,
    );
    expect(coldStartBody).not.toContain("agentStore.spawnSession(");
  });
});
