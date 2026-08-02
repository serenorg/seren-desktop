// ABOUTME: Tests deterministic ready-task admission for the run dispatcher.
// ABOUTME: Protects the three-task cap, in-flight exclusion, and assignment round robin.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/run", () => ({}));
vi.mock("@/stores/agent.store", () => ({ agentStore: {} }));
vi.mock("@/stores/fileTree", () => ({ fileTreeState: { rootPath: null } }));
vi.mock("@/stores/run.store", () => ({
  runState: { snapshot: null, activeRunId: null },
}));

import {
  assignmentSessionOptions,
  selectDispatchPlan,
  selectReadyTasks,
  taskWorkspaceRoot,
} from "@/services/run-dispatcher";
import type { AgentAssignment, RunSnapshot, Task } from "@/services/run";

function task(id: string, state: Task["state"] = "ready"): Task {
  return {
    id,
    run_id: "run-1",
    title: id,
    brief: `Brief ${id}`,
    state,
    blocked_reason: null,
    created_at: 1,
    updated_at: 1,
  };
}

function assignment(id: string): AgentAssignment {
  return {
    id,
    run_id: "run-1",
    agent_type: "codex",
    model_id: null,
    permission_mode: null,
    role_label: id,
    created_at: 1,
  };
}

describe("run dispatcher selection", () => {
  it("excludes in-flight tasks and caps admission at three", () => {
    const tasks = [task("one"), task("two"), task("three"), task("four")];
    expect(selectReadyTasks(tasks, new Set(["two"]), 3).map((item) => item.id)).toEqual([
      "one",
      "three",
    ]);
    expect(selectReadyTasks(tasks, new Set(), 2).map((item) => item.id)).toEqual([
      "one",
      "two",
    ]);
  });

  it("counts in-flight tasks against the concurrency cap", () => {
    const tasks = [task("one"), task("two"), task("three"), task("four")];
    expect(
      selectReadyTasks(tasks, new Set(["one", "two", "three"]), 3),
    ).toEqual([]);
    expect(
      selectReadyTasks(tasks, new Set(["one"]), 3).map((item) => item.id),
    ).toEqual(["two", "three"]);
    expect(selectReadyTasks(tasks, new Set(["one", "two"]), 3)).toHaveLength(1);
  });

  it("round-robins assignments in the selected plan", () => {
    const plans = selectDispatchPlan(
      [task("one"), task("two"), task("three")],
      [assignment("a"), assignment("b")],
      new Set(),
      3,
    );
    expect(plans.map((plan) => [plan.task.id, plan.assignment.id])).toEqual([
      ["one", "a"],
      ["two", "b"],
      ["three", "a"],
    ]);
    expect(
      selectDispatchPlan(
        [task("four")],
        [assignment("a"), assignment("b")],
        new Set(),
        3,
        1,
      )[0].assignment.id,
    ).toBe("b");
  });

  function attempt(
    taskId: string,
    assignmentId: string | null,
    outcome: string | null = "failed",
  ) {
    return {
      id: `attempt-${taskId}-${assignmentId}`,
      task_id: taskId,
      agent_assignment_id: assignmentId,
      agent_session_id: null,
      attempt_number: 1,
      outcome,
      started_at: 1,
      ended_at: 2,
    };
  }

  it("routes a retry to an agent the task has not already been through", () => {
    const plans = selectDispatchPlan(
      [task("one")],
      [assignment("a"), assignment("b")],
      new Set(),
      3,
      0,
      [attempt("one", "a")],
    );
    // Round-robin would hand it back to "a"; the failed agent is skipped.
    expect(plans[0].assignment.id).toBe("b");
  });

  it("falls back to the full rotation once every agent has been tried", () => {
    const plans = selectDispatchPlan(
      [task("one")],
      [assignment("a"), assignment("b")],
      new Set(),
      3,
      0,
      [attempt("one", "a"), attempt("one", "b")],
    );
    expect(["a", "b"]).toContain(plans[0].assignment.id);
  });

  it("keeps one task's history from steering another task", () => {
    const plans = selectDispatchPlan(
      [task("one"), task("two")],
      [assignment("a"), assignment("b")],
      new Set(),
      3,
      0,
      [attempt("one", "a")],
    );
    const byTask = new Map(plans.map((plan) => [plan.task.id, plan.assignment.id]));
    expect(byTask.get("one")).toBe("b");
    // "two" has no history, so it keeps its place in the rotation.
    expect(byTask.get("two")).toBe("b");
  });

  it("dispatches a provisioned task from its active lease root", () => {
    const snapshot = {
      run: { root_path: "/project" },
      leases: [
        {
          task_id: "one",
          root_path: "/isolated/task-one",
          state: "active",
        },
      ],
    } as RunSnapshot;

    expect(taskWorkspaceRoot(snapshot, "one", "/fallback")).toBe(
      "/isolated/task-one",
    );
    expect(taskWorkspaceRoot(snapshot, "two", "/fallback")).toBe("/project");
  });

  it("passes pinned model and permission choices into local session startup", () => {
    const configured = {
      ...assignment("configured"),
      model_id: "model-pinned",
      permission_mode: "ask",
    };

    expect(
      assignmentSessionOptions(configured, "session-1", "Inspect records"),
    ).toEqual({
      localSessionId: "session-1",
      conversationTitle: "Inspect records",
      initialModelId: "model-pinned",
      initialPermissionMode: "ask",
    });
  });
});
