// ABOUTME: Google Calendar read client for meeting metadata.
// ABOUTME: Lists windowed upcoming events via the Gateway publisher and matches them to recordings.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { publisherStatus, unwrapPublisherBody } from "@/lib/publisher-response";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

const PUBLISHER_SLUG = "google-calendar";

/** A normalized upcoming calendar event for meeting matching. */
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
  const candidate =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find(
      (entry) => entry.entryPointType === "video" && entry.uri,
    )?.uri ??
    // Zoom/Meet links sometimes live only in the location field; stop at the
    // first whitespace/delimiter so trailing text isn't captured.
    (event.location ?? "").match(
      /https?:\/\/[^\s,;]*(?:zoom\.us|meet\.google\.com)[^\s,;]*/i,
    )?.[0] ??
    null;
  if (!candidate) return null;
  // Only trust a well-formed https URL (location text comes from third-party invites).
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Normalize a raw Google event, dropping cancelled/non-meeting entries. */
export function normalizeEvent(event: RawGoogleEvent): CalendarEvent | null {
  if (event.status === "cancelled") return null;
  if (event.eventType && NON_MEETING_EVENT_TYPES.has(event.eventType)) {
    return null;
  }
  // All-day events (date, not dateTime) span 24h+ and aren't recordable
  // meetings — exclude them so they can't hijack the recording match.
  if (!event.start?.dateTime || !event.end?.dateTime) return null;
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
 * Whether the calendar fetch reached a connected account. `disconnected` means
 * no/expired Google authorization (connect it); `error` means a network or
 * upstream failure (retry); `connected` means a successful read (events may be
 * empty). Lets the UI distinguish "not connected" from "nothing scheduled".
 */
export type CalendarConnectionStatus = "connected" | "disconnected" | "error";

export interface UpcomingEventsResult {
  status: CalendarConnectionStatus;
  events: CalendarEvent[];
}

function statusForCode(code: number): CalendarConnectionStatus {
  return code === 401 || code === 403 ? "disconnected" : "error";
}

/**
 * Fetch upcoming events from the user's primary Google calendar, windowed
 * `[now, now + aheadMs]`. Never throws: failures map to a `disconnected` or
 * `error` status with empty events so callers degrade gracefully while still
 * being able to tell the states apart.
 */
export async function getUpcomingEvents(
  aheadMs = 12 * 60 * 60_000,
): Promise<UpcomingEventsResult> {
  const now = Date.now();
  const params = new URLSearchParams({
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + aheadMs).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });
  const url = `${apiBase}/publishers/${PUBLISHER_SLUG}/events?${params.toString()}`;
  try {
    const headers: Record<string, string> = {};
    if (!shouldUseRustGatewayAuth(url)) {
      const token = await getToken();
      if (!token) return { status: "disconnected", events: [] };
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await appFetch(url, { method: "GET", headers });
    if (!response.ok) {
      return { status: statusForCode(response.status), events: [] };
    }
    const result = await response.json();
    const status = publisherStatus(result);
    if (status !== undefined && (status < 200 || status >= 300)) {
      return { status: statusForCode(status), events: [] };
    }
    const body = unwrapPublisherBody(result) as { items?: RawGoogleEvent[] };
    const events = (body?.items ?? [])
      .map(normalizeEvent)
      .filter((event): event is CalendarEvent => event !== null)
      .sort((a, b) => a.startMs - b.startMs);
    return { status: "connected", events };
  } catch {
    return { status: "error", events: [] };
  }
}

// The detected call app → the meeting-link hostnames it owns. Used to pick the
// right event among overlapping ones (a Zoom call should match the Zoom link,
// not a coincidentally-overlapping Meet invite). Browser apps (Chrome) own no
// hostname, so they fall through to the link/ambiguity rules below.
const APP_URL_DOMAINS: ReadonlyArray<{ key: string; domains: string[] }> = [
  { key: "zoom", domains: ["zoom.us"] },
  { key: "teams", domains: ["teams.microsoft.com", "teams.live.com"] },
  { key: "webex", domains: ["webex.com"] },
  { key: "meet", domains: ["meet.google.com"] },
];

/** True when the event's join-link hostname belongs to the detected app. */
function eventMatchesApp(event: CalendarEvent, sourceApp: string): boolean {
  if (!event.meetingUrl) return false;
  const app = sourceApp.toLowerCase();
  let host: string;
  try {
    host = new URL(event.meetingUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return APP_URL_DOMAINS.some(
    ({ key, domains }) =>
      app.includes(key) && domains.some((domain) => host.includes(domain)),
  );
}

/**
 * Pick the calendar event a recording starting at `nowMs` belongs to: the one
 * whose window contains now (with a small lead-in). With a single in-window
 * event, use it. With several, disambiguate by the detected app's meeting-link
 * domain; otherwise prefer the lone event with a join link. When still
 * ambiguous (multiple plausible events), return null rather than stamp the
 * wrong title/attendees (PII) onto the recording.
 */
export function matchActiveEvent(
  events: CalendarEvent[],
  nowMs: number,
  sourceApp: string | null = null,
  leadMs = 5 * 60_000,
): CalendarEvent | null {
  const candidates = events.filter(
    (event) => nowMs >= event.startMs - leadMs && nowMs <= event.endMs,
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Several overlapping events: the detected app's link domain uniquely
  // identifies the active call when it matches exactly one.
  if (sourceApp) {
    const appMatches = candidates.filter((event) =>
      eventMatchesApp(event, sourceApp),
    );
    if (appMatches.length === 1) return appMatches[0];
    if (appMatches.length > 1) return null;
  }

  // No app signal: a real video call almost always carries a join link, so a
  // lone linked candidate is the safe pick. Multiple linked candidates are too
  // ambiguous to stamp attendee PII — leave the recording unmatched.
  const linked = candidates.filter((event) => event.meetingUrl);
  return linked.length === 1 ? linked[0] : null;
}
