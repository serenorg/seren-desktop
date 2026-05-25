// ABOUTME: #2031 — compactAndRetry must aggressively retry with a smaller
// ABOUTME: preserveCount when the first compactAgentConversation skips, so
// ABOUTME: short-but-token-heavy sessions are not dead-ended by the banner.

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

describe("#2031 — compactAndRetry recovers short-but-token-heavy sessions", () => {
  it("aggressively retries with a smaller preserveCount when the first compactAgentConversation skips", () => {
    // The first call uses the user's configured preserve count. If that skips
    // because messages.length <= preserveCount, the session is still too big
    // to send — we keep just the last user/assistant pair (preserveCount = 2)
    // and try again. Without this fallback the user sees a misleading
    // "shorten your message" banner for a message they did not type.
    const body = functionBody("async compactAndRetry(");

    // Two calls into compactAgentConversation — the configured one AND the
    // aggressive one.
    const calls = body.match(/this\.compactAgentConversation\(/g);
    expect(
      calls,
      "compactAndRetry must call compactAgentConversation twice (configured, then aggressive)",
    ).toBeTruthy();
    expect(calls?.length).toBeGreaterThanOrEqual(2);

    // The aggressive retry is gated on the first call returning
    // skipped_nothing_to_compact. Anything else (succeeded, failed_catastrophic,
    // cancelled) must propagate without a retry.
    expect(body).toMatch(/skipped_nothing_to_compact/);

    // Aggressive preserveCount is the named constant AGGRESSIVE_RETRY_PRESERVE_COUNT.
    expect(body).toMatch(
      /this\.compactAgentConversation\(\s*sessionId\s*,\s*AGGRESSIVE_RETRY_PRESERVE_COUNT/,
    );
    // The constant must be 2 — keep only the last user/assistant pair.
    expect(agentStoreSource).toMatch(
      /const\s+AGGRESSIVE_RETRY_PRESERVE_COUNT\s*=\s*2\b/,
    );
  });

  it("updates the user-facing banner so it stops blaming the user's message", () => {
    // The pre-#2031 banner read "Your last message is too large for this
    // agent's context window. Try shortening it..." — accurate only when the
    // single most-recent message is itself oversized. After #2031, that case
    // is the only one that still reaches this branch (the aggressive retry
    // handles every session with > 2 messages), so the banner can be plain
    // and honest: the session is full, start a new thread. The misleading
    // "shorten it / attach files instead of pasting" guidance must go.
    expect(agentStoreSource).not.toMatch(/Try shortening it/i);
    expect(agentStoreSource).not.toMatch(/attaching files instead of pasting/i);
  });
});
