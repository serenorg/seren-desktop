// ABOUTME: Unit tests for token-budgeted compaction tail selection (#2104).
// ABOUTME: Covers oversized tail messages, lightweight growth, anchoring, tool groups.

import { describe, expect, it } from "vitest";
import {
  type CompactionWindowItem,
  selectCompactionWindow,
} from "@/lib/compaction/window";

function item(
  tokens: number,
  role: CompactionWindowItem["role"] = "assistant",
  groupId: string | null = null,
): CompactionWindowItem {
  return { tokens, role, groupId };
}

describe("#2104 selectCompactionWindow — token budget", () => {
  it("shrinks the tail when a single preserved message is huge (fixed-count overflow case)", () => {
    // 10 messages; the old fixed preserveCount=10 would keep all of them,
    // including a 90k-token tool dump that alone blows a 100k window.
    const items = [
      ...Array.from({ length: 7 }, () => item(500, "assistant")),
      item(90_000, "tool"),
      item(400, "user"),
      item(300, "assistant"),
    ];
    const { preserveCount, cutIndex } = selectCompactionWindow(items, {
      contextLimit: 100_000,
      targetTailRatio: 0.35, // 35k tail budget
      minTailMessages: 2,
    });
    // The 90k dump must be pushed into the compacted half, not preserved.
    expect(cutIndex).toBeGreaterThan(7);
    expect(preserveCount).toBeLessThan(10);
  });

  it("grows the tail beyond a small fixed count when messages are lightweight", () => {
    // 40 tiny messages; the old preserveCount=10 would drop 30 needlessly.
    const items = Array.from({ length: 40 }, (_, i) =>
      item(50, i % 2 === 0 ? "user" : "assistant"),
    );
    const { preserveCount } = selectCompactionWindow(items, {
      contextLimit: 100_000,
      targetTailRatio: 0.35,
      minTailMessages: 2,
    });
    // 40 * 50 = 2000 tokens, well under the 35k budget → keep them all.
    expect(preserveCount).toBe(40);
  });

  it("always anchors the latest user message into the preserved tail", () => {
    // Latest user message sits near the front; budget alone would drop it.
    const items = [
      item(200, "user"), // index 0 — the latest *user* turn is later though
      ...Array.from({ length: 30 }, () => item(2_000, "assistant")),
      item(150, "user"), // index 31 — latest user
      item(60_000, "assistant"), // index 32 — huge final assistant
    ];
    const { cutIndex } = selectCompactionWindow(items, {
      contextLimit: 100_000,
      targetTailRatio: 0.35,
      minTailMessages: 1,
    });
    // cut must be at or before the latest user message (index 31).
    expect(cutIndex).toBeLessThanOrEqual(31);
  });

  it("never splits a tool group across the compaction boundary", () => {
    // A tool group [assistant, tool, tool] tagged 'g5' sits at the budget edge.
    const items = [
      ...Array.from({ length: 5 }, () => item(4_000, "assistant")),
      item(3_000, "assistant", "g5"),
      item(3_000, "tool", "g5"),
      item(3_000, "tool", "g5"),
      item(200, "user"),
      item(200, "assistant"),
    ];
    const { cutIndex } = selectCompactionWindow(items, {
      contextLimit: 100_000,
      targetTailRatio: 0.12, // ~12k budget — boundary falls inside g5
      minTailMessages: 2,
    });
    // The preserved tail must not begin in the middle of group g5: either
    // the whole group is preserved or none of it is.
    const tail = items.slice(cutIndex);
    const tailG5 = tail.filter((m) => m.groupId === "g5").length;
    expect(tailG5 === 0 || tailG5 === 3).toBe(true);
  });

  it("still makes compaction progress when the active turn alone exceeds the budget (soft ceiling)", () => {
    // A long transcript whose most recent user turn is enormous (huge
    // assistant + tool dump). One oversized turn must not block compaction:
    // the older prefix is still compacted, and the over-budget tail is flagged.
    const items = [
      ...Array.from({ length: 8 }, () => item(2_000, "assistant")),
      item(400, "user"),
      item(80_000, "assistant"),
      item(80_000, "tool"),
    ];
    const result = selectCompactionWindow(items, {
      contextLimit: 100_000,
      targetTailRatio: 0.35,
      minTailMessages: 2,
    });
    // Progress made — the old prefix is compacted, not preserved wholesale.
    expect(result.cutIndex).toBeGreaterThan(0);
    expect(result.preserveCount).toBeLessThan(items.length);
    // The forced active-turn tail exceeds the budget — flagged for telemetry.
    expect(result.overBudget).toBe(true);
  });

  it("caps the tail at maxTailTokens regardless of ratio", () => {
    const items = Array.from({ length: 100 }, () => item(1_000, "assistant"));
    const { tailTokens } = selectCompactionWindow(items, {
      contextLimit: 1_000_000,
      targetTailRatio: 0.5, // would allow 500k
      maxTailTokens: 20_000,
      minTailMessages: 2,
    });
    expect(tailTokens).toBeLessThanOrEqual(20_000);
  });

  it("returns an empty preserve for an empty transcript", () => {
    const r = selectCompactionWindow([], { contextLimit: 100_000 });
    expect(r.preserveCount).toBe(0);
    expect(r.cutIndex).toBe(0);
  });
});
