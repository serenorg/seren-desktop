// ABOUTME: Reactive Mission Control state for durable runs, findings, and coverage.
// ABOUTME: It keeps IPC in the run service and turns ordered events into a stable UI model.

import { createStore } from "solid-js/store";
import {
  type FindingStatus,
  type RunEvent,
  type RunSnapshot,
  runCancel,
  runCreate,
  runGetState,
  runRelaunch,
  runUpdateFindingStatus,
  type Task,
} from "@/services/run";

export interface RunLanes {
  queued: Task[];
  working: Task[];
  review: Task[];
  done: Task[];
}

export interface RunStoreState {
  activeRunId: string | null;
  snapshot: RunSnapshot | null;
  lastSequence: number;
  launchPending: boolean;
  error: string | null;
}

const INITIAL_STATE: RunStoreState = {
  activeRunId: null,
  snapshot: null,
  lastSequence: 0,
  launchPending: false,
  error: null,
};

const [state, setState] = createStore<RunStoreState>(INITIAL_STATE);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyTaskState(event: RunEvent): void {
  const taskId = event.task_id;
  const nextState = event.payload.state;
  if (!taskId || typeof nextState !== "string") return;
  setState("snapshot", "tasks", (tasks) =>
    tasks.map((task) =>
      task.id === taskId
        ? { ...task, state: nextState as Task["state"] }
        : task,
    ),
  );
}

function applyFindingStatus(event: RunEvent): void {
  const findingId = event.payload.finding_id;
  const status = event.payload.status;
  if (typeof findingId !== "string" || typeof status !== "string") return;
  setState("snapshot", "findings", (findings) =>
    findings.map((finding) =>
      finding.id === findingId
        ? {
            ...finding,
            status: status as FindingStatus,
            needs_approval: status === "open" ? finding.needs_approval : false,
          }
        : finding,
    ),
  );
}

async function hydrate(runId: string): Promise<void> {
  setState("error", null);
  try {
    const snapshot = await runGetState(runId);
    setState({
      activeRunId: runId,
      snapshot,
      lastSequence: 0,
    });
  } catch (error) {
    setState("error", errorMessage(error));
  }
}

async function applyEvent(event: RunEvent): Promise<void> {
  if (state.activeRunId && event.run_id !== state.activeRunId) return;
  if (event.sequence <= state.lastSequence) return;

  if (event.sequence - state.lastSequence > 1) {
    await hydrate(event.run_id);
    setState("lastSequence", event.sequence);
    return;
  }

  if (!state.activeRunId) setState("activeRunId", event.run_id);
  if (!state.snapshot && event.event_type !== "run_created") {
    await hydrate(event.run_id);
  } else if (event.event_type === "task_state_changed") {
    applyTaskState(event);
  } else if (event.event_type === "finding_status_changed") {
    applyFindingStatus(event);
  } else if (
    event.event_type === "finding_recorded" ||
    event.event_type === "coverage_gap_recorded" ||
    event.event_type === "check_declared" ||
    event.event_type === "check_approved" ||
    event.event_type === "check_result_recorded" ||
    event.event_type === "run_created" ||
    event.event_type === "task_added" ||
    event.event_type === "assignment_added"
  ) {
    await hydrate(event.run_id);
  } else if (
    event.event_type === "run_interrupted" ||
    event.event_type === "run_relaunched" ||
    event.event_type === "attempt_started" ||
    event.event_type === "attempt_finished"
  ) {
    await hydrate(event.run_id);
  }
  setState("lastSequence", event.sequence);
}

async function launch(
  objective: string,
  rootPath?: string | null,
): Promise<void> {
  const trimmedObjective = objective.trim();
  if (!trimmedObjective) {
    setState("error", "Tell Seren what to investigate first.");
    return;
  }
  setState({ launchPending: true, error: null });
  try {
    const run = await runCreate(trimmedObjective, rootPath);
    setState("activeRunId", run.id);
    await hydrate(run.id);
  } catch (error) {
    setState("error", errorMessage(error));
  } finally {
    setState("launchPending", false);
  }
}

async function cancel(): Promise<void> {
  if (!state.activeRunId) return;
  try {
    const run = await runCancel(state.activeRunId);
    setState("snapshot", "run", run);
  } catch (error) {
    setState("error", errorMessage(error));
  }
}

async function relaunch(): Promise<void> {
  if (!state.activeRunId) return;
  try {
    const run = await runRelaunch(state.activeRunId);
    setState("snapshot", "run", run);
  } catch (error) {
    setState("error", errorMessage(error));
  }
}

async function setFindingStatus(
  findingId: string,
  status: Exclude<FindingStatus, "open">,
): Promise<void> {
  if (!state.activeRunId) return;
  try {
    await runUpdateFindingStatus(state.activeRunId, findingId, status);
    setState("snapshot", "findings", (findings) =>
      findings.map((finding) =>
        finding.id === findingId
          ? { ...finding, status, needs_approval: false }
          : finding,
      ),
    );
  } catch (error) {
    setState("error", errorMessage(error));
  }
}

function needsYou() {
  return (state.snapshot?.findings ?? []).filter(
    (finding) => finding.needs_approval && finding.status === "open",
  );
}

function lanes(): RunLanes {
  const result: RunLanes = { queued: [], working: [], review: [], done: [] };
  for (const task of state.snapshot?.tasks ?? []) {
    if (
      ["provisioning", "running", "blocked", "verifying"].includes(task.state)
    ) {
      result.working.push(task);
    } else if (task.state === "review") {
      result.review.push(task);
    } else if (["done", "failed", "cancelled"].includes(task.state)) {
      result.done.push(task);
    } else {
      result.queued.push(task);
    }
  }
  return result;
}

export const runStore = {
  get activeRunId() {
    return state.activeRunId;
  },
  get snapshot() {
    return state.snapshot;
  },
  get lastSequence() {
    return state.lastSequence;
  },
  get launchPending() {
    return state.launchPending;
  },
  get error() {
    return state.error;
  },
  hydrate,
  applyEvent,
  launch,
  cancel,
  relaunch,
  approveFinding: (findingId: string) =>
    setFindingStatus(findingId, "accepted"),
  rejectFinding: (findingId: string) => setFindingStatus(findingId, "rejected"),
  needsYou,
  lanes,
  findingsCount: () => state.snapshot?.findings.length ?? 0,
  coverageGaps: () => state.snapshot?.coverage_gaps ?? [],
  isInterrupted: () => state.snapshot?.run.status === "interrupted",
};

export async function launchMission(objective: string): Promise<void> {
  await runStore.launch(objective);
}

export { INITIAL_STATE, setState as setRunState, state as runState };
