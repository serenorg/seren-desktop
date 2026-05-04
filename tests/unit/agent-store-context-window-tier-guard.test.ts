// ABOUTME: Critical guard for #1798 — the in-memory contextWindowSize write
// ABOUTME: in promptComplete must skip on a [1m]-tier mismatch so the spawn-time 1M denominator survives.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1798 — in-memory contextWindowSize tier-guard", () => {
  // Pre-#1798: agent.store.ts:4526 wrote
  //   setState("sessions", sessionId, "contextWindowSize", reportedContextWindow)
  // unconditionally any time meta.contextWindow > 0. The tier-mismatch
  // predicate immediately above only triggered captureSupportError. So a
  // [1m]-suffixed session that started with a correctly-resolved 1M window
  // got clobbered to 200K on the first promptComplete because the CLI's
  // bare-id echoback in modelUsage falls through inferClaudeContextWindow
  // to 200K — auto-compaction then fired at ~178K (89% of 200K) instead of
  // the intended ~890K, exactly 5x too early. The cache-layer guard from
  // #1769 only prevented persistence; the in-memory state was already
  // poisoned for the rest of the session.

  it("declares an isOneMTierMismatch predicate that combines the picker-vs-CLI gap with the [1m] suffix check", () => {
    // The predicate must be hoisted out of the support-capture block so
    // both the in-memory write and the cache call can read it. If a future
    // refactor inlines it back into the captureSupportError gate, the
    // unconditional overwrite returns and #1798 reopens.
    expect(agentStoreSource).toMatch(
      /const\s+isOneMTierMismatch\s*=\s*[\s\S]{0,200}expectedFromPicker\s*>\s*reportedContextWindow[\s\S]{0,200}\/\\\[1m\\\]\$\/i\.test\(/,
    );
  });

  it("guards the in-memory contextWindowSize setState behind !isOneMTierMismatch and pulls the recordModelContextWindow call into the same branch", () => {
    // Both the in-memory write (the actual auto-compact denominator) AND
    // the cache write must skip on tier mismatch. The cache layer at
    // modelContextCache.ts:50 also refuses, but having the agent.store
    // skip the call avoids the redundant captureSupportError path the
    // cache layer fires when refusing — keeping the in-store
    // contextWindowMismatchReported gate as the single source of truth.
    const anchor = "if (!isOneMTierMismatch) {";
    const idx = agentStoreSource.indexOf(anchor);
    expect(idx).toBeGreaterThan(0);
    const region = agentStoreSource.slice(idx, idx + 800);
    expect(region).toMatch(
      /setState\([\s\S]{0,80}"contextWindowSize"[\s\S]{0,80}reportedContextWindow/,
    );
    expect(region).toMatch(/recordModelContextWindow\(/);
  });

  it("does not contain an unconditional setState contextWindowSize call outside the tier-mismatch gate", () => {
    // Regression sentinel: a future edit that re-introduces the
    // unconditional overwrite (the exact pre-#1798 shape) must fail this
    // assertion. The pre-fix shape was the literal block:
    //   setState("sessions", sessionId, "contextWindowSize", reportedContextWindow)
    // sitting at the top level of the `if (reportedContextWindow > 0)`
    // block, immediately following the captureSupportError closing brace.
    const preFixShape =
      /\}\s*\n\s*setState\(\s*\n\s*"sessions",\s*\n\s*sessionId,\s*\n\s*"contextWindowSize",\s*\n\s*reportedContextWindow,\s*\n\s*\);/;
    expect(agentStoreSource).not.toMatch(preFixShape);
  });
});
