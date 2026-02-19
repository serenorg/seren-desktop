// ABOUTME: Agent tasks store for managing cloud agent task state.
// ABOUTME: Provides reactive task list, active task tracking, and SSE streaming.

import { createStore } from "solid-js/store";
import {
  type AgentTask,
  type AgentTaskStatus,
  cancelAgentTask,
  getAgentTask,
  isTerminalStatus,
  listAgentTasks,
  runAgentCloud,
  streamTask,
} from "@/services/agent-tasks";

/** A streaming event received via SSE for display in the live log. */
export interface StreamEvent {
  eventType: string;
  data: Record<string, unknown>;
  receivedAt: number;
}

interface AgentTasksState {
  tasks: AgentTask[];
  activeTaskId: string | null;
  /** Per-task accumulated streaming events, keyed by task ID. */
  taskEvents: Record<string, StreamEvent[]>;
  isLoading: boolean;
  error: string | null;
  total: number;
  offset: number;
  limit: number;
}

const initialState: AgentTasksState = {
  tasks: [],
  activeTaskId: null,
  taskEvents: {},
  isLoading: false,
  error: null,
  total: 0,
  offset: 0,
  limit: 20,
};

const [state, setState] = createStore<AgentTasksState>(initialState);

// Active stream handle for cleanup
let activeStream: { close: () => void } | null = null;

/**
 * Load tasks for an organization.
 */
async function loadTasks(orgId: string): Promise<void> {
  setState("isLoading", true);
  setState("error", null);
  try {
    const tasks = await listAgentTasks(orgId, state.limit, state.offset);
    setState("tasks", tasks);
  } catch (err) {
    setState("error", err instanceof Error ? err.message : String(err));
  } finally {
    setState("isLoading", false);
  }
}

/**
 * Run an agent and track the resulting task.
 */
async function runAgent(
  orgId: string,
  publisherSlug: string,
  message: unknown,
): Promise<AgentTask> {
  setState("error", null);
  const task = await runAgentCloud(publisherSlug, message);
  // Prepend to task list
  setState("tasks", (prev) => [task, ...prev]);
  setState("activeTaskId", task.id);
  // Start streaming updates
  followTask(orgId, task.id);
  return task;
}

/**
 * Start streaming updates for a task.
 */
function followTask(orgId: string, taskId: string): void {
  // Close any existing stream
  stopFollowing();

  setState("activeTaskId", taskId);

  // Initialize event log for this task
  setState("taskEvents", taskId, []);

  activeStream = streamTask(orgId, taskId, {
    onEvent: (eventType, data) => {
      // Accumulate event for live log display
      setState("taskEvents", taskId, (prev) => [
        ...(prev ?? []),
        { eventType, data, receivedAt: Date.now() },
      ]);
      // Update the task in the list if we get status info
      if (data.status) {
        updateTaskInList(taskId, {
          status: data.status as AgentTaskStatus,
        });
      }
    },
    onComplete: (taskData) => {
      updateTaskInList(taskId, {
        status: (taskData.status as AgentTaskStatus) ?? "completed",
        output: taskData.output as Record<string, unknown> | undefined,
        error_message: taskData.error_message as string | undefined,
        cost_total_atomic: taskData.cost_total_atomic as number | undefined,
      });
      activeStream = null;
    },
    onError: (error) => {
      console.error("[AgentTasks] Stream error:", error);
      activeStream = null;
      // Fallback: poll the task once
      refreshTask(orgId, taskId);
    },
  });
}

/**
 * Stop following the current task stream.
 */
function stopFollowing(): void {
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }
}

/**
 * Refresh a single task from the API.
 */
async function refreshTask(orgId: string, taskId: string): Promise<void> {
  try {
    const task = await getAgentTask(orgId, taskId);
    updateTaskInList(taskId, task);
  } catch (err) {
    console.error("[AgentTasks] Failed to refresh task:", err);
  }
}

/**
 * Cancel a task.
 */
async function cancelTask(orgId: string, taskId: string): Promise<void> {
  try {
    const task = await cancelAgentTask(orgId, taskId);
    updateTaskInList(taskId, task);
    if (state.activeTaskId === taskId) {
      stopFollowing();
    }
  } catch (err) {
    setState("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Update a task in the list by ID.
 */
function updateTaskInList(taskId: string, updates: Partial<AgentTask>): void {
  setState(
    "tasks",
    (task) => task.id === taskId,
    (prev) => ({ ...prev, ...updates }),
  );
}

/**
 * Get the currently active task.
 */
function getActiveTask(): AgentTask | undefined {
  if (!state.activeTaskId) return undefined;
  return state.tasks.find((t) => t.id === state.activeTaskId);
}

/**
 * Get accumulated streaming events for a task.
 */
function getEventsForTask(taskId: string): StreamEvent[] {
  return state.taskEvents[taskId] ?? [];
}

/**
 * Reset store state (e.g., on logout).
 */
function resetAgentTasksState(): void {
  stopFollowing();
  setState(initialState);
}

export {
  state as agentTasksState,
  loadTasks,
  runAgent,
  followTask,
  stopFollowing,
  refreshTask,
  cancelTask,
  getActiveTask,
  getEventsForTask,
  resetAgentTasksState,
  isTerminalStatus,
};
