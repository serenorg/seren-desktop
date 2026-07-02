import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  callSerenTool: vi.fn(),
  listConnectedPublishers: vi.fn(),
  resolveOAuthProviderForPublisher: vi.fn(),
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
  listConnectedPublishers: mocks.listConnectedPublishers,
  resolveOAuthProviderForPublisher: mocks.resolveOAuthProviderForPublisher,
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

const googleConnections = [
  {
    id: "conn-google-work",
    provider_slug: "google",
    provider_email: "work@example.com",
    provider_user_id: "work",
    is_valid: true,
    is_default: false,
    connected_at: "2026-06-01T00:00:00Z",
    last_used_at: null,
  },
  {
    id: "conn-google-personal",
    provider_slug: "google",
    provider_email: "personal@example.com",
    provider_user_id: "personal",
    is_valid: true,
    is_default: false,
    connected_at: "2026-06-15T00:00:00Z",
    last_used_at: null,
  },
];

describe("tool executor OAuth account routing", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { setThreadOAuthConnectionId } = await import(
      "@/stores/oauth-account.store"
    );
    setThreadOAuthConnectionId("thread-1", "google", null);
    mocks.resolveOAuthProviderForPublisher.mockResolvedValue({
      publisherSlug: "gmail",
      providerSlug: "google",
      providerName: "Google",
    });
    mocks.listConnectedPublishers.mockResolvedValue(googleConnections);
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

  it("fails closed before dispatch when multiple accounts have no default or chat selection", async () => {
    const { executeTool } = await import("@/lib/tools/executor");

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
});
