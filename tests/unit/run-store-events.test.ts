// ABOUTME: Tests ordered Mission Control event application and recovery.
// ABOUTME: Protects duplicate suppression, gap hydration, and operator selectors.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", async () => {
  const actual = await vi.importActual<typeof import("@/services/run")>(
    "@/services/run",
  );
  return { ...actual, runGetState: vi.fn() };
});

import {
  runGetState,
  type RunEvent,
  type RunSnapshot,
} from "@/services/run";
import {
  INITIAL_STATE,
  runState,
  runStore,
  setRunState,
} from "@/stores/run.store";

const getStateMock = vi.mocked(runGetState);

function snapshot(): RunSnapshot {
  return {
    run: {
      id: "run-1",
      objective: "Trace the billing mismatch",
      root_path: null,
      status: "running",
      cancel_requested: false,
      interrupted_at: null,
      created_at: 1,
      updated_at: 1,
      completed_at: null,
    },
    tasks: [
      {
        id: "task-working",
        run_id: "run-1",
        title: "Inspect the ledger",
        brief: "Compare the source records.",
        state: "running",
        blocked_reason: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "task-review",
        run_id: "run-1",
        title: "Review the finding",
        brief: "Check the proposed answer.",
        state: "review",
        blocked_reason: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "task-done",
        run_id: "run-1",
        title: "Collect context",
        brief: "Gather the relevant context.",
        state: "done",
        blocked_reason: null,
        created_at: 1,
        updated_at: 1,
      },
    ],
    dependencies: [],
    assignments: [],
    attempts: [],
    findings: [
      {
        id: "finding-1",
        run_id: "run-1",
        task_id: "task-review",
        attempt_id: null,
        claim: "The invoice was duplicated.",
        confidence: "asserted",
        evidence: [],
        proposed_artifact: null,
        needs_approval: true,
        status: "open",
        created_at: 1,
        updated_at: 1,
      },
    ],
    checks: [],
    check_results: [],
    coverage_gaps: [],
  };
}

function event(
  sequence: number,
  eventType: RunEvent["event_type"],
  payload: Record<string, unknown> = {},
  taskId: string | null = null,
): RunEvent {
  return {
    id: `event-${sequence}`,
    run_id: "run-1",
    task_id: taskId,
    attempt_id: null,
    agent_id: null,
    sequence,
    event_type: eventType,
    payload,
    provider_event_id: null,
    created_at: sequence,
  };
}

describe("run store event handling", () => {
  beforeEach(() => {
    setRunState(INITIAL_STATE);
    getStateMock.mockReset();
  });

  it("ignores duplicate and lower sequence events", async () => {
    setRunState({
      activeRunId: "run-1",
      snapshot: snapshot(),
      lastSequence: 3,
    });

    await runStore.applyEvent(
      event(3, "task_state_changed", { state: "done" }, "task-working"),
    );
    await runStore.applyEvent(
      event(2, "task_state_changed", { state: "blocked" }, "task-working"),
    );

    expect(
      runState.snapshot?.tasks.find((task) => task.id === "task-working")
        ?.state,
    ).toBe("running");
    expect(runState.lastSequence).toBe(3);
  });

  it("hydrates when an event sequence gap is detected", async () => {
    const rehydrated = snapshot();
    rehydrated.tasks[0].state = "verifying";
    getStateMock.mockResolvedValue(rehydrated);
    setRunState({
      activeRunId: "run-1",
      snapshot: snapshot(),
      lastSequence: 1,
    });

    await runStore.applyEvent(event(3, "task_state_changed"));

    expect(getStateMock).toHaveBeenCalledWith("run-1");
    expect(runState.snapshot?.tasks[0].state).toBe("verifying");
    expect(runState.lastSequence).toBe(3);
  });

  it("applies concurrent events in order without regressing the sequence", async () => {
    const first = snapshot();
    first.tasks[0].state = "verifying";
    const second = snapshot();
    second.tasks[0].state = "review";
    // The earlier event's hydrate resolves last, mimicking two interleaved
    // in-flight hydrates.
    getStateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(first), 20)),
      )
      .mockResolvedValueOnce(second);
    setRunState({
      activeRunId: "run-1",
      snapshot: snapshot(),
      lastSequence: 1,
    });

    await Promise.all([
      runStore.applyEvent(event(3, "task_state_changed")),
      runStore.applyEvent(event(5, "task_state_changed")),
    ]);

    expect(runState.lastSequence).toBe(5);
    expect(runState.snapshot?.tasks[0].state).toBe("review");
  });

  it("groups lanes and exposes findings that need operator review", () => {
    setRunState({
      activeRunId: "run-1",
      snapshot: snapshot(),
      lastSequence: 0,
    });

    const lanes = runStore.lanes();
    expect(runStore.needsYou().map((finding) => finding.id)).toEqual([
      "finding-1",
    ]);
    expect(lanes.working.map((task) => task.id)).toEqual(["task-working"]);
    expect(lanes.review.map((task) => task.id)).toEqual(["task-review"]);
    expect(lanes.done.map((task) => task.id)).toEqual(["task-done"]);
  });
});
