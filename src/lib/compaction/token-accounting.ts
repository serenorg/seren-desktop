// ABOUTME: Request-level token accounting for compaction — counts system, tools, args, media (#2105).
// ABOUTME: Uses a flat per-image cost instead of raw base64 length so the gauge stops missing.

import { estimateTokens } from "@/lib/token-counter";

/**
 * Flat token cost charged per image/media part. Real providers bill images at
 * a roughly fixed tile cost, NOT proportional to the base64 payload length, so
 * counting raw base64 characters (what content-only estimation effectively did
 * by ignoring them, or over-counts when inlined) misreads the gauge badly. A
 * conservative flat estimate keeps multimodal sessions honest. #2105.
 */
export const IMAGE_TOKEN_COST = 1_600;

/** One message reduced to the token-bearing parts of a provider request. */
export interface AccountedMessage {
  /** Plain text content. */
  content?: string;
  /** Tool-call arguments — object or pre-serialized string. */
  toolArgs?: unknown;
  /** Tool result text. */
  toolResult?: string;
  /** Number of image/media parts attached to this message. */
  imageParts?: number;
}

export interface RequestTokenInput {
  /** System prompt / priming block. */
  systemPrompt?: string;
  /** Tool schema definitions sent with the request (array or string). */
  toolSchemas?: unknown;
  messages: AccountedMessage[];
}

/** Token cost of an arbitrary value: strings directly, everything else as JSON. */
export function estimateValueTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return estimateTokens(value);
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** Token cost of a single message including tool args, tool result, and media. */
export function estimateAccountedMessageTokens(m: AccountedMessage): number {
  return (
    estimateTokens(m.content ?? "") +
    estimateValueTokens(m.toolArgs) +
    estimateTokens(m.toolResult ?? "") +
    Math.max(0, m.imageParts ?? 0) * IMAGE_TOKEN_COST
  );
}

/**
 * Estimate the full request token load: system prompt + tool schemas + every
 * message's content, tool-call arguments, tool results, and media parts. This
 * is the request-level view the content-only counter missed — the source of
 * false context-gauge readings in tool-heavy and multimodal sessions.
 */
export function estimateRequestTokens(input: RequestTokenInput): number {
  let total = estimateTokens(input.systemPrompt ?? "");
  total += estimateValueTokens(input.toolSchemas);
  for (const m of input.messages) {
    total += estimateAccountedMessageTokens(m);
  }
  return total;
}
