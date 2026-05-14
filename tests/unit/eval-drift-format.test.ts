// ABOUTME: Tests the pure helpers behind eval-drift rendering: delta sign and tone selection.
// ABOUTME: Also covers the relative-time helper used by the checkpoints list.

import { describe, expect, it } from "vitest";
import { formatDriftDelta } from "@/lib/employees/eval-drift-format";
import { formatRelativeTime } from "@/lib/employees/relative-time";

describe("formatDriftDelta", () => {
  it("returns null when delta is undefined or NaN", () => {
    expect(formatDriftDelta(undefined, false)).toBeNull();
    expect(formatDriftDelta(null, true)).toBeNull();
    expect(formatDriftDelta(Number.NaN, false)).toBeNull();
  });

  it("returns neutral tone when delta is zero", () => {
    expect(formatDriftDelta(0, false)).toEqual({
      text: "no change",
      tone: "neutral",
    });
  });

  it("tints positive deltas as 'good' when higher is better", () => {
    expect(formatDriftDelta(3, false)).toEqual({ text: "up 3", tone: "good" });
  });

  it("tints positive deltas as 'warn' when lower is better", () => {
    expect(formatDriftDelta(2, true)).toEqual({ text: "up 2", tone: "warn" });
  });

  it("tints negative deltas as 'warn' when higher is better", () => {
    expect(formatDriftDelta(-1, false)).toEqual({
      text: "down 1",
      tone: "warn",
    });
  });

  it("tints negative deltas as 'good' when lower is better", () => {
    expect(formatDriftDelta(-5, true)).toEqual({
      text: "down 5",
      tone: "good",
    });
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.parse("2026-05-14T12:00:00Z");
  const iso = (offsetSec: number) =>
    new Date(NOW - offsetSec * 1000).toISOString();

  it("renders 'just now' for very recent timestamps", () => {
    expect(formatRelativeTime(iso(0), NOW)).toBe("just now");
    expect(formatRelativeTime(iso(1), NOW)).toBe("just now");
  });

  it("renders seconds plural beyond 1s", () => {
    expect(formatRelativeTime(iso(30), NOW)).toBe("30 seconds ago");
  });

  it("renders minutes with singular and plural", () => {
    expect(formatRelativeTime(iso(60), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(iso(60 * 5), NOW)).toBe("5 minutes ago");
  });

  it("renders hours", () => {
    expect(formatRelativeTime(iso(3600), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(iso(3600 * 3), NOW)).toBe("3 hours ago");
  });

  it("renders days under a week", () => {
    expect(formatRelativeTime(iso(86400), NOW)).toBe("1 day ago");
    expect(formatRelativeTime(iso(86400 * 2), NOW)).toBe("2 days ago");
  });

  it("falls back to a locale date past a week", () => {
    const out = formatRelativeTime(iso(86400 * 30), NOW);
    expect(out).not.toMatch(/days ago/);
  });

  it("returns a stable fallback for bad input", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("moments ago");
  });
});
