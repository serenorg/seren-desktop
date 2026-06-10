// ABOUTME: Regression test for #2301 — Cancel/Stop must GUARANTEE the Claude
// ABOUTME: agent stops; cooperative interrupt failures must escalate to a hard kill.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);
const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

/**
 * Slice the body of the inner `async function cancelPrompt(...)` defined inside
 * createClaudeRuntime. Sibling closure methods share indent-2, so the next
 * `\n  async function ` declaration (terminateSession) bounds the slice.
 */
function extractCancelPromptBody(): string {
  const start = claudeRuntimeSource.indexOf(
    "async function cancelPrompt({ sessionId })",
  );
  if (start < 0) return "";
  const after = claudeRuntimeSource.indexOf("\n  async function ", start + 1);
  return after < 0
    ? claudeRuntimeSource.slice(start)
    : claudeRuntimeSource.slice(start, after);
}

/**
 * Slice the body of the `async abortTurn(threadId: string)` store method.
 * The next method declaration (`focusProjectSession(`) bounds the slice.
 */
function extractAbortTurnBody(): string {
  const start = agentStoreSource.indexOf(
    "async abortTurn(threadId: string): Promise<void> {",
  );
  if (start < 0) return "";
  const after = agentStoreSource.indexOf("focusProjectSession(", start);
  return after < 0
    ? agentStoreSource.slice(start)
    : agentStoreSource.slice(start, after);
}

describe("#2301 — runtime cancelPrompt escalates to a hard kill when interrupt fails", () => {
  const body = extractCancelPromptBody();

  it("body extraction succeeds (guard against refactor breakage)", () => {
    expect(body, "cancelPrompt body must be non-empty").not.toBe("");
    // Still attempts the cooperative interrupt first.
    expect(body).toContain("sendControlRequest");
    expect(body).toContain("interrupt");
  });

  it("escalates to killChildTree so the agent is guaranteed to stop", () => {
    // The bug: cancelPrompt swallowed a failed/timed-out interrupt and marked
    // the session "ready" WITHOUT killing the child, so the agent kept
    // running. Cancel must hard-kill when the cooperative interrupt does not
    // succeed — mirroring terminateSession's killChildTree.
    expect(
      body,
      "cancelPrompt must call killChildTree as an escalation when the interrupt is not honored.",
    ).toContain("killChildTree");
  });

  it("hard-kill is an escalation AFTER the cooperative interrupt, not unconditional", () => {
    const interruptIdx = body.indexOf("sendControlRequest");
    const killIdx = body.indexOf("killChildTree");
    expect(interruptIdx).toBeGreaterThan(-1);
    expect(killIdx).toBeGreaterThan(interruptIdx);
  });

  it("the hard-kill is gated on interrupt failure (not run on success)", () => {
    // A conditional/flag must guard the kill so a cooperative interrupt that
    // DID succeed leaves the session reusable. Accept either a boolean flag or
    // a catch-driven escalation.
    const hasFlag = /interrupted/.test(body);
    const hasCatchEscalation = /catch[\s\S]*killChildTree/.test(body);
    expect(
      hasFlag || hasCatchEscalation,
      "killChildTree must be guarded by interrupt-failure (a flag like `interrupted` or a catch path), not called unconditionally.",
    ).toBe(true);
  });
});

describe("#2301 — frontend abortTurn escalates to a hard stop when cancel RPC fails", () => {
  const body = extractAbortTurnBody();

  it("body extraction succeeds (guard against refactor breakage)", () => {
    expect(body, "abortTurn body must be non-empty").not.toBe("");
    // Still attempts the cooperative cancel first.
    expect(body).toContain("providerService.cancelPrompt");
  });

  it("escalates to terminateSession when cancelPrompt fails/times out", () => {
    // The bug: abortTurn caught a timed-out provider_cancel RPC, logged a
    // warning, and flipped the UI idle WITHOUT stopping the agent. On failure
    // it must escalate to terminateSession, whose runtime handler
    // unconditionally hard-kills the child via a distinct RPC.
    const cancelIdx = body.indexOf("providerService.cancelPrompt");
    expect(cancelIdx, "abortTurn must call providerService.cancelPrompt").toBeGreaterThan(0);
    const catchIdx = body.indexOf("catch", cancelIdx);
    expect(
      catchIdx,
      "abortTurn must have a catch around cancelPrompt",
    ).toBeGreaterThan(cancelIdx);
    const afterCancelCatch = body.slice(catchIdx);
    expect(
      afterCancelCatch,
      "the cancelPrompt failure path must escalate to terminateSession so the agent actually stops.",
    ).toContain("terminateSession");
  });
});
