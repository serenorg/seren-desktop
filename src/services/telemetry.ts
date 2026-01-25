// ABOUTME: Error telemetry service for reporting errors to Seren Gateway.
// ABOUTME: Captures unhandled errors, scrubs PII, rate limits, and batches reports.

import { API_BASE } from "@/lib/config";
import { scrubSensitive } from "@/lib/scrub-sensitive";
import { RateLimiter, getErrorKey } from "@/lib/rate-limiter";
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
    window.addEventListener("error", (event) => {
      this.captureError(event.error || new Error(event.message), {
        type: "uncaught",
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    });

    // Unhandled promise rejection handler
    window.addEventListener("unhandledrejection", (event) => {
      const error =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      this.captureError(error, { type: "unhandledrejection" });
    });

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
      context,
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
        headers["Authorization"] = `Bearer ${token}`;
      }

      await fetch(`${API_BASE}/diagnostics/errors`, {
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

// Default singleton instance
export const telemetry = new TelemetryService();
