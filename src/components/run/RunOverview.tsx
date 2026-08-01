// ABOUTME: Overview lane view for work in progress, blocked tasks, and completed work.
// ABOUTME: It turns the durable run snapshot into a compact operator briefing.

import { type Component, For, Show } from "solid-js";
import type { Finding, Task } from "@/services/run";
import { runStore } from "@/stores/run.store";

export interface RunOverviewProps {
  onReview: (finding: Finding) => void;
  onTaskSelect: (task: Task) => void;
}

const laneMeta = {
  working: { label: "Working", tone: "text-cyan-200", marker: "bg-cyan-300" },
  review: { label: "Review", tone: "text-amber-200", marker: "bg-amber-300" },
  done: { label: "Done", tone: "text-emerald-200", marker: "bg-emerald-300" },
};

export const RunOverview: Component<RunOverviewProps> = (props) => {
  const assignmentLabel = () => {
    const assignment = runStore.snapshot?.assignments[0];
    return assignment?.role_label ?? assignment?.agent_type ?? "Seren team";
  };

  const taskCard = (task: Task) => (
    <button
      type="button"
      class="group w-full rounded-xl border border-border/70 bg-slate-900/55 p-4 text-left transition hover:-translate-y-0.5 hover:border-cyan-300/35 hover:bg-slate-900"
      onClick={() => props.onTaskSelect(task)}
    >
      <div class="flex items-center justify-between gap-3">
        <span class="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {assignmentLabel()}
        </span>
        <span class="font-mono text-[10px] text-muted-foreground/70">
          {task.state}
        </span>
      </div>
      <div class="mt-2 text-sm font-medium leading-5 text-foreground group-hover:text-cyan-100">
        {task.title}
      </div>
      <div class="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
        {task.brief}
      </div>
      <Show when={task.blocked_reason}>
        <div class="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs leading-5 text-amber-100">
          {task.blocked_reason}
        </div>
      </Show>
      <div class="mt-3 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
        Open task detail →
      </div>
    </button>
  );

  return (
    <div class="space-y-6 p-5 lg:p-6">
      <Show when={runStore.needsYou()[0]}>
        {(finding) => (
          <div class="flex items-center justify-between gap-4 rounded-xl border border-amber-300/50 bg-amber-300/[0.08] p-4 shadow-[0_0_36px_rgba(251,191,36,0.06)]">
            <div class="min-w-0">
              <div class="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-200">
                Needs you
              </div>
              <div class="mt-1 truncate text-sm font-medium text-foreground">
                {finding().claim}
              </div>
              <div class="mt-1 text-xs text-muted-foreground">
                A proposed artifact is waiting. Nothing sends until you approve
                it.
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-200"
              onClick={() => props.onReview(finding())}
            >
              Review artifact →
            </button>
          </div>
        )}
      </Show>

      <div>
        <div class="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          <span class="h-1.5 w-1.5 rounded-full bg-cyan-300" />
          What the team is doing
        </div>
        <div class="grid gap-4 xl:grid-cols-3">
          <For each={["working", "review", "done"] as const}>
            {(lane) => {
              const meta = laneMeta[lane];
              const tasks = () => runStore.lanes()[lane];
              return (
                <section class="min-w-0 rounded-xl border border-border/70 bg-slate-950/25 p-3">
                  <div class="mb-3 flex items-center justify-between px-1">
                    <div
                      class={`flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] ${meta.tone}`}
                    >
                      <span class={`h-1.5 w-1.5 rounded-full ${meta.marker}`} />
                      {meta.label}
                    </div>
                    <span class="font-mono text-[10px] text-muted-foreground">
                      {tasks().length}
                    </span>
                  </div>
                  <div class="space-y-3">
                    <For
                      each={tasks()}
                      fallback={
                        <div class="px-1 py-5 text-xs text-muted-foreground/60">
                          Nothing here yet.
                        </div>
                      }
                    >
                      {taskCard}
                    </For>
                  </div>
                </section>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
};
