// ABOUTME: OpenAI API provider adapter.
// ABOUTME: Direct integration with api.openai.com for users with OpenAI subscriptions.

import type { ChatRequest, ProviderAdapter, ProviderModel, AuthOptions } from "./types";

/**
 * Normalize auth parameter to get the token string.
 * OpenAI uses Bearer token for both API keys and OAuth tokens.
 */
function getToken(auth: string | AuthOptions): string {
  return typeof auth === "string" ? auth : auth.token;
}

const OPENAI_API_URL = "https://api.openai.com/v1";

/**
 * Default models available from OpenAI.
 */
const DEFAULT_MODELS: ProviderModel[] = [
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", contextWindow: 128000 },
  { id: "o1", name: "o1", contextWindow: 200000 },
  { id: "o1-mini", name: "o1 Mini", contextWindow: 128000 },
];

/**
 * Context window sizes for known models.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4-turbo-preview": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
  "o1": 200000,
  "o1-mini": 128000,
  "o1-preview": 128000,
};

/**
 * Format model ID to human-readable name.
 */
function formatModelName(id: string): string {
  // Map known IDs to friendly names
  const nameMap: Record<string, string> = {
    "gpt-4o": "GPT-4o",
    "gpt-4o-mini": "GPT-4o Mini",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4-turbo-preview": "GPT-4 Turbo Preview",
    "gpt-4": "GPT-4",
    "gpt-3.5-turbo": "GPT-3.5 Turbo",
    "o1": "o1",
    "o1-mini": "o1 Mini",
    "o1-preview": "o1 Preview",
  };

  return nameMap[id] || id;
}

/**
 * Parse OpenAI SSE stream response.
 */
async function* parseOpenAISSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const openaiProvider: ProviderAdapter = {
  id: "openai",

  async sendMessage(request: ChatRequest, auth: string | AuthOptions): Promise<string> {
    const token = getToken(auth);
    const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error?.message;
      throw new Error(message || `OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  },

  async *streamMessage(
    request: ChatRequest,
    auth: string | AuthOptions
  ): AsyncGenerator<string, void, unknown> {
    const token = getToken(auth);
    const response = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error?.message;
      throw new Error(message || `OpenAI streaming failed: ${response.status}`);
    }

    yield* parseOpenAISSE(response.body);
  },

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const response = await fetch(`${OPENAI_API_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  },

  async getModels(apiKey: string): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${OPENAI_API_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        return DEFAULT_MODELS;
      }

      const data = await response.json();
      const models = data.data as Array<{ id: string; owned_by?: string }> | undefined;

      if (!models) {
        return DEFAULT_MODELS;
      }

      // Filter to chat models only (GPT and o1 models)
      const chatModels = models
        .filter(m =>
          m.id.includes("gpt") ||
          m.id.startsWith("o1") ||
          m.id.includes("turbo")
        )
        .filter(m =>
          !m.id.includes("instruct") &&
          !m.id.includes("vision") &&
          !m.id.includes("audio") &&
          !m.id.includes("realtime")
        )
        .map(m => ({
          id: m.id,
          name: formatModelName(m.id),
          contextWindow: CONTEXT_WINDOWS[m.id] || 128000,
        }))
        // Sort by preference
        .sort((a, b) => {
          const order = ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "gpt-4-turbo"];
          const aIndex = order.findIndex(o => a.id.includes(o));
          const bIndex = order.findIndex(o => b.id.includes(o));
          if (aIndex === -1 && bIndex === -1) return 0;
          if (aIndex === -1) return 1;
          if (bIndex === -1) return -1;
          return aIndex - bIndex;
        });

      return chatModels.length > 0 ? chatModels : DEFAULT_MODELS;
    } catch {
      return DEFAULT_MODELS;
    }
  },
};
