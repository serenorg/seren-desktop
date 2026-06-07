// ABOUTME: Unit tests for the resilient summarizer policy (#2106).
// ABOUTME: Fallback model, auth-refresh retry, deterministic fallback, no-drop, cooldown.

import { describe, expect, it, vi } from "vitest";
import {
  buildDeterministicFallbackSummary,
  CompactionCooldown,
  type FallbackTurn,
  runSummarizerWithPolicy,
} from "@/lib/compaction/summarizer-policy";

describe("#2106 runSummarizerWithPolicy", () => {
  it("returns the primary summary on success", async () => {
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      attempt: async () => "GOOD SUMMARY",
    });
    expect(out).toEqual({
      status: "ok",
      summary: "GOOD SUMMARY",
      model: "primary",
      usedFallbackModel: false,
    });
  });

  it("refreshes auth and retries the primary once on an auth error", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("401 Not authenticated"))
      .mockResolvedValueOnce("AFTER REFRESH");
    const refreshAuth = vi.fn(async () => true);
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      attempt,
      isAuthError: (e) => String(e).includes("401"),
      refreshAuth,
    });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.summary).toBe("AFTER REFRESH");
  });

  it("falls back to a secondary model when the primary keeps failing", async () => {
    const attempt = vi.fn(async (model: string) => {
      if (model === "primary") throw new Error("provider 500");
      return "FALLBACK MODEL SUMMARY";
    });
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      attempt,
    });
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.model).toBe("secondary");
      expect(out.usedFallbackModel).toBe(true);
    }
  });

  it("treats an empty/garbage summary as a failure and falls through", async () => {
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      attempt: async () => "   ",
      deterministicFallback: () => "LOCAL FALLBACK",
    });
    expect(out.status).toBe("fallback");
    if (out.status === "fallback") expect(out.summary).toBe("LOCAL FALLBACK");
  });

  it("produces a deterministic fallback when every model attempt fails", async () => {
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      fallbackModels: ["secondary"],
      attempt: async () => {
        throw new Error("everything down");
      },
      deterministicFallback: () => "LOCAL FALLBACK SUMMARY",
    });
    expect(out.status).toBe("fallback");
    if (out.status === "fallback") {
      expect(out.summary).toBe("LOCAL FALLBACK SUMMARY");
      expect(out.reason).toContain("everything down");
    }
  });

  it("aborts (no-drop) when no model and no deterministic fallback can produce a summary", async () => {
    const out = await runSummarizerWithPolicy({
      primaryModel: "primary",
      attempt: async () => {
        throw new Error("provider unavailable");
      },
    });
    expect(out.status).toBe("aborted");
    if (out.status === "aborted") expect(out.reason).toContain("provider unavailable");
  });
});

describe("#2106 buildDeterministicFallbackSummary", () => {
  const turns: FallbackTurn[] = [
    { role: "user", content: "Please refactor the auth module" },
    {
      role: "tool",
      content: "",
      toolName: "read_file",
      toolResult: "contents of src/services/auth.ts",
    },
    { role: "assistant", content: "Looking at the file now" },
    { role: "user", content: "Actually, also update src/stores/auth.store.ts" },
  ];

  it("captures the latest user request, tool names, and resources, marked as fallback", () => {
    const summary = buildDeterministicFallbackSummary(turns);
    expect(summary).toContain("FALLBACK SUMMARY");
    expect(summary).toContain("LATEST_USER_REQUEST: Actually, also update");
    expect(summary).toContain("read_file");
    expect(summary).toContain("src/services/auth.ts");
    // Never asserts completed work.
    expect(summary).toContain("COMPLETED: none verified (fallback)");
  });
});

describe("#2106 CompactionCooldown", () => {
  it("reports cooldown within the window and clears after it expires", () => {
    const cd = new CompactionCooldown();
    cd.enter("conv-1", 1_000, 5_000);
    expect(cd.isCoolingDown("conv-1", 2_000)).toBe(true);
    expect(cd.isCoolingDown("conv-1", 6_001)).toBe(false);
    // A second, unrelated conversation is unaffected.
    expect(cd.isCoolingDown("conv-2", 2_000)).toBe(false);
  });
});
