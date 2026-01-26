// ABOUTME: Models service for fetching available AI models from OpenRouter.
// ABOUTME: Fetches the full list of models directly from OpenRouter's public API.

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

let cachedModels: Model[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes - models don't change often

export const modelsService = {
  async getAvailable(): Promise<Model[]> {
    const now = Date.now();

    if (cachedModels && cachedModels.length > 10 && now - cacheTimestamp < CACHE_TTL) {
      return cachedModels;
    }

    try {
      const response = await fetch(OPENROUTER_MODELS_URL);

      if (!response.ok) {
        console.warn("Failed to fetch models from OpenRouter, using defaults");
        return getDefaultModels();
      }

      const data: OpenRouterResponse = await response.json();

      if (!data.data || data.data.length === 0) {
        console.warn("OpenRouter returned empty models list, using defaults");
        return getDefaultModels();
      }

      // Transform OpenRouter models to our format
      const models = data.data
        .filter((m) => m.id && m.name)
        .map((m) => {
          // Extract provider from id (e.g., "openai/gpt-4o" -> "OpenAI")
          const provider = extractProvider(m.id);
          // Clean up name (remove "Provider:" prefix if present)
          const name = cleanModelName(m.name);

          return {
            id: m.id,
            name,
            provider,
            contextWindow: m.context_length || 4096,
          };
        })
        // Sort by provider then name
        .sort((a, b) => {
          const providerCompare = a.provider.localeCompare(b.provider);
          if (providerCompare !== 0) return providerCompare;
          return a.name.localeCompare(b.name);
        });

      cachedModels = models;
      cacheTimestamp = now;
      return cachedModels;
    } catch (err) {
      console.warn("Error fetching models from OpenRouter:", err);
      return getDefaultModels();
    }
  },

  clearCache() {
    cachedModels = null;
    cacheTimestamp = 0;
  },
};

function extractProvider(modelId: string): string {
  const providerMap: Record<string, string> = {
    "anthropic": "Anthropic",
    "openai": "OpenAI",
    "google": "Google",
    "meta-llama": "Meta",
    "meta": "Meta",
    "mistralai": "Mistral AI",
    "mistral": "Mistral AI",
    "cohere": "Cohere",
    "perplexity": "Perplexity",
    "deepseek": "DeepSeek",
    "qwen": "Qwen",
    "x-ai": "xAI",
    "microsoft": "Microsoft",
    "nvidia": "NVIDIA",
    "amazon": "Amazon",
    "inflection": "Inflection",
  };

  const providerSlug = modelId.split("/")[0]?.toLowerCase() || "";
  return providerMap[providerSlug] || capitalize(providerSlug);
}

function cleanModelName(name: string): string {
  // Remove "Provider: " prefix (e.g., "OpenAI: GPT-4o" -> "GPT-4o")
  const colonIndex = name.indexOf(": ");
  if (colonIndex > 0 && colonIndex < 20) {
    return name.slice(colonIndex + 2);
  }
  return name;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getDefaultModels(): Model[] {
  return [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic", contextWindow: 200000 },
    { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", provider: "Anthropic", contextWindow: 200000 },
    { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "Anthropic", contextWindow: 200000 },
    { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI", contextWindow: 128000 },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI", contextWindow: 128000 },
    { id: "openai/o1", name: "O1", provider: "OpenAI", contextWindow: 200000 },
    { id: "openai/o1-mini", name: "O1 Mini", provider: "OpenAI", contextWindow: 128000 },
    { id: "openai/o3-mini", name: "O3 Mini", provider: "OpenAI", contextWindow: 200000 },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google", contextWindow: 1000000 },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google", contextWindow: 1000000 },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1", provider: "DeepSeek", contextWindow: 64000 },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek", contextWindow: 64000 },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct", provider: "Meta", contextWindow: 131072 },
    { id: "mistralai/mistral-large", name: "Mistral Large", provider: "Mistral AI", contextWindow: 128000 },
    { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B Instruct", provider: "Qwen", contextWindow: 131072 },
    { id: "x-ai/grok-2", name: "Grok 2", provider: "xAI", contextWindow: 131072 },
  ];
}
