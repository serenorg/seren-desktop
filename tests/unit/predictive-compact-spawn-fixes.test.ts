// ABOUTME: Critical regression tests for #1733 — every spawnSession site that
// ABOUTME: continues an existing conversation must pass initialModelId, the
// ABOUTME: synthetic-transcript ack text must not prime acknowledgement mode,
// ABOUTME: and the opus-4-7 fallback must use the 1M variant.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const syntheticTranscriptSource = readFileSync(
  resolve("bin/browser-local/synthetic-transcript.mjs"),
  "utf-8",
);

/**
 * Slice the agent.store source forward from a fixed anchor and return a
 * window large enough to contain the spawnSession call's opts object.
 * Anchors are unique strings that uniquely identify each call site so the
 * test does not rely on line numbers (which drift).
 */
function regionAfter(anchor: string, len = 600): string {
  const idx = agentStoreSource.indexOf(anchor);
  if (idx < 0) {
    throw new Error(`anchor not found in agent.store.ts: ${anchor}`);
  }
  return agentStoreSource.slice(idx, idx + len);
}

describe("#1733 Bug A — every continuation spawnSession site passes initialModelId", () => {
  // Every site below continues an existing conversation with a known
  // currentModelId. Without initialModelId, the cache lookup at
  // src/stores/agent.store.ts:1948 short-circuits and the spawn falls to the
  // 200K agent-type default — which fires predictive-compaction 5x earlier
  // than the actual 1M-context model can handle. #1700 already wired the
  // cache; these sites just need to feed it.

  it("synthetic-standby spawn passes initialModelId", () => {
    expect(
      regionAfter("const syntheticStandbyId = await this.spawnSession("),
    ).toMatch(/initialModelId:/);
  });

  it("predictive-standby spawn passes initialModelId", () => {
    expect(
      regionAfter("const standbyId = await this.spawnSession(cwd, agentType, {"),
    ).toMatch(/initialModelId:/);
  });

  it("reactive-compaction respawn passes initialModelId", () => {
    // The respawn that follows `await this.terminateSession(sessionId)` in
    // compactAgentConversation. We anchor on the unique post-terminate line
    // that precedes the spawn.
    const anchor = "await this.terminateSession(sessionId);";
    const idx = agentStoreSource.indexOf(anchor);
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 800);
    expect(region).toMatch(/spawnSession\([\s\S]*?initialModelId:/);
  });

  it("compaction-recovery spawn passes initialModelId", () => {
    // Anchor on the warn that precedes the recovery spawn block.
    expect(
      regionAfter("Attempting recovery — restoring"),
    ).toMatch(/spawnSession\([\s\S]*?initialModelId:/);
  });

  it("session-crash recovery spawn passes initialModelId", () => {
    expect(regionAfter("const doRecovery =")).toMatch(/initialModelId:/);
  });

  it("fork spawn passes initialModelId", () => {
    expect(
      regionAfter("// 3. Spawn a new local session for the fork."),
    ).toMatch(/initialModelId:/);
  });

  it("crash-ceiling restore passes initialModelId via the snapshot", () => {
    // The snapshot map at the top of provider-runtime://restarted captures
    // the fields needed to respawn each session. modelId must be in there
    // for the restore spawn (line ~308) to receive it as initialModelId.
    expect(
      regionAfter('"[AgentStore] provider-runtime://restarted'),
    ).toMatch(/currentModelId/);
    expect(regionAfter("agentStore.spawnSession(\n            snap.cwd,")).toMatch(
      /initialModelId:/,
    );
  });
});

describe("#1733 Bug B — synthetic-transcript ack does not prime acknowledgement mode", () => {
  it("SYNTHETIC_ACK_TEXT value lacks the framing keywords that primed regression", () => {
    // The original wording "Understood. Context restored from summary.
    // Continuing from prior conversation." caused the promoted standby to
    // respond with another acknowledgement turn instead of continuing the
    // user's flow (real symptom: questionnaire stalled at Q18). Pin the
    // literal const VALUE — comments are allowed to reference the old
    // wording for historical context, but the value itself must not.
    const match = syntheticTranscriptSource.match(
      /SYNTHETIC_ACK_TEXT\s*=\s*"([^"]+)"/,
    );
    expect(match, "SYNTHETIC_ACK_TEXT must be a single-line string literal").not.toBeNull();
    const value = match?.[1] ?? "";
    expect(value).not.toMatch(/Context restored from summary/);
    expect(value).not.toMatch(/Continuing from prior conversation/);
    expect(value).not.toMatch(/Understood\.\s*Context restored/);
  });

  it("compaction summary template asks about agent action, not predicted user behavior", () => {
    // The summary's NEXT: line drove the LLM to predict user behavior, which
    // made the post-compaction agent treat the user's next prompt as
    // confirmation rather than a fresh instruction. The new wording must
    // direct the summarizer toward agent action.
    const idx = agentStoreSource.indexOf("async compactAgentConversation(");
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 6000);
    expect(region).toMatch(/NEXT:/);
    expect(region).not.toMatch(/NEXT:\s*<what the user will likely ask next>/);
  });
});

describe("#1733 Bug C — opus-4-7 fallback uses the 1M variant", () => {
  it("SYNTHETIC_MODEL_FALLBACK is the [1m] tier, not the bare 200K id", () => {
    // The fallback shows up in synthetic ack records when the parent
    // transcript can't supply a model. Defaulting to the 200K variant means
    // the cache eventually persists 200K for the whole class of sessions
    // that fall through this path. Use the 1M tier id explicitly.
    expect(syntheticTranscriptSource).toMatch(
      /SYNTHETIC_MODEL_FALLBACK\s*=\s*"claude-opus-4-7\[1m\]"/,
    );
  });
});
