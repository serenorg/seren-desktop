// ABOUTME: Tests persisted Mission Control run selection after app startup.
// ABOUTME: Protects newest non-terminal hydration, interrupted recovery, and errors.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", async () => {
  const actual = await vi.importActual<typeof import("@/services/run")>(
    "@/services/run",
  );
  return {
    ...actual,
    runAddAgent: vi.fn(),
    runAddTask: vi.fn(),
    runCreate: vi.fn(),
    runGetState: vi.fn(),
    runList: vi.fn(),
    runProvisionWorkspace: vi.fn(),
  };
});

import {
  runAddAgent,
  runAddTask,
  runCreate,
  runGetState,
  runList,
  runProvisionWorkspace,
  type Run,
  type RunSnapshot,
  type Task,
} from "@/services/run";
import {
  runState,
  runStore,
  setRunState,
} from "@/stores/run.store";

const getStateMock = vi.mocked(runGetState);
const listMock = vi.mocked(runList);
const createMock = vi.mocked(runCreate);
const addAgentMock = vi.mocked(runAddAgent);
const addTaskMock = vi.mocked(runAddTask);
const provisionWorkspaceMock = vi.mocked(runProvisionWorkspace);

function run(
  id: string,
  status: Run["status"],
  createdAt: number,
): Run {
  return {
    id,
    objective: `Objective ${id}`,
    root_path: null,
    max_attempts: 2,
    status,
    cancel_requested: false,
    interrupted_at: status === "interrupted" ? createdAt + 1 : null,
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: status === "completed" ? createdAt + 1 : null,
  };
}

function snapshot(runRecord: Run): RunSnapshot {
  return {
    run: runRecord,
    tasks: [],
    dependencies: [],
    assignments: [],
    leases: [],
    attempts: [],
    findings: [],
    checks: [],
    check_results: [],
    coverage_gaps: [],
  };
}

describe("run store startup hydration", () => {
  beforeEach(() => {
    setRunState({
      activeRunId: null,
      snapshot: null,
      lastSequence: 0,
      launchPending: false,
      error: null,
    });
    getStateMock.mockReset();
    listMock.mockReset();
    createMock.mockReset();
    addAgentMock.mockReset();
    addTaskMock.mockReset();
    provisionWorkspaceMock.mockReset();
  });

  it("hydrates the newest non-terminal run", async () => {
    const olderRunning = run("run-old", "running", 10);
    const newestInterrupted = run("run-new", "interrupted", 30);
    listMock.mockResolvedValue([
      run("run-complete", "completed", 40),
      newestInterrupted,
      olderRunning,
    ]);
    getStateMock.mockResolvedValue(snapshot(newestInterrupted));

    await runStore.hydrateLatest();

    expect(getStateMock).toHaveBeenCalledWith("run-new");
    expect(runState.activeRunId).toBe("run-new");
    expect(runState.snapshot?.run.status).toBe("interrupted");
  });

  it("leaves the store empty when all runs are terminal", async () => {
    setRunState({
      activeRunId: "stale-run",
      snapshot: snapshot(run("stale-run", "running", 1)),
      lastSequence: 4,
    });
    listMock.mockResolvedValue([
      run("run-complete", "completed", 10),
      run("run-failed", "failed", 20),
      run("run-cancelled", "cancelled", 30),
    ]);

    await runStore.hydrateLatest();

    expect(runState.activeRunId).toBeNull();
    expect(runState.snapshot).toBeNull();
    expect(runState.lastSequence).toBe(0);
  });

  it("hydrates an interrupted run for the recovery banner", async () => {
    const interrupted = run("run-interrupted", "interrupted", 20);
    listMock.mockResolvedValue([interrupted]);
    getStateMock.mockResolvedValue(snapshot(interrupted));

    await runStore.hydrateLatest();

    expect(runStore.isInterrupted()).toBe(true);
    expect(runState.snapshot?.run.interrupted_at).not.toBeNull();
  });

  it("stores run-list failures without throwing", async () => {
    listMock.mockRejectedValue(new Error("run list unavailable"));

    await expect(runStore.hydrateLatest()).resolves.toBeUndefined();

    expect(runState.error).toBe("run list unavailable");
    expect(runState.snapshot).toBeNull();
  });

  it("persists launch policies and provisions the selected task isolation", async () => {
    const createdRun = run("run-policy", "running", 10);
    const createdTask: Task = {
      id: "task-policy",
      run_id: createdRun.id,
      title: "Inspect invoices",
      brief: "Compare totals.",
      state: "ready",
      blocked_reason: null,
      created_at: 11,
      updated_at: 11,
    };
    createMock.mockResolvedValue(createdRun);
    addAgentMock.mockResolvedValue({} as never);
    addTaskMock.mockResolvedValue(createdTask);
    provisionWorkspaceMock.mockResolvedValue({} as never);
    getStateMock.mockResolvedValue(snapshot(createdRun));

    await runStore.launch({
      objective: " Reconcile billing ",
      rootPath: "/project",
      tasks: [{ title: createdTask.title, brief: createdTask.brief }],
      agents: [
        {
          agentType: "codex",
          modelId: "gpt-5.4",
          permissionMode: "ask",
        },
      ],
      workspaceMode: "worktree",
      maxAttempts: 3,
    });

    expect(createMock).toHaveBeenCalledWith("Reconcile billing", "/project", 3);
    expect(addAgentMock).toHaveBeenCalledWith(
      createdRun.id,
      "codex",
      "gpt-5.4",
      "ask",
    );
    expect(provisionWorkspaceMock).toHaveBeenCalledWith(
      createdRun.id,
      createdTask.id,
      "worktree",
      "/project",
    );
  });
});
