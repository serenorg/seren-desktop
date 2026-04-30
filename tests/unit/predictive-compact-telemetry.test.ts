// ABOUTME: Critical regression for #1741 — predictive-compaction structural failures must open seren-core tickets.
// ABOUTME: Pre-fix the catch block silenced every failure with console.warn, hiding 100%-repro CLI rejections.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PREDICTIVE_STRUCTURAL_FAILURE_RE } from "../../src/stores/agent.store";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1741 — predictive-compaction telemetry triage", () => {
  it("classifier matches structural CLI rejections (incl. #1739 model poison) and skips transient spawn races", () => {
    // Structural — must open a seren-core ticket.
    expect(
      PREDICTIVE_STRUCTURAL_FAILURE_RE.test(
        "There's an issue with the selected model (<synthetic>). It may not exist or you may not have access to it.",
      ),
    ).toBe(true);

    // Transient — the original #152 rationale (don't spam support on races) still holds.
    expect(
      PREDICTIVE_STRUCTURAL_FAILURE_RE.test(
        "synthetic standby spawn returned null",
      ),
    ).toBe(false);
  });

  it("predictive catch block routes structural failures through captureSupportError, gated by the classifier", () => {
    // Locate the `mode === "predictive"` catch path (anchored on the
    // unique downgrade message from the original #152 implementation) and
    // verify it both tests the classifier AND calls captureSupportError.
    // Without both, the support pipeline either over-fires (every race)
    // or under-fires (today's bug) — the fix is the AND.
    const catchIdx = agentStoreSource.indexOf(
      "Predictive standby compaction failed (non-fatal):",
    );
    expect(catchIdx).toBeGreaterThan(0);
    const catchBody = agentStoreSource.slice(catchIdx, catchIdx + 2500);
    expect(catchBody).toContain("PREDICTIVE_STRUCTURAL_FAILURE_RE.test(");
    expect(catchBody).toContain("captureSupportError({");
    expect(catchBody).toContain('kind: "agent.predictive_compact_failed"');
  });
});
