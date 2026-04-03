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
    expect(getGatewayTools()).toHaveLength(3);
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
    expect(getGatewayTools()).toHaveLength(3);

    await resetGateway();
    expect(getGatewayTools()).toHaveLength(0);
    expect(isGatewayInitialized()).toBe(false);
  });

  it("should include built-in tools under seren-mcp publisher (#1210, #1417)", async () => {
    const { initializeGateway, getGatewayTools } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    const tools = getGatewayTools();

    // All 3 tools survive: prefixed publisher tool + 2 built-in under seren-mcp
    expect(tools).toHaveLength(3);

    const prefixedTool = tools.find((t) => t.publisher === "test");
    expect(prefixedTool).toBeDefined();
    expect(prefixedTool!.tool.name).toBe("test-tool");

    const serenTools = tools.filter((t) => t.publisher === "seren-mcp");
    expect(serenTools).toHaveLength(2);
    expect(serenTools.map((t) => t.tool.name).sort()).toEqual(
      ["call_publisher", "list_mcp_tools"],
    );
  });

  it("should discover publisher tools regardless of publisher_type (#1217)", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const callToolMock = vi.mocked(mcpClient.callToolHttp);

    // Mock list_agent_publishers → returns publisher with type "individual"
    // Mock list_mcp_tools for gmail → returns gmail tools
    callToolMock.mockImplementation(async (_server, request) => {
      if (request.name === "list_agent_publishers") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                publishers: [
                  {
                    slug: "gmail",
                    name: "GMail",
                    publisher_type: "individual",
                    integration_type: "api",
                  },
                ],
              }),
            },
          ],
          isError: false,
        };
      }
      if (
        request.name === "list_mcp_tools" &&
        request.arguments?.publisher === "gmail"
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  {
                    name: "get_messages",
                    description: "List messages in mailbox",
                    inputSchema: { type: "object", properties: {} },
                  },
                  {
                    name: "post_messages_send",
                    description: "Send a new email",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }),
            },
          ],
          isError: false,
        };
      }
      return { content: [], isError: true };
    });

    const { initializeGateway, getGatewayTools } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    const tools = getGatewayTools();

    // Should have: 1 static tool (test-tool) + 2 gmail tools.
    // discoverPublisherTools now stores bare tool names (no mcp__publisher__ prefix).
    const gmailTools = tools.filter((t) => t.publisher === "gmail");
    expect(gmailTools).toHaveLength(2);
    expect(gmailTools[0].tool.name).toBe("get_messages");
    expect(gmailTools[1].tool.name).toBe("post_messages_send");
  });
});

describe("MCP Gateway Native Tool Routing (#1329)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("should call native MCP tools directly instead of through call_publisher", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const callToolMock = vi.mocked(mcpClient.callToolHttp);

    const { initializeGateway, callGatewayTool } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();

    // Reset mock call history after init (which calls connectHttp, callToolHttp, etc.)
    callToolMock.mockClear();
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: '{"time":"2026-03-31T12:00:00Z"}' }],
      isError: false,
    });

    // Call the native MCP tool (test publisher is in connection.tools as mcp__test__test-tool)
    const result = await callGatewayTool("test", "test-tool", {});

    // Should call directly with the original MCP name, NOT through call_publisher
    expect(callToolMock).toHaveBeenCalledWith("seren-gateway", {
      name: "mcp__test__test-tool",
      arguments: {},
    });
    expect(result.is_error).toBe(false);
  });

  it("should use call_publisher for non-native REST publisher tools", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const callToolMock = vi.mocked(mcpClient.callToolHttp);

    // Add a dynamically-discovered publisher tool (not in connection.tools)
    callToolMock.mockImplementation(async (_server, request) => {
      if (request.name === "list_agent_publishers") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                publishers: [{ slug: "kraken", name: "Kraken" }],
              }),
            },
          ],
          isError: false,
        };
      }
      if (
        request.name === "list_mcp_tools" &&
        request.arguments?.publisher === "kraken"
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tools: [
                  {
                    name: "get_balance",
                    description: "Get account balance",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }),
            },
          ],
          isError: false,
        };
      }
      return { content: [], isError: true };
    });

    const { initializeGateway, callGatewayTool } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();

    // Reset and set up for the actual tool call
    callToolMock.mockClear();
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: '{"balance":"100.00"}' }],
      isError: false,
    });

    // kraken/get_balance is NOT in connection.tools, only discovered dynamically
    const result = await callGatewayTool("kraken", "get_balance", {
      currency: "USD",
    });

    // Should dispatch through call_publisher, not direct MCP call
    expect(callToolMock).toHaveBeenCalledWith("seren-gateway", {
      name: "call_publisher",
      arguments: {
        publisher: "kraken",
        tool: "get_balance",
        tool_args: { currency: "USD" },
      },
    });
    expect(result.is_error).toBe(false);
  });

  it("should track native tools and clear them on reset", async () => {
    const { initializeGateway, isNativeMcpTool, resetGateway } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();

    // "test" publisher's "test-tool" should be detected as native
    // (it's in mock connection.tools as mcp__test__test-tool)
    expect(isNativeMcpTool("test", "test-tool")).toBe(true);

    // Non-existent tool should not be native
    expect(isNativeMcpTool("kraken", "get_balance")).toBe(false);

    // Reset should clear native tool tracking
    await resetGateway();
    expect(isNativeMcpTool("test", "test-tool")).toBe(false);
  });

  it("should strip _x402_payment from args for native MCP tool calls", async () => {
    const { mcpClient } = await import("@/lib/mcp/client");
    const callToolMock = vi.mocked(mcpClient.callToolHttp);

    const { initializeGateway, callGatewayTool } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    callToolMock.mockClear();
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    await callGatewayTool("test", "test-tool", {
      some_arg: "value",
      _x402_payment: "payment-header",
    });

    // Native call should NOT include _x402_payment in arguments
    expect(callToolMock).toHaveBeenCalledWith("seren-gateway", {
      name: "mcp__test__test-tool",
      arguments: { some_arg: "value" },
    });
  });
});
