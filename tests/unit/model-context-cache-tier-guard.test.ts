// ABOUTME: Critical guard for #1769 — recordModelContextWindow must refuse to
// ABOUTME: persist sub-1M values for [1m]-suffixed models so the cache cannot poison future sessions.
// ABOUTME: #2040 extends the same invariant to reads — a sub-1M cache entry that pre-dates #1769 must be discarded.

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

describe("#2040 — getCachedModelContextWindow tier-read guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("rejects a poisoned <1M cache read for a [1m]-suffixed model and returns null", async () => {
    // The #1769 write guard cannot retroactively repair entries persisted
    // before its introduction. Spawn-time falls back to the cache first
    // (agent.store.ts:2833), and #1798's promptComplete guard refuses to
    // overwrite a spawn-time value when the CLI later reports a smaller
    // window. Without a read-side guard, one poisoned 200K pins the session
    // denominator at 200K for life — exactly the SIGTERM trigger in #2040.
    mockInvoke.mockResolvedValueOnce(200_000);
    const { getCachedModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    const result = await getCachedModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
    );
    expect(result).toBeNull();
  });

  it("returns valid 1M cache reads for [1m]-suffixed models unchanged", async () => {
    // Defense against over-correction: a legitimately-stored 1M entry must
    // pass through. Rejecting it would force every cold-start to re-derive
    // the window via defaultContextWindowFor, which is correct today (1M)
    // but couples the cache layer to that assumption.
    mockInvoke.mockResolvedValueOnce(1_000_000);
    const { getCachedModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    const result = await getCachedModelContextWindow(
      "claude-code",
      "claude-opus-4-7[1m]",
    );
    expect(result).toBe(1_000_000);
  });

  it("returns bare-tier 200K cache reads unchanged", async () => {
    // The read guard is gated on the [1m] suffix because bare IDs genuinely
    // sit on the 200K tier per claude-runtime-1m-tier.test.ts:20-28.
    // Rejecting bare 200K reads would break the cache for the un-suffixed
    // picker entries.
    mockInvoke.mockResolvedValueOnce(200_000);
    const { getCachedModelContextWindow } = await import(
      "@/services/modelContextCache"
    );
    const result = await getCachedModelContextWindow(
      "claude-code",
      "claude-opus-4-7",
    );
    expect(result).toBe(200_000);
  });
});
