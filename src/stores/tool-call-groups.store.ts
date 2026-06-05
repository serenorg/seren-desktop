// ABOUTME: Per-group expansion + tail state for in-chat tool-call groups.
// ABOUTME: Survives ChatContent regrouping remounts so user clicks stick (#1748).

import { createStore, reconcile } from "solid-js/store";

export interface ToolCallGroupState {
  expanded: boolean;
  tailing: boolean;
  /**
   * Tool call ids that Tail force-expanded while they were running (#2100).
   * Read by the group renderer to keep finished cards open instead of
   * snapping shut the instant the result lands. Cleared when the user
   * toggles Tail off so a re-enable does not resurrect stale completions.
   */
  tailedToolCallIds: string[];
}

const DEFAULT_STATE: ToolCallGroupState = {
  expanded: false,
  tailing: false,
  tailedToolCallIds: [],
};

interface StoreShape {
  groups: Record<string, ToolCallGroupState>;
}

const [state, setState] = createStore<StoreShape>({ groups: {} });

/** Reactive read of a group's state. Returns DEFAULT_STATE for unknown groups. */
export function getToolCallGroupState(groupId: string): ToolCallGroupState {
  return state.groups[groupId] ?? DEFAULT_STATE;
}

export function setToolCallGroupExpanded(
  groupId: string,
  expanded: boolean,
): void {
  const prev = state.groups[groupId] ?? DEFAULT_STATE;
  setState("groups", groupId, { ...prev, expanded });
}

export function setToolCallGroupTailing(
  groupId: string,
  tailing: boolean,
): void {
  const prev = state.groups[groupId] ?? DEFAULT_STATE;
  setState("groups", groupId, {
    ...prev,
    tailing,
    // Turning Tail off drops the sticky-expand memory so the next enable
    // starts clean. We do NOT clear when toggling on — that would erase
    // the very entries we want to keep visible.
    tailedToolCallIds: tailing ? prev.tailedToolCallIds : [],
  });
}

/**
 * Mark a tool call as having been Tail-expanded during its run. Idempotent;
 * a no-op if the id is already present. Called from a reactive effect in
 * ToolCallGroup whenever a running card is rendered with forceExpanded=true.
 */
export function markToolCallTailed(groupId: string, toolCallId: string): void {
  const prev = state.groups[groupId] ?? DEFAULT_STATE;
  if (prev.tailedToolCallIds.includes(toolCallId)) return;
  setState("groups", groupId, {
    ...prev,
    tailedToolCallIds: [...prev.tailedToolCallIds, toolCallId],
  });
}

/** Reactive check: was this tool call expanded by Tail while it was running? */
export function wasToolCallTailed(
  groupId: string,
  toolCallId: string,
): boolean {
  const group = state.groups[groupId];
  if (!group) return false;
  return group.tailedToolCallIds.includes(toolCallId);
}

/** Test/teardown helper. Clears the entire group registry. */
export function _resetToolCallGroupsForTest(): void {
  // reconcile() actually replaces the object instead of shallow-merging,
  // which is what `setState("groups", {})` would do.
  setState("groups", reconcile({}));
}
