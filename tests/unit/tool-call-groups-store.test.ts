// ABOUTME: Critical regression test for the tool-call group state store (#1748).
// ABOUTME: Proves expand/Tail state survives the regroup remount that caused the bug.

import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetToolCallGroupsForTest,
  getToolCallGroupState,
  setToolCallGroupExpanded,
  setToolCallGroupTailing,
} from "@/stores/tool-call-groups.store";

describe("tool-call-groups store", () => {
  beforeEach(() => {
    _resetToolCallGroupsForTest();
  });

  it("returns a default state for an unknown group without writing it", () => {
    const state = getToolCallGroupState("never-written");
    expect(state).toEqual({ expanded: false, tailing: false });
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
    expect(s).toEqual({ expanded: true, tailing: true });

    // Collapsing the group must not turn off Tail (spec #2: Tail persists
    // for the group's lifetime; clicking the chevron does not override it).
    setToolCallGroupExpanded("group-1", false);
    s = getToolCallGroupState("group-1");
    expect(s).toEqual({ expanded: false, tailing: true });
  });

  it("isolates state across distinct group ids", () => {
    setToolCallGroupExpanded("group-1", true);
    setToolCallGroupTailing("group-2", true);

    expect(getToolCallGroupState("group-1")).toEqual({
      expanded: true,
      tailing: false,
    });
    expect(getToolCallGroupState("group-2")).toEqual({
      expanded: false,
      tailing: true,
    });
  });
});
