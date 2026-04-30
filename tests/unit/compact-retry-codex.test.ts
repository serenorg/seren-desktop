// ABOUTME: Regression tests for #1757 — compactAndRetry must trust the new
// ABOUTME: sessionId returned by compactAgentConversation, dispatch the retry
// ABOUTME: prompt exactly once, and never search state.sessions for it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

function functionBody(anchor: string): string {
  const start = agentStoreSource.indexOf(anchor);
  if (start < 0) {
    throw new Error(`anchor not found in agent.store.ts: ${anchor}`);
  }
  const end = agentStoreSource.indexOf("\n  },", start);
  if (end < 0) {
    throw new Error(`could not find function end for: ${anchor}`);
  }
  return agentStoreSource.slice(start, end);
}

describe("#1757 — compactAgentConversation returns the new sessionId", () => {
  it("declares the CompactAgentResult shape with newSessionId on the type", () => {
    expect(agentStoreSource).toMatch(
      /type CompactAgentResult\s*=\s*\{[\s\S]*?outcome:\s*Exclude<CompactionOutcome,\s*"retried">[\s\S]*?newSessionId\?:\s*string[\s\S]*?\}/,
    );
  });

  it("compactAgentConversation's return type is CompactAgentResult", () => {
    expect(agentStoreSource).toMatch(
      /async compactAgentConversation\([\s\S]*?\):\s*Promise<CompactAgentResult>/,
    );
  });

  it("reactive success returns { outcome: 'succeeded', newSessionId }", () => {
    const body = functionBody("async compactAgentConversation(");
    // Reactive path's success return — newSessionId is the local const from
    // the post-terminate spawn at this site.
    expect(body).toMatch(
      /return\s*\{\s*outcome:\s*"succeeded",\s*newSessionId\s*\}/,
    );
  });

  it("predictive standby success returns { outcome: 'succeeded', newSessionId: standbyId }", () => {
    const body = functionBody("async compactAgentConversation(");
    expect(body).toMatch(
      /return\s*\{\s*outcome:\s*"succeeded",\s*newSessionId:\s*standbyId\s*\}/,
    );
  });

  it("synthetic-transcript success returns { outcome: 'succeeded', newSessionId: syntheticStandbyId }", () => {
    const body = functionBody("async compactAgentConversation(");
    expect(body).toMatch(
      /return\s*\{\s*outcome:\s*"succeeded",\s*newSessionId:\s*syntheticStandbyId\s*\}/,
    );
  });
});

describe("#1757 — compactAndRetry no longer searches state.sessions for the new id", () => {
  it("does not iterate state.sessions to re-derive the new sessionId", () => {
    const body = functionBody("async compactAndRetry(");
    // The brittle lookup is gone — we trust what compactAgentConversation
    // returned. This guards against the reintroduction of the bug.
    expect(body).not.toContain("Object.entries(state.sessions)");
    expect(body).not.toMatch(/state\.sessions\[[\s\S]*?conversationId/);
  });

  it("does not run a 'newSessionId === sessionId' swap-check", () => {
    const body = functionBody("async compactAndRetry(");
    // For Codex, sessionId === conversationId always, and the reactive spawn
    // passes localSessionId: conversationId — so the new id is bit-identical
    // to the old. The old swap-check false-failed and dropped users into Chat
    // (with a misleading reason=rate_limit) AFTER a successful compaction.
    expect(body).not.toMatch(/newSessionId\s*===\s*sessionId/);
    expect(body).not.toContain("compaction did not swap");
  });

  it("reads newSessionId off the returned result, not a state lookup", () => {
    const body = functionBody("async compactAndRetry(");
    expect(body).toMatch(/const\s+newSessionId\s*=\s*result\.newSessionId/);
  });
});

describe("#1757 — retry prompt is dispatched exactly once, by compactAndRetry", () => {
  it("compactAgentConversation does NOT call sendPrompt for any pendingUserPrompt", () => {
    // Pre-fix, compactAgentConversation called sendPrompt for the user's
    // failed prompt internally AND compactAndRetry called sendPrompt again
    // after its lookup succeeded — a latent double-dispatch on the path
    // where the swap-check passed (Claude Code). The fix moves dispatch out
    // of compactAgentConversation entirely; the helper sends only the seed.
    const body = functionBody("async compactAgentConversation(");
    // Assert: the only sendPrompt call references the seedPrompt local.
    const sendPromptCalls = body.match(
      /providerService\.sendPrompt\([^)]*\)/g,
    );
    expect(sendPromptCalls, "compactAgentConversation must call sendPrompt").toBeTruthy();
    for (const call of sendPromptCalls ?? []) {
      expect(
        call,
        "compactAgentConversation must only sendPrompt the seedPrompt — the retry belongs to compactAndRetry",
      ).toContain("seedPrompt");
    }
    // Belt-and-braces: pendingUserPrompt and lastUserPrompt arguments must
    // never appear on a sendPrompt inside this function.
    expect(body).not.toMatch(
      /providerService\.sendPrompt\([^)]*pendingUserPrompt/,
    );
    expect(body).not.toMatch(
      /providerService\.sendPrompt\([^)]*lastUserPrompt/,
    );
  });

  it("compactAndRetry invokes sendPrompt for lastPrompt exactly once", () => {
    const body = functionBody("async compactAndRetry(");
    const calls = body.match(
      /providerService\.sendPrompt\([^)]*lastPrompt[^)]*\)/g,
    );
    expect(calls, "compactAndRetry must dispatch the retry prompt").toBeTruthy();
    expect(
      calls?.length,
      "exactly one retry dispatch — anything else risks duplicate user turns",
    ).toBe(1);
  });

  it("compactAndRetry passes only sessionId and preserveCount to compactAgentConversation", () => {
    const body = functionBody("async compactAndRetry(");
    // The helper's signature is now (sessionId, preserveCount, opts?). We
    // call it with two positional args and no opts — reactive default mode.
    expect(body).toMatch(
      /this\.compactAgentConversation\(\s*sessionId,\s*settingsStore\.settings\.autoCompactPreserveMessages,?\s*\)/,
    );
  });
});

describe("#1757 — kickPredictiveCompact consumes the new result shape", () => {
  it("destructures result.outcome from compactAgentConversation's return", () => {
    const body = functionBody("async kickPredictiveCompact(");
    expect(body).toMatch(
      /const\s+result\s*=\s*await\s+this\.compactAgentConversation\(/,
    );
    expect(body).toContain("result.outcome");
  });

  it("does not pass a positional retry-prompt sentinel", () => {
    const body = functionBody("async kickPredictiveCompact(");
    // Old shape was (sessionId, count, undefined, { mode: "predictive" }).
    // New shape collapses the param: (sessionId, count, { mode: "predictive" }).
    expect(body).not.toMatch(
      /this\.compactAgentConversation\([\s\S]*?undefined,[\s\S]*?\{ mode: "predictive" \}/,
    );
    expect(body).toMatch(
      /this\.compactAgentConversation\([\s\S]*?\{ mode: "predictive" \}/,
    );
  });
});
