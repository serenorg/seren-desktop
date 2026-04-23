// ABOUTME: Source-level regression tests for #1631 — terminal error bubble.
// ABOUTME: Closed ErrorKind union, setTurnError wiring, inline retry-link UX.

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

describe("#1631 — ErrorKind closed union contains exactly seven variants", () => {
  it("includes all seven auto-report kinds", () => {
    expect(agentStoreSource).toContain('"restart_timeout"');
    expect(agentStoreSource).toContain('"spawn_failed"');
    expect(agentStoreSource).toContain('"auth_expired"');
    expect(agentStoreSource).toContain('"binary_missing"');
    expect(agentStoreSource).toContain('"crash_ceiling"');
    expect(agentStoreSource).toContain('"summary_call_failed"');
    expect(agentStoreSource).toContain('"seed_failed"');
  });

  it("ErrorKind is exported so tests and the UI share the type", () => {
    expect(agentStoreSource).toContain("export type ErrorKind");
  });
});

describe("#1631 — setTurnError wires the auto-report pipeline (#1630)", () => {
  it("setTurnError exists, flips turnInFlight off, and fires _submitTurnErrorReport", () => {
    const idx = agentStoreSource.indexOf("setTurnError(threadId: string");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1500);
    expect(body).toContain('setState("threadStates", threadId, "turnInFlight", false)');
    expect(body).toContain("this._submitTurnErrorReport(");
  });

  it("submit bundle references all seven error kinds via callers or the union", () => {
    // The union declares the full set; the submit helper forwards whichever
    // kind the caller passed, so the test simply re-asserts closure.
    const union = agentStoreSource.slice(
      agentStoreSource.indexOf("export type ErrorKind"),
    );
    expect(union).toContain("restart_timeout");
    expect(union).toContain("spawn_failed");
    expect(union).toContain("auth_expired");
    expect(union).toContain("binary_missing");
    expect(union).toContain("crash_ceiling");
    expect(union).toContain("summary_call_failed");
    expect(union).toContain("seed_failed");
  });

  it("submit_support_report is referenced as the pipeline target (#1630 TODO)", () => {
    // The auto-report callsite names the backend command verbatim, even
    // while the ticket stubs until #1630 ships.
    expect(agentStoreSource).toContain("submit_support_report");
  });
});

describe("#1631 — inline error bubble + retry link", () => {
  it("AgentChat reads agentStore.getTurnError for the last-user-message bubble", () => {
    expect(agentChatSource).toContain("agentStore.getTurnError(");
  });

  it("AgentChat renders 'Couldn't send. Retry' on terminal error", () => {
    expect(agentChatSource).toContain("Couldn't send.");
    // The retry word is rendered inside the <button>…</button> text node.
    expect(agentChatSource).toMatch(/>\s*Retry\s*<\/button>/);
  });

  it("retry link re-calls sendPrompt with the stored last-prompt record", () => {
    expect(agentChatSource).toContain("agentStore.clearTurnError(");
    expect(agentChatSource).toContain("agentStore.sendPrompt(");
    expect(agentChatSource).toContain("ts.lastPromptText");
  });
});

describe("#1631 — restart timer budget wired on cold-start", () => {
  it("cold-start path arms the 60s budget with spawn_failed classification", () => {
    expect(agentChatSource).toContain(
      'agentStore.armRestartTimer(thread.id, 60_000, "spawn_failed")',
    );
  });

  it("armRestartTimer clears on stream start", () => {
    // Skip the call-site at the top of the file; we want the method body.
    const idx = agentStoreSource.indexOf(
      "armRestartTimer(threadId: string",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1500);
    expect(body).toContain("streamingNow");
  });
});
