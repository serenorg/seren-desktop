import { config } from "@/lib/config";
import { auth } from "./auth";

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

let cachedModels: Model[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

export const modelsService = {
  async getAvailable(): Promise<Model[]> {
    const now = Date.now();

    if (cachedModels && now - cacheTimestamp < CACHE_TTL) {
      return cachedModels;
    }

    try {
      const token = await auth.getToken();
      const response = await fetch(`${config.apiBase}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        cachedModels = getDefaultModels();
        cacheTimestamp = now;
        return cachedModels;
      }

      const data = await response.json();
      cachedModels = data.models as Model[];
      cacheTimestamp = now;
      return cachedModels;
    } catch {
      cachedModels = getDefaultModels();
      cacheTimestamp = now;
      return cachedModels;
    }
  },

  clearCache() {
    cachedModels = null;
    cacheTimestamp = 0;
  },
};

function getDefaultModels(): Model[] {
  return [
    {
      id: "anthropic/claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      provider: "Anthropic",
      contextWindow: 200000,
    },
    {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      provider: "OpenAI",
      contextWindow: 128000,
    },
  ];
}
