// ABOUTME: Regression test for #1889 — Claude spawnSession must NOT await
// ABOUTME: replayClaudeHistoryBestEffort; replay runs in background, "ready" emit defers.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

/**
 * Slice the body of the inner `async function spawnSession(params)` defined
 * inside `createClaudeRuntime` so assertions don't match unrelated references
 * elsewhere in the (2000+ line) module. End-of-function is the next
 * `\n  async function ` declaration (sibling closure methods share indent-2).
 */
function extractSpawnSessionBody(): string {
  const start = runtimeSource.indexOf("async function spawnSession(params)");
  if (start < 0) return "";
  const after = runtimeSource.indexOf("\n  async function ", start + 1);
  return after < 0
    ? runtimeSource.slice(start)
    : runtimeSource.slice(start, after);
}

describe("#1889 — Claude spawnSession defers history replay off the await path", () => {
  const body = extractSpawnSessionBody();

  it("function body extraction succeeds (guard against refactor breakage)", () => {
    expect(body, "spawnSession body must be non-empty").not.toBe("");
    expect(body).toContain("sendControlRequest");
  });

  it("does NOT await replayClaudeHistoryBestEffort", () => {
    // The bug: `await replayClaudeHistoryBestEffort(...)` inside spawnSession
    // blocks the JSON-RPC return until the entire transcript has streamed as
    // live events. Frontend's spawn-ack arrives after the events, inverting
    // event ordering and sticking the "Evaluating…" spinner.
    const awaitedReplay = /await\s+replayClaudeHistoryBestEffort\s*\(/.test(
      body,
    );
    expect(
      awaitedReplay,
      "spawnSession must NOT await replayClaudeHistoryBestEffort — replay must run in the background so the spawn IPC returns before replay events fire.",
    ).toBe(false);
  });

  it("kicks off replay as a background promise with .catch error handling", () => {
    // Background replay must still surface failures via console.warn so a
    // corrupt transcript doesn't fail silently.
    expect(
      body,
      "spawnSession must call replayClaudeHistoryBestEffort with a chained .catch so failures are logged.",
    ).toMatch(/replayClaudeHistoryBestEffort\([\s\S]*?\)\s*\.catch\s*\(/);
  });

  it("defers the 'ready' status emit until replay drains", () => {
    // The frontend's readyPromise resolves on a real-time sessionStatus
    // event with status="ready". Emitting "ready" before replay completes
    // would unblock sendPrompt while history was still streaming, racing
    // user prompts against replay tool events.
    expect(
      body,
      "spawnSession must emit 'ready' inside a `.then(...)` on the replay promise, not synchronously after spawn setup.",
    ).toMatch(
      /\.then\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?provider:\/\/session-status[\s\S]*?\}\s*\)/,
    );
  });

  it("guards the deferred 'ready' emit against terminated sessions", () => {
    // If the user closes the thread mid-replay, the session record is
    // deleted from the `sessions` Map. The deferred emit must check the
    // session is still tracked before mutating its status and emitting,
    // otherwise we resurrect a torn-down session in the frontend.
    expect(
      body,
      "deferred 'ready' emit must guard against the session being terminated during replay.",
    ).toMatch(/sessions\.get\(sessionId\)\s*===\s*session/);
  });

  it("returns ready synchronously only when no history replay is running", () => {
    expect(body).toMatch(
      /if\s*\(resumeAgentSessionId\s*&&\s*suppressHistoryReplay\s*!==\s*true\)/,
    );
    expect(body).toMatch(
      /\.then\s*\([\s\S]*?session\.status\s*=\s*"ready"[\s\S]*?\}\s*else\s*\{[\s\S]*?session\.status\s*=\s*"ready"/,
    );
  });
});

describe("#1889 — spawn stderr log surfaces both Seren and Claude session ids", () => {
  it("logs Seren-side sessionId AND agentSessionId for cross-referencing", () => {
    // Frontend events are tagged with the Seren-side `sessionId` (the value
    // of `session.id`). The stderr log previously only printed the Claude
    // CLI's `remoteSessionId`/`agentSessionId`, making the
    // runtime-prefixed Claude spawn line useless when correlating with
    // [AgentRuntime] Event received logs in the renderer console.
    expect(runtimeSource).toMatch(
      /\$\{claudeLogPrefix\} spawn sessionId=\$\{(session\.id|sessionId)\}[\s\S]*?agentSessionId=\$\{remoteSessionId\}/,
    );
  });
});
