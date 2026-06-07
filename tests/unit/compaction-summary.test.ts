// ABOUTME: Unit tests for the shared iterative compaction-summary helper (#2103).
// ABOUTME: Proves prior-summary carry-forward, anti-prediction, and lineage tracking.

import { describe, expect, it } from "vitest";
import {
  buildIterativeCompactionPrompt,
  buildSummaryLineage,
  hashSummary,
  normalizePriorSummary,
} from "@/lib/compaction/summary";

describe("#2103 buildIterativeCompactionPrompt", () => {
  const newTurns = "USER: add a logout button\n\nASSISTANT: done, wired it up";

  it("includes a PREVIOUS SUMMARY block carrying forward the prior summary", () => {
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: "ACTIVE_TASK: build the settings page",
      newTurns,
      mode: "chat",
    });
    expect(prompt).toContain("PREVIOUS SUMMARY");
    expect(prompt).toContain("ACTIVE_TASK: build the settings page");
    expect(prompt).toContain("NEW TURNS TO INCORPORATE");
    expect(prompt).toContain(newTurns);
  });

  it("omits the PREVIOUS SUMMARY block on a first compaction (no prior summary)", () => {
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: null,
      newTurns,
      mode: "chat",
    });
    expect(prompt).not.toContain("PREVIOUS SUMMARY");
    expect(prompt).toContain(newTurns);
  });

  it("never asks the model to predict what the user will ask next (chat)", () => {
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: null,
      newTurns,
      mode: "chat",
    }).toLowerCase();
    expect(prompt).not.toContain("likely ask");
    expect(prompt).not.toContain("will likely");
    expect(prompt).not.toContain("predict");
  });

  it("uses concrete continuation fields in both modes", () => {
    for (const mode of ["chat", "agent"] as const) {
      const prompt = buildIterativeCompactionPrompt({
        previousSummary: null,
        newTurns,
        mode,
      });
      for (const field of [
        "ACTIVE_TASK",
        "COMPLETED",
        "IN_PROGRESS",
        "BLOCKERS",
        "DECISIONS",
        "RESOURCES",
        "REMAINING",
        "LATEST_USER_REQUEST",
      ]) {
        expect(prompt, `${mode} prompt must contain ${field}`).toContain(field);
      }
    }
  });

  it("instructs that the latest user request wins over stale prior tasks", () => {
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: "ACTIVE_TASK: old task",
      newTurns,
      mode: "agent",
    }).toLowerCase();
    expect(prompt).toContain("latest user request");
    expect(prompt).toContain("win");
  });

  it("keeps anti-fabrication language in agent mode", () => {
    const prompt = buildIterativeCompactionPrompt({
      previousSummary: null,
      newTurns,
      mode: "agent",
    });
    expect(prompt.toLowerCase()).toContain("do not invent");
    expect(prompt).toContain("'none'");
  });
});

describe("#2103 normalizePriorSummary", () => {
  it("strips the VERIFY-BEFORE-ACTING runtime banner", () => {
    const stored =
      "ACTIVE_TASK: wire the gauge\n\nVERIFY-BEFORE-ACTING: Files, projects, and databases mentioned above may not exist on disk. Re-read the workspace.";
    const cleaned = normalizePriorSummary(stored);
    expect(cleaned).toBe("ACTIVE_TASK: wire the gauge");
    expect(cleaned).not.toContain("VERIFY-BEFORE-ACTING");
  });

  it("strips the auto-compaction prepend labels", () => {
    const stored =
      "[Auto-compaction restored prior context]\nPrior work summary:\nACTIVE_TASK: ship it";
    const cleaned = normalizePriorSummary(stored);
    expect(cleaned).toBe("ACTIVE_TASK: ship it");
  });

  it("is idempotent — normalizing twice yields the same text (no nested banners)", () => {
    const stored =
      "Prior work summary:\nACTIVE_TASK: x\n\nVERIFY-BEFORE-ACTING: re-read disk.";
    const once = normalizePriorSummary(stored);
    expect(normalizePriorSummary(once)).toBe(once);
  });

  it("returns empty string for null/undefined/blank input", () => {
    expect(normalizePriorSummary(null)).toBe("");
    expect(normalizePriorSummary(undefined)).toBe("");
    expect(normalizePriorSummary("   \n  ")).toBe("");
  });
});

describe("#2103 summary lineage", () => {
  it("hashSummary is stable for identical content and differs for different content", () => {
    expect(hashSummary("abc")).toBe(hashSummary("abc"));
    expect(hashSummary("abc")).not.toBe(hashSummary("abd"));
  });

  it("first compaction is generation 1, non-iterative, with no previous hash", () => {
    const lineage = buildSummaryLineage({
      previousLineage: null,
      previousSummary: null,
      compactedMessageCount: 12,
      now: 1000,
    });
    expect(lineage.generation).toBe(1);
    expect(lineage.iterative).toBe(false);
    expect(lineage.previousSummaryHash).toBeUndefined();
    expect(lineage.compactedMessageCount).toBe(12);
    expect(lineage.compactedAt).toBe(1000);
  });

  it("second compaction increments generation, marks iterative, records prior hash", () => {
    const first = buildSummaryLineage({
      previousLineage: null,
      previousSummary: null,
      compactedMessageCount: 12,
      now: 1000,
    });
    const second = buildSummaryLineage({
      previousLineage: first,
      previousSummary: "ACTIVE_TASK: carried forward",
      compactedMessageCount: 8,
      now: 2000,
    });
    expect(second.generation).toBe(2);
    expect(second.iterative).toBe(true);
    expect(second.previousSummaryHash).toBe(
      hashSummary("ACTIVE_TASK: carried forward"),
    );
    expect(second.compactedAt).toBe(2000);
  });
});
