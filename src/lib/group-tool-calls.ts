// ABOUTME: Groups consecutive tool_call messages into a single collapsible block.
// ABOUTME: tool_result rows render as null in chat, so they don't break a run of tool_calls.

import type { ToolCallEvent } from "@/services/providers";
import type { ToolCallData, UnifiedMessage } from "@/types/conversation";

export type GroupedMessage =
  | { type: "single"; message: UnifiedMessage }
  | {
      type: "tool_group";
      /**
       * Stable identity for this group across regroup remounts (#1748).
       * Derived from the first tool call's id so per-group UI state
       * (expand/Tail) survives the rebuild.
       */
      id: string;
      messages: UnifiedMessage[];
      toolCalls: ToolCallEvent[];
    };

/** Threshold at or above which consecutive tool calls collapse into a group. */
export const TOOL_GROUP_THRESHOLD = 3;

/** Map orchestrator ToolCallData to the ToolCallEvent shape ToolCallCard expects. */
export function toToolCallEvent(data: ToolCallData): ToolCallEvent {
  let params: Record<string, unknown> | undefined = data.parameters;
  if (!params && data.arguments) {
    try {
      params = JSON.parse(data.arguments);
    } catch {
      /* non-JSON arguments — skip */
    }
  }
  return {
    sessionId: "",
    toolCallId: data.toolCallId,
    title: data.title || data.name || "Tool",
    kind: data.kind,
    status: data.status,
    parameters: params,
    result: data.isError ? undefined : data.result,
    error: data.isError ? data.result : undefined,
    partialResult: data.partialResult,
  };
}

function flushToolGroup(group: UnifiedMessage[], out: GroupedMessage[]): void {
  if (group.length === 0) return;
  if (group.length >= TOOL_GROUP_THRESHOLD) {
    const toolCalls = group
      .filter((m) => m.toolCall)
      .map((m) => toToolCallEvent(m.toolCall as ToolCallData));
    const id = toolCalls[0]?.toolCallId ?? group[0].id;
    out.push({ type: "tool_group", id, messages: group, toolCalls });
  } else {
    for (const msg of group) {
      out.push({ type: "single", message: msg });
    }
  }
}

/**
 * Group consecutive tool_call messages into collapsed groups. tool_result
 * messages are transparent here — they render as null in the chat surface
 * (the result is already embedded in the matching tool_call row), so they
 * must not break a consecutive run of tool calls. Without this, a turn of
 * N shell commands renders as N expanded rows because each tool_result
 * flushes a partial group below the threshold. See #1913.
 */
export function groupConsecutiveToolCalls(
  messages: UnifiedMessage[],
): GroupedMessage[] {
  const grouped: GroupedMessage[] = [];
  let currentGroup: UnifiedMessage[] = [];

  for (const message of messages) {
    if (message.type === "tool_call" && message.toolCall) {
      currentGroup.push(message);
    } else if (message.type !== "tool_result") {
      flushToolGroup(currentGroup, grouped);
      currentGroup = [];
      grouped.push({ type: "single", message });
    }
  }
  flushToolGroup(currentGroup, grouped);

  return grouped;
}
