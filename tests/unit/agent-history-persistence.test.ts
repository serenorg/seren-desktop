// ABOUTME: Tests that only finalized assistant messages are persisted to SQLite.
// ABOUTME: Prevents regression where intermediate tool-call flushes pollute restored history.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("agent message persistence guards", () => {
  it("persistAgentMessage only stores user and assistant types", () => {
    const fnStart = agentStoreSource.indexOf(
      "function persistAgentMessage(",
    );
    const fnBody = agentStoreSource.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain(
      'if (msg.type !== "user" && msg.type !== "assistant") return',
    );
  });

  it("handleToolCall does NOT persist intermediate streaming flush", () => {
    // The handleToolCall method flushes streamingContent into an assistant
    // message for UI ordering, but must NOT persist it — these intermediate
    // messages capture partial text (often file contents) that would pollute
    // the restored conversation history on restart.
    const toolCallHandler = agentStoreSource.slice(
      agentStoreSource.indexOf("handleToolCall(sessionId: string, toolCall:"),
    );
    const handlerBody = toolCallHandler.slice(
      0,
      toolCallHandler.indexOf("handleToolResult("),
    );

    // Find the streaming content flush block within handleToolCall
    const flushBlock = handlerBody.slice(
      handlerBody.indexOf("if (session.streamingContent)"),
      handlerBody.indexOf("// Skip duplicate if a message"),
    );
    expect(flushBlock.length).toBeGreaterThan(0);

    // The flush block must NOT contain a persistAgentMessage call
    expect(flushBlock).not.toContain("persistAgentMessage(");
  });

  it("finalizeStreamingContent DOES persist assistant messages", () => {
    const finalizeHandler = agentStoreSource.slice(
      agentStoreSource.indexOf("finalizeStreamingContent(sessionId: string"),
    );
    const finalizeBody = finalizeHandler.slice(
      0,
      finalizeHandler.indexOf("handleToolCall(") > 0
        ? finalizeHandler.indexOf("handleToolCall(")
        : 2000,
    );

    // finalizeStreamingContent should persist — this is the real finalization
    expect(finalizeBody).toContain("persistAgentMessage(");
  });
});
