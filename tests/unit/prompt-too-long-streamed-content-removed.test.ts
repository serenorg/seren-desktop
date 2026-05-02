// ABOUTME: Critical guard for #1776 — prompt-too-long must NOT be detected by
// ABOUTME: keyword-scanning streamed assistant content; only structured signals.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1776 — no keyword scan on streamed assistant content", () => {
  it("isPromptTooLongError is never called against session.streamingContent", () => {
    // The 17-pattern detector at rate-limit-fallback.ts is correct for short
    // structured error envelopes from the CLI. Calling it on unbounded
    // streamed assistant prose self-triggered compaction whenever the model
    // discussed context-window topics, killing the agent process and seeding
    // a fresh session in a loop. The structured `is_error` event from the
    // runtime (handled in the "error" event branch above finalizeStreamingContent)
    // is the canonical signal; nothing in the streamed-content path should
    // pattern-match assistant prose to decide whether to compact.
    expect(agentStoreSource).not.toMatch(
      /isPromptTooLongError\(\s*session\.streamingContent\s*\)/,
    );
    expect(agentStoreSource).not.toContain(
      "Prompt too long detected in streamed content",
    );
  });

  it("structured error-event detection path remains intact", () => {
    // The fix removes only the streamed-content scan. The structured error
    // event handler must still detect prompt_too_long and run compactAndRetry,
    // since that is the canonical signal we now rely on exclusively.
    expect(agentStoreSource).toContain(
      "isPromptTooLongError(String(event.data.error))",
    );
    expect(agentStoreSource).toContain(
      "[AgentStore] Prompt too long detected in error event",
    );
  });
});
