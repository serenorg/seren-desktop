// ABOUTME: Provider registry and unified API for multi-provider chat.
// ABOUTME: Routes requests to the appropriate provider based on settings.

import { getOAuthCredentials } from "@/lib/tauri-bridge";
import { needsRefresh, refreshOAuthToken } from "@/services/oauth";
import { providerStore } from "@/stores/provider.store";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import { serenProvider } from "./seren";
import type {
  ChatMessage,
  ChatRequest,
  OAuthCredentials,
  ProviderAdapter,
  ProviderId,
  ProviderModel,
} from "./types";

// Re-export types
export * from "./types";

/**
 * Registry of all available providers.
 */
const providers: Record<ProviderId, ProviderAdapter> = {
  seren: serenProvider,
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

/**
 * Get a provider adapter by ID.
 */
export function getProvider(id: ProviderId): ProviderAdapter {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

/**
 * Get authentication token for a provider.
 * Returns OAuth access token if configured via OAuth, otherwise API key.
 * Handles token refresh if needed.
 */
async function getAuthToken(
  providerId: ProviderId,
): Promise<{ token: string; isOAuth: boolean }> {
  if (providerId === "seren") {
    return { token: "", isOAuth: false };
  }

  const authType = providerStore.getAuthType(providerId);

  if (authType === "oauth") {
    // Get OAuth credentials
    const credentialsJson = await getOAuthCredentials(providerId);
    if (!credentialsJson) {
      throw new Error(
        `OAuth credentials not found for ${providerId}. Please sign in again.`,
      );
    }

    const credentials = JSON.parse(credentialsJson) as OAuthCredentials;

    // Check if token needs refresh
    if (needsRefresh(credentials) && credentials.refreshToken) {
      try {
        const refreshed = await refreshOAuthToken(
          providerId,
          credentials.refreshToken,
        );
        // Store refreshed credentials
        const { storeOAuthCredentials } = await import("@/lib/tauri-bridge");
        await storeOAuthCredentials(providerId, JSON.stringify(refreshed));
        return { token: refreshed.accessToken, isOAuth: true };
      } catch (error) {
        // If refresh fails, try using existing token (it may still work)
        console.warn(
          "Token refresh failed, attempting with existing token:",
          error,
        );
      }
    }

    return { token: credentials.accessToken, isOAuth: true };
  }

  // Fall back to API key
  const apiKey = await providerStore.getApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `No API key configured for ${providerId}. Please add your API key in Settings > AI Providers.`,
    );
  }

  return { token: apiKey, isOAuth: false };
}

/**
 * Send a non-streaming message using the specified provider.
 */
export async function sendProviderMessage(
  providerId: ProviderId,
  request: ChatRequest,
): Promise<string> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Get authentication token (API key or OAuth token)
  const { token, isOAuth } = await getAuthToken(providerId);

  return provider.sendMessage(request, { token, isOAuth });
}

/**
 * Stream a message using the specified provider.
 */
export async function* streamProviderMessage(
  providerId: ProviderId,
  request: ChatRequest,
): AsyncGenerator<string, void, unknown> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Get authentication token (API key or OAuth token)
  const { token, isOAuth } = await getAuthToken(providerId);

  yield* provider.streamMessage(request, { token, isOAuth });
}

/**
 * Validate an API key for a provider.
 */
export async function validateProviderKey(
  providerId: ProviderId,
  apiKey: string,
): Promise<boolean> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider.validateKey(apiKey);
}

/**
 * Get available models for a provider.
 * For non-Seren providers, requires a valid API key.
 */
export async function getProviderModels(
  providerId: ProviderId,
  apiKey?: string,
): Promise<ProviderModel[]> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Use provided key or fetch from store
  const key =
    apiKey ||
    (providerId === "seren"
      ? ""
      : (await providerStore.getApiKey(providerId)) || "");

  return provider.getModels(key);
}

/**
 * Send a message using the currently active provider.
 */
export async function sendMessage(request: ChatRequest): Promise<string> {
  const providerId = providerStore.activeProvider;
  return sendProviderMessage(providerId, request);
}

/**
 * Stream a message using the currently active provider.
 */
export async function* streamMessage(
  request: ChatRequest,
): AsyncGenerator<string, void, unknown> {
  const providerId = providerStore.activeProvider;
  yield* streamProviderMessage(providerId, request);
}

/**
 * Build a chat request from content, optional context, and conversation history.
 * This is a helper to construct the request object.
 */
export function buildChatRequest(
  content: string,
  model: string,
  context?: {
    content: string;
    file?: string | null;
    range?: { startLine: number; endLine: number } | null;
  },
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>,
): ChatRequest {
  const messages: ChatMessage[] = [];

  // Add system message with context if provided
  if (context && context.content.trim().length > 0) {
    const locationParts: string[] = [];
    if (context.file) {
      locationParts.push(context.file);
    }
    if (context.range) {
      locationParts.push(
        `lines ${context.range.startLine}-${context.range.endLine}`,
      );
    }
    const location = locationParts.length
      ? ` from ${locationParts.join(" ")}`
      : "";

    messages.push({
      role: "system",
      content: `The user selected the following context${location}. Use it when responding.\n\n<context>\n${context.content}\n</context>`,
    });
  }

  // Add conversation history (user and assistant messages only)
  if (history && history.length > 0) {
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // Add current user message
  messages.push({ role: "user", content });

  return {
    messages,
    model,
    stream: false,
  };
}

/**
 * Get the display name for a provider.
 */
export function getProviderDisplayName(providerId: ProviderId): string {
  const names: Record<ProviderId, string> = {
    seren: "Seren Models",
    anthropic: "Anthropic",
    openai: "OpenAI",
    gemini: "Google Gemini",
  };
  return names[providerId] || providerId;
}

/**
 * Get an icon/emoji for a provider.
 */
export function getProviderIcon(providerId: ProviderId): string {
  const icons: Record<ProviderId, string> = {
    seren: "S",
    anthropic: "A",
    openai: "O",
    gemini: "G",
  };
  return icons[providerId] || "?";
}
