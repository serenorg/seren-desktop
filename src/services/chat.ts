// ABOUTME: Chat service supporting streaming completions with multi-provider routing.
// ABOUTME: Routes requests through provider abstraction for Seren, Anthropic, OpenAI, Gemini.

import {
  sendProviderMessage,
  streamProviderMessage,
  buildChatRequest,
} from "@/lib/providers";
import { providerStore } from "@/stores/provider.store";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatContextRange {
  startLine: number;
  endLine: number;
}

export interface ChatContext {
  content: string;
  file?: string | null;
  range?: ChatContextRange | null;
}

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  model?: string;
  timestamp: number;
  status?: "pending" | "streaming" | "complete" | "error";
  error?: string | null;
  attemptCount?: number;
  request?: {
    prompt: string;
    context?: ChatContext;
  };
}

export const CHAT_MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;

/**
 * Send a non-streaming message using the active provider.
 */
export async function sendMessage(
  content: string,
  model: string,
  context?: ChatContext
): Promise<string> {
  const request = buildChatRequest(content, model, context);
  const providerId = providerStore.activeProvider;

  return sendProviderMessage(providerId, request);
}

/**
 * Stream a message using the active provider.
 */
export async function* streamMessage(
  content: string,
  model: string,
  context?: ChatContext
): AsyncGenerator<string> {
  const request = buildChatRequest(content, model, context);
  request.stream = true;
  const providerId = providerStore.activeProvider;

  yield* streamProviderMessage(providerId, request);
}

/**
 * Send a message with automatic retry on transient failures.
 */
export async function sendMessageWithRetry(
  content: string,
  model: string,
  context: ChatContext | undefined,
  onRetry?: (attempt: number) => void
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(content, model, context);
    } catch (error) {
      lastError = error as Error;

      const message = lastError.message || "";
      // Don't retry auth errors
      if (message.includes("401") || message.includes("403") || message.includes("API key")) {
        throw lastError;
      }

      if (attempt < CHAT_MAX_RETRIES) {
        const delay = INITIAL_DELAY * Math.pow(2, attempt - 1);
        onRetry?.(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Chat request failed");
}

/**
 * Get the currently active provider ID.
 */
export function getActiveProvider(): string {
  return providerStore.activeProvider;
}

/**
 * Get the currently active model ID.
 */
export function getActiveModel(): string {
  return providerStore.activeModel;
}
