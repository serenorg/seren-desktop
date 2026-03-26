import { getPrivateModels } from "@/api/seren-private-models";
import type { ProviderModel } from "@/lib/providers/types";

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

export const privateModelsService = {
  async listAvailable(forceRefresh = false): Promise<ProviderModel[]> {
    const now = Date.now();
    if (!forceRefresh && cachedModels && now < cacheExpiresAt) {
      return cachedModels;
    }

    const { data, error } = await getPrivateModels({ throwOnError: false });
    if (error) {
      throw new Error(
        `Failed to load private models: ${formatApiError(error, "unknown error")}`,
      );
    }

    const models =
      data?.data.map((model) => ({
        id: model.id,
        name: model.display_name?.trim() || model.id,
        contextWindow: 0,
        description: model.recommended ? "Recommended" : "Private model",
      })) ?? [];

    cachedModels = models;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return models;
  },

  clearCache() {
    cachedModels = null;
    cacheExpiresAt = 0;
  },
};
