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

  it("takes an explicit pendingUserPrompt parameter (not session.lastUserPrompt)", () => {
    // The old code read session.lastUserPrompt inline, which retried
    // whatever the last sendPrompt set — in the auto-compact path that was
    // the just-completed prompt, causing a duplicate turn. An explicit param
    // lets callers distinguish "failed in-flight prompt" (compactAndRetry)
    // from "prompt completed successfully" (auto-compact from promptComplete).
    expect(agentStoreSource).toContain("pendingUserPrompt?: string,");
    // The inline read must be gone.
    expect(agentStoreSource).not.toContain(
      "const pendingUserPrompt = session.lastUserPrompt;",
    );
  });

  it("auto-compact-from-promptComplete passes undefined for pendingUserPrompt", () => {
    // The prompt that produced this promptComplete already succeeded — we
    // MUST NOT retry it or the user sees a duplicate turn.
    expect(agentStoreSource).toContain(
      "settingsStore.settings.autoCompactPreserveMessages,\n                undefined,",
    );
  });

  it("compactAndRetry passes lastPrompt for pendingUserPrompt", () => {
    // The failed-prompt retry path must still work — it IS a real retry.
    expect(agentStoreSource).toContain(
      "settingsStore.settings.autoCompactPreserveMessages,\n        lastPrompt,",
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
    const sendPromptWindow = agentStoreSource.slice(
      sendPromptStart,
      sendPromptStart + 2000,
    );
    expect(sendPromptWindow).toContain("session?.isCompacting");
    expect(sendPromptWindow).toContain("this.enqueuePrompt(sessionId, prompt)");
  });
});
