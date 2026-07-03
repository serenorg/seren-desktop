// ABOUTME: Floating always-visible indicator shown while a meeting is recording.
// ABOUTME: Surfaces Stop / Pause / Resume / Delete so an auto-started capture is never silent.

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { meetingStore } from "@/stores/meeting.store";
import {
  DEFAULT_COMPOSER_GAP,
  DEFAULT_EDGE_INSET,
  DEFAULT_TITLEBAR_HEIGHT,
  defaultRecordingIndicatorPosition,
  type Position,
} from "./recordingIndicatorPlacement";

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

// Persisted drag position so a user who moved the indicator off their controls
// keeps it there across reopens. UI-only; not sensitive.
const POSITION_KEY = "seren.recordingIndicator.position";

function loadPosition(): Position | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Ignore malformed storage; fall back to the default corner.
  }
  return null;
}

export function RecordingIndicator() {
  const [now, setNow] = createSignal(Date.now());
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [position, setPosition] = createSignal<Position | null>(loadPosition());
  const [defaultPosition, setDefaultPosition] = createSignal<Position | null>(
    null,
  );
  let containerRef: HTMLDivElement | undefined;
  let drag: { px: number; py: number; ox: number; oy: number } | null = null;
  let defaultPositionFrame: number | null = null;

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
  const displayedPosition = () => position() ?? defaultPosition();

  // Drop a stale delete confirmation if the recording ends.
  createEffect(() => {
    if (active() === null && confirmingDelete()) setConfirmingDelete(false);
  });

  // Discrete recording state for assistive tech — announced on change (start,
  // pause, mic loss), unlike the per-second elapsed timer which would spam a
  // live region.
  const statusText = () => {
    const base = paused() ? "Recording paused" : "Recording in progress";
    return meetingStore.state.micCaptureLost
      ? `${base}, microphone disconnected`
      : base;
  };

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

  // Keep the indicator fully on-screen when dragged or the window resizes.
  const clampToViewport = (x: number, y: number): Position => {
    const width = containerRef?.offsetWidth ?? 0;
    const height = containerRef?.offsetHeight ?? 0;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  };

  const titlebarHeight = (): number => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--titlebar-height")
      .trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_TITLEBAR_HEIGHT;
  };

  const visibleComposerTop = (): number | null => {
    const composers = Array.from(
      document.querySelectorAll<HTMLElement>(".chat-composer-form"),
    );
    const visibleComposers = composers
      .map((composer) => composer.getBoundingClientRect())
      .filter(
        (rect) =>
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight,
      )
      .sort((a, b) => b.bottom - a.bottom);

    return visibleComposers[0]?.top ?? null;
  };

  const updateDefaultPosition = () => {
    if (!active() || position() || !containerRef) return;
    const next = defaultRecordingIndicatorPosition({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      indicatorWidth: containerRef.offsetWidth,
      indicatorHeight: containerRef.offsetHeight,
      composerTop: visibleComposerTop(),
      titlebarHeight: titlebarHeight(),
    });
    setDefaultPosition((current) =>
      current?.x === next.x && current.y === next.y ? current : next,
    );
  };

  const scheduleDefaultPositionUpdate = () => {
    if (defaultPositionFrame !== null) return;
    defaultPositionFrame = window.requestAnimationFrame(() => {
      defaultPositionFrame = null;
      updateDefaultPosition();
    });
  };

  // Clamping otherwise only runs mid-drag, so a position restored at a smaller
  // window size — or a window shrunk after dragging — could strand the pill
  // off-screen (and the drag handle out of reach). Re-clamp on window resize and
  // whenever the indicator becomes visible.
  const onResize = () => {
    const current = position();
    if (current) setPosition(clampToViewport(current.x, current.y));
    else scheduleDefaultPositionUpdate();
  };
  onMount(() => {
    window.addEventListener("resize", onResize);
    const layoutObserver = new MutationObserver(() => {
      if (active() && !position()) scheduleDefaultPositionUpdate();
    });
    layoutObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
    });
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      layoutObserver.disconnect();
      if (defaultPositionFrame !== null) {
        window.cancelAnimationFrame(defaultPositionFrame);
      }
    });
  });
  createEffect(() => {
    if (!active()) {
      setDefaultPosition(null);
      return;
    }
    const current = position();
    if (!current) {
      scheduleDefaultPositionUpdate();
      return;
    }
    if (!containerRef) return;
    setDefaultPosition(null);
    const clamped = clampToViewport(current.x, current.y);
    if (clamped.x !== current.x || clamped.y !== current.y) {
      setPosition(clamped);
    }
  });

  const onDragStart = (event: PointerEvent) => {
    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    drag = {
      px: event.clientX,
      py: event.clientY,
      ox: rect.left,
      oy: rect.top,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onDragMove = (event: PointerEvent) => {
    if (!drag) return;
    setPosition(
      clampToViewport(
        drag.ox + (event.clientX - drag.px),
        drag.oy + (event.clientY - drag.py),
      ),
    );
  };

  const onDragEnd = () => {
    if (!drag) return;
    drag = null;
    const current = position();
    if (current) {
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(current));
      } catch {
        // Non-fatal: position just won't persist across reloads.
      }
    }
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
        ref={containerRef}
        class="fixed z-50 flex items-center gap-2 rounded-full border border-destructive/40 bg-popover/95 px-3 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.32)] backdrop-blur-sm animate-[fadeIn_200ms_ease]"
        style={
          displayedPosition()
            ? {
                left: `${displayedPosition()?.x}px`,
                top: `${displayedPosition()?.y}px`,
                right: "auto",
                bottom: "auto",
              }
            : {
                right: `${DEFAULT_EDGE_INSET}px`,
                top: `calc(var(--titlebar-height, ${DEFAULT_TITLEBAR_HEIGHT}px) + ${DEFAULT_COMPOSER_GAP}px)`,
                bottom: "auto",
              }
        }
        aria-label={statusText()}
      >
        {/* Off-screen live region: announces state changes (start/pause/mic
            loss) without reading the ticking timer every second. */}
        <span class="sr-only" role="status" aria-live="polite">
          {statusText()}
        </span>
        {/* Drag handle: the timer/label area moves the pill so it never traps
            bottom-right controls. The buttons stay outside the handle. */}
        <div
          class="flex cursor-grab touch-none select-none items-center gap-2"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
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
            <span class="text-[10px] font-medium text-destructive">
              mic lost
            </span>
          </Show>
          <Show when={meetingStore.state.error}>
            {(message) => (
              <span class="max-w-[200px] truncate text-[10px] font-medium text-destructive">
                {message()}
              </span>
            )}
          </Show>
        </div>
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
