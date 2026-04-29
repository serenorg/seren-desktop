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

  it("#1716 — sets predictiveCompactBusy + predictiveCompactInFlight synchronously before the first await", () => {
    // The duplicate-spawn race (#1716) was: the 85% auto-compact branch
    // called compactAgentConversation directly, so the global mutex
    // (`predictiveCompactBusy`) and per-session flag
    // (`predictiveCompactInFlight`) stayed false until well after the
    // first `await` (the Sonnet-4 summary call). The 70% predictive block
    // that ran on the same `promptComplete` event then saw clean guards
    // and kicked a SECOND standby — orphaning the first.
    //
    // The fix routes the 85% branch through `kickPredictiveCompact`,
    // which is the only caller that flips both flags synchronously
    // before any `await`. Guard against a regression that pushes the
    // flag flip after an `await` (which would re-open the race).
    const fnStart = agentStoreSource.indexOf("async kickPredictiveCompact(");
    expect(fnStart, "kickPredictiveCompact must exist").toBeGreaterThan(0);
    const fnEnd = agentStoreSource.indexOf("\n  },", fnStart);
    const fnBody = agentStoreSource.slice(fnStart, fnEnd);

    const busyFlipIdx = fnBody.indexOf("predictiveCompactBusy = true");
    const inFlightFlipIdx = fnBody.indexOf(
      'setState("sessions", sessionId, "predictiveCompactInFlight", true)',
    );
    const firstAwaitIdx = fnBody.indexOf("await ");

    expect(busyFlipIdx, "predictiveCompactBusy must be flipped true").toBeGreaterThan(
      0,
    );
    expect(
      inFlightFlipIdx,
      "predictiveCompactInFlight must be flipped true",
    ).toBeGreaterThan(0);
    expect(firstAwaitIdx, "first await must exist").toBeGreaterThan(0);
    expect(
      busyFlipIdx,
      "predictiveCompactBusy must flip BEFORE the first await",
    ).toBeLessThan(firstAwaitIdx);
    expect(
      inFlightFlipIdx,
      "predictiveCompactInFlight must flip BEFORE the first await",
    ).toBeLessThan(firstAwaitIdx);
  });

  it("#1716 — 85% auto-compact branch and 70% predictive branch both gate on the same per-session flag", () => {
    // Without this contract the orphan-standby race returns: the 85%
    // branch could route through kickPredictiveCompact while the 70%
    // branch still gates on something else, and a third concurrent path
    // would be created. Both branches must observe predictiveCompactInFlight.
    const promptCompleteAnchor = "Predictive compaction — warm a replacement";
    const promptCompleteIdx = agentStoreSource.indexOf(promptCompleteAnchor);
    expect(promptCompleteIdx).toBeGreaterThan(0);
    const block = agentStoreSource.slice(
      promptCompleteIdx,
      promptCompleteIdx + 1000,
    );
    expect(block).toContain("!sess.predictiveCompactInFlight");
    expect(block).toContain("PREDICTIVE_COMPACT_THRESHOLD");
    expect(block).toContain("this.kickPredictiveCompact(sessionId)");
  });

  it("promoteStandbyAndDispatch swaps serving/standby at turn boundary", () => {
    expect(agentStoreSource).toContain("async promoteStandbyAndDispatch(");
    // serving gets terminated after the transcript transfers to the promoted id.
    expect(agentStoreSource).toContain('setState("sessions", standbyId, "role", "serving")');
    // The terminate call now passes opts (#1686) — match the call site loosely
    // so the formatting of the opts object doesn't regress this test.
    expect(agentStoreSource).toMatch(
      /await this\.terminateSession\(\s*servingSessionId,\s*\{/,
    );
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

describe("#1631 PR-1632 fix — cold-start cancel is honored", () => {
  const agentChatSource = readFileSync(
    resolve("src/components/chat/AgentChat.tsx"),
    "utf-8",
  );

  it("sendMessage re-checks turnInFlight after the spawn await and terminates the freshly-spawned session on cancel", () => {
    // After await spawnSession(...) resolves, if the user clicked Stop
    // mid-spawn, abortTurn flipped turnInFlight off. sendMessage must honor
    // it and tear down the half-spawned session so the prompt never sneaks
    // through. Guard against a regression to the pre-fix behavior where the
    // spawn result was dispatched regardless.
    const idx = agentChatSource.indexOf("cold-start cancelled during spawn");
    expect(idx).toBeGreaterThan(0);
    const region = agentChatSource.slice(idx - 400, idx + 400);
    expect(region).toContain("agentStore.isTurnInFlight(thread.id)");
    expect(region).toContain("agentStore.terminateSession(sid)");
  });

  it("sendMessage re-checks turnInFlight immediately before the final sendPrompt dispatch", () => {
    // Skill / doc-attachment loads add awaits between cold-start spawn and
    // the dispatch site. A late cancel during any of those awaits must
    // still prevent sendPrompt from firing.
    const idx = agentChatSource.indexOf("cancel detected before dispatch");
    expect(idx).toBeGreaterThan(0);
    const region = agentChatSource.slice(idx - 400, idx + 400);
    expect(region).toContain("agentStore.isTurnInFlight(thread.id)");
  });
});

describe("#1631 hotfix — warm-path submit sets turnInFlight before late-cancel guard", () => {
  const agentChatSource = readFileSync(
    resolve("src/components/chat/AgentChat.tsx"),
    "utf-8",
  );

  it("sendMessage flips turnInFlight true on the warm path before the late-cancel guard runs", () => {
    // Regression guard for the prod bug where the late-cancel guard fired
    // on every warm-path send — turnInFlight was never set to true before
    // the guard (sendPrompt sets it AFTER). The fix sets it true after the
    // isPrompting queue check and before any async awaits.
    const flipIdx = agentChatSource.indexOf(
      "ensures the warm path also flips it",
    );
    expect(flipIdx, "setTurnInFlight warm-path guard must exist").toBeGreaterThan(0);
    const guardIdx = agentChatSource.indexOf(
      "cancel detected before dispatch",
    );
    expect(guardIdx, "late-cancel guard must still exist").toBeGreaterThan(0);
    // The flip must appear BEFORE the late-cancel guard in source order.
    expect(flipIdx).toBeLessThan(guardIdx);
  });
});

describe("#1631 PR-1632 fix — predictive standby does not leak DB rows", () => {
  it("spawnSession skips createAgentConversation when opts.role === 'standby'", () => {
    // Without this gate, every warm-standby spawn wrote a conversation row
    // keyed on the standby session id. Promotion only rewrites the in-memory
    // conversationId, so the orphaned row re-surfaced as an idle thread in
    // the sidebar after restart. Guard against regression.
    const idx = agentStoreSource.indexOf(
      "Warm-standby spawns (#1631) must NOT write a DB row",
    );
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 800);
    expect(region).toContain('opts?.role !== "standby"');
    expect(region).toContain("createAgentConversation(");
  });
});
