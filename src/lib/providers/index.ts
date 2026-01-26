// ABOUTME: Provider registry and unified API for multi-provider chat.
// ABOUTME: Routes requests to the appropriate provider based on settings.

import { serenProvider } from "./seren";
import { anthropicProvider } from "./anthropic";
import { openaiProvider } from "./openai";
import { geminiProvider } from "./gemini";
import { providerStore } from "@/stores/provider.store";
import type {
  ChatRequest,
  ProviderId,
  ProviderAdapter,
  ProviderModel,
  ChatMessage,
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
 * Send a non-streaming message using the specified provider.
 */
export async function sendProviderMessage(
  providerId: ProviderId,
  request: ChatRequest
): Promise<string> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Get API key for non-Seren providers
  const apiKey = providerId === "seren"
    ? ""
    : await providerStore.getApiKey(providerId) || "";

  if (providerId !== "seren" && !apiKey) {
    throw new Error(`No API key configured for ${providerId}. Please add your API key in Settings > AI Providers.`);
  }

  return provider.sendMessage(request, apiKey);
}

/**
 * Stream a message using the specified provider.
 */
export async function* streamProviderMessage(
  providerId: ProviderId,
  request: ChatRequest
): AsyncGenerator<string, void, unknown> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Get API key for non-Seren providers
  const apiKey = providerId === "seren"
    ? ""
    : await providerStore.getApiKey(providerId) || "";

  if (providerId !== "seren" && !apiKey) {
    throw new Error(`No API key configured for ${providerId}. Please add your API key in Settings > AI Providers.`);
  }

  yield* provider.streamMessage(request, apiKey);
}

/**
 * Validate an API key for a provider.
 */
export async function validateProviderKey(
  providerId: ProviderId,
  apiKey: string
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
  apiKey?: string
): Promise<ProviderModel[]> {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Use provided key or fetch from store
  const key = apiKey || (
    providerId === "seren"
      ? ""
      : await providerStore.getApiKey(providerId) || ""
  );

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
  request: ChatRequest
): AsyncGenerator<string, void, unknown> {
  const providerId = providerStore.activeProvider;
  yield* streamProviderMessage(providerId, request);
}

/**
 * Build a chat request from content and optional context.
 * This is a helper to construct the request object.
 */
export function buildChatRequest(
  content: string,
  model: string,
  context?: {
    content: string;
    file?: string | null;
    range?: { startLine: number; endLine: number } | null;
  }
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
        `lines ${context.range.startLine}-${context.range.endLine}`
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

  // Add user message
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
    seren: "Seren Gateway",
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
