// ABOUTME: Reads and writes per-model context windows learned from CLI prompt metadata.
// ABOUTME: Lets the spawn-time fallback in agent.store stay correct as new models ship.

import { invoke } from "@tauri-apps/api/core";

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
