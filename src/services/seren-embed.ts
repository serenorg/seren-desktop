// ABOUTME: SerenEmbed API client for generating text embeddings.
// ABOUTME: Uses SerenBucks via /publishers endpoint for paid embedding generation.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";

const PUBLISHER_SLUG = "seren-embed";

/** Default model for embeddings */
const DEFAULT_MODEL = "text-embedding-3-small";

/** Embedding dimension for text-embedding-3-small */
export const EMBEDDING_DIM = 1536;

interface EmbeddingRequest {
  input: string | string[];
  model?: string;
}

interface EmbeddingData {
  object: "embedding";
  embedding: number[];
  index: number;
}

interface EmbeddingResponse {
  object: "list";
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Wrapped response from the /publishers endpoint */
interface GatewayResponse {
  status: number;
  body: EmbeddingResponse;
  cost: string;
}

/**
 * Generate embeddings for a single text string.
 * Uses SerenEmbed publisher via Seren Gateway.
 */
export async function embedText(text: string, model?: string): Promise<number[]> {
  const response = await embedTexts([text], model);
  return response.data[0].embedding;
}

/**
 * Generate embeddings for multiple text strings in a batch.
 * More efficient than calling embedText multiple times.
 */
export async function embedTexts(
  texts: string[],
  model?: string,
): Promise<EmbeddingResponse> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated - please log in");
  }

  const payload: EmbeddingRequest = {
    input: texts,
    model: model || DEFAULT_MODEL,
  };

  // Use unified /publishers endpoint
  const response = await appFetch(
    `${apiBase}/publishers/${PUBLISHER_SLUG}/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SerenEmbed API error: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as GatewayResponse;

  // Gateway wraps upstream errors in a 200 response with a status field
  if (result.status && result.status !== 200) {
    throw new Error(`SerenEmbed upstream error: ${result.status}`);
  }

  return result.body;
}

/**
 * Estimate the cost of embedding text.
 * Returns estimated token count (actual cost depends on SerenBucks pricing).
 */
export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English text
  // This is a heuristic; actual tokenization varies by model
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the cost of embedding multiple texts.
 */
export function estimateBatchTokens(texts: string[]): number {
  return texts.reduce((total, text) => total + estimateTokens(text), 0);
}
