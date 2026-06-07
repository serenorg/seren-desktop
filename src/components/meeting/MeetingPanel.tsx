// ABOUTME: Slide-panel interface for Meeting Mode library, recorder, and details.
// ABOUTME: Uses meeting services and store; components never call Tauri IPC directly.

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  createMeeting,
  type Meeting,
  type TranscriptSegment,
  updateMeetingStatus,
} from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";
import { settingsStore } from "@/stores/settings.store";

interface MeetingPanelProps {
  onClose: () => void;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(meeting: Meeting): string {
  const end = meeting.endedAt ?? Date.now();
  const totalSeconds = Math.max(
    0,
    Math.floor((end - meeting.startedAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function meetingTitle(meeting: Meeting): string {
  return meeting.title.trim() || `Meeting ${formatTime(meeting.startedAt)}`;
}

const STATUS_LABELS: Record<Meeting["status"], string> = {
  capturing: "Capturing",
  transcribing: "Transcribing",
  notes_ready: "Notes ready",
  agent_running: "Agent running",
  done: "Done",
  failed: "Failed",
};

function MicGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="Microphone"
    >
      <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2Z" />
      <path d="M4.5 7a.5.5 0 0 0-1 0 4.5 4.5 0 0 0 4 4.47V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.03A4.5 4.5 0 0 0 12.5 7a.5.5 0 0 0-1 0 3.5 3.5 0 1 1-7 0Z" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="Stop"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function TranscriptRow(props: { segment: TranscriptSegment }) {
  return (
    <div class="grid grid-cols-[52px_1fr] gap-3 py-2 border-b border-border/50 last:border-b-0">
      <div
        class="text-[11px] font-mono tabular-nums"
        classList={{
          "text-foreground": props.segment.speaker === "me",
          "text-muted-foreground": props.segment.speaker === "them",
        }}
      >
        {props.segment.speaker === "me" ? "Me" : "Them"}
      </div>
      <div
        class="text-[13px] leading-5"
        classList={{
          "text-muted-foreground italic": props.segment.status === "gap",
          "text-foreground": props.segment.status === "ok",
        }}
      >
        {props.segment.status === "gap" ? "Transcript gap" : props.segment.text}
      </div>
    </div>
  );
}

export function MeetingPanel(props: MeetingPanelProps) {
  const [starting, setStarting] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [title, setTitle] = createSignal("");

  onMount(() => {
    void meetingStore.loadMeetings();
    void meetingStore.startMeetingEventListeners();
  });

  onCleanup(() => meetingStore.stopMeetingEventListeners());

  const activeCapture = createMemo(() =>
    meetingStore.state.meetings.find((meeting) =>
      ["capturing", "transcribing", "agent_running"].includes(meeting.status),
    ),
  );

  const activeMeeting = () => meetingStore.state.activeMeeting;
  const template = () => settingsStore.get("meetingTemplateId");
  const desktopRuntime = isTauriRuntime();

  const startManualCapture = async () => {
    if (!desktopRuntime || starting()) return;
    setStarting(true);
    try {
      const meeting = await createMeeting({
        title: title().trim() || `Meeting ${formatTime(Date.now())}`,
        sourceApp: "Manual",
        templateId: template(),
      });
      setTitle("");
      await meetingStore.loadMeetings();
      await meetingStore.setActiveMeeting(meeting);
    } finally {
      setStarting(false);
    }
  };

  const stopManualCapture = async () => {
    const meeting = activeCapture();
    if (!desktopRuntime || !meeting || stopping()) return;
    setStopping(true);
    try {
      await updateMeetingStatus(meeting.id, "done", Date.now());
      await meetingStore.loadMeetings();
      const updated = meetingStore.state.meetings.find(
        (item) => item.id === meeting.id,
      );
      await meetingStore.setActiveMeeting(updated ?? null);
    } finally {
      setStopping(false);
    }
  };

  return (
    <section class="h-full min-h-0 flex flex-col bg-surface-1 text-foreground">
      <header class="px-5 pt-5 pb-4 border-b border-border">
        <div class="flex items-center justify-between gap-4 pr-8">
          <div class="min-w-0">
            <h2 class="text-[15px] font-semibold tracking-normal">Meetings</h2>
            <div class="mt-1 text-[12px] text-muted-foreground">
              {meetingStore.state.meetings.length} saved
            </div>
          </div>
          <button
            type="button"
            class="w-7 h-7 flex items-center justify-center rounded-md border border-border bg-surface-2 text-muted-foreground hover:text-foreground hover:bg-surface-3 transition-colors"
            onClick={props.onClose}
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div class="p-4 border-b border-border bg-surface-0/40">
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-1.5 h-8 px-2 rounded-md border border-border bg-surface-1">
            <For each={[0, 1, 2, 3, 4, 5, 6]}>
              {(bar) => (
                <span
                  class="w-0.5 rounded-full bg-primary/80 transition-all"
                  classList={{
                    "animate-[voicePulse_1s_ease-in-out_infinite]":
                      activeCapture() !== undefined,
                  }}
                  style={{
                    height: activeCapture()
                      ? `${8 + ((bar * 7) % 18)}px`
                      : "4px",
                    "animation-delay": `${bar * 80}ms`,
                  }}
                />
              )}
            </For>
          </div>
          <input
            class="min-w-0 flex-1 h-8 rounded-md border border-border bg-surface-1 px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
            placeholder="Meeting title"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            disabled={activeCapture() !== undefined}
          />
          <Show
            when={activeCapture()}
            fallback={
              <button
                type="button"
                class="h-8 w-9 flex items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 disabled:opacity-60"
                onClick={startManualCapture}
                disabled={starting() || !desktopRuntime}
                title={
                  desktopRuntime ? "Start capture" : "Desktop runtime required"
                }
              >
                <MicGlyph />
              </button>
            }
          >
            <button
              type="button"
              class="h-8 w-9 flex items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 disabled:opacity-60"
              onClick={stopManualCapture}
              disabled={stopping() || !desktopRuntime}
              title={
                desktopRuntime ? "Stop capture" : "Desktop runtime required"
              }
            >
              <StopGlyph />
            </button>
          </Show>
        </div>
        <Show when={activeCapture()}>
          {(meeting) => (
            <div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span class="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
              <span class="font-mono tabular-nums">
                {formatDuration(meeting())}
              </span>
              <span>{meetingTitle(meeting())}</span>
            </div>
          )}
        </Show>
      </div>

      <div class="min-h-0 flex-1 grid grid-cols-[220px_1fr]">
        <aside class="min-h-0 overflow-auto border-r border-border bg-surface-0/30">
          <Show
            when={meetingStore.state.meetings.length > 0}
            fallback={
              <div class="p-4 text-[13px] text-muted-foreground">
                No meetings saved.
              </div>
            }
          >
            <For each={meetingStore.state.meetings}>
              {(meeting) => {
                const selected = () => activeMeeting()?.id === meeting.id;
                return (
                  <button
                    type="button"
                    class="w-full text-left px-3 py-2.5 border-b border-border/50 bg-transparent hover:bg-surface-2 transition-colors"
                    classList={{
                      "bg-surface-2 text-foreground": selected(),
                      "text-muted-foreground": !selected(),
                    }}
                    onClick={() => void meetingStore.setActiveMeeting(meeting)}
                  >
                    <div class="text-[13px] font-medium truncate">
                      {meetingTitle(meeting)}
                    </div>
                    <div class="mt-1 flex items-center justify-between gap-2 text-[11px]">
                      <span>{formatTime(meeting.startedAt)}</span>
                      <span>{STATUS_LABELS[meeting.status]}</span>
                    </div>
                  </button>
                );
              }}
            </For>
          </Show>
        </aside>

        <main class="min-h-0 overflow-auto">
          <Show
            when={activeMeeting()}
            fallback={
              <div class="h-full flex items-center justify-center text-[13px] text-muted-foreground">
                Select a meeting.
              </div>
            }
          >
            {(meeting) => (
              <div class="p-5 max-w-[720px]">
                <div class="mb-5">
                  <h3 class="text-[18px] font-semibold tracking-normal">
                    {meetingTitle(meeting())}
                  </h3>
                  <div class="mt-1 flex items-center gap-3 text-[12px] text-muted-foreground">
                    <span>{STATUS_LABELS[meeting().status]}</span>
                    <span class="font-mono tabular-nums">
                      {formatDuration(meeting())}
                    </span>
                    <span>{meeting().sourceApp ?? "Desktop"}</span>
                  </div>
                </div>

                <section class="mb-6">
                  <div class="mb-2 text-[12px] font-medium text-muted-foreground">
                    Notes
                  </div>
                  <div class="min-h-[96px] whitespace-pre-wrap rounded-md border border-border bg-surface-0/50 p-3 text-[13px] leading-5">
                    {meeting().notesMarkdown ?? "Notes will appear here."}
                  </div>
                </section>

                <section>
                  <div class="mb-2 text-[12px] font-medium text-muted-foreground">
                    Transcript
                  </div>
                  <Show
                    when={meetingStore.state.liveSegments.length > 0}
                    fallback={
                      <div class="rounded-md border border-border bg-surface-0/50 p-3 text-[13px] text-muted-foreground">
                        No transcript yet.
                      </div>
                    }
                  >
                    <div class="rounded-md border border-border bg-surface-0/50 px-3">
                      <For each={meetingStore.state.liveSegments}>
                        {(segment) => <TranscriptRow segment={segment} />}
                      </For>
                    </div>
                  </Show>
                </section>
              </div>
            )}
          </Show>
        </main>
      </div>
    </section>
  );
}
