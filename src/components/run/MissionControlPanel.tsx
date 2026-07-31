// ABOUTME: Mission Control shell for launching a run and reviewing its evidence.
// ABOUTME: Header, tabs, and coverage stay fixed while only the active body scrolls.

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  type Component,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { RunArtifactReview } from "@/components/run/RunArtifactReview";
import { RunFindings } from "@/components/run/RunFindings";
import { RunLaunchBox } from "@/components/run/RunLaunchBox";
import { RunOverview } from "@/components/run/RunOverview";
import { RunTaskDrawer } from "@/components/run/RunTaskDrawer";
import { type Finding, subscribeRunEvents, type Task } from "@/services/run";
import { runStore } from "@/stores/run.store";

export const MissionControlPanel: Component = () => {
  const [tab, setTab] = createSignal<"overview" | "findings">("overview");
  const [reviewFinding, setReviewFinding] = createSignal<Finding | null>(null);
  const [selectedTask, setSelectedTask] = createSignal<Task | null>(null);
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  onMount(() => {
    const subscription = subscribeRunEvents((event) => {
      void runStore.applyEvent(event);
    });
    void subscription.then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
  });

  onCleanup(() => {
    disposed = true;
    unlisten?.();
  });

  const statusLabel = () => runStore.snapshot?.run.status ?? "ready";
  const agentCount = () => runStore.snapshot?.assignments.length ?? 0;
  const findingsCount = () => runStore.findingsCount();

  return (
    <div class="relative flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.08),transparent_35%),#080d18] text-foreground">
      <Show when={runStore.snapshot} fallback={<RunLaunchBox />}>
        <div class="flex h-full min-h-0 flex-col">
          <header class="shrink-0 border-b border-border/70 px-5 pb-3 pt-5 lg:px-6">
            <div class="flex items-start justify-between gap-5">
              <div class="min-w-0">
                <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.19em] text-cyan-200/80">
                  <span class="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.85)]" />
                  Run · {statusLabel()}
                </div>
                <h1 class="mt-2 truncate text-xl font-semibold tracking-[-0.03em] text-foreground">
                  {runStore.snapshot?.run.objective}
                </h1>
              </div>
              <div class="flex shrink-0 items-center gap-4">
                <div class="hidden text-right sm:block">
                  <div class="font-mono text-sm text-foreground">
                    {agentCount()}
                  </div>
                  <div class="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    Agents
                  </div>
                </div>
                <div class="hidden text-right sm:block">
                  <div class="font-mono text-sm text-foreground">
                    {findingsCount()}
                  </div>
                  <div class="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    Findings
                  </div>
                </div>
                <button
                  type="button"
                  class="rounded-lg border border-red-300/25 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-300/10"
                  onClick={() => void runStore.cancel()}
                  disabled={statusLabel() !== "running"}
                >
                  Stop
                </button>
              </div>
            </div>
            <nav
              class="mt-5 flex items-center gap-5"
              aria-label="Mission Control views"
            >
              <button
                type="button"
                class={`border-b-2 pb-2 text-xs font-medium ${tab() === "overview" ? "border-cyan-300 text-cyan-100" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => setTab("overview")}
              >
                Overview
              </button>
              <button
                type="button"
                class={`border-b-2 pb-2 text-xs font-medium ${tab() === "findings" ? "border-cyan-300 text-cyan-100" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => setTab("findings")}
              >
                Findings{" "}
                <span class="ml-1 font-mono text-[10px] text-amber-200">
                  {findingsCount()}
                </span>
              </button>
            </nav>
          </header>

          <div class="min-h-0 flex-1 overflow-hidden">
            <Show when={tab() === "overview"}>
              <div class="h-full min-h-0 overflow-y-auto">
                <RunOverview
                  onReview={setReviewFinding}
                  onTaskSelect={setSelectedTask}
                />
              </div>
            </Show>
            <Show when={tab() === "findings"}>
              <RunFindings onReview={setReviewFinding} />
            </Show>
          </div>
        </div>
      </Show>

      <Show when={reviewFinding()}>
        {(finding) => (
          <RunArtifactReview
            finding={finding()}
            onClose={() => setReviewFinding(null)}
          />
        )}
      </Show>
      <Show when={selectedTask()}>
        {(task) => (
          <RunTaskDrawer task={task()} onClose={() => setSelectedTask(null)} />
        )}
      </Show>
    </div>
  );
};
