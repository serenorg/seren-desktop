// ABOUTME: Shared display formatting for Meeting Mode surfaces.
// ABOUTME: Time, duration, title, and status labels used by the panel and detail view.

import type { Meeting } from "@/services/meetings";

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Compact date label for list rows and the detail meta row. Recent meetings
// collapse to Today/Yesterday so the row stays scannable; older ones get a
// calendar date, including the year when it differs from the current year so a
// January meeting from last year is not mistaken for this year (#2344).
export function formatMeetingDate(
  ms: number,
  now: number = Date.now(),
): string {
  const day = new Date(ms);
  const today = new Date(now);
  const sameDay =
    day.getFullYear() === today.getFullYear() &&
    day.getMonth() === today.getMonth() &&
    day.getDate() === today.getDate();
  if (sameDay) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (
    day.getFullYear() === yesterday.getFullYear() &&
    day.getMonth() === yesterday.getMonth() &&
    day.getDate() === yesterday.getDate()
  ) {
    return "Yesterday";
  }
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export function formatDuration(meeting: Meeting): string {
  const end = meeting.endedAt ?? Date.now();
  const totalSeconds = Math.max(
    0,
    Math.floor((end - meeting.startedAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Auto-generated titles carry seconds so two captures started in the same
// clock-minute stay distinguishable in the list (#2335). formatTime keeps minute
// precision for the duration/status surfaces that don't need disambiguation.
function formatTimeWithSeconds(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function meetingTitle(meeting: Meeting): string {
  return (
    meeting.title.trim() ||
    `Meeting ${formatTimeWithSeconds(meeting.startedAt)}`
  );
}

export const STATUS_LABELS: Record<Meeting["status"], string> = {
  pending_capture: "Starting",
  capturing: "Capturing",
  transcribing: "Generating notes",
  transcript_ready: "Transcript ready",
  notes_ready: "Notes ready",
  agent_running: "Agent running",
  done: "Done",
  failed: "Failed",
};

export function isMeetingProcessingStatus(status: Meeting["status"]): boolean {
  return status === "transcribing" || status === "agent_running";
}

export function isMeetingReadyStatus(status: Meeting["status"]): boolean {
  return (
    status === "transcript_ready" ||
    status === "notes_ready" ||
    status === "done"
  );
}

export function meetingProcessingLabel(status: Meeting["status"]): string {
  return status === "agent_running"
    ? "Routing transcript through skill"
    : "Generating notes from transcript";
}

export function meetingReadyLabel(status: Meeting["status"]): string {
  return status === "transcript_ready"
    ? "Transcript ready to view"
    : "Notes ready to view";
}
