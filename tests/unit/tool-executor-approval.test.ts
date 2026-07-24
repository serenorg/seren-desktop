// ABOUTME: Verifies executeTool consults the host authorization gate on every route and honors it.
// ABOUTME: Classification/state now live in Rust; this covers allow/deny/prompt dispatch and fail-closed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approvalId: "",
  approvalResponse: true,
  shellApprovalId: "",
  shellApprovalResponse: true,
  // Default gate decision; individual tests override before calling executeTool.
  authorizeDecision: {
    decision: "allow" as "allow" | "deny" | "prompt",
    promptKind: null as "one-shot" | "session" | null,
    operationClass: "trusted-read" as
      | "trusted-read"
      | "high-risk"
      | "unclassified",
    description: "",
    isDestructive: false,
  },
  authorizeError: false,
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

function webFetchCall() {
  return {
    id: "web-fetch",
    type: "function" as const,
    function: {
      name: "seren_web_fetch",
      arguments: JSON.stringify({ url: "https://example.com" }),
    },
  };
}

function shellCall() {
  return {
    id: "shell",
    type: "function" as const,
    function: {
      name: "execute_command",
      arguments: JSON.stringify({ command: "echo hi", timeout_secs: 5 }),
    },
  };
}

function skillCall() {
  return {
    id: "skill",
    type: "function" as const,
    function: {
      name: "run_skill_script",
      arguments: JSON.stringify({
        skill_slug: "demo",
        cwd: "/tmp",
        argv: ["node", "run.js"],
      }),
    },
  };
}

/** All `authorize_tool_operation` invocations, in call order. */
function authorizeCalls(): Array<Record<string, unknown>> {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "authorize_tool_operation")
    .map(([, args]) => args as Record<string, unknown>);
}

function recordCalls(): Array<Record<string, unknown>> {
  return mocks.invoke.mock.calls
    .filter(([cmd]) => cmd === "record_tool_operation_decision")
    .map(([, args]) => args as Record<string, unknown>);
}

function gatewayPromptCount(): number {
  return mocks.emit.mock.calls.filter(
    ([eventName]) => eventName === "gateway-tool-approval-request",
  ).length;
}

function shellPromptCount(): number {
  return mocks.emit.mock.calls.filter(
    ([eventName]) => eventName === "shell-command-approval-request",
  ).length;
}

describe("tool executor authorization gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approvalId = "";
    mocks.approvalResponse = true;
    mocks.shellApprovalId = "";
    mocks.shellApprovalResponse = true;
    mocks.authorizeError = false;
    mocks.authorizeDecision = {
      decision: "allow",
      promptKind: null,
      operationClass: "trusted-read",
      description: "",
      isDestructive: false,
    };
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

    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "authorize_tool_operation") {
        if (mocks.authorizeError) throw new Error("gate unavailable");
        return mocks.authorizeDecision;
      }
      if (cmd === "record_tool_operation_decision") return undefined;
      if (cmd === "web_fetch") {
        return {
          content: "web-ok",
          content_type: "text/plain",
          url: "https://example.com",
          status: 200,
          truncated: false,
        };
      }
      if (cmd === "execute_shell_command_streaming") {
        return { stdout: "shell-ok", stderr: "", exit_code: 0, timed_out: false };
      }
      if (cmd === "run_skill_script") {
        return { stdout: "skill-ok", stderr: "", exit_code: 0, timed_out: false };
      }
      return undefined;
    });

    mocks.emit.mockImplementation(async (eventName: string, payload: unknown) => {
      if (eventName === "gateway-tool-approval-request") {
        mocks.approvalId = (payload as { approvalId: string }).approvalId;
      }
      if (eventName === "shell-command-approval-request") {
        mocks.shellApprovalId = (payload as { approvalId: string }).approvalId;
      }
    });

    mocks.listen.mockImplementation(
      async (
        eventName: string,
        handler: (event: {
          payload: { id: string; approved: boolean };
        }) => void,
      ) => {
        if (eventName === "gateway-tool-approval-response") {
          handler({
            payload: { id: mocks.approvalId, approved: mocks.approvalResponse },
          });
        }
        if (eventName === "shell-command-approval-response") {
          handler({
            payload: {
              id: mocks.shellApprovalId,
              approved: mocks.shellApprovalResponse,
            },
          });
        }
        return () => {};
      },
    );
  });

  it("executes silently when the host allows a gateway call", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "allow";

    const result = await executeTool(
      gatewayCall("gmail", "get_messages"),
      "conv-a",
    );

    expect(result.is_error).toBe(false);
    expect(gatewayPromptCount()).toBe(0);
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(1);
    const [call] = authorizeCalls();
    expect(call).toMatchObject({
      route: "gateway",
      publisherSlug: "gmail",
      toolName: "get_messages",
      conversationId: "conv-a",
    });
  });

  it("refuses without executing when the host denies", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "deny";

    const result = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "conv-a",
    );

    expect(result.is_error).toBe(true);
    expect(gatewayPromptCount()).toBe(0);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("prompts on the gate's request, executes on approval, and records it", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision = {
      decision: "prompt",
      promptKind: "session",
      operationClass: "unclassified",
      description:
        "Unclassified operation on new-publisher — first use this session",
      isDestructive: false,
    };

    const result = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "conv-a",
    );

    expect(result.is_error).toBe(false);
    expect(gatewayPromptCount()).toBe(1);
    expect(mocks.emit).toHaveBeenCalledWith(
      "gateway-tool-approval-request",
      expect.objectContaining({
        description:
          "Unclassified operation on new-publisher — first use this session",
      }),
    );
    expect(mocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(recordCalls()).toEqual([
      expect.objectContaining({
        route: "gateway",
        publisherSlug: "new-publisher",
        toolName: "inspect_records",
        conversationId: "conv-a",
        approved: true,
      }),
    ]);
  });

  it("records a denial and does not execute when the user rejects a prompt", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "prompt";
    mocks.authorizeDecision.promptKind = "session";
    mocks.authorizeDecision.operationClass = "unclassified";
    mocks.approvalResponse = false;

    const result = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "conv-a",
    );

    expect(result.is_error).toBe(true);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
    expect(recordCalls()).toEqual([
      expect.objectContaining({ approved: false }),
    ]);
  });

  it("fails closed when the gate is unavailable", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeError = true;

    const result = await executeTool(
      gatewayCall("new-publisher", "inspect_records"),
      "conv-a",
    );

    expect(result.is_error).toBe(true);
    expect(gatewayPromptCount()).toBe(0);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("routes built-in Seren tools through the gate under the seren route", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "allow";

    await executeTool(serenCall("call_publisher"), "conv-a");

    expect(authorizeCalls()[0]).toMatchObject({
      route: "seren",
      publisherSlug: "seren",
      toolName: "call_publisher",
    });
    expect(mocks.callSerenTool).toHaveBeenCalledWith("call_publisher", {
      value: "test",
    });
  });

  it("routes local MCP dispatch through the gate under the mcp route", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "allow";

    await executeTool(localMcpCall("gmail", "get_messages"), "conv-a");

    expect(authorizeCalls()[0]).toMatchObject({
      route: "mcp",
      publisherSlug: "gmail",
      toolName: "get_messages",
    });
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("gates web fetch as an open-world egress route", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "allow";

    const result = await executeTool(webFetchCall(), "conv-a");

    expect(result.is_error).toBe(false);
    expect(authorizeCalls()[0]).toMatchObject({
      route: "web",
      publisherSlug: "seren",
      toolName: "web_fetch",
    });
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "web_fetch")).toBe(
      true,
    );
  });

  it("does not fetch when the host denies a web fetch", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision.decision = "deny";

    const result = await executeTool(webFetchCall(), "conv-a");

    expect(result.is_error).toBe(true);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "web_fetch")).toBe(
      false,
    );
  });

  it("gates shell execution and prompts via the shell UI", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision = {
      decision: "prompt",
      promptKind: "one-shot",
      operationClass: "high-risk",
      description: "High-risk operation on seren/execute_command",
      isDestructive: false,
    };

    const result = await executeTool(shellCall(), "conv-a");

    expect(result.is_error).toBe(false);
    expect(authorizeCalls()[0]).toMatchObject({
      route: "shell",
      toolName: "execute_command",
    });
    expect(shellPromptCount()).toBe(1);
    expect(
      mocks.invoke.mock.calls.some(
        ([cmd]) => cmd === "execute_shell_command_streaming",
      ),
    ).toBe(true);
  });

  it("does not execute a shell command when the gate fails closed", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeError = true;

    const result = await executeTool(shellCall(), "conv-a");

    expect(result.is_error).toBe(true);
    expect(shellPromptCount()).toBe(0);
    expect(
      mocks.invoke.mock.calls.some(
        ([cmd]) => cmd === "execute_shell_command_streaming",
      ),
    ).toBe(false);
  });

  it("gates skill scripts under the skill route", async () => {
    const { executeTool } = await import("@/lib/tools/executor");
    mocks.authorizeDecision = {
      decision: "prompt",
      promptKind: "one-shot",
      operationClass: "high-risk",
      description: "High-risk operation on seren/run_skill_script",
      isDestructive: false,
    };

    const result = await executeTool(skillCall(), "conv-a");

    expect(result.is_error).toBe(false);
    expect(authorizeCalls()[0]).toMatchObject({
      route: "skill",
      toolName: "run_skill_script",
    });
    expect(shellPromptCount()).toBe(1);
  });
});
