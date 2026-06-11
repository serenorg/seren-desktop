// ABOUTME: Coverage for #2344 — meeting list/detail must show a date, not just time.
// ABOUTME: formatMeetingDate maps recent dates to Today/Yesterday and falls back to a calendar date.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMeetingDate } from "@/lib/meeting-format";

function at(year: number, month: number, day: number, h = 12, m = 0): number {
  return new Date(year, month - 1, day, h, m).getTime();
}

describe("formatMeetingDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 11, 9, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Today for a meeting started earlier the same day", () => {
    expect(formatMeetingDate(at(2026, 6, 11, 7, 35))).toBe("Today");
  });

  it("returns Yesterday for a meeting started the previous calendar day", () => {
    expect(formatMeetingDate(at(2026, 6, 10, 23, 59))).toBe("Yesterday");
  });

  it("returns a same-year calendar date for older meetings", () => {
    expect(formatMeetingDate(at(2026, 1, 4))).toMatch(/Jan\b.*\b4\b/);
  });

  it("includes the year when the meeting is from a previous year", () => {
    expect(formatMeetingDate(at(2024, 12, 30))).toMatch(/2024/);
  });
});
