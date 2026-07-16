import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
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

vi.mock("@/services/publisher-oauth", () => ({
  computeAgentOAuthRouting: mocks.computeAgentOAuthRouting,
}));

vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    activeConversationId: "thread-1",
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

describe("tool executor OAuth account routing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { setThreadOAuthConnectionId } = await import(
      "@/stores/oauth-account.store"
    );
    setThreadOAuthConnectionId("thread-1", "google", null);
    setThreadOAuthConnectionId("thread-2", "google", null);
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: {},
      ambiguous: {},
      available: true,
    });
    mocks.callGatewayTool.mockResolvedValue({
      result: "ok",
      is_error: false,
    });
  });

  it("attaches the active chat OAuth connection before dispatching a Gateway publisher tool", async () => {
    const [{ executeTool }, { setThreadOAuthConnectionId }] =
      await Promise.all([
        import("@/lib/tools/executor"),
        import("@/stores/oauth-account.store"),
      ]);
    setThreadOAuthConnectionId(
      "thread-1",
      "google",
      "conn-google-personal",
    );
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: { gmail: "conn-google-personal" },
      ambiguous: {},
      available: true,
    });

    const result = await executeTool({
      id: "tool-call-1",
      type: "function",
      function: {
        name: "gateway__gmail__messages",
        arguments: JSON.stringify({ q: "from:example" }),
      },
    });

    expect(result.is_error).toBe(false);
    expect(mocks.callGatewayTool).toHaveBeenCalledWith("gmail", "messages", {
      q: "from:example",
      connection_id: "conn-google-personal",
    });
  });

  it("resolves the owning run's OAuth account, not the chat the user is viewing", async () => {
    const [{ executeTool }, { setThreadOAuthConnectionId }] =
      await Promise.all([
        import("@/lib/tools/executor"),
        import("@/stores/oauth-account.store"),
      ]);
    // The user is viewing thread-1 (active) with the work account selected,
    // while a background run in thread-2 selected the personal account.
    setThreadOAuthConnectionId("thread-1", "google", "conn-google-work");
    setThreadOAuthConnectionId("thread-2", "google", "conn-google-personal");
    mocks.computeAgentOAuthRouting.mockImplementation(async (threadId) => ({
      publishers: {
        gmail:
          threadId === "thread-2"
            ? "conn-google-personal"
            : "conn-google-work",
      },
      ambiguous: {},
      available: true,
    }));

    const result = await executeTool(
      {
        id: "tool-call-owning",
        type: "function",
        function: {
          name: "gateway__gmail__messages",
          arguments: JSON.stringify({ q: "from:example" }),
        },
      },
      "thread-2",
    );

    expect(result.is_error).toBe(false);
    expect(mocks.callGatewayTool).toHaveBeenCalledWith("gmail", "messages", {
      q: "from:example",
      connection_id: "conn-google-personal",
    });
  });

  it("fails closed before dispatch when multiple accounts have no default or chat selection", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: {},
      ambiguous: {
        gmail:
          "Multiple Google accounts are connected. Choose an active account for this chat.",
      },
      available: true,
    });

    const result = await executeTool({
      id: "tool-call-2",
      type: "function",
      function: {
        name: "gateway__gmail__messages",
        arguments: JSON.stringify({ q: "from:example" }),
      },
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Multiple Google accounts are connected");
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("fails closed when connected-account discovery is unavailable", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: {},
      ambiguous: {},
      available: false,
    });

    const result = await executeTool({
      id: "tool-call-unavailable",
      type: "function",
      function: {
        name: "gateway__gmail__messages",
        arguments: JSON.stringify({ q: "safe-read" }),
      },
    });

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("OAuth account routing is unavailable");
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("retains the owning OAuth connection when retrying a signed x402 payment", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    const paymentRequiredHeader = btoa(
      JSON.stringify({ x402Version: 2, accepts: [] }),
    );
    const signedV2Payment = btoa(JSON.stringify({ x402Version: 2 }));
    mocks.computeAgentOAuthRouting.mockResolvedValue({
      publishers: { gmail: "conn-google-personal" },
      ambiguous: {},
      available: true,
    });
    mocks.callGatewayTool
      .mockResolvedValueOnce({
        result: "payment required",
        is_error: true,
        payment_proxy: {
          payment_required_header: paymentRequiredHeader,
        },
      })
      .mockResolvedValueOnce({ result: "paid", is_error: false });
    mocks.handlePaymentRequired.mockResolvedValue({
      success: true,
      method: "crypto",
      paymentHeader: signedV2Payment,
    });

    const result = await executeTool(
      {
        id: "tool-call-paid",
        type: "function",
        function: {
          name: "gateway__gmail__messages",
          arguments: JSON.stringify({ q: "safe-read" }),
        },
      },
      "thread-2",
    );

    expect(result.is_error).toBe(false);
    expect(mocks.callGatewayTool).toHaveBeenNthCalledWith(
      1,
      "gmail",
      "messages",
      {
        q: "safe-read",
        connection_id: "conn-google-personal",
      },
    );
    expect(mocks.callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "gmail",
      "messages",
      {
        q: "safe-read",
        connection_id: "conn-google-personal",
        _x402_payment: signedV2Payment,
      },
    );
  });
});
