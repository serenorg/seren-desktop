// ABOUTME: Source-level regression tests for #1631 — turnInFlight continuous signal.
// ABOUTME: Per-thread state survives session swaps so thinking dots stay lit.

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

describe("#1631 — turnInFlight lives on per-thread state", () => {
  it("ThreadRuntimeState declares turnInFlight: boolean", () => {
    expect(agentStoreSource).toContain("interface ThreadRuntimeState");
    const idx = agentStoreSource.indexOf("interface ThreadRuntimeState");
    const body = agentStoreSource.slice(idx, idx + 500);
    expect(body).toContain("turnInFlight: boolean");
  });

  it("agentStore exposes setTurnInFlight and isTurnInFlight", () => {
    expect(agentStoreSource).toContain("setTurnInFlight(threadId: string");
    expect(agentStoreSource).toContain("isTurnInFlight(threadId: string");
  });

  it("sendPrompt flips turnInFlight true at entry", () => {
    const idx = agentStoreSource.indexOf("async sendPrompt(");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 4000);
    expect(body).toContain("this.setTurnInFlight(threadId, true)");
  });

  it("successful promptComplete clears turnInFlight and turnError", () => {
    const idx = agentStoreSource.indexOf('case "promptComplete"');
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 4000);
    expect(body).toContain("this.setTurnInFlight(convoId, false)");
    expect(body).toContain("this.clearTurnError(convoId)");
  });
});

describe("#1631 — thinking indicator driven by turnInFlight not session status", () => {
  it("AgentChat binds the loading placeholder to agentStore.isTurnInFlight", () => {
    expect(agentChatSource).toContain("agentStore.isTurnInFlight(");
  });

  it("AgentChat no longer gates the loading placeholder on isPrompting()", () => {
    // The ONLY acceptable `isPrompting()` references are for the composer
    // gating and keybindings — the loading-placeholder <Show> should read
    // the thread runtime state instead.
    const placeholderRegion = agentChatSource.slice(
      agentChatSource.indexOf("Loading placeholder"),
      agentChatSource.indexOf("Streaming Thinking"),
    );
    expect(placeholderRegion.length).toBeGreaterThan(0);
    expect(placeholderRegion).not.toContain("isPrompting()");
  });
});
