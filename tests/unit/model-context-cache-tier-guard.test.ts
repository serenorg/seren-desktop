// ABOUTME: Critical guard for #1769 — recordModelContextWindow must refuse to
// ABOUTME: persist sub-1M values for [1m]-suffixed models so the cache cannot poison future sessions.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockCaptureSupportError = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/lib/support/hook", () => ({
  captureSupportError: mockCaptureSupportError,
}));

describe("#1769 — recordModelContextWindow tier-downgrade guard", () => {
  beforeEach(() => {
    // Module-level dedup Set must reset between cases so each test starts
    // with a clean alert state. Without this, a prior test's alert would
    // hide the next test's expected fire.
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("refuses to persist a 200K window for a [1m]-suffixed model and fires the mismatch alarm", async () => {
    const { recordModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    await recordModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
      200_000,
    );
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockCaptureSupportError).toHaveBeenCalledTimes(1);
    expect(mockCaptureSupportError.mock.calls[0][0]).toMatchObject({
      kind: "agent.context_window_tier_mismatch",
      agentContext: {
        model: "claude-opus-4-7[1m]",
        provider: "claude-code",
      },
    });
  });

  it("dedups the alarm to one capture per (provider, modelId) within a process lifetime", async () => {
    const { recordModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    await recordModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
      200_000,
    );
    await recordModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
      150_000,
    );
    // Same (provider, modelId) key on both calls — only one ticket should
    // open even though the cache layer refused twice.
    expect(mockCaptureSupportError).toHaveBeenCalledTimes(1);
  });

  it("persists the value when the [1m] model reports the full 1M window", async () => {
    const { recordModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    await recordModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
      1_000_000,
    );
    expect(mockInvoke).toHaveBeenCalledWith("record_model_context_window", {
      provider: "claude-code",
      modelId: "claude-opus-4-7[1m]",
      contextWindow: 1_000_000,
    });
    expect(mockCaptureSupportError).not.toHaveBeenCalled();
  });

  it("persists sub-1M values for bare (200K-tier) Claude IDs without alarming", async () => {
    // The guard is gated on the [1m] suffix because Anthropic's bare IDs
    // genuinely sit on the 200K tier — refusing those would break the cache
    // for the unsuffixed picker entries.
    const { recordModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    await recordModelContextWindow(
      "claude-code",
      "claude-opus-4-7",
      200_000,
    );
    expect(mockInvoke).toHaveBeenCalledWith("record_model_context_window", {
      provider: "claude-code",
      modelId: "claude-opus-4-7",
      contextWindow: 200_000,
    });
    expect(mockCaptureSupportError).not.toHaveBeenCalled();
  });
});
