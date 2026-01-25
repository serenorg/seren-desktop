// ABOUTME: Rate limiter utility to prevent flooding telemetry endpoints.
// ABOUTME: Deduplicates identical errors and limits reports per time window.

interface ErrorEntry {
  count: number;
  firstSeen: number;
  lastSeen: number;
}

interface RateLimiterConfig {
  /** Maximum errors per time window */
  maxErrors: number;
  /** Time window in milliseconds */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxErrors: 10,
  windowMs: 60_000, // 1 minute
};

/**
 * Rate limiter for error telemetry.
 * Prevents flooding by limiting errors per time window and deduplicating identical errors.
 */
export class RateLimiter {
  private errors: Map<string, ErrorEntry> = new Map();
  private windowStart: number = Date.now();
  private totalInWindow: number = 0;
  private config: RateLimiterConfig;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if an error should be reported.
   * @param errorKey - Unique identifier for the error (e.g., message + stack hash)
   * @returns true if the error should be reported, false if rate limited
   */
  shouldReport(errorKey: string): boolean {
    this.maybeResetWindow();

    // Check global rate limit
    if (this.totalInWindow >= this.config.maxErrors) {
      return false;
    }

    const entry = this.errors.get(errorKey);
    const now = Date.now();

    if (entry) {
      // Duplicate error - update count but don't report
      entry.count++;
      entry.lastSeen = now;
      return false;
    }

    // New error - track and allow reporting
    this.errors.set(errorKey, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
    });
    this.totalInWindow++;
    return true;
  }

  /**
   * Get the count of occurrences for an error key.
   */
  getCount(errorKey: string): number {
    return this.errors.get(errorKey)?.count ?? 0;
  }

  /**
   * Get all error entries with their counts for batch reporting.
   * Useful for sending aggregated counts at end of window.
   */
  getErrorSummary(): Map<string, ErrorEntry> {
    return new Map(this.errors);
  }

  /**
   * Get total unique errors in current window.
   */
  getTotalInWindow(): number {
    return this.totalInWindow;
  }

  /**
   * Reset the rate limiter state.
   */
  reset(): void {
    this.errors.clear();
    this.windowStart = Date.now();
    this.totalInWindow = 0;
  }

  /**
   * Check if window has expired and reset if needed.
   */
  private maybeResetWindow(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.config.windowMs) {
      this.reset();
    }
  }
}

/**
 * Generate a unique key for an error based on message and stack.
 */
export function getErrorKey(error: Error): string {
  const message = error.message || "Unknown error";
  const stackFirstLine = error.stack?.split("\n")[1]?.trim() || "";
  return `${message}|${stackFirstLine}`;
}

// Default singleton instance
export const errorRateLimiter = new RateLimiter();
