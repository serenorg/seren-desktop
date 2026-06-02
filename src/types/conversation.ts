// ABOUTME: Unified message and conversation types for the orchestrator.
// ABOUTME: Replaces separate chat and local-agent message models.

import type { FinalOutputValidationReport } from "@/lib/agent-output-validation";
import type { Attachment } from "@/lib/providers/types";

/** Source that produced this message */
export type WorkerType =
  | "chat_model"
  | "local_agent"
  | "mcp_publisher"
  | "orchestrator"
  | "employee";

/**
 * Worker types whose failed assistant messages are eligible for the
 * Retry button in the chat composer. The retry path replays the saved
 * orchestration parameters; both seren-models orchestrator turns and
 * deployed-employee turns route through `orchestrate()` and so retry
 * cleanly.
 */
export const RETRYABLE_WORKERS: ReadonlySet<WorkerType> = new Set([
  "orchestrator",
  "employee",
]);

export function isRetryableWorker(workerType: WorkerType | undefined): boolean {
  return workerType !== undefined && RETRYABLE_WORKERS.has(workerType);
}

/** All message types in a unified conversation */
export type MessageType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "diff"
  | "thought"
  | "transition"
  | "reroute"
  | "error";

export type MessageStatus = "pending" | "streaming" | "complete" | "error";

export interface UnifiedMessage {
  id: string;
  type: MessageType;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  status: MessageStatus;

  // Routing metadata (set by orchestrator)
  workerId?: string;
  workerType?: WorkerType;
  modelId?: string;
  /** Producer provenance — the provider that emitted this message. */
  provider?: string;
  taskType?: string;

  // Optional fields depending on type
  images?: Attachment[];
  thinking?: string;
  error?: string | null;
  duration?: number;
  /** Total cost in SerenBucks for this message's query, reported by Gateway. */
  cost?: number;
  /** Verified Agent Output report for final assistant messages. */
  finalOutputValidation?: FinalOutputValidationReport;
  /** Contextual memory provenance and post-answer capture state. */
  memory?: MessageMemoryMetadata;
  toolCallId?: string;
  toolCall?: ToolCallData;
  diff?: DiffData;

  // RLM step metadata — present only when this message was produced by RLM
  rlmSteps?: RLMStepData[];

  // For retry support
  request?: {
    prompt: string;
    context?: ChatContextData;
  };

  // Migration field: retry attempt counter (temporary, from Message type)
  attemptCount?: number;
}

export interface ToolCallData {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  name?: string;
  arguments?: string;
  parameters?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface DiffData {
  path: string;
  oldText: string;
  newText: string;
  toolCallId?: string;
}

export interface RLMStepData {
  index: number;
  total: number;
  summary: string;
}

export interface ChatContextData {
  content: string;
  file?: string | null;
  range?: { startLine: number; endLine: number } | null;
}

export interface MessageMemoryDetail {
  id?: string;
  type: string;
  summary: string;
  confidence?: number;
  recency?: string;
  source?: string;
}

export interface MessageMemoryMetadata {
  used: MessageMemoryDetail[];
  captured?: MessageMemoryDetail[];
  captureStatus?: "remembered" | "undone" | "error";
  notice?: string;
}

/** Versioned metadata blob stored in the database `metadata` TEXT column. */
export interface MessageMetadata {
  v: 1;
  message_type?: MessageType | null;
  worker_type?: WorkerType | null;
  model_id?: string | null;
  task_type?: string | null;
  duration?: number | null;
  cost?: number | null;
  final_output_validation?: FinalOutputValidationReport | null;
  memory?: MessageMemoryMetadata | null;
  tool_call?: {
    id: string;
    name: string;
    arguments?: string;
  } | null;
  diff?: {
    path: string;
    old_text: string;
    new_text: string;
  } | null;
}

/**
 * Message types that need a persisted discriminator. Plain user/assistant
 * messages don't — `role` is authoritative for those. Without this, loading
 * a tool_call/tool_result back from the database collapses it to a generic
 * assistant bubble and renders the raw JSON content as markdown.
 */
const PERSISTED_DISCRIMINATOR_TYPES: ReadonlySet<MessageType> = new Set([
  "tool_call",
  "tool_result",
  "diff",
  "thought",
  "transition",
  "reroute",
  "error",
]);

/** Serialize orchestrator fields from a UnifiedMessage into a metadata JSON string. */
export function serializeMetadata(msg: UnifiedMessage): string | null {
  const needsTypeDiscriminator = PERSISTED_DISCRIMINATOR_TYPES.has(msg.type);
  if (
    !needsTypeDiscriminator &&
    !msg.workerType &&
    !msg.modelId &&
    !msg.taskType &&
    !msg.toolCall &&
    !msg.diff &&
    !msg.memory &&
    !msg.duration &&
    !msg.cost
  ) {
    return null;
  }
  const meta: MessageMetadata = {
    v: 1,
    message_type: needsTypeDiscriminator ? msg.type : null,
    worker_type: msg.workerType ?? null,
    model_id: msg.modelId ?? null,
    task_type: msg.taskType ?? null,
    duration: msg.duration ?? null,
    cost: msg.cost ?? null,
    final_output_validation: msg.finalOutputValidation ?? null,
    memory: msg.memory ?? null,
    tool_call: msg.toolCall
      ? {
          id: msg.toolCall.toolCallId,
          name: msg.toolCall.name ?? msg.toolCall.title,
          arguments: msg.toolCall.arguments,
        }
      : null,
    diff: msg.diff
      ? {
          path: msg.diff.path,
          old_text: msg.diff.oldText,
          new_text: msg.diff.newText,
        }
      : null,
  };
  return JSON.stringify(meta);
}

/** Deserialize metadata JSON string back onto a partial UnifiedMessage. */
export function deserializeMetadata(
  json: string | null,
): Partial<UnifiedMessage> {
  if (!json) {
    return {};
  }
  try {
    const meta = JSON.parse(json) as Record<string, unknown>;
    if (meta.v !== 1) {
      return {};
    }
    const result: Partial<UnifiedMessage> = {};
    if (
      typeof meta.message_type === "string" &&
      PERSISTED_DISCRIMINATOR_TYPES.has(meta.message_type as MessageType)
    ) {
      result.type = meta.message_type as MessageType;
    }
    if (typeof meta.worker_type === "string") {
      result.workerType = meta.worker_type as WorkerType;
    }
    if (meta.model_id) result.modelId = meta.model_id as string;
    if (meta.task_type) result.taskType = meta.task_type as string;
    if (typeof meta.duration === "number" && meta.duration > 0)
      result.duration = meta.duration;
    if (typeof meta.cost === "number" && meta.cost > 0) result.cost = meta.cost;
    if (
      meta.final_output_validation &&
      typeof meta.final_output_validation === "object"
    ) {
      result.finalOutputValidation =
        meta.final_output_validation as FinalOutputValidationReport;
    }
    if (isMessageMemoryMetadata(meta.memory)) {
      result.memory = meta.memory;
    }
    if (meta.tool_call && typeof meta.tool_call === "object") {
      const tc = meta.tool_call as Record<string, string>;
      result.toolCall = {
        toolCallId: tc.id,
        title: tc.name,
        kind: "unknown",
        status: "complete",
        name: tc.name,
        arguments: tc.arguments,
      };
    }
    if (meta.diff && typeof meta.diff === "object") {
      const d = meta.diff as Record<string, string>;
      result.diff = {
        path: d.path,
        oldText: d.old_text,
        newText: d.new_text,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isMemoryDetail(value: unknown): value is MessageMemoryDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Partial<MessageMemoryDetail>;
  return typeof detail.type === "string" && typeof detail.summary === "string";
}

function isMessageMemoryMetadata(
  value: unknown,
): value is MessageMemoryMetadata {
  if (typeof value !== "object" || value === null) return false;
  const metadata = value as Partial<MessageMemoryMetadata>;
  return (
    Array.isArray(metadata.used) &&
    metadata.used.every(isMemoryDetail) &&
    (metadata.captured === undefined ||
      (Array.isArray(metadata.captured) &&
        metadata.captured.every(isMemoryDetail)))
  );
}

/** Type guard: is this message a tool-related message? */
export function isToolMessage(msg: UnifiedMessage): boolean {
  return msg.type === "tool_call" || msg.type === "tool_result";
}

/**
 * Type guard: is this message from an agentic worker (orchestrator or a
 * deployed employee) rather than a plain chat-model response? Includes
 * orchestrator-only message types (transition, reroute) which only the
 * seren-models orchestrator produces today.
 */
export function isOrchestratorMessage(msg: UnifiedMessage): boolean {
  return (
    msg.type === "transition" ||
    msg.type === "reroute" ||
    msg.workerType === "orchestrator" ||
    msg.workerType === "employee"
  );
}

/** Temporary adapter: convert legacy Message to UnifiedMessage during migration. */
export function toUnifiedMessage(msg: {
  id: string;
  role: string;
  content: string;
  images?: Attachment[];
  thinking?: string;
  model?: string;
  timestamp: number;
  status?: string;
  error?: string | null;
  attemptCount?: number;
  duration?: number;
  request?: { prompt: string; context?: ChatContextData };
}): UnifiedMessage {
  return {
    id: msg.id,
    type: msg.role === "user" ? "user" : "assistant",
    role: msg.role as UnifiedMessage["role"],
    content: msg.content,
    timestamp: msg.timestamp,
    status: (msg.status as MessageStatus) ?? "complete",
    modelId: msg.model,
    workerType: "chat_model",
    images: msg.images,
    thinking: msg.thinking,
    error: msg.error,
    duration: msg.duration,
    request: msg.request,
    attemptCount: msg.attemptCount,
  };
}
