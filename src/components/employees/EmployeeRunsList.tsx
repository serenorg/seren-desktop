// ABOUTME: Recent-runs section for the employee detail pane.
// ABOUTME: Lists the deployment's most recent runs with status, source, output preview.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { EmployeeRunDetailModal } from "@/components/employees/EmployeeRunDetailModal";
import { formatMicrosUsd } from "@/lib/employees/spend";
import type { EmployeeRun } from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";

interface EmployeeRunsListProps {
  employeeId: string;
  limit?: number;
  /** Bumped by the parent to force a refetch after a manual run finishes. */
  refreshNonce?: number;
}

const FAILURE_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "timeout",
  "blocked",
  "error",
]);

function statusPillClass(status: string): string {
  if (status === "completed")
    return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (status === "running" || status === "queued")
    return "bg-sky-500/15 text-sky-300 border-sky-500/30";
  if (status === "awaiting_approval")
    return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  if (FAILURE_STATUSES.has(status))
    return "bg-red-500/15 text-red-400 border-red-500/30";
  return "bg-slate-500/15 text-slate-300 border-slate-500/30";
}

function statusLabel(status: string): string {
  if (status === "completed") return "Completed";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "awaiting_approval") return "Awaiting approval";
  if (status === "failed") return "Failed";
  if (status === "cancelled" || status === "canceled") return "Cancelled";
  if (status === "timeout") return "Timed out";
  if (status === "blocked") return "Blocked";
  if (status === "error") return "Error";
  return status;
}

function sourceLabel(source: string): string {
  if (source === "scheduler") return "Scheduled";
  if (source === "ui") return "Manual";
  if (source === "api") return "API";
  if (source === "cli") return "CLI";
  if (source === "system") return "System";
  return source;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

const LOAD_MORE_STEP = 10;

export const EmployeeRunsList: Component<EmployeeRunsListProps> = (props) => {
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [limit, setLimit] = createSignal(props.limit ?? 10);
  const [detailRunId, setDetailRunId] = createSignal<string | null>(null);

  // Derived string source: createResource compares source values with
  // Object.is. An object literal returns a fresh reference on every memo
  // re-evaluation, so an upstream invalidation (the 30s sidebar poll
  // replacing state.employees) would refetch even when nothing changed.
  // The deliberate cadence below still uses refetch() to surface new runs.
  const [runs, { refetch }] = createResource(
    () => `${props.employeeId}::${props.refreshNonce ?? 0}::${limit()}`,
    async (
      key,
    ): Promise<{ rows: EmployeeRun[]; hasMore: boolean; total: number }> => {
      const [id, , limitStr] = key.split("::");
      return svc.listRecentRuns(id, Number.parseInt(limitStr, 10));
    },
  );

  // Refresh on a slow cadence so cron-triggered runs appear without a
  // manual reload. Skipped when the document is hidden so background
  // windows don't poll.
  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    void refetch();
  };
  onMount(() => {
    interval = setInterval(tick, 30_000);
  });
  onCleanup(() => {
    if (interval !== null) clearInterval(interval);
  });

  const sorted = createMemo(() => {
    const list = runs()?.rows ?? [];
    return [...list].sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  });

  const hasMore = () => Boolean(runs()?.hasMore);

  const toggle = (run: EmployeeRun) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(run.id)) next.delete(run.id);
      else next.add(run.id);
      return next;
    });
  };

  return (
    <div>
      <div class="flex items-baseline justify-between mb-2">
        <div class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
          Recent runs
        </div>
        <button
          type="button"
          class="text-[11.5px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          onClick={() => void refetch()}
          disabled={runs.loading}
        >
          {runs.loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <Show when={runs.error}>
        <div
          class="mb-3 py-2 px-3 bg-destructive/15 text-destructive rounded text-[12.5px]"
          role="alert"
        >
          {runs.error instanceof Error
            ? runs.error.message
            : String(runs.error)}
        </div>
      </Show>
      <Show
        when={!runs.loading || (runs()?.rows ?? []).length > 0}
        fallback={
          <div class="text-[12.5px] text-muted-foreground italic py-6 text-center">
            Loading runs...
          </div>
        }
      >
        <Show
          when={sorted().length > 0}
          fallback={
            // Suppress the empty-state hint when an error banner is
            // already shown; the user shouldn't see "No runs yet." next
            // to "Failed to list employee runs".
            <Show when={!runs.error}>
              <div class="text-[12.5px] text-muted-foreground italic py-6 text-center border border-dashed border-border/60 rounded-md">
                No runs yet.
              </div>
            </Show>
          }
        >
          <ol
            class="m-0 p-0 list-none flex flex-col gap-2"
            aria-live="polite"
            aria-busy={runs.loading}
          >
            <For each={sorted()}>
              {(run) => {
                const isOpen = () => expanded().has(run.id);
                const hasOutput = () =>
                  Boolean(run.output && run.output.trim().length > 0);
                const copyRunId = async () => {
                  if (typeof navigator === "undefined" || !navigator.clipboard)
                    return;
                  try {
                    await navigator.clipboard.writeText(run.id);
                  } catch {
                    // Clipboard write can fail without a user gesture; ignore.
                  }
                };
                return (
                  <li class="border border-border rounded-md px-3 py-2.5 bg-card">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span
                        class={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10.5px] font-medium ${statusPillClass(run.status)}`}
                      >
                        {statusLabel(run.status)}
                      </span>
                      <span class="text-[11.5px] text-muted-foreground">
                        {sourceLabel(run.source)}
                      </span>
                      <Show when={run.runName}>
                        <span class="text-[12.5px] text-foreground">
                          {run.runName}
                        </span>
                      </Show>
                      <span
                        class="text-[11.5px] text-muted-foreground ml-auto"
                        title={new Date(run.startedAt).toLocaleString()}
                      >
                        {relativeTime(run.startedAt)}
                      </span>
                    </div>
                    <div class="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground/80">
                      <span class="font-mono truncate" title={run.id}>
                        {run.id}
                      </span>
                      <button
                        type="button"
                        class="text-[10.5px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                        onClick={copyRunId}
                        aria-label="Copy run id"
                      >
                        Copy
                      </button>
                      <span>{durationLabel(run.executionTimeMs)}</span>
                      <span>
                        {formatMicrosUsd(
                          run.inferenceCostAtomic + run.computeCostAtomic,
                        )}
                      </span>
                      <Show
                        when={run.status === "awaiting_approval"}
                        fallback={
                          <button
                            type="button"
                            class="ml-auto text-[11px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                            onClick={() => setDetailRunId(run.id)}
                            aria-label="Open run detail"
                          >
                            Details
                          </button>
                        }
                      >
                        <button
                          type="button"
                          class="ml-auto text-[11px] px-2 py-0.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60"
                          onClick={() => setDetailRunId(run.id)}
                          aria-label="Review approvals"
                        >
                          Review
                        </button>
                      </Show>
                      <Show when={hasOutput()}>
                        <button
                          type="button"
                          class="text-[11px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
                          onClick={() => toggle(run)}
                        >
                          {isOpen() ? "Hide output" : "View output"}
                        </button>
                      </Show>
                    </div>
                    <Show when={run.statusMessage}>
                      <div class="mt-1 text-[11.5px] text-red-400">
                        {run.statusMessage}
                      </div>
                    </Show>
                    <Show when={isOpen() && hasOutput()}>
                      <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-foreground/90 m-0 bg-background/40 border border-border/50 rounded p-2">
                        {run.output}
                      </pre>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ol>
          <Show when={hasMore()}>
            <button
              type="button"
              class="mt-2 w-full py-1.5 px-3 rounded border border-border text-[12px] text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
              onClick={() => setLimit((n) => n + LOAD_MORE_STEP)}
              disabled={runs.loading}
            >
              {runs.loading ? "Loading..." : "Load more"}
            </button>
          </Show>
        </Show>
      </Show>

      <Show when={detailRunId()}>
        {(id) => (
          <EmployeeRunDetailModal
            deploymentId={props.employeeId}
            runId={id()}
            onClose={() => setDetailRunId(null)}
          />
        )}
      </Show>
    </div>
  );
};
