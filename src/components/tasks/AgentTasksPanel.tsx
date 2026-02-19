// ABOUTME: Slide panel for viewing and managing cloud agent tasks.
// ABOUTME: Shows task list with real-time streaming, run agent form, and task details.

import {
  type Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getDefaultOrganizationId } from "@/lib/tauri-bridge";
import {
  agentTasksState,
  cancelTask,
  followTask,
  getEventsForTask,
  loadTasks,
  runAgent,
  stopFollowing,
} from "@/stores/agent-tasks.store";
import { AgentTaskItem } from "./AgentTaskItem";

interface AgentTasksPanelProps {
  onClose?: () => void;
}

export const AgentTasksPanel: Component<AgentTasksPanelProps> = (props) => {
  const [publisherSlug, setPublisherSlug] = createSignal("");
  const [messageText, setMessageText] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [orgId, setOrgId] = createSignal("");

  // Load org ID and tasks on mount
  onMount(async () => {
    const id = await getDefaultOrganizationId();
    if (id) {
      setOrgId(id);
      loadTasks(id);
    }
  });

  // Cleanup stream on unmount
  onCleanup(() => {
    stopFollowing();
  });

  const handleRunAgent = async (e: Event) => {
    e.preventDefault();
    const slug = publisherSlug().trim();
    const msg = messageText().trim();
    if (!slug || !msg || !orgId()) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg);
      } catch {
        // Wrap plain text in a text message
        parsed = { text: msg };
      }
      await runAgent(orgId(), slug, parsed);
      setMessageText("");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSelectTask = (taskId: string) => {
    if (orgId()) {
      followTask(orgId(), taskId);
    }
  };

  const handleCancelTask = (taskId: string) => {
    if (orgId()) {
      cancelTask(orgId(), taskId);
    }
  };

  const activeTasks = () =>
    agentTasksState.tasks.filter(
      (t) => !["completed", "failed", "canceled"].includes(t.status),
    );

  const completedTasks = () =>
    agentTasksState.tasks.filter((t) =>
      ["completed", "failed", "canceled"].includes(t.status),
    );

  return (
    <div class="flex flex-col h-full bg-background">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-3 border-b border-border">
        <div class="flex items-center gap-2">
          <svg
            class="w-4 h-4 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <title>Agent Tasks</title>
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <h2 class="text-sm font-semibold text-foreground m-0">Agent Tasks</h2>
          <Show when={activeTasks().length > 0}>
            <span class="px-1.5 py-0.5 bg-primary/20 text-primary text-[10px] font-bold rounded-full min-w-[18px] text-center">
              {activeTasks().length}
            </span>
          </Show>
        </div>
        <Show when={props.onClose}>
          <button
            type="button"
            class="p-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={props.onClose}
          >
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>Close panel</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </Show>
      </div>

      {/* Run Agent Form */}
      <form
        class="px-4 py-3 border-b border-border/50 bg-surface-0"
        onSubmit={handleRunAgent}
      >
        <div class="flex gap-2 mb-2">
          <input
            type="text"
            placeholder="Publisher slug"
            value={publisherSlug()}
            onInput={(e) => setPublisherSlug(e.currentTarget.value)}
            class="flex-1 px-2.5 py-1.5 bg-surface-2 border border-border rounded text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition-colors"
          />
          <button
            type="submit"
            disabled={
              isSubmitting() || !publisherSlug().trim() || !messageText().trim()
            }
            class="px-3 py-1.5 bg-primary text-background text-[12px] font-semibold rounded hover:bg-primary/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting() ? "..." : "Run"}
          </button>
        </div>
        <textarea
          placeholder="Message (JSON or plain text)"
          value={messageText()}
          onInput={(e) => setMessageText(e.currentTarget.value)}
          class="w-full px-2.5 py-2 bg-surface-2 border border-border rounded text-[12px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition-colors resize-none font-mono leading-relaxed"
          rows={2}
        />
        <Show when={submitError()}>
          <div class="mt-1.5 px-2 py-1 bg-red-950/30 border border-red-400/20 rounded text-[11px] text-red-400">
            {submitError()}
          </div>
        </Show>
      </form>

      {/* Task List */}
      <div class="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-surface-3 [&::-webkit-scrollbar-thumb]:rounded">
        <Show when={agentTasksState.isLoading}>
          <div class="flex items-center justify-center py-8">
            <div class="flex items-center gap-2 text-muted-foreground text-sm">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <title>Loading spinner</title>
                <circle
                  class="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  stroke-width="4"
                />
                <path
                  class="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Loading tasks...
            </div>
          </div>
        </Show>

        <Show when={agentTasksState.error}>
          <div class="mx-4 mt-3 px-3 py-2 bg-red-950/20 border border-red-400/20 rounded text-[12px] text-red-400">
            {agentTasksState.error}
          </div>
        </Show>

        <Show
          when={
            !agentTasksState.isLoading &&
            agentTasksState.tasks.length === 0 &&
            !agentTasksState.error
          }
        >
          <div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <svg
              class="w-10 h-10 mb-3 opacity-30"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>No tasks</title>
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p class="text-[13px] m-0">No tasks yet</p>
            <p class="text-[11px] mt-1 m-0 opacity-60">
              Run an agent above to create a task
            </p>
          </div>
        </Show>

        {/* Active Tasks */}
        <Show when={activeTasks().length > 0}>
          <div class="px-3 pt-3 pb-1">
            <div class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Active
            </div>
          </div>
          <For each={activeTasks()}>
            {(task) => (
              <AgentTaskItem
                task={task}
                isActive={agentTasksState.activeTaskId === task.id}
                events={getEventsForTask(task.id)}
                onSelect={handleSelectTask}
                onCancel={handleCancelTask}
              />
            )}
          </For>
        </Show>

        {/* Completed Tasks */}
        <Show when={completedTasks().length > 0}>
          <div class="px-3 pt-3 pb-1">
            <div class="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              History
            </div>
          </div>
          <For each={completedTasks()}>
            {(task) => (
              <AgentTaskItem
                task={task}
                isActive={agentTasksState.activeTaskId === task.id}
                events={getEventsForTask(task.id)}
                onSelect={handleSelectTask}
                onCancel={handleCancelTask}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};
