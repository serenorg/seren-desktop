// ABOUTME: Tests the New Mission reset path of the Mission Control run store.
// ABOUTME: Protects settled-run dismissal without discarding live runs.

import { beforeEach, describe, expect, it } from "vitest";
import type { Run, RunSnapshot } from "@/services/run";
import {
  INITIAL_STATE,
  runState,
  runStore,
  setRunState,
} from "@/stores/run.store";

function snapshot(status: Run["status"]): RunSnapshot {
  return {
    run: {
      id: "run-1",
      objective: "Objective",
      root_path: null,
      max_attempts: 2,
      status,
      cancel_requested: false,
      interrupted_at: status === "interrupted" ? 2 : null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
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

beforeEach(() => {
  setRunState({ ...INITIAL_STATE });
});

describe("#3617 New Mission lands on the launch form", () => {
  it("clears a settled run so the launch form renders", () => {
    setRunState({
      activeRunId: "run-1",
      snapshot: snapshot("completed"),
      lastSequence: 7,
    });

    runStore.showLaunchForm();

    expect(runState.snapshot).toBeNull();
    expect(runState.activeRunId).toBeNull();
    expect(runState.lastSequence).toBe(0);
  });

  it.each(["running", "interrupted"] as const)(
    "keeps a %s run's overview untouched",
    (status) => {
      setRunState({
        activeRunId: "run-1",
        snapshot: snapshot(status),
        lastSequence: 7,
      });

      runStore.showLaunchForm();

      expect(runState.snapshot?.run.status).toBe(status);
      expect(runState.activeRunId).toBe("run-1");
    },
  );
});
