// ABOUTME: Slide-panel interface for Meeting Mode library, recorder, and details.
// ABOUTME: Uses meeting services and store; components never call Tauri IPC directly.

import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { ConfirmDialog } from "@/components/catalog/ConfirmDialog";
import { MeetingDetail } from "@/components/meeting/MeetingDetail";
import { MeetingSettings } from "@/components/meeting/MeetingSettings";
import {
  formatDuration,
  formatTime,
  meetingTitle,
  STATUS_LABELS,
} from "@/lib/meeting-format";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { createMeeting, type Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";
import { settingsStore } from "@/stores/settings.store";

interface MeetingPanelProps {
  onClose: () => void;
}

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

export function MeetingPanel(props: MeetingPanelProps) {
  const [starting, setStarting] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [showSettings, setShowSettings] = createSignal(false);
  const [pendingDelete, setPendingDelete] = createSignal<Meeting | null>(null);
  const [deleting, setDeleting] = createSignal(false);

  // The capture lifecycle (event listeners, auto-detect, widget/tray relays)
  // lives in AppShell so it survives this panel unmounting on close. The panel
  // only refreshes its own list when it opens.
  onMount(() => {
    void meetingStore.loadMeetings();
  });

  const activeCapture = createMemo(() =>
    meetingStore.state.meetings.find(
      (meeting) => meeting.status === "capturing",
    ),
  );

  const activeMeeting = () => meetingStore.state.activeMeeting;
  const template = () => settingsStore.get("meetingTemplateId");
  const desktopRuntime = isTauriRuntime();
  const deleteConfirmationMessage = () => {
    const meeting = pendingDelete();
    return meeting
      ? `Delete "${meetingTitle(meeting)}"? Notes and transcript segments will be permanently removed.`
      : "";
  };

  // Create the meeting, then hand off to the store's gate. The store decides
  // whether to start immediately or surface the app-wide priming dialog, so
  // every start path (panel, tray, auto-detect) honors the first-run gate.
  const startManualCapture = async () => {
    if (!desktopRuntime || starting()) return;
    // A priming dialog is already pending a start; don't create a second one.
    if (meetingStore.state.primingRequest) return;
    setStarting(true);
    try {
      const meeting = await createMeeting({
        title: title().trim() || `Meeting ${formatTime(Date.now())}`,
        sourceApp: "Manual",
        templateId: template(),
      });
      setTitle("");
      meetingStore.dismissAutoDetect();
      await meetingStore.requestCaptureStart(meeting);
    } finally {
      setStarting(false);
    }
  };

  const stopManualCapture = async () => {
    const meeting = activeCapture();
    if (!desktopRuntime || !meeting || stopping()) return;
    setStopping(true);
    try {
      await meetingStore.stopAndProcess(meeting);
      meetingStore.resetAutoDetectDismissal();
    } finally {
      setStopping(false);
    }
  };

  const deleteSelectedMeeting = async () => {
    const meeting = pendingDelete();
    if (!meeting || deleting()) return;
    setDeleting(true);
    try {
      await meetingStore.deleteMeeting(meeting);
      if (!meetingStore.state.error) {
        setPendingDelete(null);
      }
    } finally {
      setDeleting(false);
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
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="w-7 h-7 flex items-center justify-center rounded-md border border-border bg-surface-2 hover:bg-surface-3 transition-colors"
              classList={{
                "text-primary": showSettings(),
                "text-muted-foreground hover:text-foreground": !showSettings(),
              }}
              onClick={() => setShowSettings((value) => !value)}
              title="Meeting settings"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-label="Settings"
                role="img"
              >
                <path d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5Zm0 1.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z" />
                <path d="M7.3 1.5a.7.7 0 0 1 1.4 0l.1.9c.4.1.8.3 1.1.5l.8-.5a.7.7 0 0 1 1 1l-.5.8c.2.3.4.7.5 1.1l.9.1a.7.7 0 0 1 0 1.4l-.9.1c-.1.4-.3.8-.5 1.1l.5.8a.7.7 0 0 1-1 1l-.8-.5c-.3.2-.7.4-1.1.5l-.1.9a.7.7 0 0 1-1.4 0l-.1-.9c-.4-.1-.8-.3-1.1-.5l-.8.5a.7.7 0 0 1-1-1l.5-.8c-.2-.3-.4-.7-.5-1.1l-.9-.1a.7.7 0 0 1 0-1.4l.9-.1c.1-.4.3-.8.5-1.1l-.5-.8a.7.7 0 0 1 1-1l.8.5c.3-.2.7-.4 1.1-.5l.1-.9Z" />
              </svg>
            </button>
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
        </div>
      </header>

      <div class="p-4 border-b border-border bg-surface-0/40">
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-1.5 h-8 px-2 rounded-md border border-border bg-surface-1">
            <For each={[0, 1, 2, 3, 4, 5, 6]}>
              {(bar) => {
                const height = () => {
                  if (!activeCapture()) return 4;
                  const level = meetingStore.state.captureLevel;
                  // Vary bars so the meter reads as a meter, driven by real amplitude.
                  const variation = 0.6 + 0.4 * Math.sin((bar + 1) * 1.7);
                  return Math.max(3, Math.min(22, 3 + level * 26 * variation));
                };
                return (
                  <span
                    class="w-0.5 rounded-full bg-primary/80 transition-[height] duration-75"
                    style={{ height: `${height()}px` }}
                  />
                );
              }}
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

      <Show when={meetingStore.state.error}>
        {(message) => (
          <div class="flex items-start gap-2 px-4 py-2.5 border-b border-destructive/30 bg-destructive/10 text-[12px] text-destructive">
            <span class="flex-1">{message()}</span>
            <button
              type="button"
              class="text-destructive/80 hover:text-destructive"
              onClick={() => meetingStore.clearError()}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
      </Show>

      {/* Auto-detect now surfaces app-wide via RecordPrompt (titlebar); the
          in-panel banner was a dead spot (only visible with this panel open). */}

      <Show when={!showSettings()} fallback={<MeetingSettings />}>
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
                      onClick={() =>
                        void meetingStore.setActiveMeeting(meeting)
                      }
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
                <MeetingDetail
                  meeting={meeting()}
                  onRequestDelete={(target) => setPendingDelete(target)}
                />
              )}
            </Show>
          </main>
        </div>
      </Show>
      <ConfirmDialog
        open={pendingDelete() !== null}
        title="Delete meeting"
        message={deleteConfirmationMessage()}
        confirmLabel="Delete"
        destructive
        pending={deleting()}
        onConfirm={() => void deleteSelectedMeeting()}
        onCancel={() => {
          if (!deleting()) setPendingDelete(null);
        }}
      />
    </section>
  );
}
