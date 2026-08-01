// ABOUTME: Tests persisted Mission Control run selection after app startup.
// ABOUTME: Protects newest non-terminal hydration, interrupted recovery, and errors.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", async () => {
  const actual = await vi.importActual<typeof import("@/services/run")>(
    "@/services/run",
  );
  return {
    ...actual,
    runGetState: vi.fn(),
    runList: vi.fn(),
  };
});

import {
  runGetState,
  runList,
  type Run,
  type RunSnapshot,
} from "@/services/run";
import {
  runState,
  runStore,
  setRunState,
} from "@/stores/run.store";

const getStateMock = vi.mocked(runGetState);
const listMock = vi.mocked(runList);

function run(
  id: string,
  status: Run["status"],
  createdAt: number,
): Run {
  return {
    id,
    objective: `Objective ${id}`,
    root_path: null,
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
});
