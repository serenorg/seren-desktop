// ABOUTME: Tests for MCP Gateway cache validity logic.
// ABOUTME: Focused on critical caching behavior that affects tool availability.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock MCP OAuth
vi.mock("@/services/mcp-oauth", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-mcp-token"),
  isMcpAuthenticated: vi.fn().mockResolvedValue(true),
  clearStoredTokens: vi.fn().mockResolvedValue(undefined),
}));

// Mock MCP client
vi.mock("@/lib/mcp/client", () => ({
  mcpClient: {
    connectHttp: vi.fn().mockResolvedValue(undefined),
    disconnectHttp: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({
      tools: [
        {
          name: "mcp__test__test-tool",
          description: "Test tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }),
    callToolHttp: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      isError: false,
    }),
  },
}));

// Mock MCP OAuth - required for gateway initialization
vi.mock("@/services/mcp-oauth", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("mock-mcp-token"),
  isMcpAuthenticated: vi.fn().mockResolvedValue(true),
  clearStoredTokens: vi.fn().mockResolvedValue(undefined),
}));

// Mock MCP client
vi.mock("@/lib/mcp/client", () => ({
  mcpClient: {
    connectHttp: vi.fn().mockResolvedValue(undefined),
    disconnectHttp: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({
      tools: [
        {
          name: "mcp__test__test-tool",
          description: "Test tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }),
    callToolHttp: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      isError: false,
    }),
  },
}));

describe("MCP Gateway Caching", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("should use cached data when cache is valid", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const connectMock = vi.mocked(mcpClient.connectHttp);

    const { initializeGateway, getGatewayTools, isGatewayInitialized } =
      await import("@/services/mcp-gateway");

    // First init - should connect
    await initializeGateway();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(getGatewayTools()).toHaveLength(1);
    expect(isGatewayInitialized()).toBe(true);

    // Second init within TTL - should use cache
    await initializeGateway();
    expect(connectMock).toHaveBeenCalledTimes(1); // No additional calls
  });

  it("should refetch when cache expires", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const connectMock = vi.mocked(mcpClient.connectHttp);

    const { initializeGateway, isGatewayInitialized } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Advance time past TTL (10 minutes + 1 second)
    vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
    expect(isGatewayInitialized()).toBe(false);

    // Third init after TTL expired - should reconnect
    await initializeGateway();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("should clear cache on reset", async () => {
    const {
      initializeGateway,
      resetGateway,
      getGatewayTools,
      isGatewayInitialized,
    } = await import("@/services/mcp-gateway");

    await initializeGateway();
    expect(getGatewayTools()).toHaveLength(1);

    await resetGateway();
    expect(getGatewayTools()).toHaveLength(0);
    expect(isGatewayInitialized()).toBe(false);
  });
});
