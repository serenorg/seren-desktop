// ABOUTME: Shared fetch resolution for Tauri and browser runtimes.
// ABOUTME: Routes Seren Gateway API traffic through Rust in Tauri to avoid webview CORS.

import { API_BASE } from "./config";
import { isTauriRuntime } from "./tauri-bridge";

type TauriFetch = typeof globalThis.fetch;
type UnlistenFn = () => void;

interface GatewayHttpRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface GatewayHttpResponseMeta {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

interface GatewayHttpEvent {
  requestId: string;
  eventType: "chunk" | "end" | "error";
  chunkBase64?: string | null;
  error?: string | null;
}

let cached: TauriFetch | null = null;
const GATEWAY_API_ORIGIN = new URL(API_BASE).origin;
const GATEWAY_HTTP_EVENT = "gateway-http://event";

function createAbortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    return new Error("The operation was aborted.");
  }
}

function decodeBase64Chunk(base64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Vitest/Node fallback
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function buildGatewayRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `gateway-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isGatewayApiRequest(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  try {
    return new URL(raw, API_BASE).origin === GATEWAY_API_ORIGIN;
  } catch {
    return false;
  }
}

export function shouldUseRustGatewayBridge(input: RequestInfo | URL): boolean {
  return isTauriRuntime() && isGatewayApiRequest(input);
}

export function shouldUseRustGatewayAuth(input: RequestInfo | URL): boolean {
  return shouldUseRustGatewayBridge(input) && !shouldSkipRefresh(input);
}

async function cancelGatewayHttpRequest(requestId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("gateway_http_cancel", { requestId });
}

async function serializeGatewayRequest(
  request: Request,
  requestId: string,
): Promise<GatewayHttpRequest> {
  const headers: Record<string, string> = {};

  for (const [name, value] of request.headers.entries()) {
    if (name.toLowerCase() === "authorization") {
      continue;
    }
    headers[name] = value;
  }

  const rawBody =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.clone().text();

  return {
    requestId,
    url: request.url,
    method: request.method,
    headers,
    body: rawBody && rawBody.length > 0 ? rawBody : null,
  };
}

async function gatewayFetch(request: Request): Promise<Response> {
  const requestId = buildGatewayRequestId();
  const abortError = createAbortError();
  const payload = await serializeGatewayRequest(request, requestId);
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let cleanedUp = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let rejectResponse: ((reason?: unknown) => void) | null = null;

  const unlistenPromise = listen<GatewayHttpEvent>(GATEWAY_HTTP_EVENT, (event) => {
    const payload = event.payload;
    if (payload.requestId !== requestId || !controllerRef) {
      return;
    }

    if (payload.eventType === "chunk" && payload.chunkBase64) {
      controllerRef.enqueue(decodeBase64Chunk(payload.chunkBase64));
      return;
    }

    if (payload.eventType === "error") {
      const error = new Error(payload.error || "Gateway request failed");
      cleanup();
      controllerRef.error(error);
      return;
    }

    if (payload.eventType === "end") {
      cleanup();
      controllerRef.close();
    }
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void unlistenPromise
      .then((unlisten: UnlistenFn) => unlisten())
      .catch(() => {});
    request.signal?.removeEventListener("abort", onAbort);
  };

  const onAbort = () => {
    void cancelGatewayHttpRequest(requestId).catch(() => {});
    cleanup();
    if (controllerRef) {
      try {
        controllerRef.error(abortError);
      } catch {
        // Stream already closed
      }
    } else if (rejectResponse) {
      rejectResponse(abortError);
    }
  };

  if (request.signal?.aborted) {
    throw abortError;
  }

  request.signal?.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      cleanup();
      void cancelGatewayHttpRequest(requestId).catch(() => {});
    },
  });

  const responseMeta = await new Promise<GatewayHttpResponseMeta>(
    (resolve, reject) => {
      rejectResponse = reject;
      void invoke<GatewayHttpResponseMeta>("gateway_http_start", { request: payload })
        .then(resolve)
        .catch((error) => {
          cleanup();
          reject(error);
        });
    },
  );
  rejectResponse = null;

  return new Response(body, {
    status: responseMeta.status,
    statusText: responseMeta.statusText,
    headers: responseMeta.headers,
  });
}

/**
 * Get the appropriate fetch function for the current environment.
 * Uses the Rust Gateway bridge for api.serendb.com requests in Tauri,
 * Tauri HTTP plugin for other network requests, and browser fetch otherwise.
 * Caches the result after first resolution.
 */
export async function getTauriFetch(): Promise<TauriFetch> {
  if (!isTauriRuntime()) {
    return globalThis.fetch;
  }

  if (cached) {
    return cached;
  }

  let fallbackFetch: TauriFetch = globalThis.fetch;

  try {
    const mod = await import("@tauri-apps/plugin-http");
    fallbackFetch = mod.fetch as TauriFetch;
  } catch {
    // Keep the Rust bridge active for Gateway requests even when the HTTP
    // plugin is unavailable. Only non-Gateway traffic falls back to window.fetch.
  }

  cached = (async (input, init) => {
    const request = new Request(input, init);
    if (shouldUseRustGatewayBridge(request)) {
      return gatewayFetch(request);
    }
    return fallbackFetch(request);
  }) as TauriFetch;

  return cached;
}

/**
 * Auth endpoints that should never trigger 401 auto-refresh (to avoid loops).
 */
const NO_REFRESH_PATHS = ["/auth/login", "/auth/refresh", "/auth/signup"];

/**
 * Check if a request URL targets an auth endpoint that should skip refresh.
 * Uses pathname matching rather than substring to avoid false positives
 * (e.g. a URL containing "auth/refresh" in a query parameter).
 */
export function shouldSkipRefresh(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  try {
    // Parse with a base so relative URLs are handled deterministically.
    const { pathname } = new URL(raw, "http://localhost");
    const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
    return NO_REFRESH_PATHS.some((p) => normalizedPathname.endsWith(p));
  } catch {
    // Last-resort fallback for malformed input: inspect only the path segment.
    const pathOnly = raw.split(/[?#]/, 1)[0] ?? raw;
    const normalizedPathname = pathOnly.replace(/\/+$/, "") || "/";
    return NO_REFRESH_PATHS.some((p) => normalizedPathname.endsWith(p));
  }
}
