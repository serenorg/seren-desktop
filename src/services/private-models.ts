import { getPrivateModels } from "@/api/seren-private-models";
import type { ProviderModel } from "@/lib/providers/types";
import { authStore } from "@/stores/auth.store";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels: ProviderModel[] | null = null;
let cacheExpiresAt = 0;

function formatApiError(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.error === "string") return obj.error;
  }
  return fallback;
}

function fallbackModelsFromPolicy(): ProviderModel[] {
  const policy = authStore.privateChatPolicy;
  if (!policy) return [];

  const orderedModelIds =
    policy.ordered_model_ids ??
    [
      policy.model_id?.trim(),
      ...(policy.fallback_models ?? []).map((value) => value.trim()),
    ].filter((value): value is string => !!value && value.length > 0);

  const deduped = orderedModelIds.filter(
    (value, index, values) =>
      values.findIndex(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      ) === index,
  );

  return deduped.map((modelId, index) => ({
    id: modelId,
    name: modelId,
    contextWindow: 0,
    description: index === 0 ? "Organization default" : "Organization fallback",
  }));
}

export const privateModelsService = {
  async listAvailable(forceRefresh = false): Promise<ProviderModel[]> {
    const now = Date.now();
    if (!forceRefresh && cachedModels && now < cacheExpiresAt) {
      return cachedModels;
    }

    const { data, error } = await getPrivateModels({ throwOnError: false });
    if (error) {
      const fallbackModels = fallbackModelsFromPolicy();
      if (fallbackModels.length > 0) {
        cachedModels = fallbackModels;
        cacheExpiresAt = now + CACHE_TTL_MS;
        return fallbackModels;
      }

      throw new Error(
        `Failed to load private models: ${formatApiError(error, "unknown error")}`,
      );
    }

    const modelCatalog = data?.data;
    const models =
      modelCatalog?.data.map((model) => ({
        id: model.id,
        name: model.display_name?.trim() || model.id,
        contextWindow: 0,
        description: model.recommended ? "Recommended" : "Private model",
      })) ?? [];

    if (models.length === 0) {
      const fallbackModels = fallbackModelsFromPolicy();
      if (fallbackModels.length > 0) {
        cachedModels = fallbackModels;
        cacheExpiresAt = now + CACHE_TTL_MS;
        return fallbackModels;
      }
    }

    cachedModels = models;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return models;
  },

  clearCache() {
    cachedModels = null;
    cacheExpiresAt = 0;
  },
};
