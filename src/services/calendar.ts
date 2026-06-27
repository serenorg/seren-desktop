// ABOUTME: Google Calendar read client for meeting metadata + pre-arm.
// ABOUTME: Lists windowed upcoming events via the Gateway publisher and matches them to recordings.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { publisherStatus, unwrapPublisherBody } from "@/lib/publisher-response";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

const PUBLISHER_SLUG = "google-calendar";

/** A normalized upcoming calendar event for meeting matching + pre-arm. */
export interface CalendarEvent {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  /** Attendee display names (falling back to email). */
  attendees: string[];
  /** Video-conferencing join link, when the event has one. */
  meetingUrl: string | null;
}

// Google `eventType`s that are not real meetings.
const NON_MEETING_EVENT_TYPES = new Set([
  "workingLocation",
  "outOfOffice",
  "focusTime",
]);

interface RawGoogleEvent {
  id?: string;
  summary?: string;
  status?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ displayName?: string; email?: string }>;
  hangoutLink?: string;
  location?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
}

function eventTimeMs(
  slot: { dateTime?: string; date?: string } | undefined,
): number | null {
  const raw = slot?.dateTime ?? slot?.date;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function videoLinkFor(event: RawGoogleEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video" && entry.uri,
  );
  if (video?.uri) return video.uri;
  // Zoom/Meet links sometimes live only in the location field.
  const match = (event.location ?? "").match(
    /https?:\/\/\S*(zoom\.us|meet\.google\.com)\S*/i,
  );
  return match ? match[0] : null;
}

/** Normalize a raw Google event, dropping cancelled/non-meeting entries. */
export function normalizeEvent(event: RawGoogleEvent): CalendarEvent | null {
  if (event.status === "cancelled") return null;
  if (event.eventType && NON_MEETING_EVENT_TYPES.has(event.eventType)) {
    return null;
  }
  const startMs = eventTimeMs(event.start);
  const endMs = eventTimeMs(event.end);
  if (startMs === null || endMs === null) return null;
  return {
    id: event.id ?? "",
    title: event.summary?.trim() || "Untitled event",
    startMs,
    endMs,
    attendees: (event.attendees ?? [])
      .map((attendee) => attendee.displayName?.trim() || attendee.email?.trim())
      .filter((name): name is string => Boolean(name)),
    meetingUrl: videoLinkFor(event),
  };
}

/**
 * Fetch upcoming events from the user's primary Google calendar, windowed
 * `[now, now + aheadMs]`. Returns `[]` on any failure (not connected, offline,
 * upstream error) so callers degrade gracefully.
 */
export async function getUpcomingEvents(
  aheadMs = 12 * 60 * 60_000,
): Promise<CalendarEvent[]> {
  const now = Date.now();
  const params = new URLSearchParams({
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + aheadMs).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });
  const url = `${apiBase}/publishers/${PUBLISHER_SLUG}/events?${params.toString()}`;
  const headers: Record<string, string> = {};
  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) return [];
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await appFetch(url, { method: "GET", headers });
    if (!response.ok) return [];
    const result = await response.json();
    if (publisherStatus(result) === 200 || publisherStatus(result) === null) {
      const body = unwrapPublisherBody(result) as { items?: RawGoogleEvent[] };
      return (body?.items ?? [])
        .map(normalizeEvent)
        .filter((event): event is CalendarEvent => event !== null)
        .sort((a, b) => a.startMs - b.startMs);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Pick the calendar event a recording starting at `nowMs` belongs to: the one
 * whose window contains now (with a small lead-in), preferring events that have
 * a video-conferencing link. Returns null when nothing matches.
 */
export function matchActiveEvent(
  events: CalendarEvent[],
  nowMs: number,
  leadMs = 5 * 60_000,
): CalendarEvent | null {
  const candidates = events.filter(
    (event) => nowMs >= event.startMs - leadMs && nowMs <= event.endMs,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const linkDelta =
      Number(Boolean(b.meetingUrl)) - Number(Boolean(a.meetingUrl));
    if (linkDelta !== 0) return linkDelta;
    return Math.abs(nowMs - a.startMs) - Math.abs(nowMs - b.startMs);
  });
  return candidates[0];
}
