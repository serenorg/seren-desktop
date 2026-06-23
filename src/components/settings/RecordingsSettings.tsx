// ABOUTME: Settings panel for managing native workflow recordings on disk.
// ABOUTME: Lists local recordings with reveal/delete so artifacts do not accumulate.

import { createSignal, For, Index, onMount, Show } from "solid-js";
import { FilmIcon, RevealIcon, TrashIcon } from "@/components/recording/icons";
import {
  formatRecordingSize,
  formatRecordingTimestamp,
} from "@/features/recording/format";
import {
  deleteLocalRecording,
  formatCaptureStats,
  type LocalRecordingSummary,
  listLocalRecordings,
  revealLocalRecording,
} from "@/features/recording/localRecordings";
import { captureSupportError } from "@/lib/support/hook";

const GHOST_ICON_BUTTON =
  "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 disabled:hover:bg-transparent";

function targetKindLabel(kind: LocalRecordingSummary["targetKind"]): string {
  if (kind === "screen") return "screen";
  if (kind === "window") return "window";
  if (kind === "browser") return "browser";
  return "recording";
}

export function RecordingsSettings() {
  const [recordings, setRecordings] = createSignal<LocalRecordingSummary[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [pendingId, setPendingId] = createSignal<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRecordings(await listLocalRecordings());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load recordings.",
      );
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());

  const reveal = async (id: string) => {
    if (pendingId()) return;
    setPendingId(id);
    setError(null);
    try {
      await revealLocalRecording(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reveal.");
      void captureSupportError({
        kind: "RecordingRevealFailure",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error && err.stack ? [err.stack] : undefined,
      });
    } finally {
      setPendingId(null);
    }
  };

  const remove = async (id: string) => {
    if (pendingId()) return;
    setPendingId(id);
    setError(null);
    try {
      await deleteLocalRecording(id);
      setRecordings((items) => items.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
      void captureSupportError({
        kind: "RecordingDeleteFailure",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error && err.stack ? [err.stack] : undefined,
      });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h3 class="m-0 flex items-center gap-2 text-[15px] font-semibold text-foreground">
            Workflow recordings
            <Show when={!loading() && recordings().length > 0}>
              <span class="rounded-full bg-surface-3 px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground">
                {recordings().length}
              </span>
            </Show>
          </h3>
          <p class="m-0 text-[12px] leading-relaxed text-muted-foreground">
            Native recordings are stored locally and never uploaded. Remove them
            here to reclaim space.
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          disabled={loading() || pendingId() !== null}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      <Show when={error()}>
        {(message) => (
          <p class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-600 dark:text-red-400">
            {message()}
          </p>
        )}
      </Show>

      <Show when={loading()}>
        <div class="flex flex-col gap-1.5">
          <Index each={[0, 1, 2]}>
            {() => (
              <div class="h-[42px] animate-pulse rounded-md border border-border bg-surface-2" />
            )}
          </Index>
        </div>
      </Show>

      <Show when={!loading() && recordings().length === 0}>
        <div class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-8 text-center">
          <span class="text-muted-foreground/60">
            <FilmIcon />
          </span>
          <p class="m-0 text-[12px] text-muted-foreground">
            No recordings yet. Use the record button in chat to capture a
            workflow.
          </p>
        </div>
      </Show>

      <Show when={!loading() && recordings().length > 0}>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          <For each={recordings()}>
            {(recording) => (
              <li class="group flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 transition-colors hover:border-border/80 hover:bg-surface-3/50">
                <span class="shrink-0 text-muted-foreground/70">
                  <FilmIcon />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-[12.5px] font-medium text-foreground">
                    {recording.targetLabel || "Workflow recording"}
                  </span>
                  <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                    <span class="rounded border border-border px-1 py-px text-[9.5px] uppercase tracking-wide text-muted-foreground">
                      {targetKindLabel(recording.targetKind)}
                    </span>
                    <Show
                      when={formatRecordingTimestamp(recording.startedAtMs)}
                    >
                      <span>
                        {formatRecordingTimestamp(recording.startedAtMs)}
                      </span>
                    </Show>
                    <Show when={formatRecordingSize(recording.sizeBytes)}>
                      <span class="text-muted-foreground/40" aria-hidden="true">
                        ·
                      </span>
                      <span class="tabular-nums">
                        {formatRecordingSize(recording.sizeBytes)}
                      </span>
                    </Show>
                    <Show when={(recording.keyframeCount ?? 0) > 0}>
                      <span class="text-muted-foreground/40" aria-hidden="true">
                        ·
                      </span>
                      <span class="tabular-nums">
                        {recording.keyframeCount} frame
                        {recording.keyframeCount === 1 ? "" : "s"}
                      </span>
                    </Show>
                    <Show when={formatCaptureStats(recording.captureStats)}>
                      {(stats) => (
                        <>
                          <span
                            class="text-muted-foreground/40"
                            aria-hidden="true"
                          >
                            -
                          </span>
                          <span class="tabular-nums">{stats()}</span>
                        </>
                      )}
                    </Show>
                    <Show when={!recording.videoUrl}>
                      <span class="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[9.5px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                        no video
                      </span>
                    </Show>
                  </span>
                </div>
                <span class="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    class={GHOST_ICON_BUTTON}
                    aria-label="Reveal in Finder"
                    title="Reveal in Finder"
                    disabled={pendingId() !== null}
                    onClick={() => void reveal(recording.id)}
                  >
                    <RevealIcon />
                  </button>
                  <button
                    type="button"
                    class={`${GHOST_ICON_BUTTON} hover:bg-red-500/10 hover:text-red-600`}
                    aria-label="Delete recording"
                    title="Delete recording from disk"
                    disabled={pendingId() !== null}
                    onClick={() => void remove(recording.id)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
