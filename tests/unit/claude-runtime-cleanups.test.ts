// ABOUTME: Regression guards for #1754 (meta.contextWindow inference fallback)
// ABOUTME: and #1755 (chooseUpdatedModelId no-op log suppression).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntime = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#1754 — Claude provider runtime infers contextWindow when CLI omits modelUsage", () => {
  it("inferClaudeContextWindow exists and enumerates known 1M-tier Claude IDs", () => {
    // The 1M Claude variants must be enumerated here so a fresh session on
    // claude-opus-4-7 reports its real window even when the CLI's result
    // event has empty modelUsage. The set must mirror CLAUDE_1M_MODELS in
    // src/stores/agent.store.ts so the runtime and the store agree on
    // cold-start defaults.
    expect(claudeRuntime).toContain("function inferClaudeContextWindow(");
    expect(claudeRuntime).toContain('"claude-opus-4-7"');
    expect(claudeRuntime).toContain('"claude-opus-4-6"');
    expect(claudeRuntime).toContain('"claude-sonnet-4-7"');
    expect(claudeRuntime).toContain('"claude-sonnet-4-6"');
  });

  it("inferClaudeContextWindow handles the [1m] suffix variant", () => {
    // The CLI advertises the 1M tier as a bracketed suffix
    // (`claude-opus-4-7[1m]`). The helper must accept the suffix form so a
    // brand-new model that has not yet been added to the explicit set still
    // reports the right window via the suffix path.
    const fnStart = claudeRuntime.indexOf("function inferClaudeContextWindow(");
    const fnEnd = claudeRuntime.indexOf("\n}\n", fnStart);
    const fnBody = claudeRuntime.slice(fnStart, fnEnd);
    expect(fnBody).toContain("\\[1m\\]");
    expect(fnBody).toMatch(/return\s+1_000_000/);
    expect(fnBody).toMatch(/return\s+200_000/);
  });

  it("buildPromptMeta takes a fallbackModelId and uses inference when modelUsage lacks contextWindow", () => {
    // The pre-fix code only read result.modelUsage[0].contextWindow. When
    // the CLI omitted modelUsage entirely (single-turn shortcuts, abort
    // paths), no meta.contextWindow was emitted and the desktop store
    // stayed at the cold-start default — premature auto-compaction
    // followed. The helper must accept a fallback model id and fall back
    // to inferClaudeContextWindow when modelUsage doesn't carry one.
    const sigIdx = claudeRuntime.indexOf("function buildPromptMeta(");
    expect(sigIdx).toBeGreaterThan(0);
    const sigLine = claudeRuntime.slice(sigIdx, sigIdx + 200);
    expect(sigLine).toMatch(
      /function buildPromptMeta\(\s*result,\s*peakInputTokens,\s*fallbackModelId\s*\)/,
    );

    const fnEnd = claudeRuntime.indexOf("\n}\n", sigIdx);
    const fnBody = claudeRuntime.slice(sigIdx, fnEnd);
    // Inference must run when the CLI-supplied window is null/undefined.
    expect(fnBody).toMatch(/contextWindow\s*==\s*null/);
    expect(fnBody).toContain("inferClaudeContextWindow(");
  });

  it("the prompt-complete emit passes session.currentModelId as the fallback", () => {
    // Without this, `inferClaudeContextWindow` has no signal when modelUsage
    // is fully absent — the inferred window would always be undefined and
    // the fix collapses to the pre-#1754 behaviour.
    expect(claudeRuntime).toContain(
      "buildPromptMeta(payload, peakInputTokens, session.currentModelId)",
    );
  });
});

describe("#1755 — chooseUpdatedModelId log skips no-op resolutions", () => {
  it("the parent-message handler computes isNoOpResolution before logging", () => {
    // The Rust stderr bridge wraps every line as log::warn!, so the
    // pre-fix code spammed a WARN for every steady-state turn (the user's
    // transcript shows 4+ identical lines back-to-back). The fix gates
    // the log on a no-op short-circuit while preserving #1718's intent
    // for transitions and picker disagreements.
    const callIdx = claudeRuntime.indexOf("chooseUpdatedModelId(");
    expect(callIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(callIdx, callIdx + 1500);
    expect(region).toContain("isNoOpResolution");
    expect(region).toMatch(/if\s*\(\s*!isNoOpResolution\s*\)/);
  });

  it("the no-op short-circuit requires all three fields to match (previous, incoming, resolved)", () => {
    // A weaker check (e.g. only previous === incoming) would suppress
    // legitimate divergence cases where the picker resolved a different
    // id than the assistant's self-report — exactly the case #1718 was
    // built to catch. All three must be equal AND non-null for the log
    // to be safely suppressed.
    const noopIdx = claudeRuntime.indexOf("isNoOpResolution");
    expect(noopIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(noopIdx, noopIdx + 600);
    expect(region).toContain("previousModelId != null");
    expect(region).toContain("message.model != null");
    expect(region).toContain("nextModelId != null");
    expect(region).toContain("previousModelId === message.model");
    expect(region).toContain("previousModelId === nextModelId");
  });
});
