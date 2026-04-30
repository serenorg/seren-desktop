// ABOUTME: Critical test for #1758 — normalizeTurnUsage forwards modelContextWindow.
// ABOUTME: Without this, predictive compaction never fires for Codex sessions.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/providers.mjs",
  import.meta.url,
).href;
const { normalizeTurnUsage } = await import(/* @vite-ignore */ modulePath);

const breakdown = (overrides: Record<string, number> = {}) => ({
  inputTokens: 15670,
  cachedInputTokens: 6528,
  outputTokens: 21,
  reasoningOutputTokens: 14,
  totalTokens: 15691,
  ...overrides,
});

describe("normalizeTurnUsage", () => {
  it("forwards modelContextWindow as meta.contextWindow when CLI reports it", () => {
    const meta = normalizeTurnUsage({
      last: breakdown(),
      total: breakdown(),
      modelContextWindow: 258_400,
    });
    expect(meta).toEqual({
      usage: { input_tokens: 15670, output_tokens: 21 },
      contextWindow: 258_400,
    });
  });

  it("omits contextWindow when modelContextWindow is null", () => {
    const meta = normalizeTurnUsage({
      last: breakdown(),
      total: breakdown(),
      modelContextWindow: null,
    });
    expect(meta).toEqual({
      usage: { input_tokens: 15670, output_tokens: 21 },
    });
    expect(meta.contextWindow).toBeUndefined();
  });

  it("omits contextWindow when modelContextWindow is missing", () => {
    const meta = normalizeTurnUsage({
      last: breakdown(),
      total: breakdown(),
    });
    expect(meta.contextWindow).toBeUndefined();
  });

  it("rejects zero or negative modelContextWindow as invalid signal", () => {
    expect(
      normalizeTurnUsage({
        last: breakdown(),
        total: breakdown(),
        modelContextWindow: 0,
      }).contextWindow,
    ).toBeUndefined();
    expect(
      normalizeTurnUsage({
        last: breakdown(),
        total: breakdown(),
        modelContextWindow: -1,
      }).contextWindow,
    ).toBeUndefined();
  });

  it("falls back to total when last is missing", () => {
    const meta = normalizeTurnUsage({
      total: breakdown({ inputTokens: 999, outputTokens: 11 }),
      modelContextWindow: 258_400,
    });
    expect(meta).toEqual({
      usage: { input_tokens: 999, output_tokens: 11 },
      contextWindow: 258_400,
    });
  });

  it("returns undefined when both last and total are missing", () => {
    expect(normalizeTurnUsage({ modelContextWindow: 258_400 })).toBeUndefined();
    expect(normalizeTurnUsage(undefined)).toBeUndefined();
    expect(normalizeTurnUsage(null)).toBeUndefined();
  });
});
