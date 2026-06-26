// ABOUTME: Critical regression tests for stalled chat-model turn recovery.
// ABOUTME: Keeps the normal orchestrator path from leaving chat stuck loading.

import { describe, expect, it, vi } from "vitest";
import {
  createOrchestratorProgressWatchdog,
  OrchestratorNoProgressTimeoutError,
} from "@/services/orchestrator-watchdog";

describe("orchestrator progress watchdog", () => {
  it("marks stalls, clears on progress, pauses for tool approval, and times out", async () => {
    vi.useFakeTimers();
    let now = 0;
    const stalls: boolean[] = [];
    const onTimeout = vi.fn();

    const watchdog = createOrchestratorProgressWatchdog({
      conversationId: "conv-2661",
      stallThresholdMs: 100,
      noProgressTimeoutMs: 300,
      tickMs: 50,
      now: () => now,
      onStallChange: (stalled) => stalls.push(stalled),
      onTimeout,
    });

    now = 100;
    await vi.advanceTimersByTimeAsync(50);
    expect(stalls).toEqual([true]);

    watchdog.markProgress();
    expect(stalls).toEqual([true, false]);

    watchdog.pause();
    now = 10_000;
    await vi.advanceTimersByTimeAsync(500);
    expect(onTimeout).not.toHaveBeenCalled();

    watchdog.resume();
    now = 10_300;
    const timeoutPromise = watchdog.waitForTimeout();
    const timeoutExpectation = expect(timeoutPromise).rejects.toBeInstanceOf(
      OrchestratorNoProgressTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(50);

    await timeoutExpectation;
    expect(onTimeout).toHaveBeenCalledWith("conv-2661");
    expect(watchdog.timedOut()).toBe(true);

    vi.useRealTimers();
  });
});
