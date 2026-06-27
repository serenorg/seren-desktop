// ABOUTME: Compact upcoming-meetings peek from the connected Google Calendar.
// ABOUTME: Shows the next events and offers one-tap recording with metadata.

import { For, Show } from "solid-js";
import { formatTime } from "@/lib/meeting-format";
import { meetingStore } from "@/stores/meeting.store";

export function UpcomingMeetings() {
  const upcoming = () =>
    meetingStore.state.upcomingEvents
      .filter((event) => event.endMs > Date.now())
      .slice(0, 4);

  return (
    <Show when={upcoming().length > 0}>
      <div class="px-4 py-3 border-b border-border bg-surface-0/40">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Upcoming
        </div>
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
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
