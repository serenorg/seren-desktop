// ABOUTME: Tests the launch failure path of the Mission Control run store.
// ABOUTME: Protects cancel-on-provision-failure so runs never drop isolation.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", async () => {
  const actual = await vi.importActual<typeof import("@/services/run")>(
    "@/services/run",
  );
  return {
    ...actual,
    runAddAgent: vi.fn(),
    runAddTask: vi.fn(),
    runCancel: vi.fn(),
    runCreate: vi.fn(),
    runGetState: vi.fn(),
    runProvisionWorkspace: vi.fn(),
  };
});

import {
  type Run,
  runAddAgent,
  runAddTask,
  runCancel,
  runCreate,
  runGetState,
  runProvisionWorkspace,
  type RunSnapshot,
  type Task,
} from "@/services/run";
import {
  INITIAL_STATE,
  runState,
  runStore,
  setRunState,
} from "@/stores/run.store";

const createMock = vi.mocked(runCreate);
const addAgentMock = vi.mocked(runAddAgent);
const addTaskMock = vi.mocked(runAddTask);
const provisionMock = vi.mocked(runProvisionWorkspace);
const cancelMock = vi.mocked(runCancel);
const getStateMock = vi.mocked(runGetState);

function snapshot(runRow: Run): RunSnapshot {
  return {
    run: runRow,
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

function run(id: string, status: Run["status"]): Run {
  return {
    id,
    objective: `Objective ${id}`,
    root_path: "/projects/example",
    max_attempts: 2,
    status,
    cancel_requested: status === "cancelled",
    interrupted_at: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
  };
}

function task(id: string, runId: string): Task {
  return {
    id,
    run_id: runId,
    title: `Task ${id}`,
    brief: "brief",
    state: "ready",
    blocked_reason: null,
    created_at: 1,
    updated_at: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setRunState({ ...INITIAL_STATE });
});

describe("#3612 launch failure cannot drop workspace isolation", () => {
  it("cancels the partial run and returns to the launch form", async () => {
    createMock.mockResolvedValue(run("run-1", "running"));
    addAgentMock.mockResolvedValue({
      id: "assignment-1",
      run_id: "run-1",
      agent_type: "claude-code",
      model_id: null,
      secondary_model_id: null,
      permission_mode: null,
      created_at: 1,
    });
    addTaskMock.mockResolvedValue(task("task-1", "run-1"));
    provisionMock.mockRejectedValue(
      new Error("worktree provisioning requires a git repository"),
    );
    cancelMock.mockResolvedValue(run("run-1", "cancelled"));

    await runStore.launch({
      objective: "Audit the schema",
      rootPath: "/projects/example",
      tasks: [{ title: "Audit", brief: "look" }],
      agents: [{ agentType: "claude-code" }],
      workspaceMode: "worktree",
      maxAttempts: 2,
    });

    // The partial run is cancelled, the launch form stays up, and the
    // provisioning error is visible on it.
    expect(cancelMock).toHaveBeenCalledWith("run-1");
    expect(runState.activeRunId).toBeNull();
    expect(runState.snapshot).toBeNull();
    expect(runState.error).toContain("git repository");
    expect(runState.launchPending).toBe(false);
  });

  it("keeps the run when every launch step succeeds", async () => {
    createMock.mockResolvedValue(run("run-2", "running"));
    addAgentMock.mockResolvedValue({
      id: "assignment-2",
      run_id: "run-2",
      agent_type: "claude-code",
      model_id: null,
      secondary_model_id: null,
      permission_mode: null,
      created_at: 1,
    });
    addTaskMock.mockResolvedValue(task("task-2", "run-2"));
    provisionMock.mockResolvedValue(undefined);
    getStateMock.mockResolvedValue(snapshot(run("run-2", "running")));

    await runStore.launch({
      objective: "Audit the schema",
      rootPath: "/projects/example",
      tasks: [{ title: "Audit", brief: "look" }],
      agents: [{ agentType: "claude-code" }],
      workspaceMode: "worktree",
      maxAttempts: 2,
    });

    expect(cancelMock).not.toHaveBeenCalled();
    expect(runState.activeRunId).toBe("run-2");
    expect(runState.error).toBeNull();
  });
});
