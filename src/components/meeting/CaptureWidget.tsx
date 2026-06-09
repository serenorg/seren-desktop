// ABOUTME: Compact floating capture widget rendered in its own always-on-top window.
// ABOUTME: Shows live recording state + elapsed time and stops capture via the main window.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { formatDuration, meetingTitle } from "@/lib/meeting-format";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { requestCaptureStop } from "@/services/captureWidget";
import { getMeeting, type Meeting } from "@/services/meetings";

function StopGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="Stop"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function meetingIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("meeting");
}

export function CaptureWidget() {
  const meetingId = meetingIdFromUrl();
  const [meeting, setMeeting] = createSignal<Meeting | null>(null);
  const [stopping, setStopping] = createSignal(false);
  // A ticking signal so the elapsed clock re-renders once per second.
  const [tick, setTick] = createSignal(0);

  let statusUnlisten: (() => void) | null = null;
  let clock: number | null = null;

  onMount(async () => {
    if (!meetingId || !isTauriRuntime()) return;

    try {
      setMeeting(await getMeeting(meetingId));
    } catch {
      // The window may open a beat before the row is queryable; status events
      // below will fill it in.
    }

    const { listen } = await import("@tauri-apps/api/event");
    statusUnlisten = await listen<Meeting>("meeting://status", (event) => {
      if (event.payload.id === meetingId) setMeeting(event.payload);
    });

    clock = window.setInterval(() => setTick((value) => value + 1), 1000);
  });

  onCleanup(() => {
    statusUnlisten?.();
    if (clock !== null) window.clearInterval(clock);
  });

  const recording = () => meeting()?.status === "capturing";

  const stop = async () => {
    if (!meetingId || stopping()) return;
    setStopping(true);
    try {
      await requestCaptureStop(meetingId);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div class="h-screen w-screen flex items-center gap-2.5 px-3 rounded-xl border border-border bg-surface-1/95 text-foreground select-none backdrop-blur">
      <div
        data-tauri-drag-region
        class="min-w-0 flex flex-1 items-center gap-2.5"
      >
        <span
          class="w-2 h-2 shrink-0 rounded-full"
          classList={{
            "bg-destructive animate-pulse": recording(),
            "bg-muted-foreground": !recording(),
          }}
        />
        <div class="min-w-0 flex-1 leading-tight">
          <div class="font-mono tabular-nums text-[13px]">
            <Show when={meeting()} fallback="00:00">
              {(active) => {
                tick();
                return formatDuration(active());
              }}
            </Show>
          </div>
          <div class="truncate text-[10px] text-muted-foreground">
            <Show when={meeting()} fallback="Recording">
              {(active) => meetingTitle(active())}
            </Show>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="h-7 w-7 shrink-0 flex items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 disabled:opacity-60"
        onClick={stop}
        disabled={stopping()}
        title="Stop capture"
      >
        <StopGlyph />
      </button>
    </div>
  );
}
