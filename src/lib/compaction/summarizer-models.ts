// ABOUTME: Selects agent-compaction summarizer models from SerenModels discovery.
// ABOUTME: Prevents compaction from posting retired model IDs absent from the live catalog.

import type { ProviderModel } from "@/lib/providers/types";

export interface CompactionSummarizerModels {
  primaryModel: string;
  fallbackModels: string[];
}

function isSonnet(model: ProviderModel): boolean {
  return model.id.startsWith("anthropic/claude-sonnet-");
}

function isFastSummarizer(model: ProviderModel): boolean {
  const searchable = `${model.id} ${model.name}`.toLowerCase();
  return searchable.includes("flash") || searchable.includes("haiku");
}

/**
 * Choose only model IDs advertised by the current SerenModels catalog.
 *
 * Preserve the established Sonnet-primary intent when available, then keep one
 * fast catalog model as the fallback. If Sonnet is unavailable, promote the
 * first fast model to primary. Returning null tells the caller to use the
 * deterministic no-network fallback.
 */
export function resolveCompactionSummarizerModels(
  models: ProviderModel[],
): CompactionSummarizerModels | null {
  const advertised = models.filter(
    (model, index) =>
      model.id.trim().length > 0 &&
      models.findIndex((candidate) => candidate.id === model.id) === index,
  );
  const fastModels = advertised.filter(isFastSummarizer);
  const primary = advertised.find(isSonnet) ?? fastModels[0];

  if (!primary) return null;

  const fallback = fastModels.find((model) => model.id !== primary.id);
  return {
    primaryModel: primary.id,
    fallbackModels: fallback ? [fallback.id] : [],
  };
}
