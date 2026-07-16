// ABOUTME: Per-Codex-session loopback proxy for deterministic Seren OAuth account routing.
// ABOUTME: Forwards MCP traffic unchanged except selected call_publisher requests, which use the supported Core selector header.

import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_SEREN_MCP_GATEWAY_URL =
  process.env.SEREN_MCP_GATEWAY_URL ?? "https://mcp.serendb.com/mcp";
const DEFAULT_SEREN_API_URL =
  process.env.SEREN_API_BASE ??
  process.env.SEREN_API_URL ??
  process.env.VITE_SEREN_API_URL ??
  "https://api.serendb.com";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PROTECTED_PUBLISHER_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "cookie",
  "mcp-protocol-version",
  "mcp-session-id",
  "x-seren-oauth-connection-id",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toolError(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
}

/**
 * Decide whether a Seren MCP request can pass through unchanged, must fail
 * closed, or should use the first-party publisher proxy with an OAuth selector.
 */
export function planSerenMcpRequest(routing, payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.method !== "tools/call" ||
    payload.params?.name !== "call_publisher"
  ) {
    return { kind: "passthrough" };
  }

  const args = payload.params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { kind: "passthrough" };
  }

  const publisher = nonEmptyString(args.publisher);
  if (!publisher) return { kind: "passthrough" };

  const explicitConnectionId = nonEmptyString(args.connection_id);
  if (!explicitConnectionId && routing == null) {
    return {
      kind: "error",
      response: toolError(
        payload.id,
        "OAuth account routing is still initializing. Retry this publisher call after connected accounts finish loading.",
      ),
    };
  }

  if (!explicitConnectionId && routing?.available === false) {
    return {
      kind: "error",
      response: toolError(
        payload.id,
        "OAuth account routing is unavailable. Retry after connected accounts finish loading; refusing to use a default account.",
      ),
    };
  }

  const ambiguity = explicitConnectionId
    ? null
    : nonEmptyString(routing?.ambiguous?.[publisher]);
  if (ambiguity) {
    return {
      kind: "error",
      response: toolError(payload.id, ambiguity),
    };
  }

  const connectionId =
    explicitConnectionId ?? nonEmptyString(routing?.publishers?.[publisher]);
  if (!connectionId) return { kind: "passthrough" };

  const tool = nonEmptyString(args.tool);
  if (tool) {
    return {
      kind: "publisher",
      id: payload.id,
      connectionId,
      publisher,
      request: {
        kind: "tool",
        tool,
        toolArgs:
          args.tool_args &&
          typeof args.tool_args === "object" &&
          !Array.isArray(args.tool_args)
            ? args.tool_args
            : {},
        headers: args.headers,
        requestId: args.request_id,
        payment: args._x402_payment,
        confirm: args.confirm,
      },
    };
  }

  const method = nonEmptyString(args.method) ?? "POST";
  const path = nonEmptyString(args.path);
  if (path) {
    return {
      kind: "publisher",
      id: payload.id,
      connectionId,
      publisher,
      request: {
        kind: "api",
        method,
        path,
        body: args.body,
        bodyBase64: args.body_base64,
        headers: args.headers,
        requestId: args.request_id,
        payment: args._x402_payment,
        confirm: args.confirm,
      },
    };
  }

  return {
    kind: "error",
    response: toolError(
      payload.id,
      `Selected-account routing for ${publisher} requires a publisher API path or tool name; refusing to fall back to the default account.`,
    ),
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildPublisherUrl(apiUrl, plan) {
  const base = new URL(ensureTrailingSlash(apiUrl));
  const publisherRoot = new URL(
    `publishers/${encodeURIComponent(plan.publisher)}/`,
    base,
  );
  const relativePath =
    plan.request.kind === "tool"
      ? `_mcp/tools/${encodeURIComponent(plan.request.tool)}`
      : plan.request.path.replace(/^\/+/, "");
  const target = new URL(relativePath, publisherRoot);

  if (
    target.origin !== publisherRoot.origin ||
    !target.pathname.startsWith(publisherRoot.pathname)
  ) {
    throw new Error("Publisher path escapes the configured Seren API route");
  }

  // The selector belongs in the ownership-checked header. Ignore any
  // model-provided query selector so two conflicting identities cannot exist.
  target.searchParams.delete("connection_id");
  target.hash = "";
  return target;
}

function copyPublisherHeaders(source, destination) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [name, value] of Object.entries(source)) {
    if (
      typeof value === "string" &&
      !PROTECTED_PUBLISHER_HEADERS.has(name.toLowerCase())
    ) {
      destination.set(name, value);
    }
  }
}

function buildPublisherBody(request, headers) {
  if (request.kind === "tool") {
    headers.set("Content-Type", "application/json");
    return JSON.stringify(request.toolArgs);
  }

  if (request.bodyBase64 != null && request.body != null) {
    throw new Error("body and body_base64 are mutually exclusive");
  }
  if (request.bodyBase64 != null) {
    const encoded = nonEmptyString(request.bodyBase64);
    if (!encoded) throw new Error("body_base64 must be a non-empty string");
    return Buffer.from(encoded, "base64");
  }
  if (request.body === undefined || request.body === null) return undefined;

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(request.body);
}

function textResponseBody(response, bytes) {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.length === 0
  ) {
    return bytes.toString("utf8");
  }
  return JSON.stringify({
    data: {
      status: response.status,
      body_base64: bytes.toString("base64"),
      response_bytes: bytes.length,
    },
  });
}

export function buildSerenPublisherRequest(plan, authorization, apiUrl) {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: authorization,
    "User-Agent": "Seren-Desktop-Codex-OAuth-Router",
    "x-seren-oauth-connection-id": plan.connectionId,
  });

  const target = buildPublisherUrl(apiUrl, plan);
  copyPublisherHeaders(plan.request.headers, headers);
  if (nonEmptyString(plan.request.requestId)) {
    headers.set("Idempotency-Key", plan.request.requestId.trim());
  }
  if (nonEmptyString(plan.request.payment)) {
    headers.set("X-PAYMENT", plan.request.payment.trim());
  }
  const body = buildPublisherBody(plan.request, headers);

  const method =
    plan.request.kind === "tool" ? "POST" : plan.request.method.toUpperCase();
  if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
    throw new Error(
      `Unsupported publisher HTTP method for selected-account routing: ${method}`,
    );
  }

  return { body, headers, method, url: target.toString() };
}

async function executePublisherPlan(plan, authorization, apiUrl, signal) {
  if (!authorization) {
    return toolError(plan.id, "Seren API authorization is unavailable.");
  }
  if (plan.request.confirm === true) {
    return toolError(
      plan.id,
      "Selected-account routing cannot safely confirm an x402 payment on this path.",
    );
  }

  let publisherRequest;
  try {
    publisherRequest = buildSerenPublisherRequest(
      plan,
      authorization,
      apiUrl,
    );
  } catch (error) {
    return toolError(
      plan.id,
      `Selected-account publisher request is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const response = await fetch(publisherRequest.url, {
      method: publisherRequest.method,
      headers: publisherRequest.headers,
      body:
        publisherRequest.method === "GET"
          ? undefined
          : publisherRequest.body,
      redirect: "manual",
      signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text =
      textResponseBody(response, bytes) ||
      JSON.stringify({ data: { status: response.status } });
    return {
      jsonrpc: "2.0",
      id: plan.id,
      result: {
        content: [{ type: "text", text }],
        isError: !response.ok,
      },
    };
  } catch {
    return toolError(
      plan.id,
      "Selected-account publisher request failed before Seren returned a response.",
    );
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function copyForwardRequestHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value == null) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // Node fetch transparently decodes compressed responses. Ask the upstream
  // for identity encoding so relayed bytes always match relayed headers.
  headers.set("Accept-Encoding", "identity");
  return headers;
}

function copyForwardResponseHeaders(response, outgoing) {
  for (const [name, value] of response.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      outgoing.setHeader(name, value);
    }
  }
}

async function forwardMcpRequest({
  request,
  response,
  body,
  gatewayUrl,
  localUrl,
  controllers,
}) {
  const target = new URL(gatewayUrl);
  target.search = localUrl.search;
  const controller = new AbortController();
  controllers.add(controller);
  request.once("aborted", () => controller.abort());
  response.once("close", () => controller.abort());

  try {
    const method = request.method ?? "GET";
    const upstream = await fetch(target, {
      method,
      headers: copyForwardRequestHeaders(request.headers),
      body:
        method === "GET" || method === "HEAD" || body.length === 0
          ? undefined
          : body,
      redirect: "manual",
      signal: controller.signal,
    });
    response.statusCode = upstream.status;
    copyForwardResponseHeaders(upstream, response);
    if (!upstream.body) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json" });
    }
    response.end(
      JSON.stringify({
        error: "seren_mcp_proxy_failure",
        message: "Seren MCP gateway request failed",
      }),
    );
  } finally {
    controllers.delete(controller);
  }
}

function sendLocalMcpResponse(response, payload) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream",
  });
  response.end(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendLocalProxyFailure(request, response) {
  if (request.aborted || response.destroyed) return;
  try {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json" });
    }
    response.end(
      JSON.stringify({
        error: "seren_mcp_proxy_failure",
        message: "Seren MCP proxy could not process the request",
      }),
    );
  } catch {
    response.destroy();
  }
}

export async function createSerenMcpOAuthProxy({
  gatewayUrl = DEFAULT_SEREN_MCP_GATEWAY_URL,
  apiUrl = DEFAULT_SEREN_API_URL,
} = {}) {
  const gateway = new URL(gatewayUrl);
  const api = new URL(apiUrl);
  if (gateway.protocol !== "https:" || api.protocol !== "https:") {
    throw new Error("Seren OAuth routing proxy requires HTTPS upstreams");
  }

  let routing = null;
  let closed = false;
  const routePath = `/${randomBytes(24).toString("hex")}/mcp`;
  const controllers = new Set();
  const sockets = new Set();

  const handleRequest = async (request, response) => {
    const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (closed || localUrl.pathname !== routePath) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const body = await readRequestBody(request);
    if ((request.method ?? "GET") === "POST" && body.length > 0) {
      let payload = null;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        // Let the upstream MCP server return the protocol parse error.
      }
      const plan = planSerenMcpRequest(routing, payload);
      if (plan.kind === "error") {
        sendLocalMcpResponse(response, plan.response);
        return;
      }
      if (plan.kind === "publisher") {
        const controller = new AbortController();
        controllers.add(controller);
        request.once("aborted", () => controller.abort());
        response.once("close", () => controller.abort());
        try {
          const routedResponse = await executePublisherPlan(
            plan,
            nonEmptyString(request.headers.authorization),
            api.toString(),
            controller.signal,
          );
          if (!response.destroyed) {
            sendLocalMcpResponse(response, routedResponse);
          }
        } finally {
          controllers.delete(controller);
        }
        return;
      }
    }

    await forwardMcpRequest({
      request,
      response,
      body,
      gatewayUrl: gateway.toString(),
      localUrl,
      controllers,
    });
  };

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      sendLocalProxyFailure(request, response);
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Seren OAuth routing proxy did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}${routePath}`,
    setRouting(nextRouting) {
      routing = {
        publishers: { ...(nextRouting?.publishers ?? {}) },
        ambiguous: { ...(nextRouting?.ambiguous ?? {}) },
        available: nextRouting?.available,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
