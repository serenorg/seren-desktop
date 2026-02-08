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

/** Type guard: is this message a tool-related message? */
export function isToolMessage(msg: UnifiedMessage): boolean {
  return msg.type === "tool_call" || msg.type === "tool_result";
}

/** Type guard: is this message from the orchestrator itself? */
export function isOrchestratorMessage(msg: UnifiedMessage): boolean {
  return msg.type === "transition" || msg.workerType === "orchestrator";
}
