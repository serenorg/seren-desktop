// ABOUTME: Shared model-search matching for the chat picker and the settings model select.
// ABOUTME: Matches whitespace-separated query words in any order across a model's searchable text.

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "meta-llama": "Meta",
  meta: "Meta",
  mistralai: "Mistral AI",
  mistral: "Mistral AI",
  cohere: "Cohere",
  perplexity: "Perplexity",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  moonshotai: "MoonshotAI",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  amazon: "Amazon",
  inflection: "Inflection",
};

/** Human vendor name for a `vendor/model` slug. */
export function providerLabel(modelId: string): string {
  const slug = modelId.split("/")[0]?.toLowerCase() || "";
  return PROVIDER_LABELS[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

export interface SearchableModel {
  id: string;
  name: string;
  provider?: string;
}

/**
 * Every whitespace-separated word in the query must appear somewhere in the
 * model's name, slug, or vendor label. Word order is not significant: the
 * vendor lives in the slug and the family lives in the name, so a query naming
 * both ("anthropic opus") spans two fields and can never match contiguously.
 */
export function matchesModelQuery(
  model: SearchableModel,
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack =
    `${model.name} ${model.id} ${model.provider ?? providerLabel(model.id)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Filter a model list with {@link matchesModelQuery}; an empty query keeps every entry. */
export function filterModelsByQuery<T extends SearchableModel>(
  models: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return models;
  return models.filter((model) => matchesModelQuery(model, query));
}
