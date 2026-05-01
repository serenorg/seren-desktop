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
  it("inferClaudeContextWindow exists and enumerates 1M-tier-capable Claude IDs", () => {
    // The 1M-tier-capable bare IDs must be enumerated here so a fresh
    // session on claude-opus-4-7[1m] reports its real window even when the
    // CLI's result event has empty modelUsage. The set must mirror
    // CLAUDE_1M_TIER_CAPABLE_MODELS in src/stores/agent.store.ts so the
    // runtime and the store agree on cold-start defaults. #1761.
    expect(claudeRuntime).toContain("function inferClaudeContextWindow(");
    expect(claudeRuntime).toContain('"claude-opus-4-7"');
    expect(claudeRuntime).toContain('"claude-opus-4-6"');
    expect(claudeRuntime).toContain('"claude-opus-4-5"');
    expect(claudeRuntime).toContain('"claude-sonnet-4-7"');
    expect(claudeRuntime).toContain('"claude-sonnet-4-6"');
    expect(claudeRuntime).toContain('"claude-sonnet-4-5"');
  });

  it("inferClaudeContextWindow checks for the [1m] suffix and the 1M-tier set", () => {
    // The 1M tier is gated on the `[1m]` suffix upstream; the helper must
    // detect the suffix and look the canonical bare id up in the
    // 1M-tier-capable set. Behavioural assertions live in
    // claude-runtime-1m-tier.test.ts; this test guards the function's
    // structural anchors so the regression cannot quietly disappear.
    const fnStart = claudeRuntime.indexOf("function inferClaudeContextWindow(");
    const fnEnd = claudeRuntime.indexOf("\n}\n", fnStart);
    const fnBody = claudeRuntime.slice(fnStart, fnEnd);
    expect(fnBody).toContain("\\[1m\\]");
    expect(fnBody).toContain("CLAUDE_1M_TIER_CAPABLE_MODELS");
    expect(fnBody).toContain("1_000_000");
    expect(fnBody).toContain("200_000");
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

  it("the no-op short-circuit suppresses whenever the resolver's output matches the previous session state (#1769)", () => {
    // The earlier strict form required previous === incoming === resolved.
    // That left the [1m]-preservation steady-state un-suppressed: Anthropic
    // echoes back the bare id (e.g. claude-opus-4-7), the resolver re-applies
    // the `[1m]` suffix, and `previous !== incoming` always — so the WARN
    // fired every parent message for every 1M-tier user. The mutation block
    // immediately below remains the source of truth for actual model swaps;
    // when resolved equals the previous session state nothing material
    // happened, so the diagnostic carries no signal worth logging.
    const noopIdx = claudeRuntime.indexOf("isNoOpResolution");
    expect(noopIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(noopIdx, noopIdx + 600);
    expect(region).toContain("previousModelId != null");
    expect(region).toContain("nextModelId != null");
    expect(region).toContain("previousModelId === nextModelId");
    // Must NOT keep the strict incoming check — that is the regression we
    // are removing. Asserting the absence locks the looser form in place.
    expect(region).not.toContain("previousModelId === message.model");
  });
});
