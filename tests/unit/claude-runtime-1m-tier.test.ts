// ABOUTME: Critical guards for #1761 — Claude Code 1M context tier translation.
// ABOUTME: Verifies bare IDs default to 200K and only [1m]-suffixed IDs unlock 1M.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const {
  _inferClaudeContextWindow: inferClaudeContextWindow,
  _augmentWithLegacyOpus: augmentWithLegacyOpus,
  _ONE_M_TIER_RECORDS: ONE_M_TIER_RECORDS,
} = await import(/* @vite-ignore */ modulePath);

describe("inferClaudeContextWindow — tier-aware semantics", () => {
  it("returns 200K for bare 1M-capable opus IDs (no [1m] suffix)", () => {
    // Anthropic gates the 1M tier on the [1m] suffix. A bare claude-opus-4-7
    // request lands on the 200K tier upstream. The desktop's cold-start
    // default must match that reality so the gauge denominator is honest
    // when the user picks the bare entry.
    expect(inferClaudeContextWindow("claude-opus-4-7")).toBe(200_000);
    expect(inferClaudeContextWindow("claude-opus-4-6")).toBe(200_000);
    expect(inferClaudeContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });

  it("returns 1M only for [1m]-suffixed 1M-capable IDs", () => {
    expect(inferClaudeContextWindow("claude-opus-4-7[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("claude-opus-4-6[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("claude-opus-4-5[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("claude-sonnet-4-7[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(inferClaudeContextWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });

  it("strips Anthropic's date suffix before the 1M-tier lookup", () => {
    // The CLI keys modelUsage by the resolved API id, which can include a
    // YYYYMMDD suffix (e.g. claude-opus-4-7-20251201[1m]). The lookup must
    // canonicalize before comparing against CLAUDE_1M_TIER_CAPABLE_MODELS.
    expect(inferClaudeContextWindow("claude-opus-4-7-20251201[1m]")).toBe(
      1_000_000,
    );
    expect(inferClaudeContextWindow("claude-opus-4-7-20251201")).toBe(200_000);
  });

  it("returns undefined for non-Claude or unknown IDs", () => {
    expect(inferClaudeContextWindow("")).toBeUndefined();
    expect(inferClaudeContextWindow("gpt-5")).toBeUndefined();
    expect(inferClaudeContextWindow(undefined)).toBeUndefined();
    expect(inferClaudeContextWindow(null)).toBeUndefined();
  });
});

describe("augmentWithLegacyOpus — picker exposes 1M-tier variants", () => {
  it("prepends a [1m] entry only when the bare base is in the catalog", () => {
    // The CLI catalog is the source of truth for which models the user can
    // actually run. We never advertise a 1M variant of a model the active
    // CLI doesn't ship — the alternative is a picker entry that produces a
    // silent API failure when selected.
    const cliCatalog = [
      {
        modelId: "claude-opus-4-7",
        name: "Opus 4.7",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        isDefault: true,
      },
      {
        modelId: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        isDefault: false,
      },
    ];

    const augmented = augmentWithLegacyOpus(cliCatalog);
    const ids = augmented.map((r: { modelId: string }) => r.modelId);

    expect(ids).toContain("claude-opus-4-7[1m]");
    expect(ids).toContain("claude-sonnet-4-6[1m]");
    // claude-sonnet-4-7 is not in the CLI catalog and not in LEGACY_OPUS_RECORDS
    // → its [1m] variant must NOT appear so we don't make a false promise.
    expect(ids).not.toContain("claude-sonnet-4-7[1m]");
  });

  it("does not duplicate [1m] entries the CLI already advertises", () => {
    const cliCatalog = [
      {
        modelId: "claude-opus-4-7",
        name: "Opus 4.7",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        isDefault: true,
      },
      {
        modelId: "claude-opus-4-7[1m]",
        name: "Opus 4.7 (1M)",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        isDefault: false,
      },
    ];

    const augmented = augmentWithLegacyOpus(cliCatalog);
    const oneMCount = augmented.filter(
      (r: { modelId: string }) => r.modelId === "claude-opus-4-7[1m]",
    ).length;
    expect(oneMCount).toBe(1);
  });

  it("ONE_M_TIER_RECORDS covers the same set as CLAUDE_1M_TIER_CAPABLE_MODELS", () => {
    // The runtime picker entries and the desktop store's tier table must
    // agree on which bare IDs unlock 1M. A divergence here means a picker
    // entry the desktop won't recognize as 1M-capable, or vice versa.
    const oneMBareIds = [
      ...(ONE_M_TIER_RECORDS as Array<{ modelId: string }>).map((r) =>
        r.modelId.replace(/\[1m\]$/i, ""),
      ),
    ].sort();
    expect(oneMBareIds).toEqual([
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-7",
    ]);
  });
});
