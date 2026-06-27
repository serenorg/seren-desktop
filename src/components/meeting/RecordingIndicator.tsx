// ABOUTME: Floating always-visible indicator shown while a meeting is recording.
// ABOUTME: Surfaces Stop / Pause / Resume / Delete so an auto-started capture is never silent.

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { meetingStore } from "@/stores/meeting.store";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const CONTROL_CLASS =
  "h-6 rounded-md px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground";

// Copyable participant disclosure — local capture gives others no automatic
// signal, so this lets the user paste a heads-up into the meeting chat.
const DISCLOSURE =
  "Heads up — I'm using an AI assistant to take notes on this call.";

export function RecordingIndicator() {
  const [now, setNow] = createSignal(Date.now());
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  let timer: number | undefined;
  onMount(() => {
    timer = window.setInterval(() => setNow(Date.now()), 1000);
  });
  onCleanup(() => {
    if (timer !== undefined) window.clearInterval(timer);
  });

  const active = () =>
    meetingStore.state.meetings.find(
      (meeting) => meeting.status === "capturing",
    ) ?? null;
  const paused = () => meetingStore.state.capturePaused;

  // Drop a stale delete confirmation if the recording ends.
  createEffect(() => {
    if (active() === null && confirmingDelete()) setConfirmingDelete(false);
  });

  // Elapsed excludes paused spans and freezes while paused: the anchor is the
  // pause-start timestamp when paused, otherwise the live clock, minus the time
  // already accumulated across completed pauses.
  const elapsed = () => {
    const meeting = active();
    if (!meeting) return "0:00";
    const state = meetingStore.state;
    const anchor = state.capturePausedAt ?? now();
    return formatElapsed(
      anchor - meeting.startedAt - state.capturePausedAccumMs,
    );
  };

  const onStop = () => {
    const meeting = active();
    if (meeting) void meetingStore.stopByUser(meeting);
  };

  const onTogglePause = () => {
    const meeting = active();
    if (!meeting) return;
    if (paused()) void meetingStore.resumeCapture(meeting.id);
    else void meetingStore.pauseCapture(meeting.id);
  };

  const onNotify = () => {
    void navigator.clipboard
      .writeText(DISCLOSURE)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  // Discard an unwanted recording: first click asks to confirm, second click
  // stops the live capture and deletes it. deleteMeeting() refuses active
  // captures, so this routes through stopAndDelete instead.
  const onDelete = () => {
    const meeting = active();
    if (!meeting || deleting()) return;
    if (!confirmingDelete()) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    setDeleting(true);
    void meetingStore.stopAndDelete(meeting).finally(() => setDeleting(false));
  };

  return (
    <Show when={active()}>
      <div
        class="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-destructive/40 bg-popover/95 px-3 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.32)] backdrop-blur-sm animate-[fadeIn_200ms_ease]"
        aria-label="Recording in progress"
      >
        <span class="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
          <Show
            when={!paused()}
            fallback={
              <span class="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
            }
          >
            <span class="absolute h-2.5 w-2.5 rounded-full bg-destructive/70 animate-[voicePulse_1.4s_ease-in-out_infinite]" />
            <span class="h-2.5 w-2.5 rounded-full bg-destructive" />
          </Show>
        </span>
        <span class="text-[11px] font-medium tabular-nums text-foreground">
          {paused() ? "Paused" : "Rec"} {elapsed()}
        </span>
        <Show when={meetingStore.state.micCaptureLost}>
          <span class="text-[10px] font-medium text-destructive">mic lost</span>
        </Show>
        <Show when={meetingStore.state.error}>
          {(message) => (
            <span class="max-w-[200px] truncate text-[10px] font-medium text-destructive">
              {message()}
            </span>
          )}
        </Show>
        <div class="ml-1 flex shrink-0 items-center gap-1">
          <button
            type="button"
            class={CONTROL_CLASS}
            onClick={onNotify}
            title="Copy a recording disclosure to paste into the meeting chat"
          >
            {copied() ? "Copied" : "Notify"}
          </button>
          <button type="button" class={CONTROL_CLASS} onClick={onTogglePause}>
            {paused() ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            class="h-6 rounded-md border border-destructive/40 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive hover:text-destructive-foreground"
            onClick={onStop}
          >
            Stop
          </button>
          <button
            type="button"
            class={CONTROL_CLASS}
            onClick={onDelete}
            disabled={deleting()}
          >
            {deleting()
              ? "Deleting…"
              : confirmingDelete()
                ? "Confirm?"
                : "Delete"}
          </button>
        </div>
      </div>
    </Show>
  );
}
