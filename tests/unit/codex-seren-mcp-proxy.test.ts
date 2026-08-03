import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  buildSerenPublisherRequest,
  createGmailSendConfirmationTracker,
  createSerenMcpOAuthProxy,
  planSerenMcpRequest,
} from "../../bin/browser-local/seren-mcp-oauth-proxy.mjs";

const callPublisher = (args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "call_publisher", arguments: args },
});

describe("native Codex Seren MCP OAuth routing", () => {
  it("routes API and synthesized-tool calls through the selected connection", () => {
    const routing = {
      publishers: { gmail: "conn-selected" },
      ambiguous: {},
    };

    expect(
      planSerenMcpRequest(
        routing,
        callPublisher({
          publisher: "gmail",
          method: "GET",
          path: "/messages?maxResults=1",
        }),
      ),
    ).toMatchObject({
      kind: "publisher",
      connectionId: "conn-selected",
      publisher: "gmail",
      request: { kind: "api", method: "GET", path: "/messages?maxResults=1" },
    });

    expect(
      planSerenMcpRequest(
        routing,
        callPublisher({
          publisher: "gmail",
          tool: "get_messages",
          tool_args: { maxResults: 1 },
        }),
      ),
    ).toMatchObject({
      kind: "publisher",
      connectionId: "conn-selected",
      publisher: "gmail",
      request: {
        kind: "tool",
        tool: "get_messages",
        toolArgs: { maxResults: 1 },
      },
    });
  });

  it("pins the selected identity on the ownership-checked Core request", () => {
    const plan = planSerenMcpRequest(
      { publishers: { gmail: "conn-selected" }, ambiguous: {} },
      callPublisher({
        publisher: "gmail",
        method: "GET",
        path: "/messages?maxResults=1&connection_id=conn-wrong",
        headers: {
          Authorization: "Bearer wrong",
          "x-seren-oauth-connection-id": "conn-wrong",
        },
      }),
    );
    expect(plan.kind).toBe("publisher");
    if (plan.kind !== "publisher") throw new Error("Expected publisher plan");

    const request = buildSerenPublisherRequest(
      plan,
      "Bearer desktop-key",
      "https://api.serendb.com",
    );

    expect(request.url).toBe(
      "https://api.serendb.com/publishers/gmail/messages?maxResults=1",
    );
    expect(request.headers.get("Authorization")).toBe("Bearer desktop-key");
    expect(request.headers.get("x-seren-oauth-connection-id")).toBe(
      "conn-selected",
    );
  });

  it("uses the versioned x402 header while keeping the selected identity pinned", () => {
    const paymentFor = (x402Version: number) =>
      Buffer.from(JSON.stringify({ x402Version })).toString("base64");
    const requestFor = (x402Version: number) => {
      const plan = planSerenMcpRequest(
        { publishers: { gmail: "conn-selected" }, ambiguous: {} },
        callPublisher({
          publisher: "gmail",
          tool: "get_messages",
          tool_args: { maxResults: 1 },
          _x402_payment: paymentFor(x402Version),
        }),
      );
      if (plan.kind !== "publisher") {
        throw new Error("Expected publisher plan");
      }
      return buildSerenPublisherRequest(
        plan,
        "Bearer desktop-key",
        "https://api.serendb.com",
      );
    };

    const v2 = requestFor(2);
    expect(v2.headers.get("PAYMENT-SIGNATURE")).toBe(paymentFor(2));
    expect(v2.headers.has("X-PAYMENT")).toBe(false);
    expect(v2.headers.get("x-seren-oauth-connection-id")).toBe(
      "conn-selected",
    );

    const v1 = requestFor(1);
    expect(v1.headers.get("X-PAYMENT")).toBe(paymentFor(1));
    expect(v1.headers.has("PAYMENT-SIGNATURE")).toBe(false);
  });

  it("surfaces Core's payment-required header as the standard MCP proxy error", async () => {
    const originalFetch = globalThis.fetch;
    const paymentRequiredHeader = Buffer.from(
      JSON.stringify({ x402Version: 2 }),
    ).toString("base64");
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 402,
        headers: { "payment-required": paymentRequiredHeader },
      }),
    );
    globalThis.fetch = upstreamFetch as typeof fetch;
    const proxy = await createSerenMcpOAuthProxy({
      gatewayUrl: "https://mcp.invalid/mcp",
      apiUrl: "https://api.invalid",
    });
    proxy.setRouting({
      publishers: { gmail: "conn-selected" },
      ambiguous: {},
    });

    try {
      const response = await originalFetch(proxy.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer desktop-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          callPublisher({
            publisher: "gmail",
            tool: "get_messages",
            tool_args: { maxResults: 1 },
          }),
        ),
      });
      const event = (await response.text())
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(event).toBeDefined();
      const payload = JSON.parse(event?.slice(6) ?? "null");
      const proxyError = JSON.parse(payload.result.content[0].text);

      expect(proxyError).toEqual({
        error: "payment_required",
        proxy_payment: true,
        payment_required_header: paymentRequiredHeader,
      });
      expect(payload.result.isError).toBe(true);
      const [, requestInit] = upstreamFetch.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(
        new Headers(requestInit.headers).get(
          "x-seren-oauth-connection-id",
        ),
      ).toBe("conn-selected");
    } finally {
      globalThis.fetch = originalFetch;
      await proxy.close();
    }
  });

  it("preserves an explicit selector and fails closed while ambiguous or initializing", () => {
    const confirmation = createGmailSendConfirmationTracker();
    confirmation.setUserTurnId("turn-1");
    confirmation.noteProfileVerified("conn-confirmed");
    expect(
      planSerenMcpRequest(
        { publishers: {}, ambiguous: { gmail: "Choose an account" } },
        callPublisher({
          publisher: "gmail",
          method: "GET",
          path: "/messages",
          connection_id: "conn-explicit",
        }),
      ),
    ).toMatchObject({
      kind: "publisher",
      connectionId: "conn-explicit",
      selectionWasExplicit: true,
    });

    expect(
      planSerenMcpRequest(
        { publishers: { gmail: "conn-auto" }, ambiguous: {} },
        callPublisher({
          publisher: "gmail",
          tool: "get_profile",
          connection_id: "conn-auto",
          _seren_auto_connection_id: true,
        }),
        confirmation,
      ),
    ).toMatchObject({
      kind: "publisher",
      connectionId: "conn-auto",
      selectionWasExplicit: false,
    });

    expect(
      planSerenMcpRequest(
        { publishers: { gmail: "conn-auto" }, ambiguous: {} },
        callPublisher({
          publisher: "gmail",
          tool: "post_send",
        }),
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });

    expect(
      planSerenMcpRequest(
        { publishers: { gmail: "conn-auto" }, ambiguous: {} },
        callPublisher({
          publisher: "gmail",
          tool: "post_send",
          connection_id: "conn-confirmed",
        }),
        confirmation,
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });

    confirmation.setUserTurnId("turn-2");

    expect(
      planSerenMcpRequest(
        { publishers: {}, ambiguous: {}, available: true },
        callPublisher({
          publisher: "gmail",
          tool: "post_send",
        }),
        confirmation,
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });

    expect(
      planSerenMcpRequest(
        { publishers: { gmail: "conn-auto" }, ambiguous: {} },
        callPublisher({
          publisher: "gmail",
          method: "POST",
          path: "/drafts/draft-safe/send?mode=send",
          connection_id: "conn-confirmed",
        }),
        confirmation,
      ),
    ).toMatchObject({
      kind: "publisher",
      connectionId: "conn-confirmed",
      selectionWasExplicit: true,
    });

    expect(
      planSerenMcpRequest(
        { publishers: {}, ambiguous: { gmail: "Choose an account" } },
        callPublisher({ publisher: "gmail", method: "GET", path: "/messages" }),
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });

    expect(
      planSerenMcpRequest(
        null,
        callPublisher({ publisher: "gmail", method: "GET", path: "/messages" }),
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });

    expect(
      planSerenMcpRequest(
        { publishers: {}, ambiguous: {}, available: false },
        callPublisher({ publisher: "gmail", method: "GET", path: "/messages" }),
      ),
    ).toMatchObject({
      kind: "error",
      response: { result: { isError: true } },
    });
  });

  it("reports a successful explicit account choice for thread persistence", async () => {
    const originalFetch = globalThis.fetch;
    const upstreamFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ emailAddress: "selected@example.test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = upstreamFetch as typeof fetch;
    const onConnectionSelected = vi.fn();
    const proxy = await createSerenMcpOAuthProxy({
      gatewayUrl: "https://mcp.invalid/mcp",
      apiUrl: "https://api.invalid",
      onConnectionSelected,
    });
    proxy.setRouting({
      publishers: { gmail: "conn-default" },
      ambiguous: {},
    });

    try {
      await originalFetch(proxy.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer desktop-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          callPublisher({
            publisher: "gmail",
            tool: "get_profile",
            connection_id: "conn-selected",
          }),
        ),
      });

      expect(onConnectionSelected).toHaveBeenCalledOnce();
      expect(onConnectionSelected).toHaveBeenCalledWith({
        publisher: "gmail",
        connectionId: "conn-selected",
      });
    } finally {
      globalThis.fetch = originalFetch;
      await proxy.close();
    }
  });

  it("blocks a native Gmail send until profile verification is followed by a later human turn", async () => {
    const originalFetch = globalThis.fetch;
    const upstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { body: { emailAddress: "selected@example.test" } },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "message-safe" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    globalThis.fetch = upstreamFetch as typeof fetch;
    const proxy = await createSerenMcpOAuthProxy({
      gatewayUrl: "https://mcp.invalid/mcp",
      apiUrl: "https://api.invalid",
    });
    const call = async (args: Record<string, unknown>) => {
      const response = await originalFetch(proxy.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer desktop-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(callPublisher(args)),
      });
      const event = (await response.text())
        .split("\n")
        .find((line) => line.startsWith("data: "));
      return JSON.parse(event?.slice(6) ?? "null");
    };

    try {
      proxy.setRouting({
        publishers: { gmail: "conn-selected" },
        ambiguous: {},
        accounts: {
          gmail: {
            providerSlug: "google",
            providerName: "Google",
            activeConnectionId: "conn-selected",
            selectionSource: "thread",
            connections: [
              {
                connectionId: "conn-selected",
                label: "selected@example.test",
                isDefault: true,
              },
            ],
          },
        },
        userTurnId: "turn-1",
      });
      const profile = await call({
        publisher: "gmail",
        tool: "get_profile",
        connection_id: "conn-selected",
        tool_args: {},
      });
      const sameTurnSend = await call({
        publisher: "gmail",
        tool: "post_send",
        connection_id: "conn-selected",
        tool_args: {
          to: ["recipient@example.test"],
          subject: "Account confirmation regression",
          body: "Safe test body",
        },
      });

      expect(profile.result.isError).toBe(false);
      expect(sameTurnSend.result.isError).toBe(true);
      expect(upstreamFetch).toHaveBeenCalledTimes(1);

      proxy.setRouting({
        publishers: { gmail: "conn-selected" },
        ambiguous: {},
        userTurnId: "turn-2",
      });
      const laterTurnSend = await call({
        publisher: "gmail",
        tool: "post_send",
        connection_id: "conn-selected",
        tool_args: {
          to: ["recipient@example.test"],
          subject: "Account confirmation regression",
          body: "Safe test body",
        },
      });

      expect(laterTurnSend.result.isError).toBe(false);
      expect(upstreamFetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
      await proxy.close();
    }
  });

  it("leaves unrelated and unselected MCP calls unchanged", () => {
    expect(
      planSerenMcpRequest(
        { publishers: {}, ambiguous: {} },
        callPublisher({
          publisher: "coingecko-serenai",
          method: "GET",
          path: "/ping",
        }),
      ),
    ).toEqual({ kind: "passthrough" });

    expect(
      planSerenMcpRequest(
        { publishers: { gmail: "conn-selected" }, ambiguous: {} },
        { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} },
      ),
    ).toEqual({ kind: "passthrough" });
  });

  it("contains an aborted request body without leaking a runtime rejection", async () => {
    const proxy = await createSerenMcpOAuthProxy({
      gatewayUrl: "https://mcp.invalid/mcp",
      apiUrl: "https://api.invalid",
    });
    const target = new URL(proxy.url);
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(
          Number(target.port),
          target.hostname,
        );
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.write(
            `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Type: application/json\r\nContent-Length: 128\r\n\r\n{`,
            () => {
              socket.destroy();
              resolve();
            },
          );
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await proxy.close();
    }
  });
});
