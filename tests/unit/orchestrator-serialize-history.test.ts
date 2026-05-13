// ABOUTME: Pins the serializeHistory contract that the Rust recency boost depends on.
// ABOUTME: Without tool_calls[] on assistant rows, extract_recent_publishers returns [] (#1895).

import { describe, expect, it } from "vitest";
import { serializeHistory } from "@/services/orchestrator-history";
import type { ToolCallData, UnifiedMessage } from "@/types/conversation";

function makeMessage(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    id: overrides.id ?? `msg-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    status: "complete",
    ...overrides,
  };
}

function makeToolCallRow(name: string, idSuffix: string): UnifiedMessage {
  const toolCall: ToolCallData = {
    toolCallId: `tc-${idSuffix}`,
    title: name,
    kind: name,
    status: "complete",
    name,
    arguments: "{}",
  };
  return makeMessage({
    id: `tool-${idSuffix}`,
    type: "tool_call",
    role: "assistant",
    toolCall,
  });
}

function makeToolResultRow(idSuffix: string, content: string): UnifiedMessage {
  return makeMessage({
    id: `result-${idSuffix}`,
    type: "tool_result",
    role: "assistant",
    content,
    toolCallId: `tc-${idSuffix}`,
  });
}

describe("serializeHistory (#1895)", () => {
  it("attaches tool_calls[] to the assistant turn so Rust can read publisher recency", () => {
    // Reproduces the GLM #1895 thread shape: user prompt → assistant prose +
    // playwright tool call → tool result → next user prompt. The Rust
    // extract_recent_publishers (tool_relevance.rs) scans assistant rows for
    // a tool_calls[] array; without it the 2x recency boost from #1283 never
    // fires and any MCP publisher (playwright, gmail, kraken, …) silently
    // ages out of the next turn's BM25 budget.
    const history: UnifiedMessage[] = [
      makeMessage({
        id: "u1",
        type: "user",
        role: "user",
        content: "/prophet-bounty-runner",
      }),
      makeMessage({
        id: "a1",
        type: "assistant",
        role: "assistant",
        content: "Starting the Prophet Bounty Runner.",
      }),
      makeToolCallRow("mcp__playwright__playwright_list_browsers", "1"),
      makeMessage({
        id: "tr1",
        type: "tool_result",
        role: "assistant",
        content: '[{"name":"chrome"}]',
        toolCallId: "tc-1",
      }),
    ];

    const serialized = serializeHistory(history);

    const assistant = serialized.find((m) => m.role === "assistant");
    expect(assistant, "assistant message must be retained").toBeDefined();
    const toolCalls = assistant?.tool_calls;
    expect(
      Array.isArray(toolCalls),
      "assistant.tool_calls[] must be present so extract_recent_publishers sees the publisher",
    ).toBe(true);
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      function: { name: "mcp__playwright__playwright_list_browsers" },
    });
  });

  it("drops orphan tool_calls so the gateway never sees an assistant without its tool reply", () => {
    // OpenAI-compatible gateways reject any assistant row whose `tool_calls[]`
    // lacks a matching `role: "tool"` follow-up. The conversation store can
    // hold a half-streamed turn (tool_call persisted, tool_result still
    // pending) — those orphans must be stripped before history reaches the
    // gateway, otherwise the entire next chat turn would 400 (#1895).
    const history: UnifiedMessage[] = [
      makeMessage({
        id: "u1",
        type: "user",
        role: "user",
        content: "/prophet-bounty-runner",
      }),
      makeMessage({
        id: "a1",
        type: "assistant",
        role: "assistant",
        content: "Step 1.",
      }),
      makeToolCallRow("mcp__playwright__playwright_navigate", "complete"),
      makeToolResultRow("complete", "ok"),
      makeToolCallRow("mcp__playwright__playwright_click", "orphan"),
    ];

    const serialized = serializeHistory(history);
    const assistant = serialized.find((m) => m.role === "assistant");
    const toolCalls = assistant?.tool_calls as
      | Array<{ id: string }>
      | undefined;

    expect(toolCalls, "tool_calls must exist for the matched pair").toBeDefined();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0].id).toBe("tc-complete");

    // The tool reply for the matched call must still ride along so the
    // gateway accepts the conversation as well-formed.
    const toolReply = serialized.find((m) => m.role === "tool");
    expect(toolReply?.tool_call_id).toBe("tc-complete");
  });
});
