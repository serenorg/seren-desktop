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
  selectDispatchPlan,
  selectReadyTasks,
} from "@/services/run-dispatcher";
import type { AgentAssignment, Task } from "@/services/run";

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
});
