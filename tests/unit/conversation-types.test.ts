// ABOUTME: Tests for unified conversation types.
// ABOUTME: Verifies type construction and type guard helpers.

import { describe, expect, it } from "vitest";
import {
  isOrchestratorMessage,
  isToolMessage,
} from "@/types/conversation";
import type {
  DiffData,
  MessageStatus,
  MessageType,
  ToolCallData,
  UnifiedMessage,
  WorkerType,
} from "@/types/conversation";

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "test-id",
    type: "assistant",
    role: "assistant",
    content: "hello",
    timestamp: Date.now(),
    status: "complete",
    ...overrides,
  };
}

describe("UnifiedMessage types", () => {
  it("constructs a user message", () => {
    const msg = makeMessage({ type: "user", role: "user", content: "hi" });
    expect(msg.type).toBe("user");
    expect(msg.role).toBe("user");
  });

  it("constructs an assistant message with routing metadata", () => {
    const msg = makeMessage({
      workerType: "chat_model",
      modelId: "anthropic/claude-opus-4-6",
      taskType: "code_generation",
    });
    expect(msg.workerType).toBe("chat_model");
    expect(msg.modelId).toBe("anthropic/claude-opus-4-6");
  });

  it("constructs a tool_call message", () => {
    const toolCall: ToolCallData = {
      toolCallId: "tc-1",
      title: "read_file",
      kind: "file",
      status: "pending",
      name: "read_file",
      arguments: '{"path":"/tmp/foo.txt"}',
    };
    const msg = makeMessage({ type: "tool_call", toolCall });
    expect(msg.type).toBe("tool_call");
    expect(msg.toolCall?.toolCallId).toBe("tc-1");
  });

  it("constructs a tool_result message", () => {
    const msg = makeMessage({
      type: "tool_result",
      toolCallId: "tc-1",
      content: "file contents here",
    });
    expect(msg.type).toBe("tool_result");
    expect(msg.toolCallId).toBe("tc-1");
  });

  it("constructs a diff message", () => {
    const diff: DiffData = {
      path: "/src/main.rs",
      oldText: "fn main() {}",
      newText: 'fn main() { println!("hello"); }',
      toolCallId: "tc-2",
    };
    const msg = makeMessage({ type: "diff", diff });
    expect(msg.type).toBe("diff");
    expect(msg.diff?.path).toBe("/src/main.rs");
  });

  it("constructs a thought message", () => {
    const msg = makeMessage({
      type: "thought",
      thinking: "Let me consider the approach...",
    });
    expect(msg.type).toBe("thought");
    expect(msg.thinking).toBeDefined();
  });

  it("constructs a transition message", () => {
    const msg = makeMessage({
      type: "transition",
      workerType: "orchestrator",
      content: "Working with Claude Opus on code generation...",
    });
    expect(msg.type).toBe("transition");
    expect(msg.workerType).toBe("orchestrator");
  });

  it("constructs an error message", () => {
    const msg = makeMessage({
      type: "error",
      status: "error",
      error: "Network timeout",
    });
    expect(msg.type).toBe("error");
    expect(msg.error).toBe("Network timeout");
  });

  it("supports image attachments", () => {
    const msg = makeMessage({
      type: "user",
      role: "user",
      images: [{ type: "base64", media_type: "image/png", data: "abc" }],
    });
    expect(msg.images).toHaveLength(1);
  });

  it("supports retry request data", () => {
    const msg = makeMessage({
      request: {
        prompt: "Write a function",
        context: { content: "fn main() {}", file: "/src/main.rs" },
      },
    });
    expect(msg.request?.prompt).toBe("Write a function");
    expect(msg.request?.context?.file).toBe("/src/main.rs");
  });
});

describe("isToolMessage", () => {
  it("returns true for tool_call", () => {
    expect(isToolMessage(makeMessage({ type: "tool_call" }))).toBe(true);
  });

  it("returns true for tool_result", () => {
    expect(isToolMessage(makeMessage({ type: "tool_result" }))).toBe(true);
  });

  it("returns false for assistant", () => {
    expect(isToolMessage(makeMessage({ type: "assistant" }))).toBe(false);
  });

  it("returns false for user", () => {
    expect(isToolMessage(makeMessage({ type: "user" }))).toBe(false);
  });

  it("returns false for transition", () => {
    expect(isToolMessage(makeMessage({ type: "transition" }))).toBe(false);
  });
});

describe("isOrchestratorMessage", () => {
  it("returns true for transition type", () => {
    expect(isOrchestratorMessage(makeMessage({ type: "transition" }))).toBe(
      true,
    );
  });

  it("returns true for orchestrator workerType", () => {
    expect(
      isOrchestratorMessage(makeMessage({ workerType: "orchestrator" })),
    ).toBe(true);
  });

  it("returns false for regular assistant message", () => {
    expect(
      isOrchestratorMessage(makeMessage({ type: "assistant" })),
    ).toBe(false);
  });
});

describe("type exhaustiveness", () => {
  it("all MessageType values are valid", () => {
    const types: MessageType[] = [
      "user",
      "assistant",
      "tool_call",
      "tool_result",
      "diff",
      "thought",
      "transition",
      "error",
    ];
    for (const t of types) {
      const msg = makeMessage({ type: t });
      expect(msg.type).toBe(t);
    }
  });

  it("all WorkerType values are valid", () => {
    const workers: WorkerType[] = [
      "chat_model",
      "acp_agent",
      "mcp_publisher",
      "orchestrator",
    ];
    for (const w of workers) {
      const msg = makeMessage({ workerType: w });
      expect(msg.workerType).toBe(w);
    }
  });

  it("all MessageStatus values are valid", () => {
    const statuses: MessageStatus[] = [
      "pending",
      "streaming",
      "complete",
      "error",
    ];
    for (const s of statuses) {
      const msg = makeMessage({ status: s });
      expect(msg.status).toBe(s);
    }
  });
});
