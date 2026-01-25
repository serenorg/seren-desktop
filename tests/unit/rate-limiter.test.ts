// ABOUTME: Unit tests for the RateLimiter utility.
// ABOUTME: Ensures rate limiting and deduplication work correctly for telemetry.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { RateLimiter, getErrorKey } from "@/lib/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxErrors: 5, windowMs: 60_000 });
  });

  describe("shouldReport", () => {
    it("allows first occurrence of an error", () => {
      expect(limiter.shouldReport("error-1")).toBe(true);
    });

    it("blocks duplicate errors", () => {
      limiter.shouldReport("error-1");
      expect(limiter.shouldReport("error-1")).toBe(false);
    });

    it("allows different errors", () => {
      expect(limiter.shouldReport("error-1")).toBe(true);
      expect(limiter.shouldReport("error-2")).toBe(true);
    });

    it("respects max errors per window", () => {
      for (let i = 0; i < 5; i++) {
        expect(limiter.shouldReport(`error-${i}`)).toBe(true);
      }
      // 6th error should be blocked
      expect(limiter.shouldReport("error-5")).toBe(false);
    });

    it("resets after window expires", () => {
      vi.useFakeTimers();

      limiter.shouldReport("error-1");
      expect(limiter.shouldReport("error-1")).toBe(false);

      // Advance time past window
      vi.advanceTimersByTime(60_001);

      // Same error should be allowed again
      expect(limiter.shouldReport("error-1")).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("getCount", () => {
    it("returns 0 for unknown errors", () => {
      expect(limiter.getCount("unknown")).toBe(0);
    });

    it("tracks occurrence count", () => {
      limiter.shouldReport("error-1");
      expect(limiter.getCount("error-1")).toBe(1);

      limiter.shouldReport("error-1");
      expect(limiter.getCount("error-1")).toBe(2);

      limiter.shouldReport("error-1");
      expect(limiter.getCount("error-1")).toBe(3);
    });
  });

  describe("getTotalInWindow", () => {
    it("tracks unique errors in window", () => {
      expect(limiter.getTotalInWindow()).toBe(0);

      limiter.shouldReport("error-1");
      expect(limiter.getTotalInWindow()).toBe(1);

      // Duplicate doesn't increase total
      limiter.shouldReport("error-1");
      expect(limiter.getTotalInWindow()).toBe(1);

      // New error increases total
      limiter.shouldReport("error-2");
      expect(limiter.getTotalInWindow()).toBe(2);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      limiter.shouldReport("error-1");
      limiter.shouldReport("error-1");
      expect(limiter.getCount("error-1")).toBe(2);
      expect(limiter.getTotalInWindow()).toBe(1);

      limiter.reset();

      expect(limiter.getCount("error-1")).toBe(0);
      expect(limiter.getTotalInWindow()).toBe(0);
      expect(limiter.shouldReport("error-1")).toBe(true);
    });
  });

  describe("getErrorSummary", () => {
    it("returns all error entries", () => {
      limiter.shouldReport("error-1");
      limiter.shouldReport("error-1");
      limiter.shouldReport("error-2");

      const summary = limiter.getErrorSummary();

      expect(summary.size).toBe(2);
      expect(summary.get("error-1")?.count).toBe(2);
      expect(summary.get("error-2")?.count).toBe(1);
    });
  });
});

describe("getErrorKey", () => {
  it("generates key from error message and stack", () => {
    const error = new Error("Test error");
    const key = getErrorKey(error);
    expect(key).toContain("Test error");
  });

  it("handles errors without stack", () => {
    const error = new Error("No stack");
    error.stack = undefined;
    const key = getErrorKey(error);
    expect(key).toBe("No stack|");
  });

  it("handles errors without message", () => {
    const error = new Error();
    const key = getErrorKey(error);
    expect(key).toContain("Unknown error");
  });

  it("generates different keys for different errors", () => {
    const error1 = new Error("Error 1");
    const error2 = new Error("Error 2");
    expect(getErrorKey(error1)).not.toBe(getErrorKey(error2));
  });
});
