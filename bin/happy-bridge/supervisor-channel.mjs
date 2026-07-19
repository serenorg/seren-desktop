// ABOUTME: Provides the bridge-side newline JSON-RPC client for Rust bookkeeping.
// ABOUTME: It carries no provider or relay payloads and keeps calls correlated.

const MAX_LINE_BYTES = 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;

/**
 * @param {{write?: (line: string) => void, timeoutMs?: number}} options
 */
export function createSupervisorChannel({
  write = (line) => process.stdout.write(`${line}\n`),
  timeoutMs = RPC_TIMEOUT_MS,
} = {}) {
  let nextId = 0;
  const pending = new Map();
  const notificationListeners = new Set();

  function handleLine(line) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return;

    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }

    if (response?.id === undefined || response?.id === null) {
      if (typeof response?.method === "string") {
        for (const listener of notificationListeners) {
          listener(response.method, response.params ?? {});
        }
      }
      return;
    }
    const request = pending.get(response.id);
    if (!request) return;

    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) {
      request.reject(new Error(response.error.message ?? "supervisor RPC failed"));
    } else {
      request.resolve(response.result);
    }
  }

  function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("supervisor RPC timed out"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  function notify(method, params = {}) {
    write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  function onNotification(listener) {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  }

  function close() {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("supervisor channel closed"));
    }
    pending.clear();
    notificationListeners.clear();
  }

  return { call, close, handleLine, notify, onNotification };
}
