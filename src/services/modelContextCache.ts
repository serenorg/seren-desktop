// ABOUTME: Reads and writes per-model context windows learned from CLI prompt metadata.
// ABOUTME: Lets the spawn-time fallback in agent.store stay correct as new models ship.

import { invoke } from "@tauri-apps/api/core";
import { captureSupportError } from "@/lib/support/hook";

// Anthropic's 1M tier minimum. Mirrors the [1m] branch of
// `defaultContextWindowFor` in src/stores/agent.store.ts; inlined here to
// avoid a circular import (agent.store already imports this module).
const ONE_M_TIER_MINIMUM = 1_000_000;
const ONE_M_SUFFIX_RE = /\[1m\]$/i;

// Process-lifetime dedup so a single poisoned upstream report only opens one
// support ticket per (provider, modelId) pair, even if the same value is
// re-attempted many times within a session. The in-session alarm at
// agent.store.ts:4476 handles the per-session signal; this set covers the
// cross-session leakage that the per-session gate cannot see.
const alertedTierMismatches = new Set<string>();

export async function getCachedModelContextWindow(
  provider: string,
  modelId: string,
): Promise<number | null> {
  try {
    const result = await invoke<number | null>("get_model_context_window", {
      provider,
      modelId,
    });
    return typeof result === "number" && result > 0 ? result : null;
  } catch (err) {
    console.warn("[modelContextCache] lookup failed", err);
    return null;
  }
}

export async function recordModelContextWindow(
  provider: string,
  modelId: string,
  contextWindow: number,
): Promise<void> {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;

  // The desktop spawns 1M-tier sessions on the [1m] suffix. If the upstream
  // CLI ever reports a window smaller than 1M for a [1m] model — gateway
  // downgrade, account tier loss, transient CLI bug — persisting that value
  // would poison every future session of the same model with the smaller
  // window, silently collapsing the auto-compact gauge denominator long after
  // the in-session alarm has been silenced for that session. Refuse the
  // write and surface the leakage exactly once per (provider, modelId). #1769.
  if (ONE_M_SUFFIX_RE.test(modelId) && contextWindow < ONE_M_TIER_MINIMUM) {
    console.warn(
      `[modelContextCache] refusing to persist ${contextWindow.toLocaleString()} for ${modelId} — [1m] tier minimum is ${ONE_M_TIER_MINIMUM.toLocaleString()}`,
    );
    const dedupKey = `${provider}:${modelId}`;
    if (!alertedTierMismatches.has(dedupKey)) {
      alertedTierMismatches.add(dedupKey);
      void captureSupportError({
        kind: "agent.context_window_tier_mismatch",
        message: `Refused to persist ${contextWindow.toLocaleString()} context window for [1m]-tier model ${modelId} (provider=${provider})`,
        stack: [],
        agentContext: {
          model: modelId,
          provider,
          tool_calls: [],
        },
      });
    }
    return;
  }

  try {
    await invoke("record_model_context_window", {
      provider,
      modelId,
      contextWindow: Math.round(contextWindow),
    });
  } catch (err) {
    console.warn("[modelContextCache] record failed", err);
  }
}
