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
export type WorkspaceWindowKind = ThreadKind | "editor";

export interface WorkspacePaneLayout {
  type: "pane";
  id: string;
  windowId: string;
  size: number;
}

export interface WorkspaceSplitLayout {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: WorkspaceLayout[];
  size: number;
}

export type WorkspaceLayout = WorkspacePaneLayout | WorkspaceSplitLayout;

export interface WorkspaceWindow {
  /** Stable identity for the pane inside a workspace. */
  id: string;
  /** Thread displayed by this window. Null = empty placeholder pane. */
  threadId: string | null;
  /** Window content type. Null when placeholder. */
  kind: WorkspaceWindowKind | null;
  /** File displayed by editor windows. */
  editorFilePath?: string | null;
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
  /** Nested i3-style split tree. Null when no panes exist. */
  layout: WorkspaceLayout | null;
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
      layout: null,
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
    layout: null,
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

let layoutIdCounter = 0;
function newLayoutId(): string {
  layoutIdCounter += 1;
  return `layout-${layoutIdCounter}`;
}

function paneLayout(windowId: string, size = 1): WorkspacePaneLayout {
  return { type: "pane", id: windowId, windowId, size };
}

function splitLayout(
  direction: SplitDirection,
  children: WorkspaceLayout[],
  size = 1,
): WorkspaceSplitLayout {
  return {
    type: "split",
    id: newLayoutId(),
    direction,
    children,
    size,
  };
}

function layoutContainsWindow(
  layout: WorkspaceLayout | null,
  windowId: string,
): boolean {
  if (!layout) return false;
  if (layout.type === "pane") return layout.windowId === windowId;
  return layout.children.some((child) => layoutContainsWindow(child, windowId));
}

function insertPaneInLayout(
  layout: WorkspaceLayout,
  focusedWindowId: string,
  newWindowId: string,
  direction: SplitDirection,
): WorkspaceLayout {
  if (layout.type === "pane") {
    if (layout.windowId !== focusedWindowId) return layout;
    return splitLayout(
      direction,
      [paneLayout(layout.windowId), paneLayout(newWindowId)],
      layout.size,
    );
  }

  const childIdx = layout.children.findIndex((child) =>
    layoutContainsWindow(child, focusedWindowId),
  );
  if (childIdx < 0) return layout;

  const child = layout.children[childIdx];
  if (
    layout.direction === direction &&
    child.type === "pane" &&
    child.windowId === focusedWindowId
  ) {
    const nextChildren = [...layout.children];
    nextChildren.splice(childIdx + 1, 0, paneLayout(newWindowId));
    return { ...layout, children: nextChildren };
  }

  const nextChildren = [...layout.children];
  nextChildren[childIdx] = insertPaneInLayout(
    child,
    focusedWindowId,
    newWindowId,
    direction,
  );
  return { ...layout, children: nextChildren };
}

function resizeLayoutNode(
  layout: WorkspaceLayout,
  id: string,
  size: number,
): WorkspaceLayout {
  if (layout.id === id || (layout.type === "pane" && layout.windowId === id)) {
    return { ...layout, size };
  }
  if (layout.type === "pane") return layout;
  return {
    ...layout,
    children: layout.children.map((child) => resizeLayoutNode(child, id, size)),
  };
}

function removeWindowFromLayout(
  layout: WorkspaceLayout | null,
  windowId: string,
): WorkspaceLayout | null {
  if (!layout) return null;
  if (layout.type === "pane") {
    return layout.windowId === windowId ? null : layout;
  }

  const children = layout.children
    .map((child) => removeWindowFromLayout(child, windowId))
    .filter((child): child is WorkspaceLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0], size: layout.size };
  return { ...layout, children };
}

function pruneLayout(
  layout: WorkspaceLayout | null,
  liveWindowIds: Set<string>,
): WorkspaceLayout | null {
  if (!layout) return null;
  if (layout.type === "pane") {
    return liveWindowIds.has(layout.windowId) ? layout : null;
  }
  const children = layout.children
    .map((child) => pruneLayout(child, liveWindowIds))
    .filter((child): child is WorkspaceLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return { ...children[0], size: layout.size };
  return { ...layout, children };
}

function focusedWindow(workspace: Workspace): WorkspaceWindow | null {
  if (!workspace.focusedWindowId) return null;
  return (
    workspace.windows.find((w) => w.id === workspace.focusedWindowId) ?? null
  );
}

function windowById(windowId: string): WorkspaceWindow | null {
  for (const workspace of state.workspaces) {
    const window = workspace.windows.find((w) => w.id === windowId);
    if (window) return window;
  }
  return null;
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

  // Editor "threads" are sessions, not chat panes. Route them through the
  // editor-pane plumbing so the existing single-editor-per-workspace
  // invariant and the wrapperCache "editor:singleton" key still hold.
  // Switching sessions doesn't remount Monaco; it just swaps which tabs
  // are visible in the existing editor pane.
  if (thread.kind === "editor") {
    workspaceStore.bindEditorToWorkspace();
    return;
  }

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

  // Editor panes are persistent. Don't replace one with the picked thread -
  // open the thread in a new pane next to the editor instead, mirroring
  // bindEditorToWorkspace's behavior when a thread pane is focused.
  if (focused?.kind === "editor") {
    const focusedIdx = workspace.windows.findIndex(
      (w) => w.id === workspace.focusedWindowId,
    );
    const insertAt =
      focusedIdx >= 0 ? focusedIdx + 1 : workspace.windows.length;
    const newId = newPaneId(number);
    setState("workspaces", idx, "windows", (windows) => [
      ...windows.slice(0, insertAt),
      { id: newId, threadId, kind: thread.kind, size: 1 },
      ...windows.slice(insertAt),
    ]);
    const anchorId =
      focusedIdx >= 0
        ? workspace.windows[focusedIdx].id
        : workspace.windows[workspace.windows.length - 1].id;
    const baseLayout = workspace.layout ?? paneLayout(anchorId);
    setState(
      "workspaces",
      idx,
      "layout",
      insertPaneInLayout(baseLayout, anchorId, newId, "row"),
    );
    setState("workspaces", idx, "focusedWindowId", newId);
    if (!state.workspaces[idx].hasHadContent) {
      setState("workspaces", idx, "hasHadContent", true);
    }
    return;
  }

  const windowId = focused?.id ?? primaryWindowId(number);

  if (!focused) {
    setState("workspaces", idx, "windows", [
      {
        id: windowId,
        threadId,
        kind: thread.kind,
        size: 1,
      },
    ]);
    setState("workspaces", idx, "layout", paneLayout(windowId));
  } else {
    const windowIdx = workspace.windows.findIndex((w) => w.id === windowId);
    if (windowIdx >= 0) {
      setState("workspaces", idx, "windows", windowIdx, {
        id: focused.id,
        threadId,
        kind: thread.kind,
        size: focused.size,
      });
    }
  }

  if (!state.workspaces[idx].layout) {
    setState("workspaces", idx, "layout", paneLayout(windowId));
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
      const liveWindowIds = new Set(windows.map((window) => window.id));
      return {
        ...workspace,
        windows,
        focusedWindowId,
        layout: pruneLayout(workspace.layout, liveWindowIds),
      };
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
   * Uses a nested layout tree so splitting the other way affects only
   * the focused pane's container, matching i3-style behavior.
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
      editorFilePath: null,
      size: 1,
    };
    if (ws.windows.length === 0) {
      // No windows yet - the placeholder becomes the only pane.
      setState("workspaces", wsIdx, "windows", [placeholder]);
      setState("workspaces", wsIdx, "layout", paneLayout(newId));
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
      const focusedWindowId =
        focusedIdx >= 0
          ? ws.windows[focusedIdx].id
          : ws.windows[ws.windows.length - 1].id;
      const baseLayout = ws.layout ?? paneLayout(focusedWindowId);
      setState(
        "workspaces",
        wsIdx,
        "layout",
        insertPaneInLayout(baseLayout, focusedWindowId, newId, direction),
      );
    }
    if (ws.windows.length <= 1) {
      setState("workspaces", wsIdx, "splitDirection", direction);
    }
    setState("workspaces", wsIdx, "focusedWindowId", newId);
    if (!state.workspaces[wsIdx].hasHadContent) {
      setState("workspaces", wsIdx, "hasHadContent", true);
    }
    if (threadStore.activeThreadId !== null) {
      threadStore.setActiveThread(null);
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
    const closedWindowId = ws.windows[focusedIdx].id;
    setState("workspaces", wsIdx, "windows", nextWindows);
    setState(
      "workspaces",
      wsIdx,
      "layout",
      removeWindowFromLayout(ws.layout, closedWindowId),
    );
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
    const window =
      ws.windows.find((w) => w.id === windowId) ??
      (() => {
        const source = windowById(windowId);
        if (!source?.threadId) return null;
        return ws.windows.find((w) => w.threadId === source.threadId) ?? null;
      })();
    if (!window) return;
    if (ws.focusedWindowId !== window.id) {
      setState("workspaces", wsIdx, "focusedWindowId", window.id);
    }
    if (window.threadId !== threadStore.activeThreadId) {
      threadStore.setActiveThread(window.threadId);
    }
  },

  /**
   * Bind a thread directly to the named pane in the active workspace and
   * activate it. This is the drop-target path: it operates on the target
   * pane without going through focused-window resolution, so the bind
   * always lands on the pane the user dropped onto. Calls
   * `threadStore.selectThread` last so callers do not also need to.
   */
  bindThreadToWindow(windowId: string, threadId: string): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const ws = state.workspaces[wsIdx];
    const targetWindow =
      ws.windows.find((w) => w.id === windowId) ??
      (() => {
        const source = windowById(windowId);
        if (!source?.threadId) return null;
        return ws.windows.find((w) => w.threadId === source.threadId) ?? null;
      })();
    if (!targetWindow) return;

    const thread = threadStore.threads.find((t) => t.id === threadId);
    if (!thread) return;

    // Editor sessions are coordinated by editorSessionStore, not by
    // window.threadId. Drag-drop into a pane should:
    //   - on a chat/agent/terminal target: replace the target with an editor
    //     pane, preserving the single-editor-per-workspace invariant by
    //     refocusing any pre-existing editor pane instead of creating two.
    //   - on a placeholder: same as above.
    //   - on the existing editor pane: just activate the dragged session.
    if (thread.kind === "editor") {
      const existingEditorIdx = ws.windows.findIndex(
        (w) => w.kind === "editor",
      );
      if (existingEditorIdx >= 0) {
        const editorPane = ws.windows[existingEditorIdx];
        if (ws.focusedWindowId !== editorPane.id) {
          setState("workspaces", wsIdx, "focusedWindowId", editorPane.id);
        }
        if (!ws.hasHadContent) {
          setState("workspaces", wsIdx, "hasHadContent", true);
        }
        threadStore.selectThread(threadId, "editor");
        return;
      }
      // No existing editor pane: replace the drop target with one.
      const targetIdx = ws.windows.findIndex((w) => w.id === targetWindow.id);
      if (targetIdx >= 0) {
        setState("workspaces", wsIdx, "windows", targetIdx, {
          id: targetWindow.id,
          threadId: null,
          kind: "editor",
          editorFilePath: null,
          size: targetWindow.size,
        });
      }
      if (ws.focusedWindowId !== targetWindow.id) {
        setState("workspaces", wsIdx, "focusedWindowId", targetWindow.id);
      }
      if (!ws.hasHadContent) {
        setState("workspaces", wsIdx, "hasHadContent", true);
      }
      threadStore.selectThread(threadId, "editor");
      return;
    }

    // Singleton-per-workspace: if this thread already lives in another
    // pane here, focus that pane instead of duplicating it.
    const existing = ws.windows.find(
      (w) => w.threadId === threadId && w.id !== targetWindow.id,
    );
    if (existing) {
      if (ws.focusedWindowId !== existing.id) {
        setState("workspaces", wsIdx, "focusedWindowId", existing.id);
      }
      threadStore.selectThread(threadId, thread.kind);
      return;
    }

    const targetIdx = ws.windows.findIndex((w) => w.id === targetWindow.id);
    // Skip the rewrite when the target pane already shows this thread:
    // any setState on `windows[targetIdx]` produces a new object identity
    // for the row, which invalidates ThreadContent's wrapperCache and
    // re-mounts the chat/agent/terminal pane (losing scroll, draft input,
    // and IPC subscriptions).
    const targetUnchanged =
      targetIdx >= 0 &&
      targetWindow.threadId === threadId &&
      targetWindow.kind === thread.kind;
    if (targetIdx >= 0 && !targetUnchanged) {
      setState("workspaces", wsIdx, "windows", targetIdx, {
        id: targetWindow.id,
        threadId,
        kind: thread.kind,
        size: targetWindow.size,
      });
    }
    if (ws.focusedWindowId !== targetWindow.id) {
      setState("workspaces", wsIdx, "focusedWindowId", targetWindow.id);
    }
    if (!ws.hasHadContent) {
      setState("workspaces", wsIdx, "hasHadContent", true);
    }
    threadStore.selectThread(threadId, thread.kind);
  },

  /**
   * Open the editor as a workspace pane. The editor owns tabs globally, so
   * each workspace gets at most one editor window.
   */
  bindEditorToWorkspace(filePath: string | null = null): void {
    const wsIdx = state.workspaces.findIndex(
      (w) => w.number === state.activeNumber,
    );
    if (wsIdx < 0) return;
    const ws = state.workspaces[wsIdx];
    const existing = ws.windows.find((w) => w.kind === "editor");
    if (existing) {
      const existingIdx = ws.windows.findIndex((w) => w.id === existing.id);
      if (filePath !== null && existing.editorFilePath !== filePath) {
        setState(
          "workspaces",
          wsIdx,
          "windows",
          existingIdx,
          "editorFilePath",
          filePath,
        );
      }
      if (ws.focusedWindowId !== existing.id) {
        setState("workspaces", wsIdx, "focusedWindowId", existing.id);
      }
      if (
        threadStore.activeThreadId !== null &&
        threadStore.activeThreadKind !== "editor"
      ) {
        threadStore.setActiveThread(null);
      }
      return;
    }

    const focused = focusedWindow(ws);
    const fillFocusedPlaceholder = focused?.kind === null;
    const windowId = fillFocusedPlaceholder
      ? focused.id
      : ws.windows.length === 0
        ? primaryWindowId(ws.number)
        : newPaneId(ws.number);
    const editorWindow: WorkspaceWindow = {
      id: windowId,
      threadId: null,
      kind: "editor",
      editorFilePath: filePath,
      size: focused?.size ?? 1,
    };

    if (ws.windows.length === 0) {
      setState("workspaces", wsIdx, "windows", [editorWindow]);
      setState("workspaces", wsIdx, "layout", paneLayout(windowId));
    } else if (fillFocusedPlaceholder) {
      const windowIdx = ws.windows.findIndex((w) => w.id === focused.id);
      setState("workspaces", wsIdx, "windows", windowIdx, editorWindow);
    } else {
      const focusedIdx = ws.windows.findIndex(
        (w) => w.id === ws.focusedWindowId,
      );
      const insertAt = focusedIdx >= 0 ? focusedIdx + 1 : ws.windows.length;
      setState("workspaces", wsIdx, "windows", (windows) => [
        ...windows.slice(0, insertAt),
        editorWindow,
        ...windows.slice(insertAt),
      ]);
      const focusedWindowId =
        focusedIdx >= 0
          ? ws.windows[focusedIdx].id
          : ws.windows[ws.windows.length - 1].id;
      const baseLayout = ws.layout ?? paneLayout(focusedWindowId);
      setState(
        "workspaces",
        wsIdx,
        "layout",
        insertPaneInLayout(baseLayout, focusedWindowId, windowId, "row"),
      );
    }

    setState("workspaces", wsIdx, "focusedWindowId", windowId);
    if (!state.workspaces[wsIdx].hasHadContent) {
      setState("workspaces", wsIdx, "hasHadContent", true);
    }
    if (
      threadStore.activeThreadId !== null &&
      threadStore.activeThreadKind !== "editor"
    ) {
      threadStore.setActiveThread(null);
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
      const nextSize = Math.max(0.05, update.size);
      const windowIdx = windows.findIndex((w) => w.id === update.id);
      if (windowIdx >= 0 && windows[windowIdx].size !== nextSize) {
        setState("workspaces", wsIdx, "windows", windowIdx, "size", nextSize);
      }
      const layout = state.workspaces[wsIdx].layout;
      if (layout) {
        setState(
          "workspaces",
          wsIdx,
          "layout",
          resizeLayoutNode(layout, update.id, nextSize),
        );
      }
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
