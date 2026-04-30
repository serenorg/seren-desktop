// ABOUTME: Regression tests for #1623 — queued user messages must survive
// ABOUTME: auto-compaction (no silent data loss in chat).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1623 — auto-compact runs BEFORE drain in promptComplete handler", () => {
  it("auto-compact comment anchor appears before the drain comment anchor", () => {
    // The bug was: drain ran first, scheduled a setTimeout(sendPrompt, 100),
    // then auto-compact triggered. The setTimeout fired during compaction and
    // added a user message to the old session's messages array, which was
    // then overwritten by compaction's stale toPreserve snapshot. Reordering
    // the two blocks causes isCompacting to be set synchronously before the
    // drain block's guard runs, so the drain is skipped.
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const drainAnchor = "Drain the prompt queue for this session";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    const drainIdx = agentStoreSource.indexOf(drainAnchor);

    expect(autoCompactIdx, "auto-compact anchor must exist").toBeGreaterThan(0);
    expect(drainIdx, "drain anchor must exist").toBeGreaterThan(0);
    expect(
      autoCompactIdx,
      "auto-compact must be positioned BEFORE drain in promptComplete handler",
    ).toBeLessThan(drainIdx);
  });
});

describe("#1623 — compactAgentConversation transfers pendingPrompts to new session", () => {
  it("captures queuedPrompts from the old session before termination", () => {
    // Without this capture, compaction's setState overwrites any
    // mid-compaction drains and the user's typed message is silently lost.
    expect(agentStoreSource).toContain(
      "const queuedPrompts = session.pendingPrompts ?? [];",
    );
  });

  it("assigns queuedPrompts to the new session's pendingPrompts", () => {
    expect(agentStoreSource).toContain(
      'setState("sessions", newSessionId, "pendingPrompts", queuedPrompts)',
    );
  });

  it("compactAgentConversation does not accept a retry-prompt parameter (#1757)", () => {
    // Post-#1757, retry dispatch is the caller's responsibility.
    // compactAgentConversation produces a fresh, idle, seeded session and
    // returns its id; nothing more. Reintroducing a pendingUserPrompt-style
    // param would re-open the double-dispatch latent in the old design
    // (Codex short-circuited via the swap-check; Claude Code double-sent).
    const fnStart = agentStoreSource.indexOf("async compactAgentConversation(");
    expect(fnStart, "compactAgentConversation must exist").toBeGreaterThan(0);
    const sigEnd = agentStoreSource.indexOf("): Promise<", fnStart);
    const signature = agentStoreSource.slice(fnStart, sigEnd);
    expect(signature).not.toMatch(/pendingUserPrompt/);
    // The inline read must also be gone.
    expect(agentStoreSource).not.toContain(
      "const pendingUserPrompt = session.lastUserPrompt;",
    );
  });

  it("auto-compact-from-promptComplete does not retry the just-completed prompt (#1716 routes via kickPredictiveCompact)", () => {
    // The prompt that produced this promptComplete already succeeded — we
    // MUST NOT retry it or the user sees a duplicate turn.
    //
    // Post-#1716 the auto-compact branch routes through
    // `this.kickPredictiveCompact(sessionId)` rather than calling
    // `compactAgentConversation` directly. Post-#1757 compactAgentConversation
    // never retries at all — there is no retry-prompt param to forward — so
    // the no-retry contract is now structural, not a question of which
    // sentinel value gets passed.
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const drainAnchor = "Drain the prompt queue for this session";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    const drainIdx = agentStoreSource.indexOf(drainAnchor);
    const autoCompactBlock = agentStoreSource.slice(autoCompactIdx, drainIdx);
    expect(autoCompactBlock).toContain("this.kickPredictiveCompact(sessionId)");
    // The auto-compact branch must NOT pass any pendingUserPrompt arg —
    // it has no business retrying the just-completed prompt.
    expect(autoCompactBlock).not.toMatch(
      /kickPredictiveCompact\(sessionId,\s*[^)]/,
    );
  });

  it("compactAndRetry retries the failed prompt itself, after compactAgentConversation returns (#1757)", () => {
    // The failed-prompt retry path must still work — it IS a real retry —
    // but the dispatch lives in compactAndRetry, not compactAgentConversation.
    // Single responsibility per function, no double-dispatch.
    const fnStart = agentStoreSource.indexOf("async compactAndRetry(");
    expect(fnStart, "compactAndRetry must exist").toBeGreaterThan(0);
    const fnEnd = agentStoreSource.indexOf("\n  },", fnStart);
    const fnBody = agentStoreSource.slice(fnStart, fnEnd);

    // The retry sendPrompt is in compactAndRetry's body, gated on lastPrompt.
    expect(fnBody).toMatch(
      /if \(lastPrompt\) \{[\s\S]*?providerService\.sendPrompt\(newSessionId,\s*lastPrompt\)/,
    );
    // And compactAndRetry's compactAgentConversation call passes neither
    // a retry prompt nor a positional sentinel for one.
    expect(fnBody).not.toMatch(
      /this\.compactAgentConversation\(\s*sessionId,\s*[^,]+,\s*lastPrompt/,
    );
  });
});

describe("#1623 — sendPrompt defensive guard against compaction race", () => {
  it("enqueues the prompt instead of sending when session.isCompacting", () => {
    const sendPromptStart = agentStoreSource.indexOf(
      "async sendPrompt(\n    prompt: string",
    );
    expect(sendPromptStart, "sendPrompt must exist").toBeGreaterThan(0);
    // The guard must live BEFORE the session.info.status === "error" branch
    // because a compacting session still has an otherwise-valid status.
    // Window widened to accommodate the predictive-swap block added in #1631
    // and the predictive-compact-race guard added in #1749, both before the
    // compacting guard. The invariant we care about is that the compacting
    // guard still fires BEFORE the `status === "error"` branch.
    const sendPromptWindow = agentStoreSource.slice(
      sendPromptStart,
      sendPromptStart + 7000,
    );
    expect(sendPromptWindow).toContain("session?.isCompacting");
    expect(sendPromptWindow).toContain("this.enqueuePrompt(sessionId, prompt)");
    const compactingIdx = sendPromptWindow.indexOf("session?.isCompacting");
    const errorBranchIdx = sendPromptWindow.indexOf(
      'session.info.status === "error"',
    );
    expect(compactingIdx, "isCompacting guard must come first").toBeLessThan(
      errorBranchIdx,
    );
  });
});
