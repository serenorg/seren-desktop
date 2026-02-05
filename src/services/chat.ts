// ABOUTME: Chat service supporting streaming completions with multi-provider routing.
// ABOUTME: Routes requests through provider abstraction for Seren, Anthropic, OpenAI, Gemini.

import { toDataUrl } from "@/lib/images/attachments";
import { retrieveCodeContext } from "@/lib/indexing/context-retrieval";
import {
  buildChatRequest,
  sendProviderMessage,
  streamProviderMessage,
} from "@/lib/providers";
import { sendMessageWithTools as sendWithTools } from "@/lib/providers/seren";
import type {
  ChatMessageWithTools,
  ChatResponse,
  ContentBlock,
  ImageAttachment,
  ToolCall,
  ToolResult,
} from "@/lib/providers/types";
import { executeTools, getAllTools } from "@/lib/tools";
import { getGatewayTools } from "@/services/mcp-gateway";
import { fileTreeState } from "@/stores/fileTree";
import { providerStore } from "@/stores/provider.store";
import {
  getActiveToolsetPublishers,
  settingsStore,
} from "@/stores/settings.store";

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
  images?: ImageAttachment[];
  thinking?: string;
  model?: string;
  timestamp: number;
  status?: "pending" | "streaming" | "complete" | "error";
  error?: string | null;
  attemptCount?: number;
  /** Duration in milliseconds for how long the response took */
  duration?: number;
  request?: {
    prompt: string;
    context?: ChatContext;
  };
}

export const CHAT_MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;
const TRANSIENT_STATUS_CODES = ["408", "429", "500", "502", "503", "504"];

/**
 * Check if an error is transient and should be retried.
 */
function isTransientError(message: string): boolean {
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("API key")
  ) {
    return false;
  }
  return TRANSIENT_STATUS_CODES.some((code) => message.includes(code));
}

/**
 * Call sendWithTools with retry on transient failures (408, 429, 5xx).
 */
async function sendWithToolsRetry(
  messages: ChatMessageWithTools[],
  model: string,
  tools: ReturnType<typeof getAllTools> | undefined,
  toolChoice: "auto" | undefined,
): Promise<ChatResponse> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      return await sendWithTools(messages, model, tools, toolChoice);
    } catch (error) {
      lastError = error as Error;
      const msg = lastError.message || "";

      if (!isTransientError(msg)) {
        throw lastError;
      }

      if (attempt < CHAT_MAX_RETRIES) {
        const delay = INITIAL_DELAY * 2 ** (attempt - 1);
        console.warn(
          `[sendWithToolsRetry] Attempt ${attempt} failed (${msg}), retrying in ${delay}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error("Tool-use request failed after retries");
}

/**
 * Send a non-streaming message using the active provider.
 */
export async function sendMessage(
  content: string,
  model: string,
  context?: ChatContext,
  history?: Message[],
): Promise<string> {
  const request = buildChatRequest(content, model, context, history);
  const providerId = providerStore.activeProvider;

  return sendProviderMessage(providerId, request);
}

/**
 * Stream a message using the active provider.
 * Includes conversation history for multi-turn context.
 */
export async function* streamMessage(
  content: string,
  model: string,
  context?: ChatContext,
  history?: Message[],
): AsyncGenerator<string> {
  const request = buildChatRequest(content, model, context, history);
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
  history?: Message[],
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHAT_MAX_RETRIES; attempt++) {
    try {
      return await sendMessage(content, model, context, history);
    } catch (error) {
      lastError = error as Error;

      const message = lastError.message || "";
      if (!isTransientError(message)) {
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

/**
 * State needed to continue a paused tool iteration loop.
 */
export interface ToolIterationState {
  messages: ChatMessageWithTools[];
  model: string;
  tools: ReturnType<typeof getAllTools> | undefined;
  fullContent: string;
  iteration: number;
}

/**
 * Event types yielded during tool-aware message streaming.
 */
export type ToolStreamEvent =
  | { type: "content"; content: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "tool_results"; results: ToolResult[] }
  | { type: "complete"; finalContent: string; finalThinking?: string }
  | {
      type: "iteration_limit";
      currentIteration: number;
      maxIterations: number;
      continueState: ToolIterationState;
    };

/**
 * Build multimodal content blocks from text and optional images.
 */
function buildUserContent(
  text: string,
  images?: ImageAttachment[],
): string | ContentBlock[] {
  if (!images || images.length === 0) {
    return text;
  }

  const blocks: ContentBlock[] = [];

  // Add image blocks first so the model sees them before the text
  for (const img of images) {
    blocks.push({
      type: "image_url",
      image_url: { url: toDataUrl(img) },
    });
  }

  blocks.push({ type: "text", text });

  return blocks;
}

/**
 * Send a message with tool support enabled.
 * Implements the tool execution loop: send → tool_calls → execute → send results → repeat.
 *
 * @param content - User's message content
 * @param model - Model ID to use
 * @param context - Optional code context
 * @param enableTools - Whether to enable tools (default true)
 * @param history - Previous messages in the conversation
 * @param images - Optional image attachments
 */
export async function* streamMessageWithTools(
  content: string,
  model: string,
  context?: ChatContext,
  enableTools = true,
  history: Message[] = [],
  images?: ImageAttachment[],
): AsyncGenerator<ToolStreamEvent> {
  // Build initial messages array
  const messages: ChatMessageWithTools[] = [];

  // Build Seren MCP publishers context dynamically based on active toolset
  // This ensures the LLM only knows about publishers that are actually available
  const buildPublishersContext = (): string => {
    const allGatewayTools = getGatewayTools();
    const activePublishers = getActiveToolsetPublishers();

    // Filter tools by active toolset (same logic as definitions.ts)
    const availableTools = activePublishers
      ? allGatewayTools.filter((t) => activePublishers.includes(t.publisher))
      : allGatewayTools;

    // Get unique publisher slugs from available tools
    const publishers = [...new Set(availableTools.map((t) => t.publisher))];

    if (publishers.length === 0) {
      return ""; // No publishers available, don't add context
    }

    const publisherList = publishers.join(", ");
    return (
      "\n\nIMPORTANT - Available Seren MCP Publishers:\n" +
      "This application connects to Seren MCP publishers - third-party data services. " +
      `You have access to the following publishers: ${publisherList}. ` +
      "ONLY use tools from these publishers. Do NOT suggest or attempt to use publishers that are not in this list. " +
      "When users mention publisher names, interpret them in the Seren MCP context unless they explicitly ask about the technology/framework itself."
    );
  };
  const serenPublishersContext = buildPublishersContext();

  // Build system message - conditional based on actual tool availability
  const toolCount = enableTools ? getAllTools(model).length : 0;
  let systemContent: string;

  if (toolCount > 0) {
    // Tools are available - describe capabilities accurately
    systemContent =
      `You are a helpful coding assistant running inside Seren Desktop with access to ${toolCount} tools. ` +
      "You can read, write, and create files and directories on the user's computer using the available tools. " +
      "When the user asks you to save, export, or write content to a file, use the write_file tool to save it to their filesystem. " +
      "Always ask for the desired file path if the user doesn't specify one." +
      serenPublishersContext;
  } else {
    // No tools available - don't claim tool capabilities
    systemContent =
      "You are a helpful coding assistant running inside Seren Desktop. " +
      "Note: File system tools are currently not available. " +
      "You can help with code questions, explanations, and provide code snippets, but cannot directly read or write files." +
      serenPublishersContext;
  }

  // Add user-provided context if available
  if (context) {
    if (context.file) {
      systemContent += `\n\nThe user has selected code from ${context.file}`;
      if (context.range) {
        systemContent += ` (lines ${context.range.startLine}-${context.range.endLine})`;
      }
      systemContent += `:\n\n\`\`\`\n${context.content}\n\`\`\``;
    } else {
      systemContent += `\n\nThe user has selected this code:\n\n\`\`\`\n${context.content}\n\`\`\``;
    }
  }

  // Retrieve and inject semantic code context if available
  try {
    const projectPath = fileTreeState.rootPath;
    const semanticContext = await retrieveCodeContext(projectPath, content);
    if (semanticContext) {
      systemContent += semanticContext;
    }
  } catch (error) {
    // Silently fail - semantic context is optional
    console.warn("[Chat] Failed to retrieve semantic context:", error);
  }

  // Add system message to messages array
  messages.push({ role: "system", content: systemContent });

  // Add conversation history (user and assistant messages only)
  for (const msg of history) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // Add current user message (with images if attached)
  messages.push({ role: "user", content: buildUserContent(content, images) });

  // Get tools if enabled, with model-specific limits
  const tools = enableTools ? getAllTools(model) : undefined;

  // Get max iterations from settings (0 = unlimited)
  const maxIterations = settingsStore.get("chatMaxToolIterations");

  // Accumulated content across all iterations
  let fullContent = "";

  for (
    let iteration = 0;
    maxIterations === 0 || iteration < maxIterations;
    iteration++
  ) {
    console.log("[streamMessageWithTools] Iteration:", iteration);
    // Send request with tools (retries on transient errors like 408 timeout)
    const response: ChatResponse = await sendWithToolsRetry(
      messages,
      model,
      tools,
      tools ? "auto" : undefined,
    );
    console.log("[streamMessageWithTools] Got response:", response);

    // Yield content if present
    if (response.content) {
      console.log(
        "[streamMessageWithTools] Yielding content:",
        response.content.substring(0, 100),
      );
      fullContent += response.content;
      yield { type: "content", content: response.content };
    } else {
      console.log("[streamMessageWithTools] No content in response");
    }

    // Check if model wants to call tools
    if (!response.tool_calls || response.tool_calls.length === 0) {
      // No tool calls, we're done
      console.log(
        "[streamMessageWithTools] No tool_calls, completing with content length:",
        fullContent.length,
      );
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

  // If we hit max iterations, yield an event that allows the user to continue
  yield {
    type: "iteration_limit",
    currentIteration: maxIterations,
    maxIterations,
    continueState: {
      messages,
      model,
      tools,
      fullContent,
      iteration: maxIterations,
    },
  };
}

/**
 * Continue a tool iteration loop from a saved state.
 * Called when user clicks "Continue" after hitting the iteration limit.
 *
 * @param state - The saved state from the iteration_limit event
 * @param additionalIterations - How many more iterations to allow (default: 10)
 */
export async function* continueToolIteration(
  state: ToolIterationState,
  additionalIterations = 10,
): AsyncGenerator<ToolStreamEvent> {
  const { messages, model, tools, fullContent: existingContent } = state;
  let fullContent = existingContent;

  for (let i = 0; i < additionalIterations; i++) {
    console.log("[continueToolIteration] Iteration:", i);

    const response: ChatResponse = await sendWithToolsRetry(
      messages,
      model,
      tools,
      tools ? "auto" : undefined,
    );

    if (response.content) {
      fullContent += response.content;
      yield { type: "content", content: response.content };
    }

    if (!response.tool_calls || response.tool_calls.length === 0) {
      yield { type: "complete", finalContent: fullContent };
      return;
    }

    yield { type: "tool_calls", toolCalls: response.tool_calls };

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    const results = await executeTools(response.tool_calls);
    yield { type: "tool_results", results };

    for (const result of results) {
      messages.push({
        role: "tool",
        content: result.content,
        tool_call_id: result.tool_call_id,
      });
    }
  }

  // Hit the additional limit again
  yield {
    type: "iteration_limit",
    currentIteration: state.iteration + additionalIterations,
    maxIterations: additionalIterations,
    continueState: {
      messages,
      model,
      tools,
      fullContent,
      iteration: state.iteration + additionalIterations,
    },
  };
}

/**
 * Check if tools are available for the current provider.
 * Verifies both provider support AND actual tool availability.
 */
export function areToolsAvailable(): boolean {
  // Only Seren provider supports tools
  if (providerStore.activeProvider !== "seren") {
    return false;
  }

  // Actually check if we have tools - this prevents making claims
  // about tool access when tools aren't actually available
  const tools = getAllTools();
  return tools.length > 0;
}

/**
 * Get the count of available tools (for conditional system prompts).
 */
export function getAvailableToolCount(): number {
  if (providerStore.activeProvider !== "seren") {
    return 0;
  }
  return getAllTools().length;
}
