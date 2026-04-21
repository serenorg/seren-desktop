// ABOUTME: Critical tests for #1611 — peak-per-turn input token tracking.
// ABOUTME: Guards the context gauge + auto-compact threshold against averaged undercounts.

import { describe, expect, it } from "vitest";

const usageModulePath = new URL(
  "../../bin/browser-local/usage.mjs",
  import.meta.url,
).href;
const { perTurnInputTokens, updatePeakInputTokens } = await import(
  /* @vite-ignore */ usageModulePath
);

describe("perTurnInputTokens", () => {
  it("sums input + cache_creation + cache_read because all three count toward the context window", () => {
    expect(
      perTurnInputTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 95000,
        output_tokens: 500,
      }),
    ).toBe(97100);
  });

  it.each([
    { value: null, note: "null" },
    { value: undefined, note: "missing" },
    { value: "garbage", note: "non-object" },
    { value: {}, note: "empty object" },
    { value: { input_tokens: -5 }, note: "negative value" },
    { value: { input_tokens: "100" }, note: "string value" },
    { value: { input_tokens: NaN }, note: "NaN" },
  ])("returns 0 for $note (fail-closed)", ({ value }) => {
    expect(perTurnInputTokens(value as unknown as Record<string, number>)).toBe(
      0,
    );
  });
});

describe("updatePeakInputTokens", () => {
  it("retains the peak when later turns are smaller — the whole point of #1611", () => {
    // Simulate a prompt with 3 tool-call turns: early turn large, later turns
    // smaller. Averaging would hide turn 2; peak tracking must keep it.
    let peak = 0;
    peak = updatePeakInputTokens(peak, { input_tokens: 50_000 });
    peak = updatePeakInputTokens(peak, { input_tokens: 180_000 });
    peak = updatePeakInputTokens(peak, { input_tokens: 40_000 });
    expect(peak).toBe(180_000);
  });

  it("handles missing usage without dropping the prior peak", () => {
    expect(updatePeakInputTokens(95_000, null)).toBe(95_000);
    expect(updatePeakInputTokens(95_000, undefined)).toBe(95_000);
  });

  it("treats a non-numeric prior peak as zero (defensive)", () => {
    expect(
      updatePeakInputTokens(undefined as unknown as number, {
        input_tokens: 1000,
      }),
    ).toBe(1000);
  });
});
