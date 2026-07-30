// ABOUTME: Regression coverage for live SerenModels discovery before Auto routing.
// ABOUTME: Ensures retired local defaults cannot reach the Rust orchestrator.

import { describe, expect, it, vi } from "vitest";
import { readSource } from "./source-text";

const fetchSerenModelCatalog = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/seren", () => ({
  fetchSerenModelCatalog,
}));

import {
  clearLiveSerenModelCatalogCache,
  getLiveSerenModelCatalog,
  SEREN_MODEL_CATALOG_TTL_MS,
} from "@/services/seren-model-catalog";

const liveModels = [
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    contextWindow: 1_000_000,
  },
  {
    id: "google/gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    contextWindow: 1_048_576,
  },
];

describe("#3492 SerenModels Auto catalog", () => {
  it("reuses a successful live catalog only within the short TTL", async () => {
    clearLiveSerenModelCatalogCache();
    fetchSerenModelCatalog.mockReset();
    fetchSerenModelCatalog.mockResolvedValue(liveModels);

    await expect(getLiveSerenModelCatalog(1_000)).resolves.toEqual(liveModels);
    await expect(
      getLiveSerenModelCatalog(1_000 + SEREN_MODEL_CATALOG_TTL_MS - 1),
    ).resolves.toEqual(liveModels);
    expect(fetchSerenModelCatalog).toHaveBeenCalledTimes(1);

    await expect(
      getLiveSerenModelCatalog(1_000 + SEREN_MODEL_CATALOG_TTL_MS),
    ).resolves.toEqual(liveModels);
    expect(fetchSerenModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("does not cache discovery failures or an empty catalog", async () => {
    clearLiveSerenModelCatalogCache();
    fetchSerenModelCatalog.mockReset();
    fetchSerenModelCatalog
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce([]);

    await expect(getLiveSerenModelCatalog(2_000)).rejects.toThrow(
      "catalog unavailable",
    );
    await expect(getLiveSerenModelCatalog(2_001)).rejects.toThrow(
      "returned no models",
    );
    expect(fetchSerenModelCatalog).toHaveBeenCalledTimes(2);
  });

  it("hydrates Auto capabilities before routing and fails closed on discovery errors", () => {
    const source = readSource("src/services/orchestrator.ts");
    const loadCatalog = source.indexOf(
      "const liveModels = await getLiveSerenModelCatalog();",
    );
    const updateStore = source.indexOf(
      'providerStore.setProviderModels("seren", liveModels);',
    );
    const buildCapabilities = source.indexOf(
      "const capabilities = buildCapabilities(",
    );

    expect(loadCatalog).toBeGreaterThan(0);
    expect(updateStore).toBeGreaterThan(loadCatalog);
    expect(buildCapabilities).toBeGreaterThan(updateStore);
    expect(source).toContain(
      "Seren Models could not load its current model catalog. Please retry.",
    );
    expect(source).toContain(
      "conversationStore.setLoading(false, conversationId);",
    );
  });
});
