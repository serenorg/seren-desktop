// ABOUTME: Seren Gateway provider adapter for chat completions.
// ABOUTME: Routes requests through Seren's /agent/api and /agent/stream endpoints.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";
import type { ChatRequest, ProviderAdapter, ProviderModel } from "./types";

const PUBLISHER_SLUG = "seren-models";
const AGENT_API_ENDPOINT = `${apiBase}/agent/api`;
const AGENT_STREAM_ENDPOINT = `${apiBase}/agent/stream`;

/**
 * Normalize old model IDs to current OpenRouter format.
 * Handles migration from date-suffixed IDs to clean IDs.
 */
function normalizeModelId(modelId: string): string {
  // Map of old IDs to new IDs
  const migrations: Record<string, string> = {
    // Anthropic - remove date suffixes
    "anthropic/claude-sonnet-4-20250514": "anthropic/claude-sonnet-4",
    "anthropic/claude-opus-4-20250514": "anthropic/claude-opus-4.5",
    "anthropic/claude-haiku-4-20250514": "anthropic/claude-haiku-4.5",
    // Also handle without namespace prefix (from old settings)
    "claude-sonnet-4-20250514": "anthropic/claude-sonnet-4",
    "claude-opus-4-20250514": "anthropic/claude-opus-4.5",
    "claude-haiku-4-20250514": "anthropic/claude-haiku-4.5",
    "claude-haiku-3-20240307": "anthropic/claude-3-haiku-20240307",
  };

  return migrations[modelId] || modelId;
}

interface AgentApiPayload {
  publisher: string;
  path: string;
  method: string;
  body: {
    model: string;
    messages: ChatRequest["messages"];
    stream: boolean;
  };
}

/**
 * Default models available through Seren Gateway.
 */
const DEFAULT_MODELS: ProviderModel[] = [
  // Anthropic
  { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", contextWindow: 200000 },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200000 },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200000 },
  // OpenAI
  { id: "openai/gpt-5", name: "GPT-5", contextWindow: 128000 },
  { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128000 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
  // Google Gemini
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000 },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1000000 },
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash", contextWindow: 1000000 },
];

async function requireToken(): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated with Seren");
  }
  return token;
}

function extractContent(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }

  const payload = data as Record<string, unknown>;
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const first = choices[0];
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") {
      return message.content;
    }

    const delta = first.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") {
      return delta.content;
    }
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  return JSON.stringify(data);
}

function parseDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data);

    if (parsed.delta && parsed.delta.content) {
      return normalizeContent(parsed.delta.content);
    }

    if (parsed.choices && parsed.choices[0]?.delta?.content) {
      return normalizeContent(parsed.choices[0].delta.content);
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeContent(chunk: unknown): string | null {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (Array.isArray(chunk)) {
    return chunk
      .map((piece) => {
        if (!piece) return "";
        if (typeof piece === "string") return piece;
        if (typeof piece === "object" && "text" in piece) {
          return (piece as Record<string, unknown>).text ?? "";
        }
        return "";
      })
      .join("");
  }

  if (typeof chunk === "object" && chunk && "text" in chunk) {
    return (chunk as Record<string, string>).text ?? null;
  }

  return null;
}

export const serenProvider: ProviderAdapter = {
  id: "seren",

  async sendMessage(request: ChatRequest, _apiKey: string): Promise<string> {
    const token = await requireToken();
    const model = normalizeModelId(request.model);

    const agentPayload: AgentApiPayload = {
      publisher: PUBLISHER_SLUG,
      path: "/chat/completions",
      method: "POST",
      body: {
        model,
        messages: request.messages,
        stream: false,
      },
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
      const errorText = await response.text().catch(() => "");
      throw new Error(`Seren request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return extractContent(data);
  },

  async *streamMessage(request: ChatRequest, _apiKey: string): AsyncGenerator<string, void, unknown> {
    const token = await requireToken();
    const model = normalizeModelId(request.model);

    const agentPayload: AgentApiPayload = {
      publisher: PUBLISHER_SLUG,
      path: "/chat/completions",
      method: "POST",
      body: {
        model,
        messages: request.messages,
        stream: true,
      },
    };

    const response = await appFetch(AGENT_STREAM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(agentPayload),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "");
      console.error("[Seren Stream Error]", {
        status: response.status,
        body: errorText,
        payload: agentPayload,
      });
      throw new Error(`Seren streaming failed: ${response.status} - ${errorText}`);
    }

    const reader = response.body.getReader();
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

          const delta = parseDelta(data);
          if (delta) {
            yield delta;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  async validateKey(_apiKey: string): Promise<boolean> {
    // Seren uses Seren auth token, not API key - always valid if logged in
    const token = await getToken();
    return token !== null;
  },

  async getModels(_apiKey: string): Promise<ProviderModel[]> {
    // Try to fetch from Seren's models endpoint
    try {
      const token = await getToken();
      if (!token) return DEFAULT_MODELS;

      const agentPayload: AgentApiPayload = {
        publisher: PUBLISHER_SLUG,
        path: "/models",
        method: "GET",
        body: {
          model: "",
          messages: [],
          stream: false,
        },
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
        return DEFAULT_MODELS;
      }

      const data = await response.json();
      if (Array.isArray(data.data)) {
        return data.data.map((m: { id: string; name?: string; context_length?: number }) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.context_length || 128000,
        }));
      }

      return DEFAULT_MODELS;
    } catch {
      return DEFAULT_MODELS;
    }
  },
};
