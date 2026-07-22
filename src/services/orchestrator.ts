// ABOUTME: Frontend orchestrator service that calls the Rust backend via Tauri IPC.
// ABOUTME: Translates orchestrator events into conversation store updates.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  extractEvidenceFromUnifiedMessages,
  validateFinalOutput,
} from "@/lib/agent-output-validation";
import type {
  Attachment,
  ProviderId,
  ToolDefinition,
} from "@/lib/providers/types";
import { getAllTools } from "@/lib/tools";
import { executeTool } from "@/lib/tools/executor";
import {
  cancelEmployeeRun,
  formatToolAuditEvent,
  runEmployeeMessage,
  runLiveStateLabel,
  type ToolAuditEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@/services/employees-runtime";
import {
  bootstrapMemoryContextDetails,
  processAssistantResponseMemory,
  recallMemoryContext,
} from "@/services/memory";
import { serializeHistory } from "@/services/orchestrator-history";
import {
  createOrchestratorProgressWatchdog,
  OrchestratorNoProgressTimeoutError,
  type OrchestratorProgressWatchdog,
} from "@/services/orchestrator-watchdog";
import {
  allowsClaudeAgent,
  allowsCodexAgent,
  allowsSerenPrivateAgent,
  allowsSerenPublicModels,
} from "@/services/organization-policy";
import { agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { fileTreeState } from "@/stores/fileTree";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";
import type { UnifiedMessage, WorkerType } from "@/types/conversation";

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
      rlm_steps?: string | null;
    }
  | { type: "error"; message: string }
  | {
      type: "reroute";
      from_model: string;
      to_model: string;
      reason: string;
    }
  | { type: "rlm_start"; chunk_count: number }
  | {
      type: "rlm_chunk_complete";
      index: number;
      total: number;
      summary: string;
    };

/** Capabilities payload sent to the Rust orchestrator. */
interface UserCapabilities {
  has_local_agent: boolean;
  agent_type: string | null;
  active_agent_session_id: string | null;
  selected_model: string | null;
  force_private_chat: boolean;
  private_chat_deployment_id: string | null;
  available_models: string[];
  available_tools: string[];
  tool_definitions: ToolDefinition[];
  installed_skills: SkillRef[];
  reasoning_effort: string | null;
  /** Active project root, threaded through to RoutingDecision.project_root
   * so the Rust ChatModelWorker can inject live git/repo context. */
  project_root: string | null;
  /** Snapshot of the existing Settings -> Agent controls for backend enforcement. */
  effective_agent_policy: {
    sandbox_mode: "read-only" | "workspace-write" | "full-access";
    approval_policy: "untrusted" | "on-failure" | "on-request" | "never";
    auto_approve_reads: boolean;
    network_enabled: boolean;
  };
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
  conversation_id: string;
  tool_call_id: string;
  name: string;
  arguments: string;
}

// =============================================================================
// Internal state for the active orchestration
// =============================================================================

const activeStreams = new Map<
  string,
  {
    messageId: string;
    startTime: number;
    provider?: ProviderId;
    modelId?: string | null;
    prompt?: string;
    memory?: UnifiedMessage["memory"];
  }
>();
const activeToolRequests = new Set<string>();

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
  // Show loading indicator immediately so the user sees feedback right
  // after hitting Enter — before history, memory, and skill context load.
  conversationStore.setLoading(true, conversationId);

  // Real agent activity in this thread bumps its folder's sidebar rank
  // (#2095). Navigation clicks intentionally do not — only sends do.
  threadStore.noteThreadActivity(conversationId);

  // Save params for retry support
  lastOrchestrationParams = { conversationId, prompt, images };

  // Employee-linked threads bypass the seren-models orchestrator and run
  // against the deployed agent's runtime via seren-cloud. The deployed
  // agent owns its own system_prompt, model_policy, tool_presets, and
  // approval policy - we just hand it the user message and surface the
  // reply.
  const conv = conversationStore.conversations.find(
    (c) => c.id === conversationId,
  );
  if (conv?.employeeId) {
    await runEmployeeTurn(conversationId, conv.employeeId, prompt);
    return;
  }

  // 1. Build history from conversation store
  const messages = conversationStore.getMessagesFor(conversationId);
  let history = serializeHistory(messages);

  // Inject compacted conversation summary so the model retains context
  // from messages that were compacted away.
  const compactedSummary = chatStore.compactedSummary;
  if (compactedSummary) {
    history = [
      {
        role: "system",
        content: `Here is a summary of the earlier part of this conversation:\n\n${compactedSummary.content}`,
      },
      ...history,
    ];
  }

  let answerMemory: UnifiedMessage["memory"] | undefined;
  // Inject typed memory context for the default orchestrator path.
  if (settingsStore.get("memoryEnabled") && authStore.isAuthenticated) {
    try {
      const memoryContext = await bootstrapMemoryContextDetails();
      if (memoryContext?.prompt) {
        history = [
          { role: "system", content: memoryContext.prompt },
          ...history,
        ];
        answerMemory = memoryContext.messageMemory;
      }
      const recall = await recallMemoryContext(prompt);
      if (recall) {
        history = [{ role: "system", content: recall.prompt }, ...history];
        const existingUsed = answerMemory?.used ?? [];
        const seenIds = new Set(
          existingUsed.flatMap((detail) => (detail.id ? [detail.id] : [])),
        );
        const newDetails = recall.details.filter(
          (detail) => !detail.id || !seenIds.has(detail.id),
        );
        answerMemory = {
          ...(answerMemory ?? {}),
          used: [...existingUsed, ...newDetails],
        };
      }
    } catch (error) {
      console.warn("[orchestrator] Failed to retrieve memory context:", error);
    }
  }

  // 2. Build capabilities (thread-aware skills: thread -> project -> global).
  // Provider/model come from the active thread's runtime binding so a
  // user switching providers on one thread cannot leak into orchestration
  // on another. Threads with no recorded selection fall back to the
  // user's globally-active default.
  await skillsStore.ensureContextLoaded(fileTreeState.rootPath, conversationId);
  const threadProvider = ((conv?.selectedProvider as ProviderId | undefined) ??
    providerStore.activeProvider) as ProviderId;
  const threadModel = conv?.selectedModel ?? providerStore.activeModel;
  const capabilities = buildCapabilities(
    conversationId,
    threadProvider,
    threadModel,
  );

  // 3. Prepare streaming state (message added on completion)
  const stream = {
    messageId: crypto.randomUUID(),
    startTime: Date.now(),
    provider: threadProvider,
    modelId: threadModel,
    prompt,
    memory: answerMemory,
  };
  activeStreams.set(conversationId, stream);

  // 4. Listen for events
  let unlistenTransition: UnlistenFn | null = null;
  let unlistenEvent: UnlistenFn | null = null;
  let unlistenToolRequest: UnlistenFn | null = null;
  let watchdog: OrchestratorProgressWatchdog | null = null;

  try {
    watchdog = createOrchestratorProgressWatchdog({
      conversationId,
      onStallChange: (stalled, id) =>
        conversationStore.setStreamingStalled(stalled, id),
      onTimeout: async (id) => {
        try {
          await invoke("cancel_orchestration", { conversationId: id });
        } catch (error) {
          console.warn("[orchestrator] Watchdog cancel failed:", error);
        }
      },
      onTimeoutError: (error, id) => {
        console.warn(
          `[orchestrator] Watchdog timeout cleanup failed for ${id}:`,
          error,
        );
      },
    });

    unlistenTransition = await listen<TransitionEvent>(
      "orchestrator://transition",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          watchdog?.markProgress();
          handleTransition(event.payload);
        }
      },
    );

    unlistenEvent = await listen<OrchestratorEvent>(
      "orchestrator://event",
      (event) => {
        if (event.payload.conversation_id === conversationId) {
          watchdog?.markProgress();
          handleWorkerEvent(event.payload);
        }
      },
    );

    unlistenToolRequest = await listen<ToolExecutionRequest>(
      "orchestrator://tool-request",
      (event) => {
        watchdog?.pause();
        void handleToolRequest(event.payload).finally(() => {
          watchdog?.resume();
        });
      },
    );

    // 5. Invoke the Rust orchestrator (auth token read from store on Rust side)
    const imagePayload = (images ?? []).map((img) => ({
      name: img.name,
      mime_type: img.mimeType,
      base64: img.base64,
    }));
    await Promise.race([
      invoke("orchestrate", {
        conversationId,
        assistantMessageId: stream.messageId,
        prompt,
        history,
        capabilities,
        images: imagePayload,
      }),
      watchdog.waitForTimeout(),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedTurn =
      error instanceof OrchestratorNoProgressTimeoutError &&
      conversationStore.getMessagesFor(conversationId).some((msg) => {
        if (msg.id !== stream.messageId || msg.status !== "complete") {
          return false;
        }
        return Boolean(msg.content.trim() || msg.thinking?.trim());
      });
    if (!completedTurn) {
      handleError(message, conversationId);
    }
  } finally {
    watchdog?.stop();
    unlistenTransition?.();
    unlistenEvent?.();
    unlistenToolRequest?.();

    // Ensure loading state is cleared
    conversationStore.setLoading(false, conversationId);
    conversationStore.setRLMProcessing(false, conversationId);
    conversationStore.finalizeStreaming(conversationId);
    activeStreams.delete(conversationId);
  }
}

/**
 * Cancel an active orchestration. For employee-linked threads this aborts
 * the local stream/poll and asks the cloud runtime to stop the run; for
 * everything else it routes through the Rust orchestrator's cancel.
 */
export async function cancelOrchestration(
  conversationId: string,
): Promise<void> {
  const conv = conversationStore.conversations.find(
    (c) => c.id === conversationId,
  );
  if (conv?.employeeId) {
    try {
      await cancelEmployeeRun(conversationId);
    } catch (error) {
      console.warn("[orchestrator] Employee cancel failed:", error);
    }
    return;
  }
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

  conversationStore.addMessage(transitionMessage, event.conversation_id);
  conversationStore.persistMessage(transitionMessage, event.conversation_id);
}

function handleWorkerEvent(event: OrchestratorEvent): void {
  const workerEvent = event.worker_event;

  switch (workerEvent.type) {
    case "content":
      handleContent(event.conversation_id, workerEvent.text);
      break;
    case "thinking":
      handleThinking(event.conversation_id, workerEvent.text);
      break;
    case "tool_call":
      handleToolCall(event.conversation_id, workerEvent);
      break;
    case "tool_result":
      handleToolResult(event.conversation_id, workerEvent);
      break;
    case "diff":
      handleDiff(event.conversation_id, workerEvent);
      break;
    case "complete":
      handleComplete(
        event.conversation_id,
        workerEvent.final_content,
        workerEvent.thinking,
        workerEvent.cost,
        workerEvent.rlm_steps ?? null,
      );
      break;
    case "error":
      handleError(workerEvent.message, event.conversation_id);
      break;
    case "reroute":
      handleReroute(event.conversation_id, workerEvent);
      break;
    case "rlm_start":
      conversationStore.setRLMProcessing(true, event.conversation_id);
      break;
    case "rlm_chunk_complete":
      // Steps are collected in the Complete event payload; nothing to do here.
      break;
  }
}

function handleContent(conversationId: string, text: string): void {
  conversationStore.appendStreamingContent(text, conversationId);
}

function handleThinking(conversationId: string, text: string): void {
  conversationStore.appendStreamingThinking(text, conversationId);
}

function handleToolCall(
  conversationId: string,
  event: {
    tool_call_id: string;
    name: string;
    arguments: string;
    title: string;
  },
): void {
  // Flush any pending streaming content into the assistant message
  flushStreamingToMessage(conversationId);

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

  conversationStore.addMessage(toolMessage, conversationId);
  conversationStore.persistMessage(toolMessage, conversationId);
}

function handleToolResult(
  conversationId: string,
  event: {
    tool_call_id: string;
    content: string;
    is_error: boolean;
  },
): void {
  // Update the original tool_call message's status so the ToolCallCard
  // transitions from "Running" to "Completed" or "Failed".
  const messages = conversationStore.getMessagesFor(conversationId);
  const toolCallMsg = messages.find(
    (m) => m.toolCallId === event.tool_call_id && m.type === "tool_call",
  );
  if (toolCallMsg?.toolCall) {
    const newStatus = event.is_error ? "error" : "completed";
    conversationStore.updateMessage(
      toolCallMsg.id,
      {
        status: "complete",
        toolCall: {
          ...toolCallMsg.toolCall,
          status: newStatus,
          result: event.content,
          isError: event.is_error,
          // The streamed partial buffer is superseded by the final
          // result content; drop it so the UI swaps to the result pane
          // and we don't keep two copies of the output around (#2100).
          partialResult: undefined,
        },
      },
      conversationId,
    );
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

  conversationStore.addMessage(resultMessage, conversationId);
  conversationStore.persistMessage(resultMessage, conversationId);
}

function handleDiff(
  conversationId: string,
  event: {
    path: string;
    old_text: string;
    new_text: string;
    tool_call_id: string | null;
  },
): void {
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

  conversationStore.addMessage(diffMessage, conversationId);
  conversationStore.persistMessage(diffMessage, conversationId);
}

function handleComplete(
  conversationId: string,
  finalContent: string,
  thinking: string | null,
  cost?: number,
  rlmStepsJson?: string | null,
): void {
  const stream = activeStreams.get(conversationId);
  if (!stream) return;

  const duration = Date.now() - stream.startTime;

  console.debug(
    "[orchestrator] complete — duration=%dms, cost=%s",
    duration,
    cost != null ? `$${cost}` : "none",
  );

  // Use accumulated streaming content or fall back to final_content
  const content =
    conversationStore.getStreamingContentFor(conversationId) || finalContent;
  const finalOutputValidation = validateFinalOutput({
    finalText: content,
    evidence: extractEvidenceFromUnifiedMessages(
      conversationStore.getMessagesFor(conversationId),
    ),
  });
  const safeContent = finalOutputValidation.safeDisplayText;
  const thinkingContent =
    conversationStore.getStreamingThinkingFor(conversationId) ||
    thinking ||
    undefined;

  // Parse RLM steps from JSON if present
  let rlmSteps: UnifiedMessage["rlmSteps"] | undefined;
  if (rlmStepsJson) {
    try {
      rlmSteps = JSON.parse(rlmStepsJson);
    } catch {
      console.warn("[orchestrator] Failed to parse rlm_steps JSON");
    }
  }

  const assistantMessage: UnifiedMessage = {
    id: stream.messageId,
    type: "assistant",
    role: "assistant",
    content: safeContent,
    thinking: thinkingContent,
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
    provider: stream.provider,
    modelId: stream.modelId ?? undefined,
    duration,
    cost,
    finalOutputValidation,
    memory: stream.memory,
    rlmSteps,
  };

  conversationStore.setRLMProcessing(false, conversationId);
  conversationStore.finalizeStreaming(conversationId);
  conversationStore.addMessage(assistantMessage, conversationId);
  conversationStore.persistMessage(assistantMessage, conversationId);

  // Extract structured memories from the transcript after the answer lands.
  const model = stream.modelId || providerStore.activeModel || "unknown";
  if (finalOutputValidation.canStoreMemory) {
    processAssistantResponseMemory(safeContent, {
      model,
      userQuery: stream.prompt,
      sessionId: conversationId,
      projectContext: fileTreeState.rootPath || undefined,
    })
      .then((result) => {
        if (!result?.messageMemory) return;
        const current = conversationStore
          .getMessagesFor(conversationId)
          .find((msg) => msg.id === assistantMessage.id);
        if (!current) return;
        const updated: UnifiedMessage = {
          ...current,
          memory: {
            used: current.memory?.used ?? [],
            captured: result.messageMemory.captured,
            captureStatus: result.messageMemory.captureStatus,
          },
        };
        conversationStore.updateMessage(
          assistantMessage.id,
          updated,
          conversationId,
        );
        void conversationStore.persistMessage(updated, conversationId);
      })
      .catch((err) => {
        console.warn("[orchestrator] Failed to process memory:", err);
      });
  }
}

/**
 * Translate a runtime `tool_call` envelope into a UnifiedMessage matching
 * the orchestrator's existing tool-card shape. The chat UI keys card
 * rendering on type/toolCall, not workerType, so they render identically;
 * the workerType discriminant exists for telemetry/attribution.
 */
function emitEmployeeToolCall(
  conversationId: string,
  event: ToolCallEvent,
): void {
  let parameters: Record<string, unknown> | undefined;
  if (event.arguments) {
    try {
      const parsed = JSON.parse(event.arguments);
      if (parsed && typeof parsed === "object") {
        parameters = parsed as Record<string, unknown>;
      }
    } catch {
      // Leave parameters undefined; the raw arguments string is still
      // available on toolCall.arguments for the card to display.
    }
  }
  // The runtime's tool_call envelope (CloudRunOutputEvent | type "tool_call")
  // exposes only id/name/arguments/status, so the tool slug is also the
  // visible label. If the runtime ever emits a richer title field, surface
  // it here in addition to name.
  // The runtime can emit a `tool_call_started` and a later
  // `tool_call_completed` for the same id (the de-dup keys in
  // employees-runtime now include `kind`). Update the existing card in
  // place on the second envelope so we don't render two identical cards.
  const messages = conversationStore.getMessagesFor(conversationId);
  const existing = messages.find(
    (m) => m.type === "tool_call" && m.toolCallId === event.id,
  );
  if (existing?.toolCall) {
    const updated: UnifiedMessage = {
      ...existing,
      status:
        event.status && event.status !== "running"
          ? "complete"
          : existing.status,
      toolCall: {
        ...existing.toolCall,
        status: event.status ?? existing.toolCall.status,
        name: event.name,
        arguments: event.arguments ?? existing.toolCall.arguments,
        parameters: parameters ?? existing.toolCall.parameters,
      },
      request: {
        prompt: existing.request?.prompt ?? "",
        employeeId: existing.request?.employeeId,
        runId: event.runId ?? existing.request?.runId,
        sequenceNumber:
          event.sequenceNumber ?? existing.request?.sequenceNumber,
        eventType: event.eventType ?? existing.request?.eventType,
        eventKind: event.eventKind ?? existing.request?.eventKind,
        itemId: event.itemId ?? existing.request?.itemId,
      },
    };
    conversationStore.updateMessage(existing.id, updated, conversationId);
    void conversationStore.persistMessage(updated, conversationId);
    return;
  }
  const messageId = event.runId
    ? `${event.runId}:tool_call:${event.id}`
    : crypto.randomUUID();
  const toolMessage: UnifiedMessage = {
    id: messageId,
    type: "tool_call",
    role: "assistant",
    content: event.name,
    timestamp: Date.now(),
    status: "streaming",
    workerType: "employee",
    toolCallId: event.id,
    toolCall: {
      toolCallId: event.id,
      title: event.name,
      kind: "",
      status: event.status ?? "running",
      name: event.name,
      arguments: event.arguments ?? undefined,
      parameters,
    },
    request: {
      prompt: "",
      runId: event.runId,
      sequenceNumber: event.sequenceNumber ?? undefined,
      eventType: event.eventType ?? undefined,
      eventKind: event.eventKind ?? undefined,
      itemId: event.itemId ?? undefined,
    },
  };
  conversationStore.addMessage(toolMessage, conversationId);
  void conversationStore.persistMessage(toolMessage, conversationId);
}

function emitEmployeeToolResult(
  conversationId: string,
  event: ToolResultEvent,
): void {
  // Match the prior tool_call message and flip its status, the same way
  // handleToolResult does for orchestrator runs.
  const messages = conversationStore.getMessagesFor(conversationId);
  const toolCallMsg = messages.find(
    (m) => m.toolCallId === event.id && m.type === "tool_call",
  );
  if (toolCallMsg?.toolCall) {
    const newStatus = event.isError ? "error" : "completed";
    const updated: UnifiedMessage = {
      ...toolCallMsg,
      status: "complete",
      toolCall: {
        ...toolCallMsg.toolCall,
        status: newStatus,
        result: event.content,
        isError: event.isError,
      },
      request: {
        prompt: toolCallMsg.request?.prompt ?? "",
        employeeId: toolCallMsg.request?.employeeId,
        runId: event.runId ?? toolCallMsg.request?.runId,
        sequenceNumber:
          event.sequenceNumber ?? toolCallMsg.request?.sequenceNumber,
        eventType: event.eventType ?? toolCallMsg.request?.eventType,
        eventKind: event.eventKind ?? toolCallMsg.request?.eventKind,
        itemId: event.itemId ?? toolCallMsg.request?.itemId,
      },
    };
    conversationStore.updateMessage(toolCallMsg.id, updated, conversationId);
    void conversationStore.persistMessage(updated, conversationId);
  }

  const resultId = event.runId
    ? `${event.runId}:tool_result:${event.id}:${
        event.sequenceNumber ?? event.eventKind ?? "result"
      }`
    : crypto.randomUUID();
  const resultMessage: UnifiedMessage = {
    id: resultId,
    type: "tool_result",
    role: "assistant",
    content: event.content,
    timestamp: Date.now(),
    status: "complete",
    workerType: "employee",
    toolCallId: event.id,
    toolCall: {
      toolCallId: event.id,
      title: "",
      kind: "",
      status: event.isError ? "error" : "completed",
      isError: event.isError,
      result: event.content,
    },
    request: {
      prompt: "",
      runId: event.runId,
      sequenceNumber: event.sequenceNumber ?? undefined,
      eventType: event.eventType ?? undefined,
      eventKind: event.eventKind ?? undefined,
      itemId: event.itemId ?? undefined,
    },
  };
  conversationStore.addMessage(resultMessage, conversationId);
  void conversationStore.persistMessage(resultMessage, conversationId);
}

function emitEmployeeToolAudit(
  conversationId: string,
  event: ToolAuditEvent,
): void {
  // Audit events are advisory (approval/skip notes), not model output.
  // Render as a markdown blockquote so the existing chat renderer styles
  // it as a distinct aside rather than letting the policy decision read
  // like prose the assistant wrote.
  const content = `> **Tool audit:** ${formatToolAuditEvent(event, {
    escapeMarkdown: true,
  })}`;
  const messageId = event.runId
    ? `${event.runId}:tool_audit:${event.id}:${
        event.sequenceNumber ?? event.eventKind ?? "audit"
      }`
    : crypto.randomUUID();
  const message: UnifiedMessage = {
    id: messageId,
    type: "assistant",
    role: "assistant",
    content,
    timestamp: Date.now(),
    status: "complete",
    workerType: "employee",
    request: {
      prompt: "",
      runId: event.runId,
      sequenceNumber: event.sequenceNumber ?? undefined,
      eventType: event.eventType ?? undefined,
      eventKind: event.eventKind ?? undefined,
      itemId: event.itemId ?? undefined,
    },
  };
  conversationStore.addMessage(message, conversationId);
  void conversationStore.persistMessage(message, conversationId);
}

/**
 * Walk the conversation's messages and flip any tool_call card whose
 * status is still "running" to a terminal state. Used when a turn
 * aborts or errors before the matching tool_result lands so the chat
 * UI doesn't show a perpetual spinner.
 */
function finalizeOrphanToolCalls(
  conversationId: string,
  finalStatus: "cancelled" | "error",
  errorText?: string,
): void {
  const messages = conversationStore.getMessagesFor(conversationId);
  for (const msg of messages) {
    if (msg.type !== "tool_call" || msg.status !== "streaming") continue;
    if (msg.toolCall?.status !== "running") continue;
    const updated: UnifiedMessage = {
      ...msg,
      status: "complete",
      toolCall: {
        ...msg.toolCall,
        status: finalStatus,
        isError: finalStatus === "error",
        result: errorText ?? msg.toolCall.result,
      },
    };
    conversationStore.updateMessage(msg.id, updated, conversationId);
    void conversationStore.persistMessage(updated, conversationId);
  }
}

/**
 * Run a single chat turn against a deployed virtual employee via seren-cloud.
 *
 * Bypasses the seren-models orchestrator entirely: the deployed agent owns
 * its own system_prompt, model resolution, tools, and approval policy. We
 * just hand it the user's message and surface the reply as an assistant
 * message.
 */
const STALL_THRESHOLD_MS = 30_000;

async function runEmployeeTurn(
  conversationId: string,
  deploymentId: string,
  prompt: string,
): Promise<void> {
  const stream = {
    messageId: crypto.randomUUID(),
    startTime: Date.now(),
  };
  activeStreams.set(conversationId, stream);

  // Track the last token-arrival timestamp so a long quiet window can
  // surface a "this is taking a while" hint in the chat UI without
  // killing the run. The stall flag flips back to false on every chunk.
  let lastProgressAt = Date.now();
  const stallTick = setInterval(() => {
    if (Date.now() - lastProgressAt < STALL_THRESHOLD_MS) return;
    conversationStore.setStreamingStalled(true, conversationId);
  }, 5_000);

  const markProgress = () => {
    lastProgressAt = Date.now();
    conversationStore.setStreamingStalled(false, conversationId);
  };
  let startupNoticeShown = false;

  try {
    const result = await runEmployeeMessage(deploymentId, prompt, {
      conversationId,
      clientMessageId: stream.messageId,
      idempotencyKey: stream.messageId,
      onStartupWait: () => {
        markProgress();
        if (startupNoticeShown) return;
        startupNoticeShown = true;
        conversationStore.appendStreamingContent(
          "Starting employee runtime. I'll send your message once it is ready.",
          conversationId,
        );
      },
      onRunState: (event) => {
        markProgress();
        if (!startupNoticeShown) return;
        const label = runLiveStateLabel(event);
        if (!label) return;
        conversationStore.clearStreamingContent(conversationId);
        conversationStore.appendStreamingContent(label, conversationId);
      },
      onText: (chunk) => {
        markProgress();
        if (startupNoticeShown) {
          startupNoticeShown = false;
          conversationStore.clearStreamingContent(conversationId);
        }
        conversationStore.appendStreamingContent(chunk, conversationId);
      },
      onThinking: (chunk) => {
        markProgress();
        if (startupNoticeShown) {
          startupNoticeShown = false;
          conversationStore.clearStreamingContent(conversationId);
        }
        conversationStore.appendStreamingThinking(chunk, conversationId);
      },
      onToolCall: (event) => {
        markProgress();
        emitEmployeeToolCall(conversationId, event);
      },
      onToolResult: (event) => {
        markProgress();
        emitEmployeeToolResult(conversationId, event);
      },
      onToolAudit: (event) => {
        markProgress();
        emitEmployeeToolAudit(conversationId, event);
      },
    });
    conversationStore.finalizeStreaming(conversationId);
    const duration = Date.now() - stream.startTime;
    const finalOutputValidation = validateFinalOutput({
      finalText: result.text,
      evidence: extractEvidenceFromUnifiedMessages(
        conversationStore.getMessagesFor(conversationId),
      ),
    });
    const assistantMessage: UnifiedMessage = {
      id: result.runId ? `${result.runId}:assistant` : stream.messageId,
      type: "assistant",
      role: "assistant",
      content: finalOutputValidation.safeDisplayText,
      timestamp: Date.now(),
      status: "complete",
      workerType: "employee",
      thinking: result.thinking ?? undefined,
      modelId: undefined,
      duration,
      finalOutputValidation,
      request: {
        prompt,
        employeeId: deploymentId,
        runId: result.runId ?? undefined,
      },
    };
    conversationStore.addMessage(assistantMessage, conversationId);
    await conversationStore.persistMessage(assistantMessage, conversationId);
  } catch (error) {
    conversationStore.finalizeStreaming(conversationId);
    // User-initiated aborts shouldn't surface as red error messages.
    // Persist the partial reply we already streamed so the user can read
    // it, then exit cleanly.
    if (error instanceof DOMException && error.name === "AbortError") {
      finalizeOrphanToolCalls(conversationId, "cancelled");
      conversationStore.setRLMProcessing(false, conversationId);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    finalizeOrphanToolCalls(conversationId, "error", message);
    handleError(message, conversationId, "employee");
  } finally {
    clearInterval(stallTick);
    conversationStore.setLoading(false, conversationId);
    conversationStore.setRLMProcessing(false, conversationId);
    activeStreams.delete(conversationId);
  }
}

function handleError(
  message: string,
  conversationId?: string,
  workerType: WorkerType = "orchestrator",
): void {
  const stream = conversationId ? activeStreams.get(conversationId) : null;
  if (conversationId && stream) {
    const errorMessage: UnifiedMessage = {
      id: stream.messageId,
      type: "assistant",
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      status: "error",
      error: message,
      workerType,
    };
    conversationStore.setRLMProcessing(false, conversationId);
    conversationStore.finalizeStreaming(conversationId);
    conversationStore.addMessage(errorMessage, conversationId);
  } else {
    conversationStore.setError(message);
  }
}

/**
 * Handle a tool execution request from the Rust ChatModelWorker.
 *
 * The ChatModelWorker encountered a non-local tool (gateway__, mcp__)
 * and is waiting for the frontend to execute it and submit the result back.
 */
async function handleToolRequest(request: ToolExecutionRequest): Promise<void> {
  if (activeToolRequests.has(request.tool_call_id)) return;
  activeToolRequests.add(request.tool_call_id);

  console.log(
    "[orchestrator] Tool request: %s (id: %s)",
    request.name,
    request.tool_call_id,
  );

  try {
    const result = await executeTool(
      {
        id: request.tool_call_id,
        type: "function",
        function: {
          name: request.name,
          arguments: request.arguments,
        },
      },
      request.conversation_id,
    );

    await invoke("submit_tool_result", {
      toolCallId: result.tool_call_id,
      content: result.content,
      isError: result.is_error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Expected agent outcome (submitted back as an is_error result). Not reportable.
    console.warn("[orchestrator] Tool execution failed:", message);

    await invoke("submit_tool_result", {
      toolCallId: request.tool_call_id,
      content: `Tool execution error: ${message}`,
      isError: true,
    });
  } finally {
    activeToolRequests.delete(request.tool_call_id);
  }
}

function handleReroute(
  conversationId: string,
  event: {
    from_model: string;
    to_model: string;
    reason: string;
  },
): void {
  // Flush any partial streaming content from the failed model
  flushStreamingToMessage(conversationId);

  const reroutedConv = conversationStore.conversations.find(
    (c) => c.id === conversationId,
  );
  const reroutedProvider =
    reroutedConv?.selectedProvider ?? providerStore.activeProvider;

  // Reset streaming state for the new model attempt
  activeStreams.set(conversationId, {
    messageId: crypto.randomUUID(),
    startTime: Date.now(),
    provider: reroutedProvider as ProviderId,
    modelId: event.to_model,
  });

  // Update UI to reflect the actual model being used after automatic fallback.
  // chatStore.setModel and providerStore are picker mirrors keyed to whichever
  // thread the user has visible; only sync them when the rerouting thread is
  // the active one so a background reroute on thread A cannot rewrite thread
  // B's selected model. Persist the rerouted thread's own selectedProvider so
  // the runtime row stays paired with the new model instead of inheriting the
  // global picker's provider.
  if (conversationId === chatStore.activeConversationId) {
    providerStore.setActiveModel(event.to_model);
    chatStore.setModel(event.to_model);
  }
  void conversationStore.updateConversationSelection(
    conversationId,
    event.to_model,
    reroutedProvider,
  );

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

  conversationStore.addMessage(rerouteMessage, conversationId);
  conversationStore.persistMessage(rerouteMessage, conversationId);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Flush accumulated streaming content into a completed assistant message
 * before tool calls or diffs create new messages.
 */
function flushStreamingToMessage(conversationId: string): void {
  const stream = activeStreams.get(conversationId);
  if (!stream) return;

  const content = conversationStore.getStreamingContentFor(conversationId);
  const thinking = conversationStore.getStreamingThinkingFor(conversationId);

  if (content || thinking) {
    const flushedMessage: UnifiedMessage = {
      id: stream.messageId,
      type: "assistant",
      role: "assistant",
      content: content || "",
      thinking: thinking || undefined,
      timestamp: Date.now(),
      status: "complete",
      workerType: "orchestrator",
      provider: stream.provider,
      modelId: stream.modelId ?? undefined,
    };
    conversationStore.addMessage(flushedMessage, conversationId);
    conversationStore.persistMessage(flushedMessage, conversationId);
    conversationStore.finalizeStreaming(conversationId);

    // Generate a new ID for the next streaming segment
    activeStreams.set(conversationId, {
      messageId: crypto.randomUUID(),
      startTime: Date.now(),
      provider: stream.provider,
      modelId: stream.modelId,
    });
  }
}

/**
 * Build the capabilities object from the thread's runtime binding plus
 * frontend state. Provider and model come from the active thread so
 * switching providers on one thread does not leak into orchestration on
 * another. The global provider store is only consulted as a fallback for
 * threads that have not yet recorded a selection.
 */
function buildCapabilities(
  threadId: string | null,
  provider: ProviderId,
  model: string | null,
): UserCapabilities {
  const privateChatPolicy = authStore.privateChatPolicy;
  const publicSerenAllowed = allowsSerenPublicModels(privateChatPolicy);
  const forcePrivateChat =
    allowsSerenPrivateAgent(privateChatPolicy) &&
    (provider === "seren-private" ||
      (provider === "seren" && !publicSerenAllowed));
  const enabledSkills = skillsStore.getThreadSkills(
    fileTreeState.rootPath,
    threadId,
  );
  const activeModels = providerStore.getModels(provider) ?? [];
  const tools = getAllTools();

  return {
    has_local_agent:
      !forcePrivateChat &&
      (allowsClaudeAgent(privateChatPolicy) ||
        allowsCodexAgent(privateChatPolicy)) &&
      agentStore.availableAgents.length > 0,
    agent_type: agentStore.selectedAgentType ?? null,
    active_agent_session_id: agentStore.agentModeEnabled
      ? (agentStore.activeSessionId ?? null)
      : null,
    selected_model: forcePrivateChat
      ? (() => {
          // Read the model bound to THIS thread (passed in by the caller),
          // not the chatStore's globally-active conversation. Otherwise a
          // background orchestration on thread A would pick up thread B's
          // model whenever the user has B selected.
          const selected = model?.trim();
          if (
            !selected ||
            selected === AUTO_MODEL_ID ||
            selected.includes("/")
          ) {
            return privateChatPolicy?.model_id ?? null;
          }
          return selected;
        })()
      : model === AUTO_MODEL_ID
        ? null
        : model,
    force_private_chat: forcePrivateChat,
    private_chat_deployment_id: privateChatPolicy?.deployment_id ?? null,
    available_models: forcePrivateChat ? [] : activeModels.map((m) => m.id),
    // Tools are available in BOTH public and private chat. The private chat
    // policy governs which MODEL is used (via force_private_chat +
    // private_chat_deployment_id), not which tools are exposed. Stripping
    // tools here was the root cause of #1529 — users in seren-private
    // threads saw zero publisher/MCP visibility because the capabilities
    // payload reached the orchestrator with empty tool arrays.
    available_tools: tools.map((t) => t.function.name),
    tool_definitions: tools,
    installed_skills: enabledSkills.map((s) => ({
      slug: s.slug,
      name: s.name,
      description: s.description ?? "",
      tags: s.tags ?? [],
      path: s.path,
    })),
    reasoning_effort: chatStore.reasoningEffort ?? null,
    project_root: fileTreeState.rootPath ?? null,
    effective_agent_policy: {
      sandbox_mode: settingsStore.settings.agentSandboxMode,
      approval_policy: settingsStore.settings.agentApprovalPolicy,
      auto_approve_reads: settingsStore.settings.agentAutoApproveReads,
      network_enabled: settingsStore.settings.agentNetworkEnabled,
    },
  };
}
