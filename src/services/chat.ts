// ABOUTME: Chat service supporting streaming completions with multi-provider routing.
// ABOUTME: Routes requests through provider abstraction for Seren, Anthropic, OpenAI, Gemini.

import {
  buildChatRequest,
  sendProviderMessage,
  streamProviderMessage,
} from "@/lib/providers";
import { sendMessageWithTools as sendWithTools } from "@/lib/providers/seren";
import type {
  ChatMessageWithTools,
  ChatResponse,
  ToolCall,
  ToolResult,
} from "@/lib/providers/types";
import { executeTools, getAllTools } from "@/lib/tools";
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
  context?: ChatContext,
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
  context?: ChatContext,
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
  onRetry?: (attempt: number) => void,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(content, model, context);
    } catch (error) {
      lastError = error as Error;

      const message = lastError.message || "";
      // Don't retry auth errors
      if (
        message.includes("401") ||
        message.includes("403") ||
        message.includes("API key")
      ) {
        throw lastError;
      }

      if (attempt < CHAT_MAX_RETRIES) {
        const delay = INITIAL_DELAY * 2 ** (attempt - 1);
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

// ============================================================================
// Tool-aware Chat Functions
// ============================================================================

const MAX_TOOL_ITERATIONS = 10;

/**
 * Event types yielded during tool-aware message streaming.
 */
export type ToolStreamEvent =
  | { type: "content"; content: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "tool_results"; results: ToolResult[] }
  | { type: "complete"; finalContent: string };

/**
 * Send a message with tool support enabled.
 * Implements the tool execution loop: send → tool_calls → execute → send results → repeat.
 *
 * @param content - User's message content
 * @param model - Model ID to use
 * @param context - Optional code context
 * @param enableTools - Whether to enable tools (default true)
 * @param history - Previous messages in the conversation
 */
export async function* streamMessageWithTools(
  content: string,
  model: string,
  context?: ChatContext,
  enableTools = true,
  history: Message[] = [],
): AsyncGenerator<ToolStreamEvent> {
  // Build initial messages array
  const messages: ChatMessageWithTools[] = [];

  // Add system message with context if provided
  if (context) {
    let systemContent =
      "You are a helpful coding assistant with access to the user's local files.";
    if (context.file) {
      systemContent += `\n\nThe user has selected code from ${context.file}`;
      if (context.range) {
        systemContent += ` (lines ${context.range.startLine}-${context.range.endLine})`;
      }
      systemContent += `:\n\n\`\`\`\n${context.content}\n\`\`\``;
    } else {
      systemContent += `\n\nThe user has selected this code:\n\n\`\`\`\n${context.content}\n\`\`\``;
    }
    messages.push({ role: "system", content: systemContent });
  } else {
    messages.push({
      role: "system",
      content:
        "You are a helpful coding assistant with access to the user's local files. Use the available tools to read, list, and write files when needed to help the user.",
    });
  }

  // Add conversation history (user and assistant messages only)
  for (const msg of history) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current user message
  messages.push({ role: "user", content });

  // Get tools if enabled
  const tools = enableTools ? getAllTools() : undefined;

  // Accumulated content across all iterations
  let fullContent = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    console.log("[streamMessageWithTools] Iteration:", iteration);
    // Send request with tools
    const response: ChatResponse = await sendWithTools(
      messages,
      model,
      tools,
      tools ? "auto" : undefined,
    );
    console.log("[streamMessageWithTools] Got response:", response);

    // Yield content if present
    if (response.content) {
      console.log("[streamMessageWithTools] Yielding content:", response.content.substring(0, 100));
      fullContent += response.content;
      yield { type: "content", content: response.content };
    } else {
      console.log("[streamMessageWithTools] No content in response");
    }

    // Check if model wants to call tools
    if (!response.tool_calls || response.tool_calls.length === 0) {
      // No tool calls, we're done
      console.log("[streamMessageWithTools] No tool_calls, completing with content length:", fullContent.length);
      yield { type: "complete", finalContent: fullContent };
      return;
    }

    // Yield tool calls for UI
    yield { type: "tool_calls", toolCalls: response.tool_calls };

    // Add assistant message with tool_calls to history
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    // Execute tools
    const results = await executeTools(response.tool_calls);

    // Yield results for UI
    yield { type: "tool_results", results };

    // Add tool results to messages
    for (const result of results) {
      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: result.tool_call_id,
      });
    }

    // Continue loop to get model's response to tool results
  }

  // If we hit max iterations, yield what we have
  yield {
    type: "complete",
    finalContent: `${fullContent}\n\n(Reached maximum tool iterations)`,
  };
}

/**
 * Check if tools are available for the current provider.
 * Currently only Seren provider supports tools.
 */
export function areToolsAvailable(): boolean {
  return providerStore.activeProvider === "seren";
}
