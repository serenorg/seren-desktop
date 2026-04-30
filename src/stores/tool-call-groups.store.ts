// ABOUTME: Per-group expansion + tail state for in-chat tool-call groups.
// ABOUTME: Survives ChatContent regrouping remounts so user clicks stick (#1748).

import { createStore, reconcile } from "solid-js/store";

export interface ToolCallGroupState {
  expanded: boolean;
  tailing: boolean;
}

const DEFAULT_STATE: ToolCallGroupState = {
  expanded: false,
  tailing: false,
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
  setState("groups", groupId, { ...prev, tailing });
}

/** Test/teardown helper. Clears the entire group registry. */
export function _resetToolCallGroupsForTest(): void {
  // reconcile() actually replaces the object instead of shallow-merging,
  // which is what `setState("groups", {})` would do.
  setState("groups", reconcile({}));
}
