// ABOUTME: Pins Seren Chat tool-call collapse — tool_result must not break runs.
// ABOUTME: Regression guard for #1913 (every shell command rendered as its own row).

import { describe, expect, it } from "vitest";
import { groupConsecutiveToolCalls } from "@/lib/group-tool-calls";
import type {
  MessageStatus,
  ToolCallData,
  UnifiedMessage,
} from "@/types/conversation";

function toolCall(id: string, command: string): UnifiedMessage {
  const toolCall: ToolCallData = {
    toolCallId: id,
    title: "Bash",
    kind: "bash",
    status: "completed",
    parameters: { command },
  };
  return {
    id,
    type: "tool_call",
    role: "assistant",
    content: "",
    timestamp: 0,
    status: "complete" as MessageStatus,
    toolCallId: id,
    toolCall,
  };
}

function toolResult(id: string, content: string): UnifiedMessage {
  return {
    id: `${id}-result`,
    type: "tool_result",
    role: "assistant",
    content,
    timestamp: 0,
    status: "complete" as MessageStatus,
    toolCallId: id,
  };
}

function assistantText(id: string, content: string): UnifiedMessage {
  return {
    id,
    type: "assistant",
    role: "assistant",
    content,
    timestamp: 0,
    status: "complete" as MessageStatus,
  };
}

describe("groupConsecutiveToolCalls", () => {
  it("groups 3+ tool_calls even when tool_result rows are interleaved (#1913)", () => {
    // What the orchestrator actually produces: tool_call → tool_result → ...
    const messages: UnifiedMessage[] = [
      toolCall("a", "ls"),
      toolResult("a", "file.txt"),
      toolCall("b", "pwd"),
      toolResult("b", "/home"),
      toolCall("c", "whoami"),
      toolResult("c", "taariq"),
    ];

    const out = groupConsecutiveToolCalls(messages);

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("tool_group");
    if (out[0].type === "tool_group") {
      expect(out[0].toolCalls).toHaveLength(3);
      expect(out[0].id).toBe("a");
    }
  });

  it("keeps fewer-than-threshold tool_calls as singles", () => {
    const messages: UnifiedMessage[] = [
      toolCall("a", "ls"),
      toolResult("a", "file.txt"),
      toolCall("b", "pwd"),
      toolResult("b", "/home"),
    ];

    const out = groupConsecutiveToolCalls(messages);

    expect(out.map((g) => g.type)).toEqual(["single", "single"]);
  });

  it("assistant text between tool_calls breaks the group", () => {
    // Regression guard: tool_result is transparent, but real assistant text
    // must still partition consecutive tool runs.
    const messages: UnifiedMessage[] = [
      toolCall("a", "ls"),
      toolResult("a", "file.txt"),
      toolCall("b", "pwd"),
      toolResult("b", "/home"),
      assistantText("text", "Let me think about this..."),
      toolCall("c", "whoami"),
      toolResult("c", "taariq"),
      toolCall("d", "uname"),
      toolResult("d", "darwin"),
      toolCall("e", "echo hi"),
      toolResult("e", "hi"),
    ];

    const out = groupConsecutiveToolCalls(messages);

    // First two tool_calls (below threshold) → 2 singles, then the assistant
    // text → 1 single, then the trailing 3 tool_calls → 1 group.
    expect(out.map((g) => g.type)).toEqual([
      "single",
      "single",
      "single",
      "tool_group",
    ]);
    if (out[3].type === "tool_group") {
      expect(out[3].toolCalls).toHaveLength(3);
    }
  });
});
