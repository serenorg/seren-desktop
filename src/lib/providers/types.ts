// ABOUTME: Type definitions for LLM provider configuration and API communication.
// ABOUTME: Supports Seren Gateway and direct provider integrations (Anthropic, OpenAI, Gemini).

/**
 * Supported LLM provider identifiers.
 */
export type ProviderId = "seren" | "anthropic" | "openai" | "gemini";

/**
 * Configuration for a provider including display info and API details.
 */
export interface ProviderConfig {
  id: ProviderId;
  name: string;
  description: string;
  apiKeyRequired: boolean;
  apiKeyPrefix?: string;
  apiKeyPlaceholder?: string;
  baseUrl: string;
  docsUrl: string;
}

/**
 * Model information for a specific provider.
 */
export interface ProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  description?: string;
}

/**
 * Credentials stored for a provider.
 */
export interface ProviderCredentials {
  apiKey: string;
  validatedAt: number;
}

/**
 * Message format for chat requests.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Request payload for chat completions.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
}

/**
 * Interface that all provider adapters must implement.
 */
export interface ProviderAdapter {
  /** Provider identifier */
  id: ProviderId;

  /**
   * Send a non-streaming message and get the complete response.
   */
  sendMessage(request: ChatRequest, apiKey: string): Promise<string>;

  /**
   * Stream a message response, yielding chunks as they arrive.
   */
  streamMessage(request: ChatRequest, apiKey: string): AsyncGenerator<string, void, unknown>;

  /**
   * Validate an API key by making a minimal test request.
   * Returns true if the key is valid.
   */
  validateKey(apiKey: string): Promise<boolean>;

  /**
   * Get available models for this provider.
   * For some providers this is a static list, others fetch dynamically.
   */
  getModels(apiKey: string): Promise<ProviderModel[]>;
}

/**
 * Static configuration for all supported providers.
 */
export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  seren: {
    id: "seren",
    name: "Seren Gateway",
    description: "Use your SerenBucks balance to access multiple AI models",
    apiKeyRequired: false,
    baseUrl: "https://api.serendb.com",
    docsUrl: "https://docs.serendb.com",
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    description: "Direct access to Claude models with your Anthropic API key",
    apiKeyRequired: true,
    apiKeyPrefix: "sk-ant-",
    apiKeyPlaceholder: "sk-ant-api03-...",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://docs.anthropic.com",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    description: "Direct access to GPT models with your OpenAI API key",
    apiKeyRequired: true,
    apiKeyPrefix: "sk-",
    apiKeyPlaceholder: "sk-proj-...",
    baseUrl: "https://api.openai.com",
    docsUrl: "https://platform.openai.com/docs",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    description: "Direct access to Gemini models with your Google AI API key",
    apiKeyRequired: true,
    apiKeyPlaceholder: "AIza...",
    baseUrl: "https://generativelanguage.googleapis.com",
    docsUrl: "https://ai.google.dev/docs",
  },
};

/**
 * List of provider IDs that require API key configuration (excludes Seren).
 */
export const CONFIGURABLE_PROVIDERS: ProviderId[] = ["anthropic", "openai", "gemini"];

/**
 * Get provider configuration by ID.
 */
export function getProviderConfig(id: ProviderId): ProviderConfig {
  return PROVIDER_CONFIGS[id];
}

/**
 * Check if a provider requires an API key.
 */
export function requiresApiKey(id: ProviderId): boolean {
  return PROVIDER_CONFIGS[id].apiKeyRequired;
}
