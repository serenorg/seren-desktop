// ABOUTME: Anthropic Claude API provider adapter.
// ABOUTME: Direct integration with api.anthropic.com for users with Anthropic subscriptions.

import { appFetch } from "@/lib/fetch";
import type {
  AuthOptions,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ProviderModel,
} from "./types";

/**
 * Get API key from auth parameter.
 * Anthropic only supports API keys (no OAuth), so just extract the token.
 */
function getApiKey(auth: string | AuthOptions): string {
  return typeof auth === "string" ? auth : auth.token;
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default models available from Anthropic.
 */
const DEFAULT_MODELS: ProviderModel[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200000,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    contextWindow: 200000,
  },
  {
    id: "claude-3-opus-20240229",
    name: "Claude 3 Opus",
    contextWindow: 200000,
  },
  {
    id: "claude-3-haiku-20240307",
    name: "Claude 3 Haiku",
    contextWindow: 200000,
  },
];

/**
 * Convert messages to Anthropic format.
 * Anthropic requires system message to be separate from messages array.
 */
function convertToAnthropicFormat(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemMessage = messages.find((m) => m.role === "system");
  const otherMessages = messages.filter((m) => m.role !== "system");

  const normalizeContent = (
    content: string | import("./types").ContentBlock[],
  ): string => {
    if (typeof content === "string") return content;
    return content
      .filter((b): b is import("./types").TextContentBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };

  return {
    system: systemMessage ? normalizeContent(systemMessage.content) : undefined,
    messages: otherMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: normalizeContent(m.content),
    })),
  };
}

/**
 * Parse Anthropic SSE stream response.
 */
async function* parseAnthropicSSE(
  body: ReadableStream<Uint8Array>,
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

        if (line.startsWith("event:")) {
          // Track event type if needed
          continue;
        }

        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          // Handle content_block_delta event
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            yield parsed.delta.text;
          }

          // Handle message_stop event
          if (parsed.type === "message_stop") {
            return;
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

export const anthropicProvider: ProviderAdapter = {
  id: "anthropic",

  async sendMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): Promise<string> {
    const apiKey = getApiKey(auth);
    const { system, messages } = convertToAnthropicFormat(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
    };

    if (system) {
      body.system = system;
    }

    const response = await appFetch(`${ANTHROPIC_API_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error
        ?.message;
      throw new Error(message || `Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.content as
      | Array<{ type: string; text?: string }>
      | undefined;
    if (content && content.length > 0) {
      const textBlock = content.find((b) => b.type === "text");
      return textBlock?.text || "";
    }

    return "";
  },

  async *streamMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): AsyncGenerator<string, void, unknown> {
    const apiKey = getApiKey(auth);
    const { system, messages } = convertToAnthropicFormat(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      stream: true,
    };

    if (system) {
      body.system = system;
    }

    const response = await appFetch(`${ANTHROPIC_API_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error
        ?.message;
      throw new Error(
        message || `Anthropic streaming failed: ${response.status}`,
      );
    }

    yield* parseAnthropicSSE(response.body);
  },

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      // Make a minimal request to validate the key
      const response = await appFetch(`${ANTHROPIC_API_URL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
      });

      // 200 = valid, 400 = valid key but bad request, 401/403 = invalid key
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  },

  async getModels(): Promise<ProviderModel[]> {
    // Anthropic doesn't have a public models list endpoint
    return DEFAULT_MODELS;
  },
};
