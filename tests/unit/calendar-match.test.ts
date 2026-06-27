// ABOUTME: Critical-path coverage for calendar event normalization + recording match.
// ABOUTME: Pure logic that decides a recording's title/attendees from a calendar event.

import { describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  matchActiveEvent,
  normalizeEvent,
} from "@/services/calendar";

describe("calendar normalizeEvent", () => {
  it("parses a timed meeting with attendees and a hangout link", () => {
    const event = normalizeEvent({
      id: "e1",
      summary: "Sync",
      status: "confirmed",
      eventType: "default",
      start: { dateTime: "2026-06-26T10:00:00-07:00" },
      end: { dateTime: "2026-06-26T10:30:00-07:00" },
      attendees: [
        { displayName: "Taariq Lewis", email: "t@x.com" },
        { email: "a@b.com" },
      ],
      hangoutLink: "https://meet.google.com/abc",
    });
    expect(event?.title).toBe("Sync");
    expect(event?.attendees).toEqual(["Taariq Lewis", "a@b.com"]);
    expect(event?.meetingUrl).toBe("https://meet.google.com/abc");
    expect(event?.startMs).toBe(Date.parse("2026-06-26T10:00:00-07:00"));
  });

  it("drops cancelled and non-meeting event types", () => {
    expect(
      normalizeEvent({
        status: "cancelled",
        start: { date: "2026-06-26" },
        end: { date: "2026-06-27" },
      }),
    ).toBeNull();
    expect(
      normalizeEvent({
        eventType: "outOfOffice",
        start: { dateTime: "2026-06-26T10:00:00Z" },
        end: { dateTime: "2026-06-26T11:00:00Z" },
      }),
    ).toBeNull();
  });

  it("extracts a zoom link from the location field", () => {
    const event = normalizeEvent({
      summary: "Call",
      eventType: "default",
      start: { dateTime: "2026-06-26T10:00:00Z" },
      end: { dateTime: "2026-06-26T11:00:00Z" },
      location: "Zoom: https://us02web.zoom.us/j/123",
    });
    expect(event?.meetingUrl).toBe("https://us02web.zoom.us/j/123");
  });
});

describe("calendar matchActiveEvent", () => {
  const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
    id: "x",
    title: "T",
    startMs: 0,
    endMs: 0,
    attendees: [],
    meetingUrl: null,
    ...over,
  });

  it("matches an in-window event and prefers one with a join link", () => {
    const now = 1_000_000;
    const noLink = event({ id: "no", startMs: now - 1000, endMs: now + 60_000 });
    const withLink = event({
      id: "yes",
      startMs: now - 1000,
      endMs: now + 60_000,
      meetingUrl: "https://meet.google.com/x",
    });
    expect(matchActiveEvent([noLink, withLink], now)?.id).toBe("yes");
  });

  it("matches during the lead-in, and returns null outside any window", () => {
    const now = 1_000_000;
    const soon = event({
      id: "soon",
      startMs: now + 2 * 60_000,
      endMs: now + 30 * 60_000,
    });
    expect(matchActiveEvent([soon], now)?.id).toBe("soon");
    const later = event({
      id: "later",
      startMs: now + 60 * 60_000,
      endMs: now + 90 * 60_000,
    });
    expect(matchActiveEvent([later], now)).toBeNull();
  });

  it("disambiguates overlapping events by the detected app's link domain", () => {
    const now = 1_000_000;
    const zoom = event({
      id: "zoom",
      startMs: now - 1000,
      endMs: now + 60_000,
      meetingUrl: "https://us02web.zoom.us/j/123",
    });
    const meet = event({
      id: "meet",
      startMs: now - 1000,
      endMs: now + 60_000,
      meetingUrl: "https://meet.google.com/abc",
    });
    expect(matchActiveEvent([zoom, meet], now, "Zoom")?.id).toBe("zoom");
    expect(matchActiveEvent([zoom, meet], now, "Google Chrome")).toBeNull();
  });

  it("returns null for multiple linked overlapping events with no app match", () => {
    const now = 1_000_000;
    const a = event({
      id: "a",
      startMs: now - 1000,
      endMs: now + 60_000,
      meetingUrl: "https://us02web.zoom.us/j/1",
    });
    const b = event({
      id: "b",
      startMs: now - 1000,
      endMs: now + 60_000,
      meetingUrl: "https://meet.google.com/2",
    });
    // No detected app → cannot tell which call is live → leave unmatched
    // rather than stamp the wrong attendees.
    expect(matchActiveEvent([a, b], now)).toBeNull();
  });
});
