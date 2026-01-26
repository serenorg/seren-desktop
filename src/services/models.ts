// ABOUTME: Models service for fetching available AI models from Seren.
// ABOUTME: Uses the seren-models publisher through the Seren Gateway API.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

interface AgentApiPayload {
  publisher: string;
  path: string;
  method: string;
}

const PUBLISHER_SLUG = "seren-models";
const AGENT_API_ENDPOINT = `${apiBase}/agent/api`;

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
      const token = await getToken();
      if (!token) {
        return getDefaultModels();
      }

      const agentPayload: AgentApiPayload = {
        publisher: PUBLISHER_SLUG,
        path: "/models",
        method: "GET",
      };

      const response = await appFetch(AGENT_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(agentPayload),
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
      id: "anthropic/claude-sonnet-4",
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
