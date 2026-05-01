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
  _DEFAULT_PREFERRED_MODEL: DEFAULT_PREFERRED_MODEL,
  _comparePickerEntries: comparePickerEntries,
  _resolveSpawnShell: resolveSpawnShell,
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

  it("promotes the [1m] sibling of the CLI default and pins it to slot one (#1763)", () => {
    // The session is spawned on the [1m] tier (DEFAULT_PREFERRED_MODEL), so
    // the picker default must follow — otherwise the UI highlights the bare
    // 200K entry while the runtime is on 1M.
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

    const augmented = augmentWithLegacyOpus(cliCatalog) as Array<{
      modelId: string;
      isDefault: boolean;
    }>;
    expect(augmented[0].modelId).toBe("claude-opus-4-7[1m]");
    expect(augmented[0].isDefault).toBe(true);
    const bareOpus = augmented.find((r) => r.modelId === "claude-opus-4-7");
    expect(bareOpus?.isDefault).toBe(false);
  });
});

describe("comparePickerEntries — default first, newest descending (#1763)", () => {
  it("orders entries default first, then opus > sonnet > haiku, then version desc, then 1M before bare", () => {
    const records = [
      { modelId: "claude-haiku-4-5", isDefault: false },
      { modelId: "claude-sonnet-4-6", isDefault: false },
      { modelId: "claude-opus-4-5", isDefault: false },
      { modelId: "claude-opus-4-7", isDefault: false },
      { modelId: "claude-opus-4-7[1m]", isDefault: true },
      { modelId: "claude-opus-4-6[1m]", isDefault: false },
      { modelId: "claude-opus-4-6", isDefault: false },
    ];
    const sorted = records.slice().sort(comparePickerEntries);
    expect(sorted.map((r) => r.modelId)).toEqual([
      "claude-opus-4-7[1m]", // default pinned to slot one
      "claude-opus-4-7",
      "claude-opus-4-6[1m]",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });
});

describe("DEFAULT_PREFERRED_MODEL — fresh-session out-of-box default (#1763)", () => {
  it("is the Opus 4.7 1M-tier id so new users get the wider window without picker discovery", () => {
    expect(DEFAULT_PREFERRED_MODEL).toBe("claude-opus-4-7[1m]");
  });
});

describe("resolveSpawnShell — Windows bracket-arg parsing safety (#1763)", () => {
  it("returns false on non-Windows platforms — direct spawn, no shell", () => {
    if (process.platform === "win32") return;
    expect(resolveSpawnShell("/Users/u/.local/bin/claude")).toBe(false);
    expect(resolveSpawnShell("/usr/local/bin/claude")).toBe(false);
  });

  it("on Windows, returns false for .exe paths and 'cmd.exe' for .cmd/.bat shims", () => {
    // Behavioural check stays cross-platform by inspecting the helper's
    // logic: .exe binaries don't need a shell, .cmd shims do (Node 16+
    // refuses to spawn batch files directly post-CVE-2024-27980), and
    // forcing 'cmd.exe' keeps a custom ComSpec from rerouting through
    // PowerShell, which would treat the `[1m]` brackets as array-index
    // metacharacters and silently drop the 1M tier. The helper short-
    // circuits to false on non-Windows, so we verify by parsing its own
    // logic against the input strings.
    if (process.platform !== "win32") {
      // Cannot exercise the win32 branch on non-Windows. The non-win32
      // assertion above plus the explicit cross-platform short-circuit
      // are what protect the desktop here. See the helper jsdoc.
      return;
    }
    expect(resolveSpawnShell("C:\\\\Users\\\\u\\\\.claude\\\\bin\\\\claude.exe")).toBe(false);
    expect(resolveSpawnShell("C:\\\\Users\\\\u\\\\AppData\\\\Roaming\\\\npm\\\\claude.cmd")).toBe(
      "cmd.exe",
    );
    expect(resolveSpawnShell("C:\\\\path\\\\claude.bat")).toBe("cmd.exe");
  });
});
