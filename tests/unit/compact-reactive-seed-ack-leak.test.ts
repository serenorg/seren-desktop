// ABOUTME: Critical regression for #1827 — the reactive compaction respawn
// ABOUTME: must use role: "standby" so the seed-ack is filtered, then flip to
// ABOUTME: "serving" before returning so the user's retry runs visibly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

/** Region of compactAgentConversation's reactive branch. */
function reactiveBranch(): string {
  const start = agentStoreSource.indexOf(
    "// Reactive path: terminate old, spawn fresh serving",
  );
  if (start < 0) throw new Error("reactive-branch anchor not found");
  // The branch ends at `return { outcome: "succeeded", newSessionId };`
  // followed by the catch block. Take a generous window.
  const end = agentStoreSource.indexOf("} catch (error) {", start);
  if (end < 0) throw new Error("reactive-branch end anchor not found");
  return agentStoreSource.slice(start, end);
}

describe("#1827 — reactive compaction must not leak the seed-ack into the UI", () => {
  it("reactive respawn passes role: \"standby\" so messageChunk events are filtered", () => {
    // The role-based event filter at handleSessionEvent (~line 4434) is the
    // ONLY thing that prevents the seed-prompt response from streaming into
    // the user-visible chat as an assistant message. Predictive already does
    // this; reactive must too. Without the role, the user sees the model's
    // stock acknowledgement ("I'll acknowledge the system reminders…").
    const region = reactiveBranch();
    expect(region).toMatch(
      /spawnSession\(cwd,\s*agentType,\s*\{[\s\S]*?role:\s*"standby"/,
    );
  });

  it("reactive respawn flips role back to \"serving\" before returning", () => {
    // The session must serve the user's retried prompt visibly. After the
    // seed has completed and idle is reached, the role flip + seedCompleted
    // reset are both required: serving so events render, seedCompleted reset
    // so the next promptComplete is treated as a real turn (not a second
    // seed) by the standby short-circuit at line ~4485.
    const region = reactiveBranch();
    expect(region).toMatch(
      /setState\("sessions",\s*newSessionId,\s*"role",\s*"serving"\)/,
    );
    expect(region).toMatch(
      /setState\("sessions",\s*newSessionId,\s*"seedCompleted",\s*undefined\)/,
    );
  });

  it("role flip happens AFTER waitForSessionIdle (so the seed-ack is fully consumed first)", () => {
    // Flipping early would re-expose the seed-ack mid-stream. The waitFor
    // / send / wait sequence must finish before the role swap, otherwise
    // the standby filter releases while messageChunks are still arriving.
    const region = reactiveBranch();
    const idleIdx = region.indexOf("waitForSessionIdle(newSessionId)");
    const roleFlipIdx = region.indexOf(
      'setState("sessions", newSessionId, "role", "serving")',
    );
    expect(idleIdx).toBeGreaterThan(0);
    expect(roleFlipIdx).toBeGreaterThan(idleIdx);
  });
});
