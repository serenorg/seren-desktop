// ABOUTME: First-run Mission Control launch surface for a plain-language objective.
// ABOUTME: Keeps the safety boundary visible before a durable run is created.

import { type Component, createSignal, Show } from "solid-js";
import { launchMission, runStore } from "@/stores/run.store";

export interface RunLaunchBoxProps {
  onStarted?: () => void;
}

export const RunLaunchBox: Component<RunLaunchBoxProps> = (props) => {
  const [objective, setObjective] = createSignal("");

  const start = async () => {
    const value = objective().trim();
    if (!value) return;
    await launchMission(value);
    props.onStarted?.();
  };

  return (
    <div class="mx-auto flex w-full max-w-2xl flex-col justify-center px-8 py-12">
      <div class="mb-8">
        <div class="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/75">
          <span class="h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.85)]" />
          Mission control
        </div>
        <h1 class="m-0 text-3xl font-semibold tracking-[-0.04em] text-foreground">
          What should Seren investigate?
        </h1>
        <p class="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          Give the team a question with a useful finish line. Seren will keep
          work, evidence, and anything needing your approval in one place.
        </p>
      </div>

      <div class="rounded-2xl border border-cyan-300/20 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.13),transparent_42%),rgba(15,23,42,0.7)] p-5 shadow-[0_24px_80px_rgba(2,8,23,0.35)]">
        <label
          for="mission-objective"
          class="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
        >
          Objective
        </label>
        <textarea
          id="mission-objective"
          rows="4"
          value={objective()}
          onInput={(event) => setObjective(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              void start();
            }
          }}
          placeholder="Example: Find the source of the billing mismatch and prepare a reviewable reply."
          class="w-full resize-none rounded-xl border border-border/80 bg-slate-950/45 px-4 py-3 text-sm leading-6 text-foreground outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
        />

        <div class="mt-5 grid gap-4 border-t border-border/50 pt-4 sm:grid-cols-2">
          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300/80">
              Seren will
            </div>
            <ul class="m-0 space-y-2 p-0 text-xs leading-5 text-muted-foreground">
              <li>Break the objective into observable work.</li>
              <li>Show evidence and coverage gaps as they appear.</li>
              <li>Pause before anything external is sent or changed.</li>
            </ul>
          </div>
          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-300/80">
              It will not
            </div>
            <ul class="m-0 space-y-2 p-0 text-xs leading-5 text-muted-foreground">
              <li>Invent evidence for a blocked source.</li>
              <li>Hide a failed check behind a green status.</li>
              <li>Send a draft without your approval.</li>
            </ul>
          </div>
        </div>

        <details class="mt-5 border-t border-border/50 pt-4">
          <summary class="cursor-pointer text-xs font-medium text-muted-foreground transition hover:text-foreground">
            Advanced controls
          </summary>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <div class="rounded-lg border border-border/50 bg-slate-950/25 px-3 py-2 text-xs text-muted-foreground">
              Models <span class="float-right text-foreground/70">Auto</span>
            </div>
            <div class="rounded-lg border border-border/50 bg-slate-950/25 px-3 py-2 text-xs text-muted-foreground">
              Isolation{" "}
              <span class="float-right text-foreground/70">Workspace</span>
            </div>
            <div class="rounded-lg border border-border/50 bg-slate-950/25 px-3 py-2 text-xs text-muted-foreground">
              Budget <span class="float-right text-foreground/70">Guarded</span>
            </div>
            <div class="rounded-lg border border-border/50 bg-slate-950/25 px-3 py-2 text-xs text-muted-foreground">
              Permissions{" "}
              <span class="float-right text-foreground/70">Review first</span>
            </div>
          </div>
        </details>

        <div class="mt-5 flex items-center justify-between gap-3">
          <span class="text-[11px] text-muted-foreground/70">
            ⌘/Ctrl + Enter to start
          </span>
          <button
            type="button"
            onClick={() => void start()}
            disabled={!objective().trim() || runStore.launchPending}
            class="rounded-lg bg-cyan-300 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {runStore.launchPending ? "Starting…" : "Start mission"}
          </button>
        </div>
        <Show when={runStore.error}>
          <div class="mt-3 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            {runStore.error}
          </div>
        </Show>
      </div>
    </div>
  );
};
