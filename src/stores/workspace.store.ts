// ABOUTME: i3-style virtual workspaces. Each workspace remembers its open thread;
// ABOUTME: empty non-permanent workspaces auto-delete when the user switches away.

import { createEffect, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import {
  type ThreadKind,
  type ThreadStatus,
  threadStore,
} from "@/stores/thread.store";

export type SplitDirection = "row" | "column";

export interface WorkspaceWindow {
  /** Stable identity for the pane inside a workspace. */
  id: string;
  /** Thread displayed by this window. Null = empty placeholder pane. */
  threadId: string | null;
  /** Mirrors thread kind once bound. Null when placeholder. */
  kind: ThreadKind | null;
  /** Flex-grow weight when laid out in the workspace. Defaults to 1. */
  size: number;
}

export interface Workspace {
  /** 1-indexed display number; also the identity. */
  number: number;
  windows: WorkspaceWindow[];
  focusedWindowId: string | null;
  /** Tile layout direction: row = side by side, column = stacked. */
  splitDirection: SplitDirection;
  /** Sticky: auto-cleanup spares workspaces that ever had a window. */
  hasHadContent: boolean;
  /** Set when a thread here goes running -> not-running while inactive. */
  needsAttention: boolean;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeNumber: number;
}

type WorkspaceRemovedListener = (number: number) => void;

// Workspace 1 is permanent: never auto-deleted, even when empty.
const PERMANENT_WORKSPACE_NUMBER = 1;
const workspaceRemovedListeners = new Set<WorkspaceRemovedListener>();

const [state, setState] = createStore<WorkspaceState>({
  workspaces: [
    {
      number: 1,
      windows: [],
      focusedWindowId: null,
      splitDirection: "row",
      hasHadContent: false,
      needsAttention: false,
    },
  ],
  activeNumber: 1,
});

function emptyWorkspace(number: number): Workspace {
  return {
    number,
    windows: [],
    focusedWindowId: null,
    splitDirection: "row",
    hasHadContent: false,
    needsAttention: false,
  };
}

function primaryWindowId(number: number): string {
  return `workspace-${number}-primary`;
}

let paneIdCounter = 0;
function newPaneId(workspaceNumber: number): string {
  paneIdCounter += 1;
  return `workspace-${workspaceNumber}-pane-${paneIdCounter}`;
}

function focusedWindow(workspace: Workspace): WorkspaceWindow | null {
  if (!workspace.focusedWindowId) return null;
  return (
    workspace.windows.find((w) => w.id === workspace.focusedWindowId) ?? null
  );
}

function bindThreadToWorkspace(
  number: number,
  threadId: string | null,
  options: { activeThreadChanged: boolean } = { activeThreadChanged: true },
): void {
  if (threadId === null) return;

  const thread = threadStore.threads.find((t) => t.id === threadId);
  if (!thread) return;

  const idx = state.workspaces.findIndex((w) => w.number === number);
  if (idx < 0) return;

  const workspace = state.workspaces[idx];

  // Same thread already in another pane in this workspace? Just refocus
  // it - we enforce one pane per thread per workspace so the singleton
  // mounting in ThreadContent stays valid. Skip the refocus when this
  // call was triggered by a thread-list change (rather than a deliberate
  // activeThreadId change), so background thread additions cannot snap
  // focus away from a placeholder the user just split into.
  const existingPaneWithThread = workspace.windows.find(
    (w) => w.threadId === threadId,
  );
  if (existingPaneWithThread) {
    if (
      options.activeThreadChanged &&
      workspace.focusedWindowId !== existingPaneWithThread.id
    ) {
      setState("workspaces", idx, "focusedWindowId", existingPaneWithThread.id);
    }
    if (!workspace.hasHadContent) {
      setState("workspaces", idx, "hasHadContent", true);
    }
    return;
  }

  const focused = focusedWindow(workspace) ?? workspace.windows[0];
  const windowId = focused?.id ?? primaryWindowId(number);

  if (!focused) {
    setState("workspaces", idx, "windows", [
      { id: windowId, threadId, kind: thread.kind, size: 1 },
    ]);
  } else {
    const windowIdx = workspace.windows.findIndex((w) => w.id === windowId);
    if (windowIdx >= 0) {
      setState("workspaces", idx, "windows", windowIdx, {
        ...focused,
        threadId,
        kind: thread.kind,
      });
    }
  }

  if (state.workspaces[idx].focusedWindowId !== windowId) {
    setState("workspaces", idx, "focusedWindowId", windowId);
  }
  if (!state.workspaces[idx].hasHadContent) {
    setState("workspaces", idx, "hasHadContent", true);
  }
}

function pruneMissingThreadWindows(threadIds: Set<string>): void {
  // Steady state must be a no-op: setState on `workspaces` cascades
  // reactivity to every consumer. Placeholder panes (threadId === null)
  // are kept - the user just hasn't filled them yet.
  let needsPrune = false;
  for (const workspace of state.workspaces) {
    for (const window of workspace.windows) {
      if (window.threadId !== null && !threadIds.has(window.threadId)) {
        needsPrune = true;
        break;
      }
    }
    if (needsPrune) break;
  }
  if (!needsPrune) return;

  setState("workspaces", (workspaces) =>
    workspaces.map((workspace) => {
      const windows = workspace.windows.filter(
        (window) => window.threadId === null || threadIds.has(window.threadId),
      );
      if (windows.length === workspace.windows.length) return workspace;
      const focusedWindowId = windows.some(
        (window) => window.id === workspace.focusedWindowId,
      )
        ? workspace.focusedWindowId
        : (windows[0]?.id ?? null);
      return { ...workspace, windows, focusedWindowId };
    }),
  );
}

function notifyWorkspaceRemoved(number: number): void {
  for (const listener of workspaceRemovedListeners) {
    listener(number);
  }
}

/**
 * Bind `threadStore.activeThreadId` to the focused window in the
 * active workspace. Must run inside a Solid root so the effects are
 * disposed with it.
 */
export function initWorkspaceStore(): void {
  // Untracked workspace lookup: this effect must only fire on
  // activeThreadId changes, not activeNumber flips, or switchTo's
  // "set activeNumber, then setActiveThread" sequence races itself.
  // Track the previous activeThreadId so we can distinguish a
  // user-driven thread switch from a thread-list change that just
  // re-runs the effect.
  let previousActiveThread: string | null | undefined;
  createEffect(() => {
    const active = threadStore.activeThreadId;
    const threadIds = new Set(threadStore.threads.map((thread) => thread.id));
    untrack(() => {
      const activeThreadChanged = previousActiveThread !== active;
      previousActiveThread = active;
      pruneMissingThreadWindows(threadIds);
      bindThreadToWorkspace(state.activeNumber, active, {
        activeThreadChanged,
      });
    });
  });

  // Flip needsAttention when a bound thread transitions out of
  // "running" while the user is on a different workspace.
  const lastStatuses = new Map<string, ThreadStatus>();
  createEffect(() => {
    const snapshot = threadStore.threads.map((t) => ({
      id: t.id,
      status: t.status,
    }));
    untrack(() => {
      const live = new Set<string>();
      for (const { id, status } of snapshot) {
        live.add(id);
        const prev = lastStatuses.get(id);
        lastStatuses.set(id, status);
        if (prev !== "running" || status === "running") continue;
        for (let i = 0; i < state.workspaces.length; i++) {
          const ws = state.workspaces[i];
          if (ws.number === state.activeNumber) continue;
          if (!ws.windows.some((w) => w.threadId === id)) continue;
          if (!ws.needsAttention) {
            setState("workspaces", i, "needsAttention", true);
          }
        }
      }
      for (const id of [...lastStatuses.keys()]) {
        if (!live.has(id)) lastStatuses.delete(id);
      }
    });
  });
}

export const workspaceStore = {
  get workspaces(): Workspace[] {
    return state.workspaces;
  },

  get activeNumber(): number {
    return state.activeNumber;
  },

  get activeWorkspace(): Workspace {
    return (
      state.workspaces.find((w) => w.number === state.activeNumber) ??
      state.workspaces[0]
    );
  },

  get activeWindow(): WorkspaceWindow | null {
    return focusedWindow(this.activeWorkspace);
  },

  /**
   * Switch to workspace `number`. Auto-deletes the previous one if it
   * never had a window and is not permanent (i3 convention).
   */
  switchTo(number: number): void {
    if (number === state.activeNumber) return;
    const target = state.workspaces.find((w) => w.number === number);
    if (!target) return;
    if (target.needsAttention) {
      const targetIdx = state.workspaces.findIndex((w) => w.number === number);
      setState("workspaces", targetIdx, "needsAttention", false);
    }
    const targetThreadId = focusedWindow(target)?.threadId ?? null;
    const previous = state.activeNumber;
    bindThreadToWorkspace(previous, threadStore.activeThreadId);
    setState("activeNumber", number);

    if (targetThreadId !== threadStore.activeThreadId) {
      threadStore.setActiveThread(targetThreadId);
    }

    const prev = state.workspaces.find((w) => w.number === previous);
    if (
      prev &&
      prev.number !== PERMANENT_WORKSPACE_NUMBER &&
      !prev.hasHadContent
    ) {
      setState("workspaces", (ws) => ws.filter((w) => w.number !== previous));
      notifyWorkspaceRemoved(previous);
    }
  },

  /** Append a new workspace numbered max+1 and switch to it. */
  addWorkspace(): void {
    const nextNumber =
      (state.workspaces.at(-1)?.number ?? PERMANENT_WORKSPACE_NUMBER) + 1;
    setState("workspaces", (ws) => [...ws, emptyWorkspace(nextNumber)]);
    this.switchTo(nextNumber);
  },

  /** Switch to workspace `number`, creating it (sorted insert) if absent. */
  switchOrCreate(number: number): void {
    if (number < 1) return;
    const existing = state.workspaces.find((w) => w.number === number);
    if (existing) {
      this.switchTo(number);
      return;
    }
    setState("workspaces", (ws) => {
      const next = [...ws, emptyWorkspace(number)];
      next.sort((a, b) => a.number - b.number);
      return next;
    });
    this.switchTo(number);
  },

  /**
   * Split the focused pane in `direction`, inserting a new empty
   * placeholder pane after it. The new pane becomes focused; the
   * next thread the user opens (sidebar click, "+ New") fills it.
   * Sets the workspace's split direction to match.
   */
  splitFocusedPane(direction: SplitDirection): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const ws = state.workspaces[wsIdx];
    const newId = newPaneId(ws.number);
    const placeholder: WorkspaceWindow = {
      id: newId,
      threadId: null,
      kind: null,
      size: 1,
    };
    if (ws.windows.length === 0) {
      // No windows yet - the placeholder becomes the only pane.
      setState("workspaces", wsIdx, "windows", [placeholder]);
    } else {
      const focusedIdx = ws.windows.findIndex(
        (w) => w.id === ws.focusedWindowId,
      );
      const insertAt = focusedIdx >= 0 ? focusedIdx + 1 : ws.windows.length;
      setState("workspaces", wsIdx, "windows", (windows) => [
        ...windows.slice(0, insertAt),
        placeholder,
        ...windows.slice(insertAt),
      ]);
    }
    // Direction is locked once the workspace has more than one pane.
    // Splitting the other way past that point would silently re-flow
    // every existing tile (e.g. 3 horizontal panes flipping to a stack
    // of 3), which is more surprising than honoring the lock.
    if (ws.windows.length <= 1) {
      setState("workspaces", wsIdx, "splitDirection", direction);
    }
    setState("workspaces", wsIdx, "focusedWindowId", newId);
    if (!state.workspaces[wsIdx].hasHadContent) {
      setState("workspaces", wsIdx, "hasHadContent", true);
    }
  },

  /**
   * Close the focused pane in the active workspace. If the pane held
   * a thread, the underlying thread is NOT deleted - it just leaves
   * this workspace. Focus moves to the previous (or next) pane.
   */
  closeFocusedWindow(): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const ws = state.workspaces[wsIdx];
    const focusedIdx = ws.windows.findIndex((w) => w.id === ws.focusedWindowId);
    if (focusedIdx < 0) return;
    const nextWindows = [
      ...ws.windows.slice(0, focusedIdx),
      ...ws.windows.slice(focusedIdx + 1),
    ];
    setState("workspaces", wsIdx, "windows", nextWindows);
    const nextFocusIdx = Math.min(focusedIdx, nextWindows.length - 1);
    const nextFocusId = nextFocusIdx >= 0 ? nextWindows[nextFocusIdx].id : null;
    setState("workspaces", wsIdx, "focusedWindowId", nextFocusId);
    if (nextFocusId !== null) {
      const nextThreadId = nextWindows[nextFocusIdx].threadId;
      if (nextThreadId !== threadStore.activeThreadId) {
        threadStore.setActiveThread(nextThreadId);
      }
    } else if (threadStore.activeThreadId !== null) {
      threadStore.setActiveThread(null);
    }
  },

  /** Set the focused pane within the active workspace. */
  focusWindow(windowId: string): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const ws = state.workspaces[wsIdx];
    const window = ws.windows.find((w) => w.id === windowId);
    if (!window) return;
    if (ws.focusedWindowId !== windowId) {
      setState("workspaces", wsIdx, "focusedWindowId", windowId);
    }
    if (window.threadId !== threadStore.activeThreadId) {
      threadStore.setActiveThread(window.threadId);
    }
  },

  /**
   * Update pane sizes from a drag-resize. Sizes are flex-grow values;
   * relative magnitudes determine each pane's share of the workspace.
   * Updates each pane's `size` field in place so the underlying window
   * proxy identity is preserved - any consumer iterating windows (e.g.
   * the singleton-per-thread mount in ThreadContent) keeps the same
   * row references and does not re-mount on every drag tick.
   */
  resizePanes(updates: Array<{ id: string; size: number }>): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const windows = state.workspaces[wsIdx].windows;
    for (const update of updates) {
      const windowIdx = windows.findIndex((w) => w.id === update.id);
      if (windowIdx < 0) continue;
      const nextSize = Math.max(0.05, update.size);
      if (windows[windowIdx].size === nextSize) continue;
      setState("workspaces", wsIdx, "windows", windowIdx, "size", nextSize);
    }
  },

  /** Reset to the initial single-workspace state (called on logout). */
  reset(): void {
    setState({
      workspaces: [emptyWorkspace(PERMANENT_WORKSPACE_NUMBER)],
      activeNumber: PERMANENT_WORKSPACE_NUMBER,
    });
  },

  onWorkspaceRemoved(listener: WorkspaceRemovedListener): () => void {
    workspaceRemovedListeners.add(listener);
    return () => workspaceRemovedListeners.delete(listener);
  },
};
