import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { API_BASE } from "@/lib/config";
import { getSerenApiKey, isTauriRuntime } from "@/lib/tauri-bridge";
import {
  capSupportPayload,
  redactString,
  redactSupportPayload,
} from "./redact";
import { supportSignature } from "./signature";
import type {
  SupportBuildInfo,
  SupportCaptureInput,
  SupportReportIds,
  SupportReportLogEntry,
  SupportReportPayload,
} from "./types";

const SESSION_ID = buildSessionId();
const LOG_LIMIT = 600;
const LOG_ENTRY_MESSAGE_LIMIT = 4_096;
const SEEN_SIGNATURES_LIMIT = 256;
const HTTP_BODY_CAPTURE_LIMIT = 64 * 1024;
const SIGNATURE_LENGTH = 64;
const ID_LENGTH = 16;
const HEX_PATTERN = /^[0-9a-f]+$/;

// FIFO-evicting set so a long-running session with many distinct errors
// cannot grow this unbounded.
const seenSignatures = new Map<string, true>();
const logSlice: SupportReportLogEntry[] = [];

let installed = false;
type SupportReportingGlobal = typeof globalThis & {
  __serenSupportReportingInstalled?: boolean;
  __serenSupportOriginalError?: typeof console.error;
  __serenSupportOriginalWarn?: typeof console.warn;
};

function supportReportingGlobal(): SupportReportingGlobal {
  return globalThis as SupportReportingGlobal;
}

// Re-entrancy sentinel: when a captureSupportError is in its synchronous
// preamble we suppress recursive captures triggered by the same call stack
// (e.g. a console.error fired by our own redaction code). This is *not* a
// single-flight gate; concurrent unrelated errors continue to be captured
// and dedupe is enforced by `seenSignatures` instead.
let capturing = false;

function buildSessionId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeError(error: unknown): {
  message: string;
  stack: string[];
  kind: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: error.stack ? error.stack.split("\n") : [],
      kind: error.name || "Error",
    };
  }

  if (typeof error === "string") {
    return { message: error, stack: [], kind: "Error" };
  }

  try {
    return { message: JSON.stringify(error), stack: [], kind: "Error" };
  } catch {
    return { message: String(error), stack: [], kind: "Error" };
  }
}

function inferOs(raw: string): SupportReportPayload["os"] {
  const value = raw.toLowerCase();
  if (value.includes("windows") || value.includes("win32")) return "windows";
  if (value.includes("linux")) return "linux";
  return "darwin";
}

function inferArch(raw: string): SupportReportPayload["arch"] {
  return raw.toLowerCase().includes("x86_64") ||
    raw.toLowerCase().includes("x64") ||
    raw.toLowerCase().includes("amd64")
    ? "x86_64"
    : "aarch64";
}

async function getBuildInfo(): Promise<SupportBuildInfo> {
  if (isTauriRuntime()) {
    try {
      return await rawInvoke<SupportBuildInfo>("get_build_info");
    } catch {
      // Fall through to browser defaults.
    }
  }

  return {
    app_version: "dev",
    tauri_version: "unknown",
    os: navigator.platform || "unknown",
  };
}

async function sha256HexPrefix(input: string, length: number): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, length);
  }
  // Last-resort browser fallback (no SubtleCrypto). Not a leak: input is
  // already an opaque session id in this code path.
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(length, "0").slice(0, length);
}

async function getSupportIds(): Promise<SupportReportIds> {
  if (isTauriRuntime()) {
    return rawInvoke<SupportReportIds>("get_support_report_ids", {
      sessionId: SESSION_ID,
    });
  }

  const installKey = "seren_support_install_id";
  let installId = localStorage.getItem(installKey);
  if (!installId || !isValidId(installId)) {
    installId = Math.random()
      .toString(16)
      .slice(2)
      .padEnd(ID_LENGTH, "0")
      .slice(0, ID_LENGTH);
    localStorage.setItem(installKey, installId);
  }
  // Hash the session id rather than slicing raw UUID hex; otherwise the
  // wire field exposes the actual session UUID's first 16 chars.
  const sessionIdHash = await sha256HexPrefix(SESSION_ID, ID_LENGTH);
  return {
    install_id: installId,
    session_id_hash: sessionIdHash,
  };
}

function isValidId(value: string): boolean {
  return value.length === ID_LENGTH && HEX_PATTERN.test(value);
}

function isValidSignature(value: string): boolean {
  return value.length === SIGNATURE_LENGTH && HEX_PATTERN.test(value);
}

function rememberSignature(signature: string): boolean {
  if (seenSignatures.has(signature)) return false;
  seenSignatures.set(signature, true);
  if (seenSignatures.size > SEEN_SIGNATURES_LIMIT) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = seenSignatures.keys().next().value;
    if (oldest !== undefined) seenSignatures.delete(oldest);
  }
  return true;
}

// Test-only hooks. Gated behind `import.meta.env.DEV` so production bundles
// drop the closure (and the off-switch it would otherwise expose to anyone
// with devtools access). Vitest runs with DEV=true so tests still see them.
export const __supportReportingTestHooks = import.meta.env.DEV
  ? {
      rememberSignature,
      seenSignatures: () => [...seenSignatures.keys()],
      reset: () => {
        seenSignatures.clear();
        logSlice.splice(0);
        capturing = false;
        installed = false;

        const supportGlobal = supportReportingGlobal();
        if (supportGlobal.__serenSupportOriginalError) {
          console.error = supportGlobal.__serenSupportOriginalError;
        }
        if (supportGlobal.__serenSupportOriginalWarn) {
          console.warn = supportGlobal.__serenSupportOriginalWarn;
        }
        delete supportGlobal.__serenSupportReportingInstalled;
        delete supportGlobal.__serenSupportOriginalError;
        delete supportGlobal.__serenSupportOriginalWarn;
      },
    }
  : undefined;

export function appendSupportLog(
  level: SupportReportLogEntry["level"],
  module: string,
  message: string,
): void {
  // Cap each entry up front so a single huge log line cannot blow up the
  // ring buffer; the cap pass below trims further as needed.
  const trimmed =
    message.length > LOG_ENTRY_MESSAGE_LIMIT
      ? `${message.slice(0, LOG_ENTRY_MESSAGE_LIMIT)}...[truncated]`
      : message;
  logSlice.push({
    ts: new Date().toISOString(),
    level,
    module,
    message: trimmed,
  });
  if (logSlice.length > LOG_LIMIT) {
    logSlice.splice(0, logSlice.length - LOG_LIMIT);
  }
}

type SubmitOutcome = { status: "ok" } | { status: "failed"; reason: string };

async function submitPayload(
  payload: SupportReportPayload,
): Promise<SubmitOutcome> {
  if (isTauriRuntime()) {
    try {
      await rawInvoke("submit_support_report", { bundle: payload });
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        reason: `tauri-invoke: ${redactString(normalizeError(err).message)}`,
      };
    }
  }

  const apiKey = await getSerenApiKey();
  if (!apiKey) {
    return { status: "failed", reason: "no-api-key" };
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/support/report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      status: "failed",
      reason: `fetch: ${redactString(normalizeError(err).message)}`,
    };
  }

  if (!response.ok) {
    return { status: "failed", reason: `http-${response.status}` };
  }
  return { status: "ok" };
}

/**
 * Log a submit failure in a way that a user or operator can audit later.
 * Uses `console.warn` so it lands in the support log slice (the install
 * hook captures `console.warn` to `appendSupportLog` without recursing
 * into `captureSupportError`, which is reserved for `console.error`).
 * The signature prefix is included so a user reporting "I saw an error
 * but no ticket exists" can correlate with which capture dropped. #1736.
 */
function logSubmitFailure(signature: string, reason: string): void {
  try {
    console.warn(
      `[support-report] submit failed (signature=${signature.slice(0, 8)}, reason=${reason})`,
    );
  } catch {
    // Drop log failures; support reporting must never recurse on itself.
  }
}

export async function captureSupportError(
  input: SupportCaptureInput,
): Promise<void> {
  // Re-entrancy guard: only suppress nested captures on the same synchronous
  // call stack. Concurrent captures from independent stacks are fine; they
  // dedupe by signature below.
  if (capturing) return;
  capturing = true;

  let error: {
    kind: string;
    message: string;
    stack: string[];
  };
  try {
    error = {
      kind: input.kind || "Error",
      message: input.message || "Unknown error",
      stack: input.stack ?? [],
    };
  } finally {
    capturing = false;
  }

  const signature = await supportSignature(error);
  if (!isValidSignature(signature)) return;
  if (!rememberSignature(signature)) return;

  const [ids, build] = await Promise.all([getSupportIds(), getBuildInfo()]);
  const installId = ids.install_id.toLowerCase();
  const sessionIdHash = ids.session_id_hash.toLowerCase();
  if (!isValidId(installId) || !isValidId(sessionIdHash)) {
    // Server would 400 on these; drop the report rather than wasting
    // the four-attempt retry budget.
    return;
  }

  const payload = capSupportPayload(
    redactSupportPayload({
      schema_version: 1,
      signature,
      install_id: installId,
      session_id_hash: sessionIdHash,
      app_version: build.app_version || "unknown",
      tauri_version: build.tauri_version || "unknown",
      os: inferOs(build.os),
      arch: inferArch(build.os),
      timestamp: new Date().toISOString(),
      crash_recovery: false,
      truncated: false,
      error,
      http: input.http,
      log_slice: [...logSlice],
      agent_context: input.agentContext,
    }),
  );

  void submitPayload(payload)
    .then((outcome) => {
      if (outcome.status === "failed") {
        logSubmitFailure(signature, outcome.reason);
      }
    })
    .catch((err) => {
      // submitPayload itself is structured to never throw, but a thrown
      // exception from the surrounding plumbing (e.g. payload serialization
      // edge case) should still be loud, not silent.
      logSubmitFailure(
        signature,
        `unexpected: ${redactString(normalizeError(err).message)}`,
      );
    });
}

export function captureUnknownError(kind: string, error: unknown): void {
  const normalized = normalizeError(error);
  void captureSupportError({
    kind: normalized.kind || kind,
    message: normalized.message,
    stack: normalized.stack,
  });
}

export async function safeInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await rawInvoke<T>(command, args);
  } catch (error) {
    captureUnknownError(`invoke:${command}`, error);
    throw error;
  }
}

export function installSupportReporting(): void {
  if (installed || typeof window === "undefined") return;
  const supportGlobal = supportReportingGlobal();
  if (supportGlobal.__serenSupportReportingInstalled) return;
  installed = true;
  supportGlobal.__serenSupportReportingInstalled = true;
  // Known dev-only artifact: under Vite HMR, a hot-reload produces a fresh
  // module instance whose `seenSignatures` Map is independent of the wrapped
  // console (which still closes over the previous instance's Map). Direct
  // calls to `captureSupportError` from the new instance therefore dedupe
  // against a different Map than console.error captures, so the same error
  // can be reported twice during a long Vite session. Production has no HMR
  // so this is harmless there; intentionally not refactored to avoid
  // wrapper indirection.

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  supportGlobal.__serenSupportOriginalError = originalError;
  supportGlobal.__serenSupportOriginalWarn = originalWarn;

  console.error = (...args: unknown[]) => {
    originalError(...args);
    const message = args.map(String).join(" ");
    appendSupportLog("ERROR", "console", message);
    // Only forward to the support pipeline when this looks like a real
    // exception (Error instance or something with a stack). Lots of code
    // uses `console.error` for non-fatal warnings (e.g. "failed to connect
    // to local provider") and we don't want every such log to become a
    // public GitHub issue.
    const candidate = args.find(
      (arg) =>
        arg instanceof Error ||
        (typeof arg === "object" && arg !== null && "stack" in arg),
    );
    if (!candidate) return;
    const normalized = normalizeError(candidate);
    void captureSupportError({
      kind: normalized.kind || "console.error",
      message: normalized.message,
      stack: normalized.stack,
    });
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    appendSupportLog("WARN", "console", args.map(String).join(" "));
  };

  window.addEventListener("error", (event) => {
    const normalized = normalizeError(event.error ?? event.message);
    void captureSupportError({
      kind: normalized.kind || "window.onerror",
      message: normalized.message,
      stack: normalized.stack,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    captureUnknownError("unhandledrejection", event.reason);
  });

  if (isTauriRuntime()) {
    void listen<SupportReportPayload>("panic-report", (event) => {
      const payload = event.payload;
      if (isValidSignature(payload.signature)) {
        rememberSignature(payload.signature);
      }
    }).catch(() => {});

    void rawInvoke("sweep_support_crash_reports").catch(() => {});
  }
}

export async function captureHttpFailure(
  request: Request,
  response: Response,
): Promise<void> {
  if (response.status < 400) return;
  // Never report failures from the support endpoint itself; otherwise a
  // server-side outage would create an unbounded retry storm.
  if (request.url.includes("/support/report")) return;

  let body: string | undefined;
  try {
    const raw = await response.clone().text();
    body =
      raw.length > HTTP_BODY_CAPTURE_LIMIT
        ? `${raw.slice(0, HTTP_BODY_CAPTURE_LIMIT)}...[truncated]`
        : raw;
  } catch {
    body = undefined;
  }

  await captureSupportError({
    kind: "http_error",
    message: `${request.method} ${request.url} returned ${response.status}`,
    stack: [],
    http: {
      method: request.method,
      url: request.url,
      status: response.status,
      body,
    },
  });
}
