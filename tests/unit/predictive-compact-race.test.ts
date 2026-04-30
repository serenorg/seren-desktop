// ABOUTME: Regression guards for #1749 — predictive compaction race where
// ABOUTME: sendPrompt dispatches on overloaded serving session before standby is ready.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1749 — sendPrompt enqueues instead of dispatching when predictive compact is in flight", () => {
  it("guard fires when predictiveCompactInFlight=true, no standby yet, and usage >= autoCompactThreshold", () => {
    // The bug: kickPredictiveCompact flips predictiveCompactInFlight=true
    // synchronously (agent.store.ts:3292-3293) but standbySessionId is not
    // populated until the spawn round-trip completes (~10s later, line ~3029).
    // sendPrompt only intercepted on standbySessionId, so a user submit during
    // the spawn window dispatched on the overloaded serving session and grew
    // context further (127% → 183% in the reported transcript). The guard
    // must check predictiveCompactInFlight AND !standbySessionId AND
    // critical-usage so a fast user does not get held up below the threshold.
    const sendPromptStart = agentStoreSource.indexOf(
      "async sendPrompt(\n    prompt: string",
    );
    expect(sendPromptStart, "sendPrompt must exist").toBeGreaterThan(0);
    // Guard must live before the "standbySessionId" promote-or-wait block.
    const standbyBlockIdx = agentStoreSource.indexOf(
      "// Predictive swap: if a warm standby is ready",
      sendPromptStart,
    );
    expect(standbyBlockIdx).toBeGreaterThan(sendPromptStart);

    const guardWindow = agentStoreSource.slice(sendPromptStart, standbyBlockIdx);
    expect(guardWindow).toContain("session.predictiveCompactInFlight");
    expect(guardWindow).toContain("!session.standbySessionId");
    expect(guardWindow).toContain(
      "settingsStore.settings.autoCompactThreshold / 100",
    );
    expect(guardWindow).toContain("this.enqueuePrompt(sessionId, prompt)");
  });

  it("guard does not reset turnInFlight (UI stays in 'sending' until dispatch completes)", () => {
    // Matches the #1623 isCompacting re-enqueue contract: when a prompt is
    // queued for a session that is about to swap, the turn IS still in
    // flight conceptually — the UI must keep showing "sending..." until the
    // promoted session's promptComplete clears it. Resetting turnInFlight to
    // false here would let the user fire-and-forget more prompts before the
    // first one even dispatches, and would hide the spinner mid-turn.
    const guardStart = agentStoreSource.indexOf(
      "// Predictive-compact race guard (#1749)",
    );
    expect(guardStart, "race guard must be tagged with #1749").toBeGreaterThan(
      0,
    );
    const guardEnd = agentStoreSource.indexOf("\n    }\n", guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guardBlock = agentStoreSource.slice(guardStart, guardEnd);
    expect(guardBlock).not.toMatch(/setTurnInFlight\([^)]+,\s*false\)/);
  });
});

describe("#1749 — promoteStandbyAndDispatch carries pendingPrompts across the swap", () => {
  it("transfers serving.pendingPrompts to the standby BEFORE terminateSession deletes serving", () => {
    // Without this transfer, prompts queued by the race guard above would be
    // dropped on the floor when terminateSession deletes serving from
    // state.sessions. The transfer must happen before the terminateSession
    // call.
    const fnStart = agentStoreSource.indexOf("async promoteStandbyAndDispatch(");
    expect(fnStart, "promoteStandbyAndDispatch must exist").toBeGreaterThan(0);
    const terminateIdx = agentStoreSource.indexOf(
      "this.terminateSession(servingSessionId",
      fnStart,
    );
    expect(terminateIdx).toBeGreaterThan(fnStart);

    const preTerminate = agentStoreSource.slice(fnStart, terminateIdx);
    expect(preTerminate).toContain("serving.pendingPrompts");
    expect(preTerminate).toMatch(
      /setState\(\s*"sessions",\s*standbyId,\s*"pendingPrompts"/,
    );
  });
});

describe("#1749 — standby seedCompleted handler drains the serving queue", () => {
  it("when standby's seed promptComplete fires, drains a queued prompt on the matching serving session", () => {
    // Without this drain trigger, prompts the race guard parked on the
    // serving session's pendingPrompts would sit there forever — the user
    // never sees a reply because no event re-enters sendPrompt for them.
    // The drain must happen inside the standby branch of the promptComplete
    // handler, after seedCompleted=true and predictiveCompactInFlight=false
    // have been written.
    const standbyBranch = agentStoreSource.indexOf(
      'state.sessions[sessionId]?.role === "standby"',
    );
    expect(standbyBranch, "standby promptComplete branch must exist").toBeGreaterThan(
      0,
    );
    const branchEnd = agentStoreSource.indexOf("\n          break;\n", standbyBranch);
    expect(branchEnd).toBeGreaterThan(standbyBranch);
    const branchBody = agentStoreSource.slice(standbyBranch, branchEnd);

    // Must drain when serving has pendingPrompts.
    expect(branchBody).toMatch(/pendingPrompts/);
    // Must dispatch via sendPrompt on the serving session (not the standby).
    expect(branchBody).toContain("this.sendPrompt(");
    // Must reference #1749 so future readers know why this drain exists.
    expect(branchBody).toContain("#1749");
  });
});

describe("#1749 — defaultContextWindowFor recognises 1M Claude variants at spawn time", () => {
  it("the spawn-time fallback delegates to defaultContextWindowFor with agentType + initialModelId", () => {
    // The pre-#1749 fallback hardcoded 200_000 for Claude regardless of the
    // model — so a session on claude-opus-4-7 (1M) reported 127%/183% usage
    // on a model that actually had plenty of room, kicking premature
    // compaction. The helper centralises the cold-start default and lets
    // 1M-tier Claude IDs report their real window.
    expect(agentStoreSource).toContain(
      "defaultContextWindowFor(resolvedAgentType, opts?.initialModelId)",
    );
    // The old inline ternary cascade must be gone from the spawn block.
    const spawnBlockIdx = agentStoreSource.indexOf("const cachedContextWindow");
    const spawnBlockEnd = agentStoreSource.indexOf(
      "bootstrapPromptContext: finalBootstrapContext",
      spawnBlockIdx,
    );
    const spawnBlock = agentStoreSource.slice(spawnBlockIdx, spawnBlockEnd);
    expect(spawnBlock).not.toMatch(/resolvedAgentType\s*===\s*"codex"/);
  });

  it("the helper maps known 1M Claude IDs to 1_000_000 and unknowns to 200_000", () => {
    const helperStart = agentStoreSource.indexOf(
      "function defaultContextWindowFor(",
    );
    expect(helperStart, "defaultContextWindowFor must exist").toBeGreaterThan(0);
    const helperEnd = agentStoreSource.indexOf("\n}\n", helperStart);
    const helperBody = agentStoreSource.slice(helperStart, helperEnd);

    // Codex / Gemini cases must still return their existing defaults.
    expect(helperBody).toContain('agentType === "codex"');
    expect(helperBody).toContain("400_000");
    expect(helperBody).toContain('agentType === "gemini"');
    expect(helperBody).toContain("1_000_000");

    // Claude 1M models must be enumerated explicitly so a brand-new install
    // hits the right window on the very first turn (before the CLI's
    // meta.contextWindow has had a chance to upsert).
    expect(agentStoreSource).toContain('"claude-opus-4-7"');
    expect(agentStoreSource).toContain('"claude-sonnet-4-6"');
    // Default for anything unknown is still 200_000.
    expect(helperBody).toContain("200_000");
  });

  it("the [1m] suffix variant also maps to 1M context", () => {
    // The CLI advertises the 1M tier as a bracketed suffix
    // (`claude-opus-4-7[1m]`); both the bare ID and the bracketed form
    // must hit the 1M branch so a fresh session does not start at 200K
    // and trigger premature auto-compaction.
    const helperStart = agentStoreSource.indexOf(
      "function defaultContextWindowFor(",
    );
    const helperEnd = agentStoreSource.indexOf("\n}\n", helperStart);
    const helperBody = agentStoreSource.slice(helperStart, helperEnd);
    expect(helperBody).toContain("\\[1m\\]");
  });
});
