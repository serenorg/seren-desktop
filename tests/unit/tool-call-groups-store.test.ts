// ABOUTME: Critical regression tests for the tool-call group state store.
// ABOUTME: Covers regroup-remount survival (#1748) and Tail sticky-expand (#2100).

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetToolCallGroupsForTest,
  getToolCallGroupState,
  markToolCallTailed,
  setToolCallGroupExpanded,
  setToolCallGroupTailing,
  wasToolCallTailed,
} from "@/stores/tool-call-groups.store";

const EMPTY_TAILED: string[] = [];

describe("tool-call-groups store", () => {
  beforeEach(() => {
    _resetToolCallGroupsForTest();
  });

  it("returns a default state for an unknown group without writing it", () => {
    const state = getToolCallGroupState("never-written");
    expect(state).toEqual({
      expanded: false,
      tailing: false,
      tailedToolCallIds: EMPTY_TAILED,
    });
  });

  it("persists expanded across reads — proxies the regroup remount that closed the chevron pre-#1748", () => {
    setToolCallGroupExpanded("group-1", true);

    // Simulate ChatContent rebuilding the grouped array and a fresh
    // ToolCallGroup component instance reading the same groupId.
    expect(getToolCallGroupState("group-1").expanded).toBe(true);

    setToolCallGroupExpanded("group-1", false);
    expect(getToolCallGroupState("group-1").expanded).toBe(false);
  });

  it("persists tailing independently of expanded on the same group", () => {
    setToolCallGroupExpanded("group-1", true);
    setToolCallGroupTailing("group-1", true);

    let s = getToolCallGroupState("group-1");
    expect(s.expanded).toBe(true);
    expect(s.tailing).toBe(true);

    // Collapsing the group must not turn off Tail (spec #2: Tail persists
    // for the group's lifetime; clicking the chevron does not override it).
    setToolCallGroupExpanded("group-1", false);
    s = getToolCallGroupState("group-1");
    expect(s.expanded).toBe(false);
    expect(s.tailing).toBe(true);
  });

  it("isolates state across distinct group ids", () => {
    setToolCallGroupExpanded("group-1", true);
    setToolCallGroupTailing("group-2", true);

    expect(getToolCallGroupState("group-1").expanded).toBe(true);
    expect(getToolCallGroupState("group-1").tailing).toBe(false);
    expect(getToolCallGroupState("group-2").expanded).toBe(false);
    expect(getToolCallGroupState("group-2").tailing).toBe(true);
  });

  // ===== Sticky-expand (#2100) =====
  //
  // The bug: Tail's forceExpanded predicate gated on `isRunning(toolCall)`,
  // so cards snapped shut the instant a tool finished. The fix is to record
  // each tool-call id that Tail force-expanded while running, and keep it
  // open through completion. These tests guard the contract.

  it("tracks tailed tool-call ids idempotently and scopes them per group", () => {
    setToolCallGroupTailing("group-1", true);

    expect(wasToolCallTailed("group-1", "tc-abc")).toBe(false);

    markToolCallTailed("group-1", "tc-abc");
    markToolCallTailed("group-1", "tc-abc");

    expect(wasToolCallTailed("group-1", "tc-abc")).toBe(true);
    expect(wasToolCallTailed("group-2", "tc-abc")).toBe(false);
    expect(getToolCallGroupState("group-1").tailedToolCallIds).toEqual([
      "tc-abc",
    ]);
  });

  it("keeps sticky ids on redundant Tail enable and clears them when Tail turns off", () => {
    setToolCallGroupTailing("group-1", true);
    markToolCallTailed("group-1", "tc-abc");

    setToolCallGroupTailing("group-1", true);
    expect(wasToolCallTailed("group-1", "tc-abc")).toBe(true);

    setToolCallGroupTailing("group-1", false);

    const cleared = getToolCallGroupState("group-1");
    expect(cleared.tailing).toBe(false);
    expect(cleared.tailedToolCallIds).toEqual([]);

    // Re-enable: must start clean, not surface previously-tailed ids.
    setToolCallGroupTailing("group-1", true);
    expect(wasToolCallTailed("group-1", "tc-abc")).toBe(false);
  });
});
