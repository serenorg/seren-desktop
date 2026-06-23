// ABOUTME: Compact card for a just-stopped native recording in the composer.
// ABOUTME: Surfaces capture summary plus reveal/delete actions for local artifacts.

import type { RecordingSession } from "@seren/recording-core";
import { createSignal, Show } from "solid-js";
import {
  CloseIcon,
  RevealIcon,
  SparkIcon,
  TrashIcon,
} from "@/components/recording/icons";
import { RecordedSkillDraftBuilder } from "@/components/recording/RecordedSkillDraftBuilder";
import { formatRecordingSize } from "@/features/recording/format";
import {
  deleteLocalRecording,
  formatCaptureStats,
  revealLocalRecording,
} from "@/features/recording/localRecordings";

function qualityPillClass(status: RecordingSession["qualityStatus"]): string {
  if (status === "ready") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "retry") {
    return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

function qualityLabel(status: RecordingSession["qualityStatus"]): string {
  if (status === "ready") return "ready";
  if (status === "needs_review") return "review";
  if (status === "retry") return "retry";
  return "captured";
}

const GHOST_ICON_BUTTON =
  "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 disabled:hover:bg-transparent";

export function RecordedSessionCard(props: {
  session: RecordingSession;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = createSignal<"reveal" | "delete" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [buildingSkill, setBuildingSkill] = createSignal(false);

  const sizeLabel = () => formatRecordingSize(props.session.sizeBytes);
  const markerCount = () => props.session.markerCount ?? 0;
  const captureStatsLabel = () =>
    formatCaptureStats(props.session.captureStats);

  const reveal = async () => {
    if (busy()) return;
    setBusy("reveal");
    setError(null);
    try {
      await revealLocalRecording(props.session.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reveal recording.",
      );
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy()) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteLocalRecording(props.session.id);
      props.onDismiss();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete recording.",
      );
      setBusy(null);
    }
  };

  return (
    <div class="recording-card-enter mb-2 overflow-hidden rounded-lg border border-border border-l-2 border-l-red-500/70 bg-surface-2 shadow-sm">
      <div class="flex flex-col gap-2 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <span
            class="recording-rec-dot inline-flex size-2 shrink-0 rounded-full bg-red-500"
            aria-hidden="true"
          />
          <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-red-500/90">
            Rec
          </span>
          <span class="min-w-0 truncate text-[13px] font-medium text-foreground">
            {props.session.targetLabel || "Workflow recording"}
          </span>
          <span
            class={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${qualityPillClass(props.session.qualityStatus)}`}
          >
            {qualityLabel(props.session.qualityStatus)}
          </span>

          <span class="ml-auto flex items-center gap-1">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              aria-expanded={buildingSkill()}
              onClick={() => setBuildingSkill((open) => !open)}
            >
              <SparkIcon />
              {buildingSkill() ? "Hide draft" : "Build skill"}
            </button>
            <button
              type="button"
              class={GHOST_ICON_BUTTON}
              aria-label="Reveal recording in Finder"
              title="Reveal in Finder"
              disabled={busy() !== null}
              onClick={() => void reveal()}
            >
              <RevealIcon />
            </button>
            <button
              type="button"
              class={`${GHOST_ICON_BUTTON} hover:bg-red-500/10 hover:text-red-600`}
              aria-label="Delete recording"
              title="Delete recording from disk"
              disabled={busy() !== null}
              onClick={() => void remove()}
            >
              <TrashIcon />
            </button>
            <button
              type="button"
              class={GHOST_ICON_BUTTON}
              aria-label="Dismiss"
              title="Keep the recording but hide this card"
              disabled={busy() !== null}
              onClick={props.onDismiss}
            >
              <CloseIcon />
            </button>
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-muted-foreground">
          <Show when={sizeLabel()}>
            <span class="tabular-nums">{sizeLabel()}</span>
            <span class="text-border" aria-hidden="true">
              ·
            </span>
          </Show>
          <span class="tabular-nums">
            {markerCount()} marker{markerCount() === 1 ? "" : "s"}
          </span>
          <Show when={captureStatsLabel()}>
            {(stats) => (
              <>
                <span class="text-muted-foreground/40" aria-hidden="true">
                  -
                </span>
                <span class="tabular-nums">{stats()}</span>
              </>
            )}
          </Show>
          <span class="text-muted-foreground/40" aria-hidden="true">
            ·
          </span>
          <span class="uppercase tracking-wide text-muted-foreground/80">
            local only
          </span>
        </div>

        <p class="text-[11px] leading-snug text-muted-foreground">
          The skill-draft prompt was added to your message. Send it, then paste
          the reply into <span class="text-foreground/80">Build skill</span>.
          The video stays on this device.
        </p>

        <Show when={error()}>
          {(message) => (
            <p class="text-[11px] text-red-600 dark:text-red-400">
              {message()}
            </p>
          )}
        </Show>
      </div>

      <Show when={buildingSkill()}>
        <div class="border-t border-border bg-surface-1/40 px-3 pb-3">
          <RecordedSkillDraftBuilder session={props.session} />
        </div>
      </Show>
    </div>
  );
}
