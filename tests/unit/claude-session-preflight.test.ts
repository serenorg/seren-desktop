// ABOUTME: Regression test for #1657 — resumeAgentConversation must call
// ABOUTME: claudeSessionExists before the initial spawn for claude-code agents,
// ABOUTME: and must skip --resume when the JSONL file is missing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const claudeMemorySource = readFileSync(
  resolve("src/services/claudeMemory.ts"),
  "utf-8",
);

function extractResumeAgentConversationBody(): string {
  const start = agentStoreSource.indexOf("async resumeAgentConversation(");
  if (start < 0) return "";
  const after = agentStoreSource.indexOf("\n  async ", start + 1);
  return after < 0
    ? agentStoreSource.slice(start)
    : agentStoreSource.slice(start, after);
}

describe("#1657 — claudeSessionExists pre-flight before --resume", () => {
  const body = extractResumeAgentConversationBody();

  it("services/claudeMemory exports claudeSessionExists invoking the Tauri command", () => {
    expect(claudeMemorySource).toContain(
      "export async function claudeSessionExists(",
    );
    expect(claudeMemorySource).toContain('invoke<boolean>("claude_session_exists"');
    // Browser runtime degrades to false (no CLI sessions to check). Without
    // this guard, the chat panel inside a non-Tauri shell would always think
    // the file exists and try --resume, which is a guaranteed failure.
    expect(claudeMemorySource).toContain("if (!isTauriRuntime()) {");
  });

  it("agent.store imports claudeSessionExists from the service module", () => {
    expect(agentStoreSource).toContain(
      'import { claudeSessionExists } from "@/services/claudeMemory"',
    );
  });

  it("resumeAgentConversation calls claudeSessionExists before the initial resume spawn", () => {
    // resumeAgentConversation has multiple spawnSession calls (early-exit
    // branch, initial-resume, post-failure fallback). The pre-flight must
    // run BEFORE the initial resume spawn — the one that actually passes
    // resumeAgentSessionId. Use that specific call as the anchor.
    expect(body, "function body must be non-empty").not.toBe("");
    const checkIdx = body.indexOf("claudeSessionExists(");
    const initialResumeSpawnIdx = body.indexOf(
      "resumeAgentSessionId: effectiveResumeId",
    );
    expect(checkIdx, "must call claudeSessionExists").toBeGreaterThan(0);
    expect(
      initialResumeSpawnIdx,
      "must pass effectiveResumeId to the initial resume spawn",
    ).toBeGreaterThan(0);
    expect(
      checkIdx,
      "claudeSessionExists must be called BEFORE the initial resume spawn",
    ).toBeLessThan(initialResumeSpawnIdx);
  });

  it("guard is gated on agentType === 'claude-code'", () => {
    // Codex and other agents must not pay the IPC cost of the check.
    const guardIdx = body.indexOf('agentType === "claude-code"');
    const checkIdx = body.indexOf("claudeSessionExists(");
    expect(guardIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(checkIdx);
  });

  it("when the file is missing, the spawn drops --resume by setting effectiveResumeId to undefined", () => {
    expect(body).toContain("effectiveResumeId = undefined");
    expect(body).toContain("resumeAgentSessionId: effectiveResumeId");
  });

  it("falls through to the spawn-and-recover path if the IPC check itself errors", () => {
    // A failure in the existence check must NOT regress to a hard error.
    // The catch arm must log a warning and proceed with the original
    // remoteSessionId so the existing fallback path still runs.
    expect(body).toContain("claudeSessionExists check failed");
  });
});
