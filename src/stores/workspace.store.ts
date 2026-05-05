// ABOUTME: i3-style virtual workspaces. Each workspace remembers its open thread;
// ABOUTME: empty non-permanent workspaces auto-delete when the user switches away.

import { createEffect, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import {
  type ThreadKind,
  type ThreadStatus,
  threadStore,
} from "@/stores/thread.store";

export interface WorkspaceWindow {
  /** Stable identity for the pane inside a workspace. */
  id: string;
  /** Thread displayed by this window. */
  threadId: string;
  kind: ThreadKind;
}

export interface Workspace {
  /** 1-indexed display number; also the identity. */
  number: number;
  windows: WorkspaceWindow[];
  focusedWindowId: string | null;
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
    hasHadContent: false,
    needsAttention: false,
  };
}

function primaryWindowId(number: number): string {
  return `workspace-${number}-primary`;
}

function focusedWindow(workspace: Workspace): WorkspaceWindow | null {
  if (!workspace.focusedWindowId) return null;
  return (
    workspace.windows.find((w) => w.id === workspace.focusedWindowId) ?? null
  );
}

function bindThreadToWorkspace(number: number, threadId: string | null): void {
  if (threadId === null) return;

  const thread = threadStore.threads.find((t) => t.id === threadId);
  if (!thread) return;

  const idx = state.workspaces.findIndex((w) => w.number === number);
  if (idx < 0) return;

  const workspace = state.workspaces[idx];
  const existingWindow = focusedWindow(workspace) ?? workspace.windows[0];
  const windowId = existingWindow?.id ?? primaryWindowId(number);

  if (!existingWindow) {
    setState("workspaces", idx, "windows", [
      { id: windowId, threadId, kind: thread.kind },
    ]);
  } else if (
    existingWindow.threadId !== threadId ||
    existingWindow.kind !== thread.kind
  ) {
    const windowIdx = workspace.windows.findIndex((w) => w.id === windowId);
    if (windowIdx >= 0) {
      setState("workspaces", idx, "windows", windowIdx, {
        ...existingWindow,
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
  // reactivity to every consumer.
  let needsPrune = false;
  for (const workspace of state.workspaces) {
    for (const window of workspace.windows) {
      if (!threadIds.has(window.threadId)) {
        needsPrune = true;
        break;
      }
    }
    if (needsPrune) break;
  }
  if (!needsPrune) return;

  setState("workspaces", (workspaces) =>
    workspaces.map((workspace) => {
      const windows = workspace.windows.filter((window) =>
        threadIds.has(window.threadId),
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
  createEffect(() => {
    const active = threadStore.activeThreadId;
    const threadIds = new Set(threadStore.threads.map((thread) => thread.id));
    untrack(() => {
      pruneMissingThreadWindows(threadIds);
      bindThreadToWorkspace(state.activeNumber, active);
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
