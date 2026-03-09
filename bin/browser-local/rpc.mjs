// ABOUTME: Minimal JSON-RPC 2.0 router for the browser-local runtime.
// ABOUTME: Dispatches WebSocket method calls to async handlers.

const handlers = new Map();

export function registerHandler(method, handler) {
  handlers.set(method, handler);
}

export async function handleRpcMessage(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  }

  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  if (!request.method || typeof request.method !== "string") {
    if (isNotification) {
      return null;
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid request" },
      id,
    });
  }

  const handler = handlers.get(request.method);
  if (!handler) {
    if (isNotification) {
      return null;
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32601,
        message: `Method not found: ${request.method}`,
      },
      id,
    });
  }

  try {
    const result = await handler(request.params ?? {});
    if (isNotification) {
      return null;
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      result,
      id,
    });
  } catch (error) {
    if (isNotification) {
      return null;
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
      id,
    });
  }
}
