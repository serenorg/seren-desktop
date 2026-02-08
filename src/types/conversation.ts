// ABOUTME: Unified message and conversation types for the orchestrator.
// ABOUTME: Replaces separate Message (chat) and AgentMessage (acp) types.

import type { Attachment } from "@/lib/providers/types";

/** Source that produced this message */
export type WorkerType =
  | "chat_model"
  | "acp_agent"
  | "mcp_publisher"
  | "orchestrator";

/** All message types in a unified conversation */
export type MessageType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "diff"
  | "thought"
  | "transition"
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
  taskType?: string;

  // Optional fields depending on type
  images?: Attachment[];
  thinking?: string;
  error?: string | null;
  duration?: number;
  toolCallId?: string;
  toolCall?: ToolCallData;
  diff?: DiffData;

  // For retry support
  request?: {
    prompt: string;
    context?: ChatContextData;
  };
}

export interface ToolCallData {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  name?: string;
  arguments?: string;
  result?: string;
  isError?: boolean;
}

export interface DiffData {
  path: string;
  oldText: string;
  newText: string;
  toolCallId?: string;
}

export interface ChatContextData {
  content: string;
  file?: string | null;
  range?: { startLine: number; endLine: number } | null;
}

/** Versioned metadata blob stored in the database `metadata` TEXT column. */
export interface MessageMetadata {
  v: 1;
  worker_type?: WorkerType | null;
  model_id?: string | null;
  task_type?: string | null;
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

/** Serialize orchestrator fields from a UnifiedMessage into a metadata JSON string. */
export function serializeMetadata(msg: UnifiedMessage): string | null {
  if (
    !msg.workerType &&
    !msg.modelId &&
    !msg.taskType &&
    !msg.toolCall &&
    !msg.diff
  ) {
    return null;
  }
  const meta: MessageMetadata = {
    v: 1,
    worker_type: msg.workerType ?? null,
    model_id: msg.modelId ?? null,
    task_type: msg.taskType ?? null,
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
    if (meta.worker_type) result.workerType = meta.worker_type as WorkerType;
    if (meta.model_id) result.modelId = meta.model_id as string;
    if (meta.task_type) result.taskType = meta.task_type as string;
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

/** Type guard: is this message a tool-related message? */
export function isToolMessage(msg: UnifiedMessage): boolean {
  return msg.type === "tool_call" || msg.type === "tool_result";
}

/** Type guard: is this message from the orchestrator itself? */
export function isOrchestratorMessage(msg: UnifiedMessage): boolean {
  return msg.type === "transition" || msg.workerType === "orchestrator";
}
