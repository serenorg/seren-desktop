// ABOUTME: Regression coverage for MCP chat approval reset on logout.
// ABOUTME: Ensures pending and completed tool calls cannot survive a session reset.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/client", () => ({
  mcpClient: {
    callTool: vi.fn(),
    connections: vi.fn(() => new Map()),
  },
}));

describe("resetMcpChatState", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("clears pending and completed MCP chat requests", async () => {
    const {
      createToolCallRequest,
      denyToolCall,
      getCompletedRequests,
      getPendingRequests,
      hasPendingApprovals,
      resetMcpChatState,
    } = await import("@/stores/mcp-chat.store");

    const pendingId = createToolCallRequest("seren", {
      name: "list_things",
      arguments: {},
    });
    const completedId = createToolCallRequest("seren", {
      name: "read_thing",
      arguments: { id: "thing_1" },
    });

    expect(pendingId).toMatch(/^mcp-/);
    denyToolCall(completedId);

    expect(getPendingRequests()).toHaveLength(1);
    expect(getCompletedRequests()).toHaveLength(1);
    expect(hasPendingApprovals()).toBe(true);

    resetMcpChatState();

    expect(getPendingRequests()).toEqual([]);
    expect(getCompletedRequests()).toEqual([]);
    expect(hasPendingApprovals()).toBe(false);
  });
});
