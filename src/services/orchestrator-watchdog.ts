// ABOUTME: Progress watchdog for frontend orchestrator turns.
// ABOUTME: Prevents chat turns from leaving the composer blocked forever.

export const ORCHESTRATOR_STALL_THRESHOLD_MS = 30_000;
export const ORCHESTRATOR_NO_PROGRESS_TIMEOUT_MS = 5 * 60_000;
export const ORCHESTRATOR_WATCHDOG_TICK_MS = 5_000;

export class OrchestratorNoProgressTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorNoProgressTimeoutError";
  }
}

export interface OrchestratorProgressWatchdog {
  markProgress: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  waitForTimeout: () => Promise<never>;
  timedOut: () => boolean;
}

interface WatchdogOptions {
  conversationId: string;
  stallThresholdMs?: number;
  noProgressTimeoutMs?: number;
  tickMs?: number;
  now?: () => number;
  onStallChange: (stalled: boolean, conversationId: string) => void;
  onTimeout?: (conversationId: string) => void | Promise<void>;
  onTimeoutError?: (error: unknown, conversationId: string) => void;
}

function timeoutMessage(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return (
    `The model stopped sending progress for ${minutes} minutes, so Seren ` +
    "stopped this turn and made the chat usable again. Please retry or switch models."
  );
}

export function createOrchestratorProgressWatchdog({
  conversationId,
  stallThresholdMs = ORCHESTRATOR_STALL_THRESHOLD_MS,
  noProgressTimeoutMs = ORCHESTRATOR_NO_PROGRESS_TIMEOUT_MS,
  tickMs = ORCHESTRATOR_WATCHDOG_TICK_MS,
  now = () => Date.now(),
  onStallChange,
  onTimeout,
  onTimeoutError,
}: WatchdogOptions): OrchestratorProgressWatchdog {
  let stopped = false;
  let paused = false;
  let stalled = false;
  let didTimeOut = false;
  let lastProgressAt = now();
  let rejectTimeout: (error: OrchestratorNoProgressTimeoutError) => void = () =>
    undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  const clearStall = () => {
    if (!stalled) return;
    stalled = false;
    onStallChange(false, conversationId);
  };

  const timer = setInterval(() => {
    if (stopped || paused) return;

    const quietMs = now() - lastProgressAt;
    if (quietMs >= noProgressTimeoutMs) {
      stopped = true;
      didTimeOut = true;
      clearInterval(timer);
      clearStall();
      void Promise.resolve(onTimeout?.(conversationId)).catch((error) => {
        onTimeoutError?.(error, conversationId);
      });
      rejectTimeout(
        new OrchestratorNoProgressTimeoutError(
          timeoutMessage(noProgressTimeoutMs),
        ),
      );
      return;
    }

    if (!stalled && quietMs >= stallThresholdMs) {
      stalled = true;
      onStallChange(true, conversationId);
    }
  }, tickMs);

  return {
    markProgress() {
      if (stopped) return;
      lastProgressAt = now();
      clearStall();
    },
    pause() {
      if (stopped) return;
      paused = true;
      clearStall();
    },
    resume() {
      if (stopped) return;
      paused = false;
      lastProgressAt = now();
      clearStall();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearStall();
    },
    waitForTimeout() {
      return timeoutPromise;
    },
    timedOut() {
      return didTimeOut;
    },
  };
}
