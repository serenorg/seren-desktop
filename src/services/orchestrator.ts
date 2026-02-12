// ABOUTME: Frontend orchestrator service that calls the Rust backend via Tauri IPC.
// ABOUTME: Translates orchestrator events into conversation store updates.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Attachment, ToolDefinition } from "@/lib/providers/types";
import { getAllTools } from "@/lib/tools";
import { executeTool } from "@/lib/tools/executor";
import { storeAssistantResponse } from "@/services/memory";
import { acpStore } from "@/stores/acp.store";
import { conversationStore } from "@/stores/conversation.store";
import { fileTreeState } from "@/stores/fileTree";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";
import { skillsStore } from "@/stores/skills.store";
import type { UnifiedMessage } from "@/types/conversation";

// =============================================================================
// Types matching the Rust orchestrator events
// =============================================================================

interface OrchestratorEvent {
  conversation_id: string;
  worker_event: WorkerEvent;
  subtask_id?: string;
}

interface TransitionEvent {
  conversation_id: string;
  model_name: string;
  task_description: string;
}

type WorkerEvent =
  | { type: "content"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      tool_call_id: string;
      name: string;
      arguments: string;
      title: string;
    }
  | {
      type: "tool_result";
      tool_call_id: string;
      content: string;
      is_error: boolean;
    }
  | {
      type: "diff";
      path: string;
      old_text: string;
      new_text: string;
      tool_call_id: string | null;
    }
  | {
      type: "complete";
      final_content: string;
      thinking: string | null;
      cost?: number;
    }
  | { type: "error"; message: string }
  | {
      type: "reroute";
      from_model: string;
      to_model: string;
      reason: string;
    };

/** Capabilities payload sent to the Rust orchestrator. */
interface UserCapabilities {
  has_acp_agent: boolean;
  agent_type: string | null;
  active_acp_session_id: string | null;
  selected_model: string | null;
  available_models: string[];
  available_tools: string[];
  tool_definitions: ToolDefinition[];
  installed_skills: SkillRef[];
}

interface SkillRef {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  path: string;
}

/** Tool execution request emitted by the Rust ChatModelWorker for non-local tools. */
interface ToolExecutionRequest {
  tool_call_id: string;
  name: string;
  arguments: string;
}

// =============================================================================
// Internal state for the active orchestration
// =============================================================================

/** ID of the assistant message being streamed into. */
let activeMessageId: string | null = null;

/** Start time for duration tracking. */
let streamStartTime = 0;

/** Last orchestration params for retry support. */
let lastOrchestrationParams: {
  conversationId: string;
  prompt: string;
  images?: Attachment[];
} | null = null;

// =============================================================================
// Public API
// =============================================================================

/**
 * Send a prompt through the orchestrator pipeline.
 *
 * Sets up event listeners, invokes the Rust command, and updates
 * the conversation store as events arrive.
 */
export async function orchestrate(
  conversationId: string,
  prompt: string,
  images?: Attachment[],
): Promise<void> {
  // Save params for retry support
  lastOrchestrationParams = { conversationId, prompt, images };

  // 1. Build history from conversation store
  const messages = conversationStore.getMessagesFor(conversationId);
  const history = serializeHistory(messages);

  // 2. Build capabilities
  const capabilities = buildCapabilities();

  // 3. Prepare streaming state (message added on completion)
  activeMessageId = crypto.randomUUID();
  streamStartTime = Date.now();
  conversationStore.setLoading(true);

  // 4. Listen for events
  let unlistenTransition: UnlistenFn | null = null;
  let unlistenEvent: UnlistenFn | null = null;
  let unlistenToolRequest: UnlistenFn | null = null;

  try {
    unlistenTransition = await listen<TransitionEvent>(
      "orchestrator://transition",
      (event) => handleTransition(event.payload),
    );

    unlistenEvent = await listen<OrchestratorEvent>(
      "orchestrator://event",
      (event) => handleWorkerEvent(event.payload),
    );

    unlistenToolRequest = await listen<ToolExecutionRequest>(
      "orchestrator://tool-request",
      (event) => handleToolRequest(event.payload),
    );

    // 5. Invoke the Rust orchestrator (auth token read from store on Rust side)
    const imagePayload = (images ?? []).map((img) => ({
      name: img.name,
      mime_type: img.mimeType,
      base64: img.base64,
    }));
    await invoke("orchestrate", {
      conversationId,
      prompt,
      history,
      capabilities,
      images: imagePayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handleError(message);
  } finally {
    unlistenTransition?.();
    unlistenEvent?.();
    unlistenToolRequest?.();

    // Ensure loading state is cleared
    conversationStore.setLoading(false);
    conversationStore.finalizeStreaming();
    activeMessageId = null;
  }
}

/**
 * Cancel an active orchestration.
 */
export async function cancelOrchestration(
  conversationId: string,
): Promise<void> {
  try {
    await invoke("cancel_orchestration", { conversationId });
  } catch (error) {
    console.warn("[orchestrator] Cancel failed:", error);
  }
}

/**
 * Retry the last orchestration that failed.
 * Re-uses the saved conversationId, prompt, and images.
 */
export async function retryOrchestration(): Promise<void> {
  if (!lastOrchestrationParams) {
    console.warn("[orchestrator] No previous orchestration to retry");
    return;
  }

  const { conversationId, prompt, images } = lastOrchestrationParams;
  await orchestrate(conversationId, prompt, images);
}

// =============================================================================
// Event Handlers
// =============================================================================

function handleTransition(event: TransitionEvent): void {
  // Create a transition message in the conversation
  const transitionMessage: UnifiedMessage = {
    id: crypto.randomUUID(),
    type: "transition",
    role: "system",
    content: event.task_description,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    modelId: event.model_name,
  };

  conversationStore.addMessage(transitionMessage);
  conversationStore.persistMessage(transitionMessage);
}

function handleWorkerEvent(event: OrchestratorEvent): void {
  const workerEvent = event.worker_event;

  switch (workerEvent.type) {
    case "content":
      handleContent(workerEvent.text);
      break;
    case "thinking":
      handleThinking(workerEvent.text);
      break;
    case "tool_call":
      handleToolCall(workerEvent);
      break;
    case "tool_result":
      handleToolResult(workerEvent);
      break;
    case "diff":
      handleDiff(workerEvent);
      break;
    case "complete":
      handleComplete(
        workerEvent.final_content,
        workerEvent.thinking,
        workerEvent.cost,
      );
      break;
    case "error":
      handleError(workerEvent.message);
      break;
    case "reroute":
      handleReroute(workerEvent);
      break;
  }
}

function handleContent(text: string): void {
  conversationStore.appendStreamingContent(text);
}

function handleThinking(text: string): void {
  conversationStore.appendStreamingThinking(text);
}

function handleToolCall(event: {
  tool_call_id: string;
  name: string;
  arguments: string;
  title: string;
}): void {
  // Flush any pending streaming content into the assistant message
  flushStreamingToMessage();

  // Parse arguments JSON for display in ToolCallCard
  let parameters: Record<string, unknown> | undefined;
  try {
    if (event.arguments) {
      parameters = JSON.parse(event.arguments);
    }
  } catch (error) {
    console.warn(
      `[orchestrator] Failed to parse tool arguments for ${event.name}:`,
      error,
    );
  }

  const toolMessage: UnifiedMessage = {
    id: crypto.randomUUID(),
    type: "tool_call",
    role: "assistant",
    content: event.title || event.name,
    timestamp: Date.now(),
    status: "streaming",
    workerType: "orchestrator",
    toolCallId: event.tool_call_id,
    toolCall: {
      toolCallId: event.tool_call_id,
      title: event.title,
      kind: "",
      status: "running",
      name: event.name,
      arguments: event.arguments,
      parameters,
    },
  };

  conversationStore.addMessage(toolMessage);
  conversationStore.persistMessage(toolMessage);
}

function handleToolResult(event: {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}): void {
  // Update the original tool_call message's status so the ToolCallCard
  // transitions from "Running" to "Completed" or "Failed".
  const messages = conversationStore.messages;
  const toolCallMsg = messages.find(
    (m) => m.toolCallId === event.tool_call_id && m.type === "tool_call",
  );
  if (toolCallMsg?.toolCall) {
    const newStatus = event.is_error ? "error" : "completed";
    conversationStore.updateMessage(toolCallMsg.id, {
      status: "complete",
      toolCall: {
        ...toolCallMsg.toolCall,
        status: newStatus,
        result: event.content,
        isError: event.is_error,
      },
    });
  }

  const resultMessage: UnifiedMessage = {
    id: crypto.randomUUID(),
    type: "tool_result",
    role: "assistant",
    content: event.content,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    toolCallId: event.tool_call_id,
    toolCall: {
      toolCallId: event.tool_call_id,
      title: "",
      kind: "",
      status: event.is_error ? "error" : "completed",
      isError: event.is_error,
      result: event.content,
    },
  };

  conversationStore.addMessage(resultMessage);
  conversationStore.persistMessage(resultMessage);
}

function handleDiff(event: {
  path: string;
  old_text: string;
  new_text: string;
  tool_call_id: string | null;
}): void {
  const diffMessage: UnifiedMessage = {
    id: crypto.randomUUID(),
    type: "diff",
    role: "assistant",
    content: `File changed: ${event.path}`,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    toolCallId: event.tool_call_id ?? undefined,
    diff: {
      path: event.path,
      oldText: event.old_text,
      newText: event.new_text,
      toolCallId: event.tool_call_id ?? undefined,
    },
  };

  conversationStore.addMessage(diffMessage);
  conversationStore.persistMessage(diffMessage);
}

function handleComplete(
  finalContent: string,
  thinking: string | null,
  cost?: number,
): void {
  if (!activeMessageId) return;

  const duration = Date.now() - streamStartTime;

  console.debug(
    "[orchestrator] complete — duration=%dms, cost=%s",
    duration,
    cost != null ? `$${cost}` : "none",
  );

  // Use accumulated streaming content or fall back to final_content
  const content = conversationStore.streamingContent || finalContent;
  const thinkingContent =
    conversationStore.streamingThinking || thinking || undefined;

  const assistantMessage: UnifiedMessage = {
    id: activeMessageId,
    type: "assistant",
    role: "assistant",
    content,
    thinking: thinkingContent,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    duration,
    cost,
  };

  conversationStore.finalizeStreaming();
  conversationStore.addMessage(assistantMessage);
  conversationStore.persistMessage(assistantMessage);

  // Store conversation to memory if enabled
  const model = providerStore.activeModel || "unknown";
  storeAssistantResponse(content, { model }).catch((err) => {
    console.warn("[orchestrator] Failed to store memory:", err);
  });
}

function handleError(message: string): void {
  if (activeMessageId) {
    const errorMessage: UnifiedMessage = {
      id: activeMessageId,
      type: "assistant",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      status: "error",
      error: message,
      workerType: "orchestrator",
    };
    conversationStore.finalizeStreaming();
    conversationStore.addMessage(errorMessage);
  } else {
    conversationStore.setError(message);
  }
}

/**
 * Handle a tool execution request from the Rust ChatModelWorker.
 *
 * The ChatModelWorker encountered a non-local tool (gateway__, mcp__, openclaw__)
 * and is waiting for the frontend to execute it and submit the result back.
 */
async function handleToolRequest(request: ToolExecutionRequest): Promise<void> {
  console.log(
    "[orchestrator] Tool request: %s (id: %s)",
    request.name,
    request.tool_call_id,
  );

  try {
    const result = await executeTool({
      id: request.tool_call_id,
      type: "function",
      function: {
        name: request.name,
        arguments: request.arguments,
      },
    });

    await invoke("submit_tool_result", {
      toolCallId: result.tool_call_id,
      content: result.content,
      isError: result.is_error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[orchestrator] Tool execution failed:", message);

    await invoke("submit_tool_result", {
      toolCallId: request.tool_call_id,
      content: `Tool execution error: ${message}`,
      isError: true,
    });
  }
}

function handleReroute(event: {
  from_model: string;
  to_model: string;
  reason: string;
}): void {
  // Flush any partial streaming content from the failed model
  flushStreamingToMessage();

  // Reset streaming state for the new model attempt
  activeMessageId = crypto.randomUUID();
  streamStartTime = Date.now();

  // Add a reroute announcement message to the conversation
  const rerouteMessage: UnifiedMessage = {
    id: crypto.randomUUID(),
    type: "reroute",
    role: "system",
    content: event.reason,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    modelId: event.to_model,
    error: event.from_model,
  };

  conversationStore.addMessage(rerouteMessage);
  conversationStore.persistMessage(rerouteMessage);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Flush accumulated streaming content into a completed assistant message
 * before tool calls or diffs create new messages.
 */
function flushStreamingToMessage(): void {
  if (!activeMessageId) return;

  const content = conversationStore.streamingContent;
  const thinking = conversationStore.streamingThinking;

  if (content || thinking) {
    const flushedMessage: UnifiedMessage = {
      id: activeMessageId,
      type: "assistant",
      role: "assistant",
      content: content || "",
      thinking: thinking || undefined,
      timestamp: Date.now(),
      status: "complete",
      workerType: "orchestrator",
    };
    conversationStore.addMessage(flushedMessage);
    conversationStore.persistMessage(flushedMessage);
    conversationStore.finalizeStreaming();

    // Generate a new ID for the next streaming segment
    activeMessageId = crypto.randomUUID();
  }
}

/**
 * Serialize conversation messages into the format expected by the Rust backend.
 * Only includes user and assistant messages (not system, tool, transition, etc.)
 */
function serializeHistory(
  messages: UnifiedMessage[],
): Record<string, unknown>[] {
  return messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        m.type !== "transition" &&
        m.type !== "reroute" &&
        m.type !== "tool_call" &&
        m.type !== "tool_result" &&
        m.type !== "diff" &&
        m.status === "complete",
    )
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

/**
 * Build the capabilities object from current frontend state.
 * Passes lightweight skill metadata — the Rust side reads actual content from disk.
 */
function buildCapabilities(): UserCapabilities {
  const enabledSkills = skillsStore.getProjectSkills(fileTreeState.rootPath);
  const activeModels =
    providerStore.getModels(providerStore.activeProvider) ?? [];
  const tools = getAllTools();

  return {
    has_acp_agent: acpStore.availableAgents.length > 0,
    agent_type: acpStore.selectedAgentType ?? null,
    active_acp_session_id: acpStore.agentModeEnabled
      ? (acpStore.activeSessionId ?? null)
      : null,
    selected_model:
      providerStore.activeModel === AUTO_MODEL_ID
        ? null
        : providerStore.activeModel,
    available_models: activeModels.map((m) => m.id),
    available_tools: tools.map((t) => t.function.name),
    tool_definitions: tools,
    installed_skills: enabledSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description ?? "",
      tags: s.tags ?? [],
      path: s.path,
    })),
  };
}
