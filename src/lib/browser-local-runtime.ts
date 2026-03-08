// ABOUTME: Browser-local runtime client for the localhost launcher.
// ABOUTME: Connects to the bundled WebSocket JSON-RPC bridge for provider agents and local file access.

import type { SerenRuntimeConfig } from "@/lib/runtime";

declare global {
  interface Window {
    __SEREN_RUNTIME_CONFIG__?: Partial<SerenRuntimeConfig>;
  }
}

interface RuntimeHealth {
  ok: boolean;
  mode: string;
  token?: string;
  projectRoot?: string | null;
}

interface JsonRpcSuccess {
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

let socket: WebSocket | null = null;
let connectPromise: Promise<void> | null = null;
let rpcId = 0;

const pendingRpc = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }
>();

const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

function getInjectedConfig() {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.__SEREN_RUNTIME_CONFIG__;
}

function getApiBaseUrl(): string {
  const config = getInjectedConfig();
  return config?.apiBaseUrl ?? window.location.origin;
}

function getWsBaseUrl(): string {
  const config = getInjectedConfig();
  if (config?.wsBaseUrl) {
    return config.wsBaseUrl;
  }
  return getApiBaseUrl().replace(/^http/i, "ws");
}

export function isBrowserLocalRuntime(): boolean {
  return getInjectedConfig()?.mode === "browser-local";
}

export function getBrowserLocalProjectRoot(): string | null {
  return getInjectedConfig()?.localProjectRoot ?? null;
}

async function fetchRuntimeHealth(): Promise<RuntimeHealth> {
  const response = await fetch(`${getApiBaseUrl()}/__seren/health`, {
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(
      `Browser-local runtime health check failed: ${response.status}`,
    );
  }

  return response.json() as Promise<RuntimeHealth>;
}

function rejectPendingRpc(error: Error): void {
  for (const [, pending] of pendingRpc) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.reject(error);
  }
  pendingRpc.clear();
}

async function openAndAuthenticateSocket(token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(getWsBaseUrl());
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore close errors while failing connect
      }
      reject(error);
    };

    const authId = ++rpcId;
    const authTimer = setTimeout(() => {
      fail(new Error("Timed out connecting to browser-local runtime."));
    }, 5_000);

    const cleanupPending = () => {
      const pending = pendingRpc.get(authId);
      if (pending?.timer) {
        clearTimeout(pending.timer);
      }
      pendingRpc.delete(authId);
      clearTimeout(authTimer);
    };

    ws.addEventListener("open", () => {
      pendingRpc.set(authId, {
        resolve: () => {
          cleanupPending();
          if (settled) return;
          settled = true;
          socket = ws;
          resolve();
        },
        reject: (error) => {
          cleanupPending();
          fail(error);
        },
        timer: null,
      });

      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "auth",
          params: { token },
          id: authId,
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      let payload: JsonRpcSuccess;
      try {
        payload = JSON.parse(String(event.data)) as JsonRpcSuccess;
      } catch {
        return;
      }

      if (payload.id != null && pendingRpc.has(Number(payload.id))) {
        const pending = pendingRpc.get(Number(payload.id));
        if (!pending) return;
        pendingRpc.delete(Number(payload.id));
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (payload.error?.message) {
          pending.reject(new Error(payload.error.message));
        } else {
          pending.resolve(payload.result);
        }
        return;
      }

      if (payload.method) {
        const listeners = eventListeners.get(payload.method);
        if (!listeners) return;
        for (const listener of listeners) {
          listener(payload.params);
        }
      }
    });

    ws.addEventListener("close", () => {
      if (socket === ws) {
        socket = null;
      }
      if (!settled) {
        cleanupPending();
        reject(new Error("Browser-local runtime connection closed."));
        return;
      }
      rejectPendingRpc(new Error("Browser-local runtime connection closed."));
    });

    ws.addEventListener("error", () => {
      fail(new Error("Failed to connect to browser-local runtime."));
    });
  });
}

export async function connectBrowserLocalRuntime(): Promise<void> {
  if (!isBrowserLocalRuntime()) {
    return;
  }

  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      const health = await fetchRuntimeHealth();
      if (!health.ok || !health.token) {
        throw new Error("Browser-local runtime did not return an auth token.");
      }
      await openAndAuthenticateSocket(health.token);
    })().finally(() => {
      connectPromise = null;
    });
  }

  await connectPromise;
}

export function disconnectBrowserLocalRuntime(): void {
  if (socket) {
    socket.close();
  }
  socket = null;
  rejectPendingRpc(new Error("Browser-local runtime disconnected."));
}

export async function runtimeInvoke<T>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number | null },
): Promise<T> {
  await connectBrowserLocalRuntime();

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Browser-local runtime is not connected.");
  }

  const activeSocket = socket;

  const id = ++rpcId;
  const timeoutMs =
    options?.timeoutMs === undefined
      ? DEFAULT_RPC_TIMEOUT_MS
      : options.timeoutMs;

  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(() => {
            pendingRpc.delete(id);
            reject(new Error(`Runtime RPC timed out: ${method}`));
          }, timeoutMs);

    pendingRpc.set(id, {
      resolve: (value) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value as T);
      },
      reject: (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      },
      timer,
    });

    activeSocket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? {},
      }),
    );
  });
}

export function onRuntimeEvent(
  event: string,
  callback: (payload: unknown) => void,
): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }

  eventListeners.get(event)?.add(callback);
  if (isBrowserLocalRuntime()) {
    void connectBrowserLocalRuntime().catch((error) => {
      console.warn(
        `[browser-local-runtime] Failed to establish event connection for ${event}:`,
        error,
      );
    });
  }

  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}
