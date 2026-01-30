// ABOUTME: Google Gemini API provider adapter.
// ABOUTME: Direct integration with Google AI for users with Gemini API access.

import { appFetch } from "@/lib/fetch";
import type {
  AuthOptions,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ProviderModel,
} from "./types";

/**
 * Normalize auth parameter to AuthOptions object.
 */
function normalizeAuth(auth: string | AuthOptions): AuthOptions {
  if (typeof auth === "string") {
    return { token: auth, isOAuth: false };
  }
  return auth;
}

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Default models available from Google Gemini.
 */
const DEFAULT_MODELS: ProviderModel[] = [
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1000000 },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2000000 },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextWindow: 1000000 },
];

/**
 * Convert messages to Gemini format.
 * Gemini uses different role names and structure.
 */
function convertToGeminiFormat(messages: ChatMessage[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: Array<{ role: "user" | "model"; parts: { text: string }[] }>;
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

  const contents = otherMessages.map((m) => ({
    role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
    parts: [{ text: normalizeContent(m.content) }],
  }));

  const result: {
    systemInstruction?: { parts: { text: string }[] };
    contents: Array<{ role: "user" | "model"; parts: { text: string }[] }>;
  } = { contents };

  if (systemMessage) {
    result.systemInstruction = {
      parts: [{ text: normalizeContent(systemMessage.content) }],
    };
  }

  return result;
}

/**
 * Parse Gemini SSE stream response.
 */
async function* parseGeminiSSE(
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
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            yield text;
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

export const geminiProvider: ProviderAdapter = {
  id: "gemini",

  async sendMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): Promise<string> {
    const { token, isOAuth } = normalizeAuth(auth);
    const { systemInstruction, contents } = convertToGeminiFormat(
      request.messages,
    );

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 8192,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // OAuth uses Authorization header, API key uses query parameter
    const url = isOAuth
      ? `${GEMINI_API_URL}/models/${request.model}:generateContent`
      : `${GEMINI_API_URL}/models/${request.model}:generateContent?key=${token}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isOAuth) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await appFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error
        ?.message;
      throw new Error(message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || "";
  },

  async *streamMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): AsyncGenerator<string, void, unknown> {
    const { token, isOAuth } = normalizeAuth(auth);
    const { systemInstruction, contents } = convertToGeminiFormat(
      request.messages,
    );

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens || 8192,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // OAuth uses Authorization header, API key uses query parameter
    const url = isOAuth
      ? `${GEMINI_API_URL}/models/${request.model}:streamGenerateContent?alt=sse`
      : `${GEMINI_API_URL}/models/${request.model}:streamGenerateContent?key=${token}&alt=sse`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (isOAuth) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await appFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      const message = (error as { error?: { message?: string } }).error
        ?.message;
      throw new Error(message || `Gemini streaming failed: ${response.status}`);
    }

    yield* parseGeminiSSE(response.body);
  },

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      // Make a minimal request to validate the key
      const url = `${GEMINI_API_URL}/models?key=${apiKey}`;
      const response = await appFetch(url);
      return response.ok;
    } catch {
      return false;
    }
  },

  async getModels(apiKey: string): Promise<ProviderModel[]> {
    try {
      const url = `${GEMINI_API_URL}/models?key=${apiKey}`;
      const response = await appFetch(url);

      if (!response.ok) {
        return DEFAULT_MODELS;
      }

      const data = await response.json();
      const models = data.models as
        | Array<{
            name: string;
            displayName?: string;
            inputTokenLimit?: number;
            supportedGenerationMethods?: string[];
          }>
        | undefined;

      if (!models) {
        return DEFAULT_MODELS;
      }

      // Filter to models that support generateContent
      const chatModels = models
        .filter(
          (m) =>
            m.supportedGenerationMethods?.includes("generateContent") &&
            m.name.includes("gemini"),
        )
        .map((m) => {
          // Extract model ID from name (e.g., "models/gemini-1.5-pro" -> "gemini-1.5-pro")
          const id = m.name.replace("models/", "");
          return {
            id,
            name: m.displayName || id,
            contextWindow: m.inputTokenLimit || 1000000,
          };
        })
        // Sort by preference
        .sort((a, b) => {
          const order = ["gemini-2.0", "gemini-1.5-pro", "gemini-1.5-flash"];
          const aIndex = order.findIndex((o) => a.id.includes(o));
          const bIndex = order.findIndex((o) => b.id.includes(o));
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
