import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  buildSerenPublisherRequest,
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
    ).toMatchObject({ kind: "publisher", connectionId: "conn-explicit" });

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
