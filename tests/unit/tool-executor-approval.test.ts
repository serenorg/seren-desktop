// ABOUTME: Verifies the temporary centralized approval containment for tool execution.
// ABOUTME: Covers trusted reads, one-shot high risk, session grants, and durable denials.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionDecisions } from "@/lib/tools/approval-session";

const mocks = vi.hoisted(() => ({
  approvalId: "",
  approvalResponse: true,
  callGatewayTool: vi.fn(),
  callMcpTool: vi.fn(),
  callSerenTool: vi.fn(),
  computeAgentOAuthRouting: vi.fn(),
  emit: vi.fn(),
  listen: vi.fn(),
  invoke: vi.fn(),
  startShellProgressListener: vi.fn(),
  handlePaymentRequired: vi.fn(),
}));

vi.mock("@/services/mcp-gateway", () => ({
  callGatewayTool: mocks.callGatewayTool,
  callSerenTool: mocks.callSerenTool,
}));

vi.mock("@/lib/mcp/client", () => ({
  mcpClient: {
    callTool: mocks.callMcpTool,
  },
}));

vi.mock("@/services/publisher-oauth", () => ({
  computeAgentOAuthRouting: mocks.computeAgentOAuthRouting,
}));

vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    activeConversationId: "active-conversation",
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/services/shell-progress", () => ({
  startShellProgressListener: mocks.startShellProgressListener,
}));

vi.mock("@/services/x402", () => ({
  x402Service: {
    handlePaymentRequired: mocks.handlePaymentRequired,
  },
}));

function gatewayCall(publisher: string, toolName: string) {
  return {
    id: `${publisher}-${toolName}`,
    type: "function" as const,
    function: {
      name: `gateway__${publisher}__${toolName}`,
      arguments: JSON.stringify({ value: "test" }),
    },
  };
}

function localMcpCall(serverName: string, toolName: string) {
  return {
    id: `${serverName}-${toolName}`,
    type: "function" as const,
    function: {
      name: `mcp__${serverName}__${toolName}`,
      arguments: JSON.stringify({ value: "test" }),
    },
  };
}

function serenCall(toolName: string) {
  return {
    id: `seren-${toolName}`,
    type: "function" as const,
    function: {
      name: `seren__${toolName}`,
      arguments: JSON.stringify({ value: "test" }),
    },
  };
}

function approvalRequestCount(): number {
  return mocks.emit.mock.calls.filter(
    ([eventName]) => eventName === "gateway-tool-approval-request",
  ).length;
}

describe("tool executor approval containment", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.approvalId = "";
    mocks.approvalResponse = true;
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: {},
      ambiguous: {},
      available: true,
    });
    mocks.callGatewayTool.mockResolvedValue({ result: "ok", is_error: false });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    mocks.callSerenTool.mockResolvedValue({ result: "ok", is_error: false });
    mocks.emit.mockImplementation(async (eventName, payload) => {
      if (eventName === "gateway-tool-approval-request") {
        mocks.approvalId = (payload as { approvalId: string }).approvalId;
      }
    });
    mocks.listen.mockImplementation(async (eventName, handler) => {
      if (eventName === "gateway-tool-approval-response") {
        handler({
          payload: {
            id: mocks.approvalId,
            approved: mocks.approvalResponse,
          },
        });
      }
      return () => {};
    });

    for (const conversationId of [
      "grant-conversation",
      "denial-conversation",
      "high-risk-conversation",
      "trusted-read-conversation",
      "unknown-conversation",
      "local-mcp-conversation",
      "builtin-conversation",
      "batch-conversation",
    ]) {
      clearSessionDecisions(conversationId);
    }
  });

  it("prompts an unclassified operation once and reuses its session grant", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    const first = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "grant-conversation",
    );
    const second = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "grant-conversation",
    );

    expect(first.is_error).toBe(false);
    expect(second.is_error).toBe(false);
    expect(approvalRequestCount()).toBe(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      "gateway-tool-approval-request",
      expect.objectContaining({
        description:
          "Unclassified operation on new-publisher — first use this session",
      }),
    );
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("returns a durable denial for a rejected unclassified operation", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.approvalResponse = false;

    const first = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "denial-conversation",
    );
    const second = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "denial-conversation",
    );

    expect(first.is_error).toBe(true);
    expect(second.is_error).toBe(true);
    expect(first.content).toContain("not approved");
    expect(second.content).toContain("not approved");
    expect(approvalRequestCount()).toBe(1);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("requires a one-shot approval for every high-risk verb call", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    await executeTool(
      gatewayCall("new-publisher", "delete_record"),
      "high-risk-conversation",
    );
    await executeTool(
      gatewayCall("new-publisher", "delete_record"),
      "high-risk-conversation",
    );

    expect(approvalRequestCount()).toBe(2);
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(2);
  });

  it("allows explicit trusted reads without a confirmation prompt", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    const result = await executeTool(
      gatewayCall("gmail", "get_messages"),
      "trusted-read-conversation",
    );

    expect(result.is_error).toBe(false);
    expect(approvalRequestCount()).toBe(0);
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("does not silently allow a never-seen publisher and tool", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    const result = await executeTool(
      gatewayCall("never-seen", "inspect_everything"),
      "unknown-conversation",
    );

    expect(result.is_error).toBe(false);
    expect(approvalRequestCount()).toBe(1);
  });

  it("routes unclassified built-in Seren tools through the same gate", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    const result = await executeTool(
      serenCall("call_publisher"),
      "builtin-conversation",
    );

    expect(result.is_error).toBe(false);
    expect(approvalRequestCount()).toBe(1);
    expect(mocks.callSerenTool).toHaveBeenCalledWith("call_publisher", {
      value: "test",
    });
  });

  it("routes local MCP dispatch through the same session-bound gate", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

    const first = await executeTool(
      // A local server can choose a publisher-like name, but it still has no
      // trusted security metadata and must not inherit Gmail's read allowlist.
      localMcpCall("gmail", "get_messages"),
      "local-mcp-conversation",
    );
    const second = await executeTool(
      localMcpCall("gmail", "get_messages"),
      "local-mcp-conversation",
    );

    expect(first.is_error).toBe(false);
    expect(second.is_error).toBe(false);
    expect(approvalRequestCount()).toBe(1);
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(2);
  });

  it("keeps batched gateway execution bound to its supplied conversation", async () => {
    const { executeTool, executeTools } = await import("@/lib/tools/executor");
    const call = gatewayCall("batch-publisher", "inspect_records");

    await executeTools([call], "batch-conversation");
    await executeTool(call, "batch-conversation");

    expect(approvalRequestCount()).toBe(1);
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(2);
  });
});
