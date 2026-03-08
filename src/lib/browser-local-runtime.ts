// ABOUTME: Local provider runtime client for desktop-native and browser-local modes.
// ABOUTME: Connects to the localhost JSON-RPC bridge for provider agents and optional local file access.

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

interface DesktopRuntimeConfig {
  host: string;
  port: number;
  token: string;
  apiBaseUrl: string;
  wsBaseUrl: string;
}

interface LocalRuntimeConnectionConfig {
  mode: string;
  apiBaseUrl: string;
  wsBaseUrl: string;
  token?: string;
  localProjectRoot?: string | null;
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
let runtimeConfigPromise: Promise<LocalRuntimeConnectionConfig> | null = null;
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

function isDesktopNativeRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

function getInjectedApiBaseUrl(): string {
  const config = getInjectedConfig();
  return config?.apiBaseUrl ?? window.location.origin;
}

function getInjectedWsBaseUrl(): string {
  const config = getInjectedConfig();
  return config?.wsBaseUrl ?? getInjectedApiBaseUrl().replace(/^http/i, "ws");
}

export function isBrowserLocalRuntime(): boolean {
  return getInjectedConfig()?.mode === "browser-local";
}

export function isLocalProviderRuntime(): boolean {
  return isBrowserLocalRuntime() || isDesktopNativeRuntime();
}

export function getLocalProviderProjectRoot(): string | null {
  return getInjectedConfig()?.localProjectRoot ?? null;
}

async function fetchRuntimeHealth(apiBaseUrl: string): Promise<RuntimeHealth> {
  const response = await fetch(`${apiBaseUrl}/__seren/health`, {
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

async function loadDesktopRuntimeConfig(): Promise<LocalRuntimeConnectionConfig> {
  const { invoke } = await import("@tauri-apps/api/core");
  const config = await invoke<DesktopRuntimeConfig>("provider_runtime_get_config");
  return {
    mode: "desktop-native",
    apiBaseUrl: config.apiBaseUrl,
    wsBaseUrl: config.wsBaseUrl,
    token: config.token,
  };
}

async function getLocalRuntimeConfig(): Promise<LocalRuntimeConnectionConfig> {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = (async () => {
      if (isBrowserLocalRuntime()) {
        return {
          mode: "browser-local",
          apiBaseUrl: getInjectedApiBaseUrl(),
          wsBaseUrl: getInjectedWsBaseUrl(),
          localProjectRoot: getLocalProviderProjectRoot(),
        };
      }

      if (isDesktopNativeRuntime()) {
        return loadDesktopRuntimeConfig();
      }

      throw new Error("Local provider runtime is not configured.");
    })();
  }

  return runtimeConfigPromise;
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

async function openAndAuthenticateSocket(
  wsBaseUrl: string,
  token: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsBaseUrl);
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
      fail(new Error("Timed out connecting to local provider runtime."));
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
        reject(new Error("Local provider runtime connection closed."));
        return;
      }
      rejectPendingRpc(new Error("Local provider runtime connection closed."));
    });

    ws.addEventListener("error", () => {
      fail(new Error("Failed to connect to local provider runtime."));
    });
  });
}

export async function connectLocalProviderRuntime(): Promise<void> {
  if (!isLocalProviderRuntime()) {
    return;
  }

  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      const config = await getLocalRuntimeConfig();
      let token = config.token;

      if (!token) {
        const health = await fetchRuntimeHealth(config.apiBaseUrl);
        if (!health.ok || !health.token) {
          throw new Error(
            "Local provider runtime did not return an auth token.",
          );
        }
        token = health.token;
      }

      await openAndAuthenticateSocket(config.wsBaseUrl, token);
    })()
      .catch((error) => {
        runtimeConfigPromise = null;
        throw error;
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  await connectPromise;
}

export function disconnectLocalProviderRuntime(): void {
  if (socket) {
    socket.close();
  }
  connectPromise = null;
  runtimeConfigPromise = null;
  socket = null;
  rejectPendingRpc(new Error("Local provider runtime disconnected."));
}

export async function runtimeInvoke<T>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number | null },
): Promise<T> {
  await connectLocalProviderRuntime();

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("Local provider runtime is not connected.");
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
  if (isLocalProviderRuntime()) {
    void connectLocalProviderRuntime().catch((error) => {
      console.warn(
        `[local-provider-runtime] Failed to establish event connection for ${event}:`,
        error,
      );
    });
  }

  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}
