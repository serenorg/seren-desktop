// ABOUTME: Models service for fetching the searchable AI model catalog.
// ABOUTME: Serves the live SerenModels publisher catalog — the set chat can route.

import { providerLabel } from "@/lib/model-search";
import { getLiveSerenModelCatalog } from "@/services/seren-model-catalog";

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

// Every ID this service returns is sent to the SerenModels publisher
// (`POST /publishers/seren-models/chat/completions`), which routes only the
// models advertised by `GET /publishers/seren-models/models`. Offering a
// broader discovery catalog let users select IDs that fail with
// `404 Model not found` (#3683), so discovery and routing share one source
// of truth. There is no static fallback: an unreachable catalog yields an
// error rather than a list of unroutable IDs.
export const modelsService = {
  async getAvailable(): Promise<Model[]> {
    const models = await getLiveSerenModelCatalog();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      provider: providerLabel(model.id),
      contextWindow: model.contextWindow,
    }));
  },
};
