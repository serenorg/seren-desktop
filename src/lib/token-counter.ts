// ABOUTME: Token counting utility for estimating context window usage.
// ABOUTME: Uses character-based heuristic (4 chars ≈ 1 token) for efficiency.

import type { Message } from "@/services/chat";

/**
 * Model context limits in tokens.
 * These are approximate limits for common models.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude models
  "anthropic/claude-sonnet-4": 200000,
  "anthropic/claude-opus-4": 200000,
  "anthropic/claude-3-5-sonnet": 200000,
  "anthropic/claude-3-opus": 200000,
  "anthropic/claude-3-haiku": 200000,
  // OpenAI models
  "openai/gpt-4-turbo": 128000,
  "openai/gpt-4o": 128000,
  "openai/gpt-4": 8192,
  "openai/gpt-3.5-turbo": 16385,
  // Gemini models
  "google/gemini-pro": 32760,
  "google/gemini-1.5-pro": 1000000,
  // Default for unknown models
  default: 100000,
};

/**
 * Estimate token count for a string.
 * Uses a simple heuristic: ~4 characters per token on average.
 * This is a reasonable approximation for English text and code.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Average of ~4 characters per token for English/code
  return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a single message.
 * Includes overhead for message structure (role, formatting).
 */
export function estimateMessageTokens(message: Message): number {
  // Base overhead for message structure (~4 tokens)
  const overhead = 4;
  return overhead + estimateTokens(message.content);
}

/**
 * Estimate total token count for an array of messages.
 */
export function estimateConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Get the context limit for a given model.
 */
export function getModelContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? MODEL_CONTEXT_LIMITS.default;
}

/**
 * Calculate the percentage of context used.
 */
export function calculateContextUsage(
  messages: Message[],
  model: string,
): number {
  const tokens = estimateConversationTokens(messages);
  const limit = getModelContextLimit(model);
  return Math.min(100, Math.round((tokens / limit) * 100));
}

/**
 * Check if compaction should be triggered based on threshold.
 */
export function shouldTriggerCompaction(
  messages: Message[],
  model: string,
  thresholdPercent: number,
): boolean {
  const usage = calculateContextUsage(messages, model);
  return usage >= thresholdPercent;
}
