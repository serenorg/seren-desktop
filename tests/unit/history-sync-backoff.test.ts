// ABOUTME: Verifies exponential backoff math for the history sync scheduler.
// ABOUTME: Regression guard for #2255 — scheduled sync hot-looped on repeated failure.

import { describe, expect, it } from "vitest";
import { nextSyncDelayMs } from "@/services/historySync";

describe("nextSyncDelayMs", () => {
  const BASE = 15_000;
  const CAP = 5 * 60_000;

  it("returns the base delay when there are no failures", () => {
    expect(nextSyncDelayMs(BASE, 0, CAP)).toBe(BASE);
  });

  it("doubles the delay on each failure", () => {
    expect(nextSyncDelayMs(BASE, 1, CAP)).toBe(BASE * 2);
    expect(nextSyncDelayMs(BASE, 2, CAP)).toBe(BASE * 4);
    expect(nextSyncDelayMs(BASE, 3, CAP)).toBe(BASE * 8);
  });

  it("clamps to the cap so a poison-pill row cannot stall indefinitely past the cap", () => {
    expect(nextSyncDelayMs(BASE, 16, CAP)).toBe(CAP);
    expect(nextSyncDelayMs(BASE, 100, CAP)).toBe(CAP);
  });
});
