// ABOUTME: Type definitions for LLM provider configuration and API communication.
// ABOUTME: Supports Seren Gateway and direct provider integrations (Anthropic, OpenAI, Gemini).

/**
 * Supported LLM provider identifiers.
 */
export type ProviderId = "seren" | "anthropic" | "openai" | "gemini";

/**
 * Authentication method for a provider.
 */
export type AuthMethod = "none" | "api_key" | "oauth" | "api_key_or_oauth";

/**
 * OAuth configuration for providers that support it.
 */
export interface OAuthConfig {
  /** OAuth authorization endpoint */
  authUrl: string;
  /** OAuth token endpoint */
  tokenUrl: string;
  /** OAuth scopes required */
  scopes: string[];
  /** OAuth client ID (public, registered with provider) */
  clientId: string;
  /** Whether this provider uses PKCE (most modern providers do) */
  usePkce: boolean;
}

/**
 * Configuration for a provider including display info and API details.
 */
export interface ProviderConfig {
  id: ProviderId;
  name: string;
  description: string;
  /** Authentication methods supported by this provider */
  authMethod: AuthMethod;
  apiKeyPrefix?: string;
  apiKeyPlaceholder?: string;
  baseUrl: string;
  docsUrl: string;
  /** OAuth configuration (if authMethod includes oauth) */
  oauth?: OAuthConfig;
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
 * API key credentials stored for a provider.
 */
export interface ApiKeyCredentials {
  type: "api_key";
  apiKey: string;
  validatedAt: number;
}

/**
 * OAuth credentials stored for a provider.
 */
export interface OAuthCredentials {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
  validatedAt: number;
}

/**
 * Credentials stored for a provider (API key or OAuth).
 */
export type ProviderCredentials = ApiKeyCredentials | OAuthCredentials;

/**
 * Text content block for multimodal messages.
 */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * Image content block for multimodal messages (OpenAI-compatible format).
 */
export interface ImageContentBlock {
  type: "image_url";
  image_url: {
    url: string; // data:image/png;base64,... or https://...
  };
}

/**
 * Document content block for PDFs (Anthropic-native format).
 * Used when sending PDFs through content blocks to Anthropic API.
 */
export interface DocumentContentBlock {
  type: "document";
  source: {
    type: "base64";
    media_type: "application/pdf";
    data: string; // raw base64 without data URL prefix
  };
}

/**
 * Content block for multimodal messages.
 * Supports text, images (OpenAI format), and documents (Anthropic format).
 */
export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | DocumentContentBlock;

/**
 * File attachment metadata stored with messages.
 * Supports images, PDFs, and text/code files.
 */
export interface Attachment {
  name: string;
  mimeType: string;
  base64: string; // raw base64 without data URL prefix
}

/** @deprecated Use Attachment instead */
export type ImageAttachment = Attachment;

/**
 * Message format for chat requests.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

/**
 * Request payload for chat completions.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
}

// ============================================================================
// Tool Types (OpenAI Function Calling Format)
// ============================================================================

/**
 * JSON Schema for tool parameters.
 */
export interface ToolParameterSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description?: string;
      enum?: string[];
      items?: { type: string };
    }
  >;
  required?: string[];
}

/**
 * Tool definition following OpenAI function calling format.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
}

/**
 * Tool choice options for controlling tool usage.
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * A tool call returned by the model.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string of arguments
  };
}

/**
 * Extended message that can include tool calls (assistant) or tool results.
 */
export interface ChatMessageWithTools {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentBlock[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // Required when role is "tool"
}

/**
 * Structured response from a chat completion that may contain tool calls.
 */
export interface ChatResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
}

/**
 * Result from executing a tool.
 */
export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

/**
 * Authentication options for provider API calls.
 */
export interface AuthOptions {
  /** The authentication token (API key or OAuth access token) */
  token: string;
  /** Whether the token is an OAuth access token (affects how auth is passed to API) */
  isOAuth?: boolean;
}

/**
 * Interface that all provider adapters must implement.
 */
export interface ProviderAdapter {
  /** Provider identifier */
  id: ProviderId;

  /**
   * Send a non-streaming message and get the complete response.
   * @param request - The chat request
   * @param auth - Authentication token string or AuthOptions object
   */
  sendMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): Promise<string>;

  /**
   * Stream a message response, yielding chunks as they arrive.
   * @param request - The chat request
   * @param auth - Authentication token string or AuthOptions object
   */
  streamMessage(
    request: ChatRequest,
    auth: string | AuthOptions,
  ): AsyncGenerator<string, void, unknown>;

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
    name: "Seren Models",
    description: "Use your SerenBucks balance to access multiple AI models",
    authMethod: "none",
    baseUrl: "https://api.serendb.com",
    docsUrl: "https://docs.serendb.com",
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    description: "Direct access to Claude models with your Anthropic API key",
    authMethod: "api_key",
    apiKeyPrefix: "sk-ant-",
    apiKeyPlaceholder: "sk-ant-api03-...",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://docs.anthropic.com",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    description: "Direct access to GPT models with your OpenAI API key",
    authMethod: "api_key",
    apiKeyPrefix: "sk-",
    apiKeyPlaceholder: "sk-proj-...",
    baseUrl: "https://api.openai.com",
    docsUrl: "https://platform.openai.com/docs",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    description: "Access Gemini models via Google sign-in or API key",
    authMethod: "api_key_or_oauth",
    apiKeyPlaceholder: "AIza...",
    baseUrl: "https://generativelanguage.googleapis.com",
    docsUrl: "https://ai.google.dev/docs",
    oauth: {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/generative-language.retriever",
        "https://www.googleapis.com/auth/cloud-platform",
      ],
      clientId:
        "394120216619-p8h1i4ple18omhcp76h4va64v5ao4jv8.apps.googleusercontent.com",
      usePkce: true,
    },
  },
};

/**
 * List of provider IDs that can be configured by users (excludes Seren).
 */
export const CONFIGURABLE_PROVIDERS: ProviderId[] = [
  "anthropic",
  "openai",
  "gemini",
];

/**
 * List of provider IDs that support OAuth.
 */
export const OAUTH_PROVIDERS: ProviderId[] = ["gemini"];

/**
 * Get provider configuration by ID.
 */
export function getProviderConfig(id: ProviderId): ProviderConfig {
  return PROVIDER_CONFIGS[id];
}

/**
 * Check if a provider supports API key authentication.
 */
export function supportsApiKey(id: ProviderId): boolean {
  const method = PROVIDER_CONFIGS[id].authMethod;
  return method === "api_key" || method === "api_key_or_oauth";
}

/**
 * Check if a provider supports OAuth authentication.
 */
export function supportsOAuth(id: ProviderId): boolean {
  const method = PROVIDER_CONFIGS[id].authMethod;
  return (
    (method === "oauth" || method === "api_key_or_oauth") &&
    !!PROVIDER_CONFIGS[id].oauth
  );
}
