// ABOUTME: Runtime invocation for deployed employee agents via the seren-cloud SDK.
// ABOUTME: POSTs a run, streams events via SSE (with poll fallback), returns the reply.

import {
  type CloudRunOutputEventEnvelope,
  serenCloudDeploymentRun,
  serenCloudDeploymentRunCancel,
  serenCloudDeploymentRunStream,
  serenCloudRun,
} from "@/api/seren-cloud";

interface ActiveRun {
  controller: AbortController;
  deploymentId: string;
  runId: string | null;
}

/**
 * In-flight employee runs keyed by the desktop conversation_id. Lets the
 * orchestrator's cancel button reach into a running turn, abort the local
 * stream/poll, and tell the cloud runtime to stop.
 */
const activeRuns = new Map<string, ActiveRun>();

/**
 * Abort the in-flight employee run for `conversationId` (if any) and ask
 * the cloud runtime to cancel it. Safe to call when no run is active.
 */
export async function cancelEmployeeRun(conversationId: string): Promise<void> {
  const active = activeRuns.get(conversationId);
  if (!active) return;
  active.controller.abort();
  if (active.runId) {
    try {
      await serenCloudDeploymentRunCancel({
        path: { id: active.deploymentId, run_id: active.runId },
        throwOnError: false,
      });
    } catch {
      // The local abort already stopped consumers; a network failure on
      // the runtime-side cancel is acceptable.
    }
  }
}

const POLL_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const STREAM_MAX_RETRY_ATTEMPTS = 1;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "timeout",
  "blocked",
  "error",
  "awaiting_approval",
]);

const FAILURE_STATUSES = new Set([
  "failed",
  "cancelled",
  "canceled",
  "timeout",
  "blocked",
  "error",
]);

export interface RunResult {
  text: string;
  status: string;
  runId: string | null;
  thinking: string | null;
  errorMessage: string | null;
}

function asMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
    if (typeof obj.error === "string") return obj.error;
  }
  return fallback;
}

function fallbackTextFromResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.output === "string") return obj.output;
  }
  return "";
}

function abortableDelay(ms: number, signal: AbortSignal | undefined) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RunCallbacks {
  /** Called for each text token streamed from the runtime. */
  onText?: (chunk: string) => void;
  /** Called for each thinking-trace token streamed from the runtime. */
  onThinking?: (chunk: string) => void;
}

export interface RunOptions extends RunCallbacks {
  signal?: AbortSignal;
  /**
   * Stable desktop-side conversation identifier. Forwarded to the runtime
   * as `conversation_id` so a deployed agent can correlate turns into a
   * single session and answer with multi-turn context. The seren-cloud
   * run-request schema explicitly accepts additional JSON fields.
   */
  conversationId?: string;
}

function applyEnvelope(
  raw: unknown,
  state: { text: string; thinking: string; errorMessage: string | null },
  callbacks: RunCallbacks,
): void {
  if (!raw || typeof raw !== "object") return;
  const ev = raw as CloudRunOutputEventEnvelope;
  switch (ev.type) {
    case "text":
      if (typeof ev.text === "string" && ev.text.length > 0) {
        state.text += ev.text;
        callbacks.onText?.(ev.text);
      }
      break;
    case "thinking":
      if (typeof ev.text === "string" && ev.text.length > 0) {
        state.thinking += ev.text;
        callbacks.onThinking?.(ev.text);
      }
      break;
    case "error":
      if (typeof ev.message === "string" && !state.errorMessage) {
        state.errorMessage = ev.message;
      }
      break;
    default:
      break;
  }
}

async function pollUntilTerminal(
  deploymentId: string,
  runId: string,
  signal: AbortSignal | undefined,
  state: { text: string; thinking: string; errorMessage: string | null },
  callbacks: RunCallbacks,
  startedAt: number,
): Promise<{
  status: string;
  statusMessage: string | null;
  output: string | null;
}> {
  while (true) {
    signal?.throwIfAborted();
    const r = await serenCloudDeploymentRun({
      path: { id: deploymentId, run_id: runId },
      throwOnError: false,
    });
    if (r.error || !r.data?.data) {
      throw new Error(
        `Failed to read run ${runId}: ${asMessage(
          r.error,
          "missing run data",
        )}`,
      );
    }
    const event = r.data.data;
    if (TERMINAL_STATUSES.has(event.status)) {
      // Replay any events the caller has not seen yet (because we fell
      // back to polling without ever opening the stream, or because the
      // stream dropped before terminal). Only emit a diff when the
      // persisted text starts with what we already streamed; if the server
      // dedupes/reorders tokens differently from the live stream, trust
      // the streamed state rather than splicing a non-prefix tail that
      // would garble the displayed reply.
      const recovered = { text: "", thinking: "", errorMessage: null } as {
        text: string;
        thinking: string;
        errorMessage: string | null;
      };
      if (Array.isArray(event.output_events)) {
        for (const raw of event.output_events) {
          applyEnvelope(raw, recovered, {});
        }
      }
      if (
        recovered.text.length > state.text.length &&
        recovered.text.startsWith(state.text)
      ) {
        const diff = recovered.text.slice(state.text.length);
        state.text = recovered.text;
        callbacks.onText?.(diff);
      }
      if (
        recovered.thinking.length > state.thinking.length &&
        recovered.thinking.startsWith(state.thinking)
      ) {
        const diff = recovered.thinking.slice(state.thinking.length);
        state.thinking = recovered.thinking;
        callbacks.onThinking?.(diff);
      }
      if (recovered.errorMessage && !state.errorMessage) {
        state.errorMessage = recovered.errorMessage;
      }
      return {
        status: event.status,
        statusMessage: event.status_message ?? null,
        output: event.output ?? null,
      };
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(
        `Employee run ${runId} did not complete within ${Math.round(
          POLL_TIMEOUT_MS / 1000,
        )}s`,
      );
    }
    await abortableDelay(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Trigger a run on a deployed employee and wait for it to finish.
 *
 * POSTs to `serenCloudRun` with the user's message, then opens an SSE
 * stream at `/deployments/{id}/runs/{run_id}/stream`. Each text/thinking
 * chunk is dispatched through the provided callbacks while a running tally
 * is kept so the final RunResult carries the assembled reply. If the
 * stream drops or the runtime emits no events, falls back to polling
 * `serenCloudDeploymentRun` until terminal state.
 */
export async function runEmployeeMessage(
  deploymentId: string,
  message: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const { onText, onThinking, conversationId } = options;
  const callbacks: RunCallbacks = { onText, onThinking };
  options.signal?.throwIfAborted();

  // Wrap the run in our own AbortController so cancelEmployeeRun can
  // reach in via the activeRuns registry. If the caller also passed a
  // signal, forward its abort through.
  const controller = new AbortController();
  const signal = controller.signal;
  let externalAbortHandler: (() => void) | null = null;
  if (options.signal) {
    externalAbortHandler = () => controller.abort(options.signal?.reason);
    options.signal.addEventListener("abort", externalAbortHandler, {
      once: true,
    });
  }
  // Replace any prior in-flight run for this conversation so the new run
  // owns the cancellation slot. The previous controller, if any, will be
  // released by its own runEmployeeMessage finally block.
  const registered: ActiveRun | null = conversationId
    ? { controller, deploymentId, runId: null }
    : null;
  if (registered && conversationId) {
    activeRuns.set(conversationId, registered);
  }

  try {
    // CloudDeploymentRunRequest's typed surface only knows {message, async,
    // run_id, ...}; the schema description allows additional fields. Cast
    // through `unknown` so the runtime sees `conversation_id` without
    // upsetting the SDK's generated body type.
    const body = {
      message,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    } as unknown as Parameters<typeof serenCloudRun>[0]["body"];

    const created = await serenCloudRun({
      path: { id: deploymentId },
      body,
      throwOnError: false,
    });
    if (created.error || !created.data?.data) {
      throw new Error(
        `Failed to start employee run: ${asMessage(created.error, "")}`,
      );
    }

    const invocation = created.data.data;
    const runId = invocation.run_id ?? null;
    if (registered) registered.runId = runId;

    // Some compute backends complete synchronously and return the result
    // inline without a run_id. Emit it as a single chunk and return.
    if (!runId) {
      const text = fallbackTextFromResult(invocation.result);
      const status = invocation.status ?? "completed";
      if (FAILURE_STATUSES.has(status) && !text) {
        throw new Error(`Run ${status} with no output`);
      }
      if (text) callbacks.onText?.(text);
      return {
        text,
        status,
        runId: null,
        thinking: null,
        errorMessage: null,
      };
    }

    const state = { text: "", thinking: "", errorMessage: null } as {
      text: string;
      thinking: string;
      errorMessage: string | null;
    };
    const startedAt = Date.now();

    try {
      const { stream } = await serenCloudDeploymentRunStream({
        path: { id: deploymentId, run_id: runId },
        signal,
        sseMaxRetryAttempts: STREAM_MAX_RETRY_ATTEMPTS,
        throwOnError: false,
      });
      // heyapi's SSE generator catches stream errors internally and breaks
      // out of its loop rather than rethrowing, so this for-await typically
      // completes cleanly even when the connection drops mid-stream. The
      // unconditional pollUntilTerminal call below is the actual recovery
      // path - it reads canonical status and replays any events we missed.
      for await (const raw of stream) {
        signal.throwIfAborted();
        applyEnvelope(raw, state, callbacks);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      // Surfaced when the SSE request itself fails to open (URL/auth/etc.)
      // or when our abort signal fires. Mid-stream errors are absorbed by
      // heyapi's generator and don't reach here.
      console.warn(
        "[employees-runtime] Stream open failed, falling back to poll:",
        err,
      );
    }

    // Always poll the run for canonical terminal state and replay any
    // events the stream missed (or all of them, if the stream never
    // delivered any).
    const final = await pollUntilTerminal(
      deploymentId,
      runId,
      signal,
      state,
      callbacks,
      startedAt,
    );

    // Prefer streamed text; fall back to the runtime's raw stdout/stderr for
    // backends that don't emit structured events (e.g. plain script runtimes).
    const text = state.text || final.output || "";
    const errorMessage = state.errorMessage ?? final.statusMessage ?? null;

    if (FAILURE_STATUSES.has(final.status)) {
      throw new Error(errorMessage ?? (text || `Employee run ${final.status}`));
    }
    if (final.status === "awaiting_approval") {
      throw new Error(
        "Employee run is awaiting approval. Approval flow is not yet supported in chat.",
      );
    }

    return {
      text,
      status: final.status,
      runId,
      thinking: state.thinking || null,
      errorMessage,
    };
  } finally {
    if (options.signal && externalAbortHandler) {
      options.signal.removeEventListener("abort", externalAbortHandler);
    }
    if (registered && conversationId) {
      // Only clear the slot if it still points at our run. A subsequent
      // runEmployeeMessage call for the same conversation may have
      // replaced the registration before we reached the finally.
      if (activeRuns.get(conversationId) === registered) {
        activeRuns.delete(conversationId);
      }
    }
  }
}
