// ABOUTME: Critical regression tests for #1733 — every spawnSession site that
// ABOUTME: continues an existing conversation must pass initialModelId, the
// ABOUTME: synthetic-transcript ack text must not prime acknowledgement mode,
// ABOUTME: and the opus-4-7 fallback must use the 1M variant.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";
import { buildIterativeCompactionPrompt } from "@/lib/compaction/summary";

const agentStoreSource = readSource("src/stores/agent.store.ts");
const syntheticTranscriptSource = readSource("bin/browser-local/synthetic-transcript.mjs");

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
    expect(regionAfter("async recoverDroppedPrompt(", 4000)).toMatch(
      /spawnSession\([\s\S]*?initialModelId/,
    );
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
    // The old `NEXT: <what the user will likely ask next>` line drove the LLM
    // to predict user behavior, which made the post-compaction agent treat
    // the user's next prompt as confirmation rather than a fresh instruction.
    // Post-#2103 the shared template replaces it with a REMAINING field (next
    // agent action) plus a LATEST_USER_REQUEST field that preserves — not
    // predicts — the user's most recent ask. Assert the actual built prompt.
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: null,
      newTurns: "USER: ship the feature\n\nASSISTANT: working on it",
      mode: "agent",
    });
    // Agent-action continuation field present.
    expect(prompt).toMatch(/REMAINING:\s*<what the agent should do next/);
    // Latest user request preserved, not predicted.
    expect(prompt).toMatch(/LATEST_USER_REQUEST:/);
    // The user-behavior-prediction wording must never come back.
    expect(prompt.toLowerCase()).not.toContain("likely ask");
    expect(prompt.toLowerCase()).not.toContain("will likely");
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
