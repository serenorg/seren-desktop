// ABOUTME: Source-level regression tests for #1631 — predictive compaction.
// ABOUTME: Verifies threshold constant, mutex, mode param, and promotion wiring.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1631 — predictive compaction threshold & concurrency", () => {
  it("exposes the 0.70 trigger constant at module scope", () => {
    expect(agentStoreSource).toContain(
      "export const PREDICTIVE_COMPACT_THRESHOLD = 0.7",
    );
  });

  it("declares a module-level predictiveCompactBusy flag", () => {
    expect(agentStoreSource).toMatch(
      /let predictiveCompactBusy\s*=\s*false/,
    );
  });

  it("gates the trigger in promptComplete on all four invariants", () => {
    expect(agentStoreSource).toContain("!sess.standbySessionId");
    expect(agentStoreSource).toContain("!sess.isCompacting");
    expect(agentStoreSource).toContain("!sess.predictiveCompactInFlight");
    expect(agentStoreSource).toContain("PREDICTIVE_COMPACT_THRESHOLD");
  });
});

describe("#1631 — compactAgentConversation accepts mode", () => {
  it("compactAgentConversation has a mode: 'reactive' | 'predictive' param", () => {
    expect(agentStoreSource).toMatch(
      /mode\?:\s*"reactive"\s*\|\s*"predictive"/,
    );
  });

  it("predictive branch spawns with role=\"standby\" and does not terminate serving", () => {
    expect(agentStoreSource).toContain('if (mode === "predictive")');
    expect(agentStoreSource).toContain('role: "standby"');
  });
});

describe("#1631 — kickPredictiveCompact + promoteStandbyAndDispatch", () => {
  it("kickPredictiveCompact symbol exists and is idempotent via busy flag", () => {
    expect(agentStoreSource).toContain("async kickPredictiveCompact(");
    expect(agentStoreSource).toContain("if (predictiveCompactBusy) return");
  });

  it("promoteStandbyAndDispatch swaps serving/standby at turn boundary", () => {
    expect(agentStoreSource).toContain("async promoteStandbyAndDispatch(");
    // serving gets terminated after the transcript transfers to the promoted id.
    expect(agentStoreSource).toContain('setState("sessions", standbyId!, "role", "serving")');
    expect(agentStoreSource).toContain("await this.terminateSession(servingSessionId)");
  });

  it("sendPrompt checks for a ready standby and promotes when present", () => {
    expect(agentStoreSource).toContain("standby.seedCompleted === true");
    expect(agentStoreSource).toContain("await this.promoteStandbyAndDispatch(");
  });
});

describe("#1631 — abortTurn wired for user cancel", () => {
  it("abortTurn symbol exists and does NOT set turnError", () => {
    const idx = agentStoreSource.indexOf("async abortTurn(");
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 1200);
    expect(body).toContain("this.setTurnInFlight(threadId, false)");
    expect(body).not.toContain("this.setTurnError(");
  });

  it("composer stop button calls agentStore.abortTurn", () => {
    const chat = readFileSync(
      resolve("src/components/chat/AgentChat.tsx"),
      "utf-8",
    );
    expect(chat).toContain("agentStore.abortTurn(");
  });
});
