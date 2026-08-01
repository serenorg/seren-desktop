// ABOUTME: Verifies the objective-only launch path still produces dispatchable work.
// ABOUTME: Protects the primary Mission Control flow where task slots stay collapsed.

import { describe, expect, it } from "vitest";
import { objectiveTaskTitle } from "@/stores/run.store";

describe("objective task title", () => {
  it("keeps a short objective intact", () => {
    expect(objectiveTaskTitle("  Find every stalled invoice  ")).toBe(
      "Find every stalled invoice",
    );
  });

  it("collapses whitespace", () => {
    expect(objectiveTaskTitle("Find\n  every\tstalled invoice")).toBe(
      "Find every stalled invoice",
    );
  });

  it("truncates a long objective on a word boundary", () => {
    const objective =
      "Investigate every unpaid invoice across the billing system and the ledger exports and report which customers are affected";
    const title = objectiveTaskTitle(objective);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
    expect(objective.startsWith(title.slice(0, -1))).toBe(true);
  });

  it("truncates a single long word without leaving an empty title", () => {
    const title = objectiveTaskTitle("x".repeat(200));
    expect(title).toBe(`${"x".repeat(80)}…`);
  });
});
