// ABOUTME: Compact upcoming-meetings peek from the connected Google Calendar.
// ABOUTME: Shows the next events and offers one-tap recording with metadata.

import { For, Show } from "solid-js";
import { TrashIcon } from "@/components/recording/icons";
import { formatTime } from "@/lib/meeting-format";
import { meetingStore } from "@/stores/meeting.store";

export function UpcomingMeetings() {
  const upcoming = () =>
    meetingStore.state.upcomingEvents
      .filter((event) => event.endMs > Date.now())
      .slice(0, 4);
  const status = () => meetingStore.state.upcomingStatus;
  // Surface the panel when there are events, or when there's an actionable
  // calendar problem to report. A connected-but-empty calendar stays quiet.
  const visible = () => upcoming().length > 0 || status() !== "connected";
  const statusMessage = () =>
    status() === "disconnected"
      ? "Connect Google Calendar to see upcoming meetings."
      : "Couldn't load your calendar — it'll retry shortly.";

  return (
    <Show when={visible()}>
      <div class="px-4 py-3 border-b border-border bg-surface-0/40">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Upcoming
        </div>
        <Show
          when={upcoming().length > 0}
          fallback={
            <div class="text-[11px] text-muted-foreground">
              {statusMessage()}
            </div>
          }
        >
          <div class="flex flex-col gap-1.5">
            <For each={upcoming()}>
              {(event) => (
                <div class="flex min-w-0 items-center gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[12px] font-medium text-foreground">
                      {event.title}
                    </div>
                    <div class="truncate text-[10px] text-muted-foreground">
                      {formatTime(event.startMs)}
                      {event.attendees.length > 0
                        ? ` · ${event.attendees.length} attendee${
                            event.attendees.length === 1 ? "" : "s"
                          }`
                        : ""}
                      {event.meetingUrl ? " · video" : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="h-6 shrink-0 rounded-md border border-border bg-surface-2 px-2 text-[10px] font-medium text-foreground transition-colors hover:bg-surface-3"
                    onClick={() =>
                      void meetingStore.startFromCalendarEvent(event)
                    }
                  >
                    Record
                  </button>
                  <button
                    type="button"
                    class="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-surface-1 text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
                    aria-label={`Remove ${event.title} from upcoming recordings`}
                    title="Remove from upcoming recordings"
                    onClick={() => meetingStore.skipUpcomingEvent(event)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
