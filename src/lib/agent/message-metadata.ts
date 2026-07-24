// ABOUTME: Pure (de)serialization between persisted SQLite rows and AgentMessage.
// ABOUTME: Behavior-preserving extraction from agent.store; no store state closure.

import type { StoredMessage } from "@/lib/tauri-bridge";
import type {
  DiffEvent,
  PairedSpawnConfig,
  ToolCallEvent,
} from "@/services/providers";
import type { AgentMessage } from "@/stores/agent.store";

export interface AgentConversationMetadata {
  pendingBootstrapPromptContext?: string;
  pendingBootstrapMessages?: AgentMessage[];
  /** Pinned Planner/Executor model + effort choices for paired threads. */
  pairedConfig?: PairedSpawnConfig;
}

export function parseAgentConversationMetadata(
  raw: string | null | undefined,
): AgentConversationMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AgentConversationMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function serializeAgentConversationMetadata(
  metadata: AgentConversationMetadata,
): string | null {
  return metadata.pendingBootstrapPromptContext ||
    (metadata.pendingBootstrapMessages &&
      metadata.pendingBootstrapMessages.length > 0) ||
    metadata.pairedConfig
    ? JSON.stringify(metadata)
    : null;
}

/**
 * Metadata shape for a persisted non-prose turn block (#3247). A `tool` or
 * `diff` message rides in the `messages` table as a `role: "assistant"` row;
 * `block_type` plus the serialized payload let `reconstructStoredAgentMessage`
 * rebuild the original `AgentMessage.type`/`toolCall`/`diff` on read.
 */
export interface PersistedBlockMetadata {
  block_type?: "tool" | "diff";
  tool_call?: ToolCallEvent;
  diff?: DiffEvent;
}

export function parsePersistedBlockMetadata(
  raw: string | null | undefined,
): PersistedBlockMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedBlockMetadata;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeAgentMessageMetadata(
  msg: AgentMessage,
): string | null {
  if (msg.type === "handoff") {
    return JSON.stringify({ v: 1, paired_handoff: true });
  }
  // Tool calls and file diffs carry their payload in metadata so the full
  // claude-code turn — not just its final answer — survives reload, export,
  // and sync (#3247). The transient live stdout buffer (`partialResult`) is
  // dropped by the final status upsert, so it never lands here.
  if (msg.type === "tool" && msg.toolCall) {
    return JSON.stringify({
      v: 1,
      block_type: "tool",
      tool_call: msg.toolCall,
    });
  }
  if (msg.type === "diff" && msg.diff) {
    return JSON.stringify({ v: 1, block_type: "diff", diff: msg.diff });
  }
  if (!msg.finalOutputValidation) return null;
  return JSON.stringify({
    v: 1,
    final_output_validation: msg.finalOutputValidation,
  });
}

/**
 * Rebuild an `AgentMessage` from a persisted SQLite row. Tool/diff blocks
 * (#3247) reconstruct their `type` and payload from `block_type` metadata;
 * everything else maps to user/handoff/assistant as before. Pure and exported
 * for round-trip regression coverage.
 */
export function reconstructStoredAgentMessage(m: StoredMessage): AgentMessage {
  if (m.role === "user") {
    return {
      id: m.id,
      type: "user",
      content: m.content,
      timestamp: m.timestamp,
    };
  }
  const block = parsePersistedBlockMetadata(m.metadata);
  if (block?.block_type === "tool" && block.tool_call) {
    return {
      id: m.id,
      type: "tool",
      content: m.content,
      timestamp: m.timestamp,
      toolCallId: block.tool_call.toolCallId,
      toolCall: block.tool_call,
      provider: m.provider ?? undefined,
    };
  }
  if (block?.block_type === "diff" && block.diff) {
    return {
      id: m.id,
      type: "diff",
      content: m.content,
      timestamp: m.timestamp,
      toolCallId: block.diff.toolCallId,
      diff: block.diff,
      provider: m.provider ?? undefined,
    };
  }
  return {
    id: m.id,
    type: isPairedHandoffMetadata(m.metadata) ? "handoff" : "assistant",
    content: m.content,
    timestamp: m.timestamp,
    provider: m.provider ?? undefined,
  };
}

function isPairedHandoffMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    return JSON.parse(metadata)?.paired_handoff === true;
  } catch {
    return false;
  }
}
