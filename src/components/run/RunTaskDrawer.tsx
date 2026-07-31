// ABOUTME: Task detail drawer with durable state, blockers, attempts, and session activity.
// ABOUTME: Reuses the existing session timeline instead of introducing a second transcript renderer.

import { type Component, createEffect, Show } from "solid-js";
import { SessionTimeline } from "@/components/session/SessionTimeline";
import type { Task } from "@/services/run";
import { runStore } from "@/stores/run.store";
import { sessionStore } from "@/stores/session.store";

export interface RunTaskDrawerProps {
  task: Task;
  onClose: () => void;
}

export const RunTaskDrawer: Component<RunTaskDrawerProps> = (props) => {
  const attempt = () =>
    runStore.snapshot?.attempts.find((item) => item.task_id === props.task.id);
  const sessionId = () => attempt()?.agent_session_id ?? null;

  createEffect(() => {
    const id = sessionId();
    if (id) void sessionStore.loadEvents(id);
  });

  return (
    <div class="fixed inset-y-0 right-0 z-[70] flex w-full max-w-xl flex-col border-l border-border/80 bg-slate-950 shadow-[-20px_0_80px_rgba(2,8,23,0.45)]">
      <div class="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div>
          <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">
            Task detail
          </div>
          <h2 class="mt-1 text-base font-medium text-foreground">
            {props.task.title}
          </h2>
        </div>
        <button
          type="button"
          class="text-xs text-muted-foreground hover:text-foreground"
          onClick={props.onClose}
        >
          Close
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div class="flex items-center justify-between rounded-xl border border-border/60 bg-slate-900/60 px-4 py-3">
          <span class="text-xs text-muted-foreground">State</span>
          <span class="font-mono text-xs text-cyan-100">
            {props.task.state}
          </span>
        </div>
        <Show when={props.task.blocked_reason}>
          <div class="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs leading-5 text-amber-100">
            {props.task.blocked_reason}
          </div>
        </Show>
        <div class="mt-5">
          <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Brief
          </div>
          <p class="m-0 text-sm leading-6 text-foreground/85">
            {props.task.brief}
          </p>
        </div>
        <div class="mt-5">
          <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Agent activity
          </div>
          <Show
            when={sessionId()}
            fallback={
              <div class="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">
                No live session is attached yet.
              </div>
            }
          >
            {(id) => (
              <div class="rounded-xl border border-border/60 bg-slate-900/50 px-3 py-3">
                <SessionTimeline events={sessionStore.getEventsFor(id())} />
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
};
