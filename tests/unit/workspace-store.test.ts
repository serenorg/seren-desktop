// ABOUTME: Regression tests for i3-style workspace cleanup semantics.
// ABOUTME: Verifies sticky lifetime content survives transient thread clears.

import { afterEach, describe, expect, it, vi } from "vitest";

type MockThreadStatus = "idle" | "running" | "waiting-input" | "error";
const harness = vi.hoisted(() => ({
  activeThreadId: null as string | null,
  effects: [] as Array<() => void>,
  threads: [] as Array<{
    id: string;
    kind: "chat" | "agent" | "terminal";
    status: "idle" | "running" | "waiting-input" | "error";
  }>,
}));

vi.mock("solid-js", async () => {
  const actual = await vi.importActual<typeof import("solid-js")>("solid-js");
  return {
    ...actual,
    createEffect(fn: () => void): void {
      harness.effects.push(fn);
      fn();
    },
    untrack<T>(fn: () => T): T {
      return fn();
    },
  };
});

vi.mock("@/stores/thread.store", () => {
  const setActiveThread = vi.fn((id: string | null) => {
    if (id && !harness.threads.some((t) => t.id === id)) {
      harness.threads.push({ id, kind: "chat", status: "idle" });
    }
    harness.activeThreadId = id;
    for (const effect of harness.effects) effect();
  });

  return {
    threadStore: {
      get activeThreadId(): string | null {
        return harness.activeThreadId;
      },
      get threads() {
        return harness.threads;
      },
      setActiveThread,
    },
    __setMockActiveThread(id: string | null): void {
      setActiveThread.mockClear();
      harness.activeThreadId = id;
      if (id && !harness.threads.some((t) => t.id === id)) {
        harness.threads.push({ id, kind: "chat", status: "idle" });
      }
    },
    __setMockActiveThreadWithoutThread(id: string | null): void {
      setActiveThread.mockClear();
      harness.activeThreadId = id;
      for (const effect of harness.effects) effect();
    },
    __addMockThread(
      id: string,
      kind: "chat" | "agent" | "terminal" = "chat",
    ): void {
      if (!harness.threads.some((thread) => thread.id === id)) {
        harness.threads.push({ id, kind, status: "idle" });
      }
      for (const effect of harness.effects) effect();
    },
    __removeMockThread(id: string): void {
      harness.threads = harness.threads.filter((thread) => thread.id !== id);
      for (const effect of harness.effects) effect();
    },
    __setMockThreadStatus(id: string, status: MockThreadStatus): void {
      const thread = harness.threads.find((t) => t.id === id);
      if (thread) thread.status = status;
      for (const effect of harness.effects) effect();
    },
  };
});

async function setup(initialActiveThreadId: string | null = null) {
  harness.activeThreadId = initialActiveThreadId;
  harness.effects = [];
  harness.threads = initialActiveThreadId
    ? [{ id: initialActiveThreadId, kind: "chat", status: "idle" }]
    : [];
  vi.resetModules();
  type ThreadStoreTestModule = typeof import("@/stores/thread.store") & {
    __setMockActiveThread(id: string | null): void;
    __setMockActiveThreadWithoutThread(id: string | null): void;
    __addMockThread(
      id: string,
      kind?: "chat" | "agent" | "terminal",
    ): void;
    __removeMockThread(id: string): void;
    __setMockThreadStatus(id: string, status: MockThreadStatus): void;
  };
  const threadModule = (await import(
    "@/stores/thread.store"
  )) as ThreadStoreTestModule;
  threadModule.__setMockActiveThread(initialActiveThreadId);

  const workspaceModule = await import("@/stores/workspace.store");
  workspaceModule.initWorkspaceStore();
  await Promise.resolve();

  return {
    threadModule,
    threadStore: threadModule.threadStore,
    workspaceStore: workspaceModule.workspaceStore,
  };
}

afterEach(() => {
  harness.activeThreadId = null;
  harness.threads = [];
  harness.effects = [];
  vi.clearAllMocks();
});

describe("workspaceStore", () => {
  it("auto-deletes a created workspace that never had content", async () => {
    const { workspaceStore } = await setup();

    workspaceStore.addWorkspace();
    expect(workspaceStore.activeNumber).toBe(2);

    workspaceStore.switchTo(1);

    expect(workspaceStore.workspaces.map((w) => w.number)).toEqual([1]);
  });

  it("notifies listeners when an empty workspace auto-deletes", async () => {
    const { workspaceStore } = await setup();
    const removed = vi.fn();
    const unsubscribe = workspaceStore.onWorkspaceRemoved(removed);

    workspaceStore.addWorkspace();
    workspaceStore.switchTo(1);

    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(2);

    unsubscribe();
    workspaceStore.switchOrCreate(3);
    workspaceStore.switchTo(1);

    expect(removed).toHaveBeenCalledOnce();
  });

  it("keeps a workspace that had content after its live thread mirror clears", async () => {
    const { threadStore, workspaceStore } = await setup();

    workspaceStore.addWorkspace();
    threadStore.setActiveThread("thread-1");

    const usedWorkspace = () =>
      workspaceStore.workspaces.find((w) => w.number === 2);
    expect(usedWorkspace()?.windows[0]).toMatchObject({
      threadId: "thread-1",
      kind: "chat",
    });
    expect(usedWorkspace()?.hasHadContent).toBe(true);

    threadStore.setActiveThread(null);
    expect(usedWorkspace()?.windows[0]).toMatchObject({
      threadId: "thread-1",
      kind: "chat",
    });
    expect(usedWorkspace()?.hasHadContent).toBe(true);

    workspaceStore.switchTo(1);

    expect(workspaceStore.workspaces.map((w) => w.number)).toEqual([1, 2]);
  });

  it("closes windows for threads that are actually removed", async () => {
    const { threadModule, threadStore, workspaceStore } = await setup();

    workspaceStore.addWorkspace();
    threadStore.setActiveThread("thread-1");

    threadStore.setActiveThread(null);
    expect(workspaceStore.workspaces.find((w) => w.number === 2)).toMatchObject(
      {
        windows: [
          {
            threadId: "thread-1",
          },
        ],
        hasHadContent: true,
      },
    );

    threadModule.__removeMockThread("thread-1");

    expect(workspaceStore.workspaces.find((w) => w.number === 2)).toMatchObject(
      {
        windows: [],
        focusedWindowId: null,
        hasHadContent: true,
      },
    );
  });

  it("captures the outgoing thread even if the mirror has not flushed yet", async () => {
    const { threadModule, workspaceStore } = await setup();

    workspaceStore.addWorkspace();
    threadModule.__setMockActiveThread("thread-1");

    workspaceStore.switchTo(1);
    workspaceStore.switchTo(2);

    expect(workspaceStore.workspaces.find((w) => w.number === 2)).toMatchObject(
      {
        windows: [
          {
            threadId: "thread-1",
            kind: "chat",
          },
        ],
        hasHadContent: true,
      },
    );
  });

  it("marks workspace 1 as used when a thread is already active before init", async () => {
    const { workspaceStore } = await setup("restored-thread");

    expect(workspaceStore.workspaces).toEqual([
      {
        number: 1,
        windows: [
          {
            id: "workspace-1-primary",
            threadId: "restored-thread",
            kind: "chat",
          },
        ],
        focusedWindowId: "workspace-1-primary",
        hasHadContent: true,
        needsAttention: false,
      },
    ]);
  });

  it("binds an already-active thread when the thread list arrives later", async () => {
    const { threadModule, workspaceStore } = await setup();

    threadModule.__setMockActiveThreadWithoutThread("late-thread");
    expect(workspaceStore.activeWindow).toBeNull();

    threadModule.__addMockThread("late-thread", "agent");

    expect(workspaceStore.activeWindow).toMatchObject({
      id: "workspace-1-primary",
      threadId: "late-thread",
      kind: "agent",
    });
    expect(workspaceStore.activeWorkspace.hasHadContent).toBe(true);
  });

  it("does not reselect when switching between workspaces sharing a thread", async () => {
    const { threadStore, workspaceStore } = await setup();

    threadStore.setActiveThread("thread-1");
    workspaceStore.switchOrCreate(2);
    threadStore.setActiveThread("thread-1");
    vi.mocked(threadStore.setActiveThread).mockClear();

    workspaceStore.switchTo(1);

    expect(threadStore.setActiveThread).not.toHaveBeenCalled();
    expect(workspaceStore.activeWindow).toMatchObject({
      threadId: "thread-1",
      kind: "chat",
    });
  });

  it("keeps shortcut-created workspaces empty across repeated same-target switches", async () => {
    const { workspaceStore } = await setup();

    workspaceStore.switchOrCreate(5);
    workspaceStore.switchOrCreate(5);

    const workspace5 = workspaceStore.workspaces.find((w) => w.number === 5);
    expect(workspace5?.windows).toEqual([]);
    expect(workspace5?.hasHadContent).toBe(false);

    workspaceStore.switchTo(1);

    expect(workspaceStore.workspaces.map((w) => w.number)).toEqual([1]);
  });

  it("ignores direct switches to missing workspaces", async () => {
    const { workspaceStore } = await setup();

    workspaceStore.switchTo(7);

    expect(workspaceStore.activeNumber).toBe(1);
    expect(workspaceStore.workspaces.map((w) => w.number)).toEqual([1]);
  });

  it("resets workspace lifetime state for a new auth session", async () => {
    const { threadStore, workspaceStore } = await setup();

    workspaceStore.switchOrCreate(3);
    threadStore.setActiveThread("thread-3");

    workspaceStore.reset();

    expect(workspaceStore.activeNumber).toBe(1);
    expect(workspaceStore.workspaces).toEqual([
      {
        number: 1,
        windows: [],
        focusedWindowId: null,
        hasHadContent: false,
        needsAttention: false,
      },
    ]);
  });

  it("flags an inactive workspace when its thread transitions running -> idle", async () => {
    const { threadModule, threadStore, workspaceStore } = await setup();

    // Bind a thread to ws2 then leave for ws1.
    workspaceStore.addWorkspace();
    threadStore.setActiveThread("agent-thread");
    workspaceStore.switchTo(1);

    const ws2 = () => workspaceStore.workspaces.find((w) => w.number === 2);
    expect(ws2()?.needsAttention).toBe(false);

    // Agent starts a turn, then finishes - the dot should appear on
    // ws2 because the user is currently looking at ws1.
    threadModule.__setMockThreadStatus("agent-thread", "running");
    expect(ws2()?.needsAttention).toBe(false);

    threadModule.__setMockThreadStatus("agent-thread", "idle");
    expect(ws2()?.needsAttention).toBe(true);
  });

  it("does not flag the active workspace when its thread settles", async () => {
    const { threadModule, threadStore, workspaceStore } = await setup();

    threadStore.setActiveThread("agent-thread");
    threadModule.__setMockThreadStatus("agent-thread", "running");
    threadModule.__setMockThreadStatus("agent-thread", "idle");

    expect(workspaceStore.activeWorkspace.needsAttention).toBe(false);
  });

  it("clears needsAttention when the user switches into the workspace", async () => {
    const { threadModule, threadStore, workspaceStore } = await setup();

    workspaceStore.addWorkspace();
    threadStore.setActiveThread("agent-thread");
    workspaceStore.switchTo(1);
    threadModule.__setMockThreadStatus("agent-thread", "running");
    threadModule.__setMockThreadStatus("agent-thread", "idle");
    expect(
      workspaceStore.workspaces.find((w) => w.number === 2)?.needsAttention,
    ).toBe(true);

    workspaceStore.switchTo(2);

    expect(workspaceStore.activeWorkspace.needsAttention).toBe(false);
  });
});
