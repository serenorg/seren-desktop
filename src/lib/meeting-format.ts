// ABOUTME: Shared display formatting for Meeting Mode surfaces.
// ABOUTME: Time, duration, title, and status labels used by the panel and detail view.

import type { Meeting } from "@/services/meetings";

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
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

export function meetingTitle(meeting: Meeting): string {
  return meeting.title.trim() || `Meeting ${formatTime(meeting.startedAt)}`;
}

export const STATUS_LABELS: Record<Meeting["status"], string> = {
  capturing: "Capturing",
  transcribing: "Transcribing",
  notes_ready: "Notes ready",
  agent_running: "Agent running",
  done: "Done",
  failed: "Failed",
};
