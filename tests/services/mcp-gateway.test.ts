// ABOUTME: Tests for MCP Gateway cache validity logic.
// ABOUTME: Focused on critical caching behavior that affects tool availability.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock tauri-bridge to avoid localStorage dependency in Node
vi.mock("@/lib/tauri-bridge", () => ({
  getSerenApiKey: vi.fn().mockResolvedValue("test-api-key"),
  clearSerenApiKey: vi.fn().mockResolvedValue(undefined),
  isTauri: vi.fn().mockReturnValue(false),
}));

// Mock MCP OAuth
vi.mock("@/services/mcp-oauth", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-mcp-token"),
  isMcpAuthenticated: vi.fn().mockResolvedValue(true),
  clearStoredTokens: vi.fn().mockResolvedValue(undefined),
}));

// Mock MCP client — includes a publisher tool AND a built-in tool (no mcp__ prefix)
vi.mock("@/lib/mcp/client", () => ({
  mcpClient: {
    connectHttp: vi.fn().mockResolvedValue(undefined),
    disconnectHttp: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockReturnValue({
      tools: [
        {
          name: "mcp__test__test-tool",
          description: "Test publisher tool",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "list_mcp_tools",
          description: "Built-in gateway management tool",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "call_publisher",
          description: "Another built-in tool",
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

  it("should exclude built-in tools without mcp__ prefix (#1210)", async () => {
    const { initializeGateway, getGatewayTools } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    const tools = getGatewayTools();

    // Only the mcp__test__test-tool should survive; list_mcp_tools and
    // call_publisher are built-in gateway tools and must not be converted
    expect(tools).toHaveLength(1);
    expect(tools[0].publisher).toBe("test");
    expect(tools[0].tool.name).toBe("mcp__test__test-tool");

    // Verify no tool has the fallback "seren" publisher
    const serenTools = tools.filter((t) => t.publisher === "seren");
    expect(serenTools).toHaveLength(0);
  });
});
