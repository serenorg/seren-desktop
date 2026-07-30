// ABOUTME: Short-lived cache for the authoritative SerenModels inference catalog.
// ABOUTME: Prevents Auto chat from routing through retired hard-coded model IDs.

import { fetchSerenModelCatalog } from "@/lib/providers/seren";
import type { ProviderModel } from "@/lib/providers/types";

export const SEREN_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

let cachedCatalog: ProviderModel[] | null = null;
let catalogExpiresAt = 0;
let catalogRequest: Promise<ProviderModel[]> | null = null;

export async function getLiveSerenModelCatalog(
  now = Date.now(),
): Promise<ProviderModel[]> {
  if (cachedCatalog && cachedCatalog.length > 0 && now < catalogExpiresAt) {
    return cachedCatalog;
  }

  if (catalogRequest) {
    return catalogRequest;
  }

  catalogRequest = fetchSerenModelCatalog()
    .then((models) => {
      if (models.length === 0) {
        throw new Error("Seren model catalog returned no models");
      }
      cachedCatalog = models;
      catalogExpiresAt = now + SEREN_MODEL_CATALOG_TTL_MS;
      return models;
    })
    .finally(() => {
      catalogRequest = null;
    });

  return catalogRequest;
}

export function clearLiveSerenModelCatalogCache(): void {
  cachedCatalog = null;
  catalogExpiresAt = 0;
  catalogRequest = null;
}
