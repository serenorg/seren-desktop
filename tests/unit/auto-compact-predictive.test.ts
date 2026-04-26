// ABOUTME: Regression guards for #1675 — auto-compaction at the user-configured
// ABOUTME: threshold must use predictive mode and must not flash the chatbox.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1675 — auto-compact-from-promptComplete uses predictive mode", () => {
  it("passes { mode: \"predictive\" } so the chatbox stays mounted", () => {
    // The flash regression: if this call defaults to reactive, terminateSession
    // deletes the active session, hasSession() flips to false, and
    // <Show when={hasSession()}> unmounts the input area until the new session
    // registers. Predictive mode warms a standby alongside the live session
    // and promotes it on the NEXT user submit — no teardown, no flash.
    expect(agentStoreSource).toContain(
      "settingsStore.settings.autoCompactPreserveMessages,\n                  undefined,\n                  { mode: \"predictive\" },",
    );
  });
});

describe("#1675 — compactAndRetry still uses reactive (failed-prompt retry)", () => {
  it("does not pass mode:predictive to compactAndRetry's compactAgentConversation call", () => {
    // compactAndRetry runs when a prompt has ALREADY failed (prompt_too_long)
    // on a session that is now effectively dead. There is no live session to
    // promote a standby onto — we MUST tear down and retry on a fresh session.
    // This is the one path that legitimately needs reactive mode.
    const fnStart = agentStoreSource.indexOf("async compactAndRetry(");
    expect(fnStart, "compactAndRetry must exist").toBeGreaterThan(0);
    const fnEnd = agentStoreSource.indexOf("\n  },", fnStart);
    const fnBody = agentStoreSource.slice(fnStart, fnEnd);

    // The compactAgentConversation call inside compactAndRetry should not
    // mention predictive mode at all — defaults to reactive.
    const callIdx = fnBody.indexOf("this.compactAgentConversation(");
    expect(callIdx, "compactAndRetry must call compactAgentConversation").toBeGreaterThan(0);
    const callBlock = fnBody.slice(callIdx, callIdx + 400);
    expect(callBlock).not.toContain("predictive");
    expect(callBlock).toContain("lastPrompt,");
  });
});

describe("#1675 — sendPrompt awaits standby seed when context is critical", () => {
  it("uses autoCompactThreshold to gate the bounded wait", () => {
    // Without the gate, every standby-not-ready submit would block for up to
    // STANDBY_SEED_WAIT_MS — terrible UX at low context (predictive 70%
    // standby simply lost the race). The gate ensures the wait only runs when
    // the next prompt is genuinely likely to overflow the serving session.
    expect(agentStoreSource).toContain(
      "settingsStore.settings.autoCompactThreshold / 100",
    );
  });

  it("calls waitForStandbySeed with the bounded timeout", () => {
    // The whole point of #1675 is: instead of cancelling the standby and
    // falling through to a doomed dispatch on the overloaded serving session
    // (which causes a reactive teardown via compactAndRetry), wait briefly
    // for the seed and promote.
    expect(agentStoreSource).toContain(
      "waitForStandbySeed(\n            session.standbySessionId,\n            STANDBY_SEED_WAIT_MS,\n          )",
    );
  });

  it("promotes the standby when the seed completes within the timeout", () => {
    // Static check: the success path of waitForStandbySeed inside sendPrompt
    // must invoke promoteStandbyAndDispatch — otherwise the standby is wasted
    // and the prompt still goes to the overloaded session.
    const sendPromptStart = agentStoreSource.indexOf(
      "async sendPrompt(\n    prompt: string",
    );
    expect(sendPromptStart, "sendPrompt must exist").toBeGreaterThan(0);
    const sendPromptWindow = agentStoreSource.slice(
      sendPromptStart,
      sendPromptStart + 8000,
    );
    const waitIdx = sendPromptWindow.indexOf("waitForStandbySeed(");
    expect(waitIdx, "waitForStandbySeed must be called inside sendPrompt").toBeGreaterThan(0);
    const afterWait = sendPromptWindow.slice(waitIdx, waitIdx + 800);
    expect(afterWait).toContain("promoteStandbyAndDispatch(");
  });
});

describe("#1675 — waitForStandbySeed helper", () => {
  it("returns false when the standby session is missing", () => {
    // If the standby was terminated mid-wait, the loop must not spin until
    // the deadline — bail immediately. This matches the rest of the file's
    // guard pattern (waitForSessionIdle reads through state.sessions[id]?).
    const fnStart = agentStoreSource.indexOf(
      "async function waitForStandbySeed(",
    );
    expect(fnStart, "waitForStandbySeed helper must exist").toBeGreaterThan(0);
    const fnBody = agentStoreSource.slice(fnStart, fnStart + 1000);
    expect(fnBody).toContain("if (!standby) return false;");
    expect(fnBody).toContain("standby.seedCompleted === true");
  });

  it("STANDBY_SEED_WAIT_MS is bounded and short", () => {
    // The wait blocks the user's submit. Keep it short enough that a worst-
    // case wait is still tolerable (under ~5s) and long enough that a typical
    // seed prompt (~1-3s) actually completes.
    const constMatch = agentStoreSource.match(
      /const STANDBY_SEED_WAIT_MS = (\d+(?:_\d+)?);/,
    );
    expect(constMatch, "STANDBY_SEED_WAIT_MS constant must exist").not.toBeNull();
    const value = Number(constMatch![1].replace(/_/g, ""));
    expect(value).toBeGreaterThanOrEqual(2_000);
    expect(value).toBeLessThanOrEqual(10_000);
  });
});
