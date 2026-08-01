// ABOUTME: Reactive Mission Control state for durable runs, findings, and coverage.
// ABOUTME: It keeps IPC in the run service and turns ordered events into a stable UI model.

import { createStore } from "solid-js/store";
import {
  type FindingStatus,
  type Run,
  type RunEvent,
  type RunSnapshot,
  runAddAgent,
  runAddTask,
  runCancel,
  runCreate,
  runGetState,
  runList,
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

export interface LaunchTaskInput {
  title: string;
  brief: string;
}

export interface LaunchOptions {
  objective: string;
  rootPath?: string | null;
  tasks: LaunchTaskInput[];
  agents: string[];
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

async function hydrateLatest(): Promise<void> {
  setState("error", null);
  try {
    const latest = (await runList())
      .filter((run) => run.status === "running" || run.status === "interrupted")
      .reduce<Run | null>(
        (current, candidate) =>
          current === null || candidate.created_at > current.created_at
            ? candidate
            : current,
        null,
      );

    if (latest) {
      await hydrate(latest.id);
      return;
    }

    setState({ activeRunId: null, snapshot: null, lastSequence: 0 });
  } catch (error) {
    setState("error", errorMessage(error));
  }
}

// Events are applied one at a time. Each handler may await a hydrate, and two
// interleaved hydrates can finish out of order — writing back a lower sequence
// and an older snapshot over a newer one.
let applyQueue: Promise<void> = Promise.resolve();

function enqueueEvent(event: RunEvent): Promise<void> {
  applyQueue = applyQueue.then(() => applyEvent(event)).catch(() => {});
  return applyQueue;
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
    event.event_type === "run_finalized" ||
    event.event_type === "attempt_started" ||
    event.event_type === "attempt_finished"
  ) {
    await hydrate(event.run_id);
  }
  setState("lastSequence", event.sequence);
}

const OBJECTIVE_TASK_TITLE_MAX = 80;

export function objectiveTaskTitle(objective: string): string {
  const collapsed = objective.trim().replace(/\s+/g, " ");
  if (collapsed.length <= OBJECTIVE_TASK_TITLE_MAX) return collapsed;
  const head = collapsed.slice(0, OBJECTIVE_TASK_TITLE_MAX);
  const lastSpace = head.lastIndexOf(" ");
  return `${lastSpace > 20 ? head.slice(0, lastSpace) : head}…`;
}

async function launch(options: LaunchOptions): Promise<void> {
  const trimmedObjective = options.objective.trim();
  if (!trimmedObjective) {
    setState("error", "Tell Seren what to investigate first.");
    return;
  }
  setState({ launchPending: true, error: null });
  try {
    const run = await runCreate(trimmedObjective, options.rootPath ?? null);
    for (const agentType of options.agents) {
      await runAddAgent(run.id, agentType);
    }
    let taskCount = 0;
    for (const task of options.tasks) {
      const title = task.title.trim();
      if (!title) continue;
      await runAddTask(run.id, title, task.brief.trim());
      taskCount += 1;
    }
    // Task slots live behind Advanced controls, so the primary flow is an
    // objective on its own. Without a task there is nothing to dispatch and the
    // run sits at "running" with empty lanes forever, so the objective itself
    // becomes the work.
    if (taskCount === 0) {
      await runAddTask(run.id, objectiveTaskTitle(trimmedObjective), trimmedObjective);
    }
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
  hydrateLatest,
  applyEvent: enqueueEvent,
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

export async function launchMission(options: LaunchOptions): Promise<void> {
  await runStore.launch(options);
}

export { INITIAL_STATE, setState as setRunState, state as runState };
