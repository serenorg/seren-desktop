// ABOUTME: Source-level regression tests for #1805 — mid-prompt session death recovery.
// ABOUTME: Wires runtime-emitted death strings into setTurnError so the inline Retry link surfaces.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);
const codexRuntimeSource = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);
const geminiRuntimeSource = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);

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
    expect(geminiRuntimeSource).toContain(
      '"Session terminated before request completed."',
    );
  });
});

describe("#1805 — error event handler detects mid-prompt session death", () => {
  it("matches the four substring patterns covering all three providers", () => {
    expect(agentStoreSource).toContain('errStr.includes("Session terminated")');
    expect(agentStoreSource).toContain(
      'errStr.includes("stopped before request completed")',
    );
    expect(agentStoreSource).toContain(
      'errStr.includes("stopped while prompt was active")',
    );
    expect(agentStoreSource).toContain(
      'errStr.includes("Worker thread dropped")',
    );
  });

  it("only triggers when turnInFlight is true for the conversation", () => {
    const detect = agentStoreSource.indexOf("isSessionDeath");
    expect(detect).toBeGreaterThan(0);
    const body = agentStoreSource.slice(detect, detect + 1500);
    expect(body).toContain("this.isTurnInFlight(deathConvoId)");
  });

  it("resets session status to ready and routes through setTurnError", () => {
    const detect = agentStoreSource.indexOf("isSessionDeath");
    expect(detect).toBeGreaterThan(0);
    const body = agentStoreSource.slice(detect, detect + 1500);
    expect(body).toContain('"ready" as SessionStatus');
    expect(body).toContain(
      'this.setTurnError(deathConvoId, "crash_ceiling"',
    );
  });
});

describe("#1805 — handleStatusChange safety net", () => {
  it("fires when status becomes terminated/error while turnInFlight is true", () => {
    // Belt-and-suspenders for the case where session-status arrives without
    // a paired provider://error event.
    const idx = agentStoreSource.indexOf(
      "Belt-and-suspenders for the case where session-status",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 800);
    expect(body).toContain('status === "terminated" || status === "error"');
    expect(body).toContain("this.isTurnInFlight(convoId)");
    expect(body).toContain("!this.getTurnError(convoId)");
    expect(body).toMatch(
      /this\.setTurnError\(\s*convoId,\s*"crash_ceiling"/,
    );
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
