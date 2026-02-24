// ABOUTME: Error telemetry service for reporting errors to Seren Gateway.
// ABOUTME: Captures unhandled errors, scrubs PII, rate limits, and batches reports.

import { API_BASE } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getErrorKey, RateLimiter } from "@/lib/rate-limiter";
import { scrubSensitive } from "@/lib/scrub-sensitive";
import { getToken } from "@/lib/tauri-bridge";

export interface ErrorReport {
  message: string;
  stack?: string;
  timestamp: string;
  appVersion: string;
  platform: string;
  context?: Record<string, unknown>;
  occurrences?: number;
}

interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Batch interval in milliseconds */
  batchIntervalMs: number;
  /** Maximum errors per batch */
  maxBatchSize: number;
}

const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: true,
  batchIntervalMs: 30_000, // 30 seconds
  maxBatchSize: 20,
};

class TelemetryService {
  private config: TelemetryConfig;
  private rateLimiter: RateLimiter;
  private errorQueue: ErrorReport[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private errorHandler: ((event: ErrorEvent) => void) | null = null;
  private rejectionHandler: ((event: PromiseRejectionEvent) => void) | null =
    null;

  constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rateLimiter = new RateLimiter();
  }

  /**
   * Initialize telemetry service and attach global error handlers.
   */
  init(): void {
    if (this.initialized || !this.config.enabled) return;

    // Global error handler
    this.errorHandler = (event: ErrorEvent) => {
      this.captureError(event.error || new Error(event.message), {
        type: "uncaught",
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };
    window.addEventListener("error", this.errorHandler);

    // Unhandled promise rejection handler
    this.rejectionHandler = (event: PromiseRejectionEvent) => {
      const error =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      this.captureError(error, { type: "unhandledrejection" });
    };
    window.addEventListener("unhandledrejection", this.rejectionHandler);

    // Start batch processing
    this.startBatchTimer();
    this.initialized = true;
  }

  /**
   * Capture an error for telemetry.
   */
  captureError(error: Error, context?: Record<string, unknown>): void {
    if (!this.config.enabled) return;

    const errorKey = getErrorKey(error);

    // Check rate limit
    if (!this.rateLimiter.shouldReport(errorKey)) {
      return;
    }

    const report: ErrorReport = {
      message: scrubSensitive(error.message || "Unknown error"),
      stack: error.stack ? scrubSensitive(error.stack) : undefined,
      timestamp: new Date().toISOString(),
      appVersion: this.getAppVersion(),
      platform: this.getPlatform(),
      context: context ? scrubContext(context) : undefined,
    };

    this.errorQueue.push(report);

    // Flush immediately if queue is full
    if (this.errorQueue.length >= this.config.maxBatchSize) {
      this.flush();
    }
  }

  /**
   * Manually report an error (for try/catch scenarios).
   */
  reportError(error: Error, context?: Record<string, unknown>): void {
    this.captureError(error, context);
  }

  /**
   * Send queued errors to the server.
   */
  async flush(): Promise<void> {
    if (this.errorQueue.length === 0) return;

    const batch = this.errorQueue.splice(0, this.config.maxBatchSize);

    try {
      const token = await getToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      await appFetch(`${API_BASE}/diagnostics/errors`, {
        method: "POST",
        headers,
        body: JSON.stringify({ errors: batch }),
      });
    } catch {
      // Silently fail - don't want telemetry errors to cause more errors
      // Put errors back in queue for retry (up to max size)
      const remaining = this.config.maxBatchSize - this.errorQueue.length;
      if (remaining > 0) {
        this.errorQueue.unshift(...batch.slice(0, remaining));
      }
    }
  }

  /**
   * Enable or disable telemetry.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (!enabled) {
      this.stopBatchTimer();
      this.errorQueue = [];
    } else if (this.initialized) {
      this.startBatchTimer();
    }
  }

  /**
   * Check if telemetry is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Shutdown telemetry service.
   */
  shutdown(): void {
    if (this.errorHandler) {
      window.removeEventListener("error", this.errorHandler);
      this.errorHandler = null;
    }
    if (this.rejectionHandler) {
      window.removeEventListener("unhandledrejection", this.rejectionHandler);
      this.rejectionHandler = null;
    }
    this.stopBatchTimer();
    this.flush();
    this.initialized = false;
  }

  private startBatchTimer(): void {
    if (this.batchTimer) return;
    this.batchTimer = setInterval(() => {
      this.flush();
    }, this.config.batchIntervalMs);
  }

  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  private getAppVersion(): string {
    // Could be injected at build time via Vite
    return import.meta.env.VITE_APP_VERSION || "0.0.0";
  }

  private getPlatform(): string {
    const ua = navigator.userAgent;
    if (ua.includes("Mac")) return "macos";
    if (ua.includes("Windows")) return "windows";
    if (ua.includes("Linux")) return "linux";
    return "unknown";
  }
}

/**
 * Recursively scrub string values in a context object before telemetry.
 */
function scrubContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (typeof value === "string") {
      scrubbed[key] = scrubSensitive(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      scrubbed[key] = scrubContext(value as Record<string, unknown>);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

// Default singleton instance
export const telemetry = new TelemetryService();
