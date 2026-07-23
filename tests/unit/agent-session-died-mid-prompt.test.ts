// ABOUTME: Source-level regression tests for #1805/#1952 — mid-prompt session death recovery.
// ABOUTME: Ensures runtime-emitted death strings recover silently with restored context.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const agentStoreSource = readSource("src/stores/agent.store.ts");
const agentChatSource = readSource("src/components/chat/AgentChat.tsx");

const claudeRuntimeSource = readSource("bin/browser-local/claude-runtime.mjs");
const codexRuntimeSource = readSource("bin/browser-local/providers.mjs");
const geminiRuntimeSource = readSource("bin/browser-local/gemini-runtime.mjs");
const acpRuntimeSource = readSource("bin/browser-local/acp-runtime.mjs");

describe("#1805 — death-string catalog matches what runtimes emit", () => {
  // The error event handler's session-death detection MUST stay in sync with
  // the strings the runtimes actually emit. If the runtime adds a new death
  // path with a different prefix, this test should be the canary.

  it("Claude runtime emits the documented death strings", () => {
    expect(claudeRuntimeSource).toContain(
      '"Session terminated before request completed."',
    );
    expect(claudeRuntimeSource).toContain(
      "Claude Code stopped before request completed",
    );
    expect(claudeRuntimeSource).toContain(
      "Claude Code stopped while prompt was active",
    );
  });

  it("Codex runtime emits the documented death strings", () => {
    expect(codexRuntimeSource).toContain(
      '"Codex App Server stopped before request completed."',
    );
    expect(codexRuntimeSource).toContain(
      '"Worker thread dropped while prompt was active."',
    );
    expect(codexRuntimeSource).toContain(
      '"Session terminated before request completed."',
    );
  });

  it("Gemini runtime emits the documented death strings", () => {
    expect(geminiRuntimeSource).toContain(
      '"Gemini agent stopped before request completed."',
    );
    expect(acpRuntimeSource).toContain(
      '"Session terminated before request completed."',
    );
    expect(acpRuntimeSource).toContain("stoppedBeforeRequestMessage");
  });
});

describe("#1805 — error event handler detects mid-prompt session death", () => {
  it("matches the four substring patterns covering all three providers", () => {
    const idx = agentStoreSource.indexOf("function isSessionDeathMessage");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 500);
    expect(body).toContain('message.includes("Session terminated")');
    expect(body).toContain(
      'message.includes("stopped before request completed")',
    );
    expect(body).toContain(
      'message.includes("stopped while prompt was active")',
    );
    expect(body).toContain('message.includes("Worker thread dropped")');
  });

  it("only triggers when turnInFlight is true for the conversation", () => {
    const detect = agentStoreSource.indexOf(
      "const errStr = String(event.data.error)",
    );
    expect(detect).toBeGreaterThan(0);
    const body = agentStoreSource.slice(detect, detect + 1500);
    expect(body).toContain("this.isTurnInFlight(deathConvoId)");
  });

  it("routes through silent dropped-prompt recovery instead of surfacing a turn error", () => {
    const detect = agentStoreSource.indexOf(
      "const errStr = String(event.data.error)",
    );
    expect(detect).toBeGreaterThan(0);
    const body = agentStoreSource.slice(detect, detect + 2500);
    expect(body).toContain(
      "void this.recoverDroppedPrompt(sessionId, errStr",
    );
    expect(body).not.toContain('this.setTurnError(deathConvoId, "crash_ceiling"');
    expect(body).toContain(
      "} else {\n            this.addErrorMessage(sessionId, event.data.error);",
    );
  });
});

describe("#1805 — handleStatusChange safety net", () => {
  it("recovers silently when status becomes terminated/error while turnInFlight is true", () => {
    // Belt-and-suspenders for the case where session-status arrives without
    // a paired provider://error event.
    const idx = agentStoreSource.indexOf(
      "Belt-and-suspenders for the case where session-status",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1200);
    expect(body).toContain('status === "terminated" || status === "error"');
    expect(body).toContain("this.isTurnInFlight(convoId)");
    expect(body).toContain("!this.getTurnError(convoId)");
    expect(body).toContain("void this.recoverDroppedPrompt(");
    expect(body).not.toMatch(/this\.setTurnError\(\s*convoId,\s*"crash_ceiling"/);
  });
});

describe("#1952 — dropped-prompt recovery keeps context and replay invisible", () => {
  it("has a dedicated recovery helper", () => {
    expect(agentStoreSource).toMatch(
      /async recoverDroppedPrompt\(\s*sessionId: string,\s*reason: string,/,
    );
  });

  it("spawns the replacement session with restored messages and bootstrap context", () => {
    const idx = agentStoreSource.indexOf("async recoverDroppedPrompt(");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 5000);
    expect(body).toContain("buildDroppedPromptRecoverySnapshot(");
    expect(body).toContain("restoredMessages: snapshot.restoredMessages");
    expect(body).toContain(
      "bootstrapPromptContext: snapshot.bootstrapPromptContext",
    );
  });

  it("explicitly tells the restarted worker not to rely on a manual continue", () => {
    const idx = agentStoreSource.indexOf(
      "function buildDroppedPromptRecoveryBootstrapContext",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1800);
    expect(body).toContain(
      "do not ask the user to type continue",
    );
    expect(body).toContain("original prompt will be replayed automatically");
  });

  it("replays directly through providerService.sendPrompt without adding a duplicate user bubble", () => {
    const idx = agentStoreSource.indexOf("async recoverDroppedPrompt(");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 6500);
    expect(body).toContain("providerService.sendPrompt(");
    expect(body).not.toContain("this.sendPrompt(");
    expect(body).not.toContain("persistAgentMessage(newConvoId, userMessage)");
  });

  it("sendPrompt catch delegates dead sessions into the silent recovery helper", () => {
    const idx = agentStoreSource.indexOf(
      "Auto-recover from dead/zombie sessions.",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1600);
    expect(body).toContain("await this.recoverDroppedPrompt(sessionId, message");
    expect(body).toContain("currentUserMessageId: userMessage.id");
    expect(body).not.toContain("Retry failed:");
  });

  it("downgrades missing backend session termination during recovery to info logging", () => {
    const idx = agentStoreSource.indexOf("async terminateSession(");
    expect(idx).toBeGreaterThan(0);
    // Session teardown now revokes the session credential before the existing
    // provider-runtime recovery branch. Keep inspecting that branch rather
    // than treating the fixed source-window length as product behavior.
    const body = agentStoreSource.slice(idx, idx + 3200);
    expect(body).toContain('message.includes("not found")');
    expect(body).toContain("terminateSession: backend session already gone");
  });
});

describe("#1805 — retryLastPrompt consolidator", () => {
  it("is a public async method on agentStore", () => {
    expect(agentStoreSource).toContain("async retryLastPrompt(threadId: string)");
  });

  it("bails when no lastPromptText is recorded", () => {
    const idx = agentStoreSource.indexOf("async retryLastPrompt(threadId");
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain("ts?.lastPromptText");
    expect(body).toMatch(/no lastPromptText for thread/);
  });

  it("clears prior turnError before dispatching", () => {
    const idx = agentStoreSource.indexOf("async retryLastPrompt(threadId");
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain("this.clearTurnError(threadId)");
  });

  it("dispatches against the live session when one is usable", () => {
    const idx = agentStoreSource.indexOf("async retryLastPrompt(threadId");
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain("this.getSessionForConversation(threadId)");
    expect(body).toContain('liveStatus !== "error" && liveStatus !== "terminated"');
  });

  it("falls back to resumeAgentConversation when no live session exists", () => {
    const idx = agentStoreSource.indexOf("async retryLastPrompt(threadId");
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain("this.resumeAgentConversation(threadId)");
  });

  it("re-arms turnError on dispatch failure so the user can retry again", () => {
    const idx = agentStoreSource.indexOf("async retryLastPrompt(threadId");
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain('this.setTurnError(threadId, "crash_ceiling"');
  });
});

describe("#1805 — Retry button uses retryLastPrompt", () => {
  it("delegates to agentStore.retryLastPrompt(activeAgentThread().id)", () => {
    expect(agentChatSource).toContain("agentStore.retryLastPrompt(");
    // No leftover direct sendPrompt call from the inline retry click handler.
    // The retry click handler block must not contain the old direct dispatch.
    const idx = agentChatSource.indexOf("Couldn't send.");
    expect(idx).toBeGreaterThan(0);
    const block = agentChatSource.slice(idx, idx + 1500);
    expect(block).toContain("agentStore.retryLastPrompt(");
    expect(block).not.toContain("ts.lastPromptText");
  });
});
