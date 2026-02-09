// ABOUTME: Frontend orchestrator service that calls the Rust backend via Tauri IPC.
// ABOUTME: Translates orchestrator events into conversation store updates.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getToken } from "@/lib/tauri-bridge";
import { getAllTools } from "@/lib/tools";
import { acpStore } from "@/stores/acp.store";
import { conversationStore } from "@/stores/conversation.store";
import { providerStore } from "@/stores/provider.store";
import { skillsStore } from "@/stores/skills.store";
import type { UnifiedMessage } from "@/types/conversation";

// =============================================================================
// Types matching the Rust orchestrator events
// =============================================================================

interface OrchestratorEvent {
  conversation_id: string;
  worker_event: WorkerEvent;
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
  | { type: "complete"; final_content: string; thinking: string | null }
  | { type: "error"; message: string };

/** Capabilities payload sent to the Rust orchestrator. */
interface UserCapabilities {
  has_acp_agent: boolean;
  agent_type: string | null;
  available_models: string[];
  available_tools: string[];
  installed_skills: SkillRef[];
}

interface SkillRef {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  path: string;
}

// =============================================================================
// Internal state for the active orchestration
// =============================================================================

/** ID of the assistant message being streamed into. */
let activeMessageId: string | null = null;

/** Start time for duration tracking. */
let streamStartTime = 0;

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
): Promise<void> {
  // 1. Build history from conversation store
  const messages = conversationStore.getMessagesFor(conversationId);
  const history = serializeHistory(messages);

  // 2. Build capabilities
  const capabilities = buildCapabilities();

  // 3. Get auth token
  let token = (await getToken()) ?? "";

  // 4. Create the assistant message placeholder
  activeMessageId = crypto.randomUUID();
  streamStartTime = Date.now();

  const assistantMessage: UnifiedMessage = {
    id: activeMessageId,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    status: "streaming",
    workerType: "orchestrator",
  };
  conversationStore.addMessage(assistantMessage);
  conversationStore.setLoading(true);

  // 5. Listen for events
  let unlistenTransition: UnlistenFn | null = null;
  let unlistenEvent: UnlistenFn | null = null;

  try {
    unlistenTransition = await listen<TransitionEvent>(
      "orchestrator://transition",
      (event) => handleTransition(event.payload),
    );

    unlistenEvent = await listen<OrchestratorEvent>(
      "orchestrator://event",
      (event) => handleWorkerEvent(event.payload),
    );

    // 6. Invoke the Rust orchestrator
    await invoke("orchestrate", {
      conversationId,
      prompt,
      history,
      capabilities,
      authToken: token,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handleError(message);
  } finally {
    unlistenTransition?.();
    unlistenEvent?.();
    token = "";

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
      handleComplete(workerEvent.final_content, workerEvent.thinking);
      break;
    case "error":
      handleError(workerEvent.message);
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
    },
  };

  conversationStore.addMessage(toolMessage);
}

function handleToolResult(event: {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}): void {
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
      status: event.is_error ? "error" : "complete",
      isError: event.is_error,
      result: event.content,
    },
  };

  conversationStore.addMessage(resultMessage);
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
}

function handleComplete(finalContent: string, thinking: string | null): void {
  if (!activeMessageId) return;

  const duration = Date.now() - streamStartTime;

  // Use accumulated streaming content or fall back to final_content
  const content = conversationStore.streamingContent || finalContent;
  const thinkingContent =
    conversationStore.streamingThinking || thinking || undefined;

  conversationStore.updateMessage(activeMessageId, {
    content,
    thinking: thinkingContent,
    status: "complete",
    duration,
  });

  conversationStore.finalizeStreaming();

  // Persist the completed message
  const messages = conversationStore.messages;
  const completedMsg = messages.find((m) => m.id === activeMessageId);
  if (completedMsg) {
    conversationStore.persistMessage(completedMsg);
  }
}

function handleError(message: string): void {
  if (activeMessageId) {
    conversationStore.updateMessage(activeMessageId, {
      content: message,
      status: "error",
      error: message,
    });
  } else {
    conversationStore.setError(message);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Flush accumulated streaming content into the active assistant message
 * before tool calls or diffs create new messages.
 */
function flushStreamingToMessage(): void {
  if (!activeMessageId) return;

  const content = conversationStore.streamingContent;
  const thinking = conversationStore.streamingThinking;

  if (content || thinking) {
    conversationStore.updateMessage(activeMessageId, {
      content: content || undefined,
      thinking: thinking || undefined,
    });
    conversationStore.finalizeStreaming();
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
  const enabledSkills = skillsStore.enabledSkills;
  const activeModels =
    providerStore.getModels(providerStore.activeProvider) ?? [];
  const tools = getAllTools();

  return {
    has_acp_agent: acpStore.availableAgents.length > 0,
    agent_type: acpStore.selectedAgentType ?? null,
    available_models: activeModels.map((m) => m.id),
    available_tools: tools.map((t) => t.function.name),
    installed_skills: enabledSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description ?? "",
      tags: s.tags ?? [],
      path: s.path,
    })),
  };
}
