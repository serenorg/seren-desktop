// ABOUTME: Seren Models provider adapter for chat completions.
// ABOUTME: Routes requests through Seren's /publishers endpoint.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";
import { updateBalanceFromError } from "@/stores/wallet.store";
import type {
  AuthOptions,
  ChatMessageWithTools,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderModel,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from "./types";

const PUBLISHER_SLUG = "seren-models";

/**
 * User-friendly error message for credits/payment issues.
 * Contains "Insufficient" keyword so isPaymentError() detects it.
 */
const CREDITS_ERROR_MESSAGE =
  "Insufficient SerenBucks balance. Please add funds to continue.";

/**
 * Check if an error status indicates a credits/payment issue.
 */
function isCreditsError(status: number, rawError: string): boolean {
  // 402 Payment Required
  if (status === 402) return true;
  // Check for credit-related keywords in error message
  const creditKeywords = ["credits", "credit", "afford", "payment", "billing"];
  const lowerError = rawError.toLowerCase();
  return creditKeywords.some((kw) => lowerError.includes(kw));
}

/**
 * Parse 402 error response and update wallet balance if available.
 * The 402 response contains the actual balance, so we update the UI immediately.
 */
function handleInsufficientBalanceError(errorText: string): void {
  try {
    const data = JSON.parse(errorText);
    // The 402 response includes availableBalanceAtomic as a string
    if (data.availableBalanceAtomic !== undefined) {
      const balanceAtomic = Number.parseInt(data.availableBalanceAtomic, 10);
      if (!Number.isNaN(balanceAtomic)) {
        updateBalanceFromError(balanceAtomic);
      }
    }
  } catch {
    // Failed to parse error response, ignore
  }
}

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

/** Request body for chat completions */
interface ChatCompletionRequest {
  model: string;
  messages: ChatRequest["messages"] | ChatMessageWithTools[];
  stream: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
}

/** Wrapped response from the /publishers endpoint */
interface GatewayResponse<T> {
  status: number;
  body: T;
  cost: string;
}

/**
 * Default models available through Seren Gateway.
 */
const DEFAULT_MODELS: ProviderModel[] = [
  // Anthropic
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    contextWindow: 1000000,
  },
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    contextWindow: 200000,
  },
  // OpenAI
  { id: "openai/gpt-5", name: "GPT-5", contextWindow: 128000 },
  { id: "openai/gpt-4o", name: "GPT-4o", contextWindow: 128000 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
  // Google Gemini
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    contextWindow: 1048576,
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    contextWindow: 1048576,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1000000,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    contextWindow: 1000000,
  },
  // Zhipu AI
  {
    id: "thudm/glm-4",
    name: "GLM-4",
    contextWindow: 128000,
  },
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
  // Unwrap body if response is wrapped (e.g., { status: 200, body: { choices: [...] } })
  const body = payload.body as Record<string, unknown> | undefined;
  const responseData = body || payload;
  const choices = responseData.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (choices && choices.length > 0) {
    const first = choices[0];
    const message = first.message as Record<string, unknown> | undefined;
    if (message) {
      // Handle content in string or array format (Gemini may return array of parts)
      const extracted = normalizeContent(message.content);
      if (extracted) return extracted;
    }

    const delta = first.delta as Record<string, unknown> | undefined;
    if (delta) {
      const extracted = normalizeContent(delta.content);
      if (extracted) return extracted;
    }
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  return JSON.stringify(data);
}

/**
 * Extract a structured ChatResponse from API response data.
 * Handles both content and tool_calls.
 */
function extractChatResponse(data: unknown): ChatResponse {
  if (!data || typeof data !== "object") {
    return { content: "", finish_reason: "stop" };
  }

  const payload = data as Record<string, unknown>;
  // Unwrap body if response is wrapped (e.g., { status: 200, body: { choices: [...] } })
  const body = payload.body as Record<string, unknown> | undefined;
  const responseData = body || payload;
  const choices = responseData.choices as
    | Array<Record<string, unknown>>
    | undefined;

  if (!choices || choices.length === 0) {
    return { content: null, finish_reason: "stop" };
  }

  const first = choices[0];
  const message = first.message as Record<string, unknown> | undefined;
  const finishReason = (first.finish_reason as string) || "stop";

  let content: string | null = null;
  let toolCalls: ToolCall[] | undefined;

  if (message) {
    // Extract content (handle string, array, or null formats)
    // Gemini models may return content as an array of parts
    content = normalizeContent(message.content);

    // Extract tool_calls
    const rawToolCalls = message.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (rawToolCalls && rawToolCalls.length > 0) {
      toolCalls = rawToolCalls.map((tc) => ({
        id: tc.id as string,
        type: "function" as const,
        function: {
          name: (tc.function as Record<string, unknown>).name as string,
          arguments: (tc.function as Record<string, unknown>)
            .arguments as string,
        },
      }));
    }
  }

  return {
    content,
    tool_calls: toolCalls,
    finish_reason:
      finishReason === "tool_calls"
        ? "tool_calls"
        : finishReason === "length"
          ? "length"
          : finishReason === "content_filter"
            ? "content_filter"
            : "stop",
  };
}

function parseDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data);

    if (parsed.delta?.content) {
      return normalizeContent(parsed.delta.content);
    }

    if (parsed.choices?.[0]?.delta?.content) {
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

  async sendMessage(
    request: ChatRequest,
    _auth: string | AuthOptions,
  ): Promise<string> {
    const token = await requireToken();
    const model = normalizeModelId(request.model);

    const payload: ChatCompletionRequest = {
      model,
      messages: request.messages,
      stream: false,
      tools: request.tools,
      tool_choice: request.tool_choice,
    };

    const response = await appFetch(
      `${apiBase}/publishers/${PUBLISHER_SLUG}/chat/completions`,
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
      const errorText = await response.text().catch(() => "");
      // Update displayed balance from 402 error response
      if (response.status === 402) {
        handleInsufficientBalanceError(errorText);
      }
      throw new Error(`Seren request failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as GatewayResponse<unknown>;

    // Check for wrapped error responses (HTTP 200 but error in body)
    if (data.status && data.status >= 400) {
      const body = data.body as Record<string, unknown> | undefined;
      const error = body?.error as Record<string, unknown> | undefined;
      if (error) {
        const metadata = (error.metadata as Record<string, unknown>) || {};
        const rawError = String(
          metadata.raw || error.message || "Unknown error",
        );

        // Show user-friendly message for credits/payment issues
        if (isCreditsError(data.status, rawError)) {
          throw new Error(CREDITS_ERROR_MESSAGE);
        }

        const providerName = metadata.provider_name || "Provider";
        throw new Error(`${providerName} error (${data.status}): ${rawError}`);
      }
      throw new Error(`Seren upstream error: ${data.status}`);
    }

    return extractContent(data);
  },

  async *streamMessage(
    request: ChatRequest,
    _auth: string | AuthOptions,
  ): AsyncGenerator<string, void, unknown> {
    const token = await requireToken();
    const model = normalizeModelId(request.model);

    const payload: ChatCompletionRequest = {
      model,
      messages: request.messages,
      stream: true,
    };

    const response = await appFetch(
      `${apiBase}/publishers/${PUBLISHER_SLUG}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => "");
      console.error("[Seren Stream Error]", {
        status: response.status,
        body: errorText,
        model,
      });
      // Update displayed balance from 402 error response
      if (response.status === 402) {
        handleInsufficientBalanceError(errorText);
      }
      throw new Error(
        `Seren streaming failed: ${response.status} - ${errorText}`,
      );
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

      const response = await appFetch(
        `${apiBase}/publishers/${PUBLISHER_SLUG}/models`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        return DEFAULT_MODELS;
      }

      const result = (await response.json()) as GatewayResponse<{
        data?: Array<{ id: string; name?: string; context_length?: number }>;
      }>;

      // Unwrap gateway response
      const data = result.body || result;
      if (Array.isArray((data as { data?: unknown[] }).data)) {
        return (
          data as {
            data: Array<{ id: string; name?: string; context_length?: number }>;
          }
        ).data.map((m) => ({
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

// ============================================================================
// Tool-aware API Functions
// ============================================================================

/**
 * Send a message with tool support and get a structured response.
 * Unlike sendMessage which returns string, this returns ChatResponse with tool_calls.
 */
export async function sendMessageWithTools(
  messages: ChatMessageWithTools[],
  model: string,
  tools?: ToolDefinition[],
  toolChoice?: ToolChoice,
): Promise<ChatResponse> {
  const token = await requireToken();
  const normalizedModel = normalizeModelId(model);

  const payload: ChatCompletionRequest = {
    model: normalizedModel,
    messages,
    stream: false,
    tools,
    tool_choice: toolChoice,
  };

  const response = await appFetch(
    `${apiBase}/publishers/${PUBLISHER_SLUG}/chat/completions`,
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
    const errorText = await response.text().catch(() => "");
    // Update displayed balance from 402 error response
    if (response.status === 402) {
      handleInsufficientBalanceError(errorText);
    }
    throw new Error(`Seren request failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as GatewayResponse<unknown>;
  console.log(
    "[sendMessageWithTools] Raw API response:",
    JSON.stringify(data, null, 2),
  );

  // Check for wrapped error responses (HTTP 200 but error in body)
  if (data.status && data.status >= 400) {
    const body = data.body as Record<string, unknown> | undefined;
    const error = body?.error as Record<string, unknown> | undefined;
    if (error) {
      const metadata = (error.metadata as Record<string, unknown>) || {};
      const rawError = String(metadata.raw || error.message || "Unknown error");

      // Show user-friendly message for credits/payment issues
      if (isCreditsError(data.status, rawError)) {
        throw new Error(CREDITS_ERROR_MESSAGE);
      }

      const providerName = metadata.provider_name || "Provider";
      throw new Error(`${providerName} error (${data.status}): ${rawError}`);
    }
    throw new Error(`Seren upstream error: ${data.status}`);
  }

  const parsed = extractChatResponse(data);
  console.log("[sendMessageWithTools] Parsed response:", parsed);
  return parsed;
}
