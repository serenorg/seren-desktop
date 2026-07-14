export const EMPLOYEE_RUN_SOURCE_API = "api";

const DEFAULT_POLL_INTERVAL_MS = 600;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_MAX_RETRY_ATTEMPTS = 4;
// If the live stream goes silent this long without a terminal frame, stop
// waiting on it and fall back to polling. Guards against a stalled SSE
// connection that neither errors nor closes (which would otherwise hang the run
// indefinitely since the for-await loop never completes).
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_STARTUP_RETRY_INTERVAL_MS = 2_000;
const DEFAULT_STARTUP_RETRY_TIMEOUT_MS = 2 * 60 * 1000;

const STARTUP_NOT_READY_MARKERS = ["deployment is still starting"];

// Frame names emitted by the sequenced run-event stream. `run.event` carries a
// durable event envelope; the rest are control frames. Frame ids are sequence
// numbers, so an EventSource resumes from the last id after a disconnect.
const STREAM_EVENT_LOG = "run.event";
const STREAM_EVENT_STATE = "run.state";
const STREAM_EVENT_REPLAY_COMPLETE = "replay_complete";
const STREAM_EVENT_END = "end";
const STREAM_EVENT_TIMEOUT = "timeout";
const STREAM_EVENT_ERROR = "error";

/// Control frames that close the stream for good: after one of these the run is
/// terminal (or hit a hard limit) and a clean EOF must NOT trigger a reconnect.
/// Shared with the SDK adapters so reconnect logic stays consistent.
export const STREAM_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  STREAM_EVENT_END,
  STREAM_EVENT_TIMEOUT,
  STREAM_EVENT_ERROR,
]);

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

export interface EmployeeRunEventLike {
  id: string;
  deployment_id: string;
  conversation_id?: string | null;
  invocation_payload: unknown;
  output?: string | null;
  output_events?: unknown;
  run_name?: string | null;
  started_at: string;
  completed_at?: string | null;
  updated_at: string;
  status: string;
  status_message?: string | null;
}

export interface EmployeeHistoryEmployeeLike {
  id: string;
}

export interface EmployeeRunInvocationLike {
  run_id?: string | null;
  status?: string | null;
  result?: unknown;
}

export interface EmployeeInteractiveSessionLike {
  session_id: string;
  conversation_id?: string | null;
}

export interface EmployeeInteractiveSessionMessageLike {
  run?: EmployeeRunInvocationLike | null;
}

export interface EmployeeMessageRunSummaryInput {
  status?: string | null;
  status_message?: string | null;
}

export interface EmployeeMessageRunInput {
  output?: string | null;
  output_events?: unknown;
  status?: string | null;
  status_message?: string | null;
}

export interface EmployeeMessageTextInput {
  role?: string | null;
  content?: string | null;
  events?: unknown;
  run_summary?: EmployeeMessageRunSummaryInput | null;
  run?: EmployeeMessageRunInput | null;
}

export interface EmployeeCapabilityInput {
  modelPolicy?: string | null;
  modelId?: string | null;
  routingReason?: string | null;
  toolPresets?: readonly string[] | null;
  resolvedTools?: readonly string[] | null;
  allowedPublisherOperations?: readonly string[] | null;
  approvalPolicy?: string | null;
}

export interface EmployeeCapabilityBadge {
  label: string;
  tone: "neutral" | "success" | "warning";
  title: string;
}

export interface EmployeeToolGroupInput {
  id: string;
  preset?: string | null;
  label: string;
  description: string;
  tool_count?: number | null;
  tool_names?: readonly string[] | null;
  side_effecting?: boolean | null;
  checkpoint_required?: boolean | null;
  approval_type?: string | null;
  effective_policy?: EmployeeToolEffectivePolicyInput | null;
  data_labels?: readonly string[] | null;
}

export interface EmployeeToolEffectivePolicyInput {
  status?: string | null;
  source?: string | null;
  conditional_status?: string | null;
  reason?: string | null;
}

export interface EmployeeToolGroupSummary {
  id: string;
  label: string;
  description: string;
  toolCount: number;
  toolPreview: string;
  modeLabel: string;
  approvalLabel: string;
  tone: "neutral" | "success" | "warning";
}

export type EmployeeRunErrorCode =
  | "tool_unavailable"
  | "tool_not_configured"
  | "tool_missing_credential"
  | "tool_permission_denied"
  | "tool_rate_limited"
  | "tool_provider_failed"
  | "model_tool_response_rejected"
  | "model_tool_calls_unsupported"
  | "model_provider_rejected"
  | "approval_required"
  | "guardrail_blocked"
  | "runtime_error"
  | "timeout"
  | "unknown";

export type EmployeeOutputEventEnvelope =
  | {
      type: "text";
      text: string;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "thinking";
      text: string;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments?: string | null;
      status?: string | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "tool_result";
      id: string;
      content: string;
      is_error: boolean;
      code?: string | null;
      retryable?: boolean | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "tool_audit";
      id: string;
      tool: string;
      reason: string;
      tool_ref_kind?: string | null;
      action?: string | null;
      lease_ref?: string | null;
      status?: string | null;
      input_bytes?: number | null;
      output_bytes?: number | null;
      latency_ms?: number | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "approval_wait";
      reason?: string | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "approval_decision";
      decision: string;
      reason?: string | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "workflow";
      state: string;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "guardrail_fail";
      action: string;
      name: string;
      message: string;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "handoff";
      to_agent: string;
      from_agent?: string | null;
      reason?: string | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    }
  | {
      type: "artifact";
      id: string;
      kind: string;
      uri?: string | null;
      sequence_number?: number | null;
      event_type?: string | null;
      item_id?: string | null;
    }
  | {
      type: "error";
      message: string;
      code?: EmployeeRunErrorCode | null;
      retryable?: boolean | null;
      sequence_number?: number | null;
      event_type?: string | null;
      kind?: string | null;
      item_id?: string | null;
    };

export interface ToolCallEvent {
  id: string;
  name: string;
  arguments: string | null;
  status: string | null;
  runId?: string;
  sequenceNumber?: number | null;
  eventType?: string | null;
  eventKind?: string | null;
  itemId?: string | null;
}

export interface ToolResultEvent {
  id: string;
  content: string;
  isError: boolean;
  code?: string | null;
  retryable?: boolean | null;
  runId?: string;
  sequenceNumber?: number | null;
  eventType?: string | null;
  eventKind?: string | null;
  itemId?: string | null;
}

export interface ToolAuditEvent {
  id: string;
  tool: string;
  reason: string;
  toolRefKind: string | null;
  action: string | null;
  leaseRef: string | null;
  status: string | null;
  inputBytes: number | null;
  outputBytes: number | null;
  latencyMs: number | null;
  runId?: string;
  sequenceNumber?: number | null;
  eventType?: string | null;
  eventKind?: string | null;
  itemId?: string | null;
}

export interface StartupWaitEvent {
  attempt: number;
  elapsedMs: number;
  message: string;
}

export interface RunLiveStateEvent {
  checkpoint_id?: string | null;
  current_step?: string | null;
  current_tool?: string | null;
  deployment_id: string;
  latest_event_kind?: string | null;
  latest_sequence: number;
  pending_approval_count: number;
  phase: string;
  run_id: string;
  started_at: string;
  status: string;
  status_message?: string | null;
  terminal: boolean;
  updated_at: string;
}

export interface RunCallbacks {
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  onToolResult?: (event: ToolResultEvent) => void;
  onToolAudit?: (event: ToolAuditEvent) => void;
  onRunState?: (event: RunLiveStateEvent) => void;
  onStartupWait?: (event: StartupWaitEvent) => void;
}

export interface RunOptions extends RunCallbacks {
  signal?: AbortSignal;
  conversationId?: string;
  runKey?: string;
  extraPayload?: Record<string, unknown>;
  interactiveSessionId?: string | null;
  createInteractiveSession?: boolean;
  clientMessageId?: string;
  idempotencyKey?: string;
  startupRetryDelayMs?: number;
  startupRetryTimeoutMs?: number;
}

export interface RunResult {
  text: string;
  status: string;
  runId: string | null;
  sessionId: string | null;
  thinking: string | null;
  errorMessage: string | null;
}

export interface EmployeeRuntimeApi {
  resolveSessionId?(input: {
    deploymentId: string;
    conversationId: string;
    signal: AbortSignal;
  }): Promise<string | null>;
  createSession?(input: {
    deploymentId: string;
    conversationId?: string;
    signal: AbortSignal;
  }): Promise<EmployeeInteractiveSessionLike>;
  postSessionMessage?(input: {
    deploymentId: string;
    sessionId: string;
    content: string;
    clientMessageId: string;
    idempotencyKey: string;
    metadata: Record<string, unknown> | null;
    signal: AbortSignal;
  }): Promise<EmployeeInteractiveSessionMessageLike>;
  createRun(input: {
    deploymentId: string;
    body: unknown;
    signal: AbortSignal;
  }): Promise<EmployeeRunInvocationLike>;
  getRun(input: {
    deploymentId: string;
    runId: string;
    signal: AbortSignal;
  }): Promise<EmployeeRunEventLike>;
  streamRun(input: {
    deploymentId: string;
    runId: string;
    signal: AbortSignal;
    maxRetryAttempts: number;
    lastEventId?: string | null;
  }): Promise<AsyncIterable<unknown>>;
  cancelRun(input: { deploymentId: string; runId: string }): Promise<void>;
}

export interface EmployeeRunManagerOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  streamMaxRetryAttempts?: number;
  streamIdleTimeoutMs?: number;
  startupRetryDelayMs?: number;
  startupRetryTimeoutMs?: number;
  onStreamOpenError?: (error: unknown) => void;
}

interface ActiveRun {
  controller: AbortController;
  deploymentId: string;
  runId: string | null;
}

interface RunState {
  text: string;
  thinking: string;
  errorMessage: string | null;
  seenTextEvents: Set<string>;
  seenThinkingEvents: Set<string>;
  seenToolEvents: Set<string>;
}

interface TerminalRun {
  status: string;
  statusMessage: string | null;
  output: string | null;
}

type ToolEventDedupeEnvelope = Extract<
  EmployeeOutputEventEnvelope,
  { type: "tool_call" | "tool_result" | "tool_audit" }
>;

function applyRunSnapshot(
  event: EmployeeRunEventLike,
  state: RunState,
  callbacks: RunCallbacks,
  runId?: string,
): void {
  const recovered: RunState = {
    text: "",
    thinking: "",
    errorMessage: null,
    seenTextEvents: new Set<string>(),
    seenThinkingEvents: new Set<string>(),
    seenToolEvents: state.seenToolEvents,
  };
  const replayCallbacks: RunCallbacks = {
    onToolCall: callbacks.onToolCall,
    onToolResult: callbacks.onToolResult,
    onToolAudit: callbacks.onToolAudit,
  };
  for (const raw of outputEventEnvelopes(event.output_events)) {
    applyEnvelope(raw, recovered, replayCallbacks, runId);
  }
  const snapshotText = recovered.text || event.output || "";
  if (snapshotText) {
    // Terminal snapshots can carry cumulative text in output_events or, for
    // older/fallback rows, in output. Reconcile either source so polling after a
    // partial stream still returns the authoritative final text.
    const textDiff = reconcileCumulativeText(state.text, snapshotText);
    if (textDiff.next !== state.text) {
      state.text = textDiff.next;
      if (textDiff.diff) callbacks.onText?.(textDiff.diff);
    }
  }
  if (recovered.thinking) {
    const thinkingDiff = reconcileCumulativeText(
      state.thinking,
      recovered.thinking,
    );
    if (thinkingDiff.next !== state.thinking) {
      state.thinking = thinkingDiff.next;
      if (thinkingDiff.diff) callbacks.onThinking?.(thinkingDiff.diff);
    }
  }
  if (recovered.errorMessage && !state.errorMessage) {
    state.errorMessage = recovered.errorMessage;
  }
}

// Snapshots are cumulative. Normally each one extends the previous text, so we
// emit only the appended suffix. If a snapshot diverges (server rewrote/trimmed
// earlier text) or shrinks, resync `state` to the authoritative cumulative text
// without emitting an append-only chunk; callers replace from the returned
// result at terminal reconciliation.
function reconcileCumulativeText(
  prev: string,
  next: string,
): { diff: string; next: string } {
  if (next === prev) return { diff: "", next: prev };
  if (next.length >= prev.length && next.startsWith(prev)) {
    return { diff: next.slice(prev.length), next };
  }
  return { diff: "", next };
}

// A frame from the sequenced stream: a control `event` name plus its parsed
// payload `data`. The adapter pairs each yielded payload with the SSE event
// name; an unwrapped value is treated as a `run.event` envelope by default.
interface EmployeeStreamFrame {
  event?: string;
  id?: string;
  data: unknown;
}

function streamFrameFromMessage(raw: unknown): EmployeeStreamFrame {
  if (raw && typeof raw === "object" && "data" in raw) {
    const frame = raw as { event?: unknown; id?: unknown; data: unknown };
    return {
      event: typeof frame.event === "string" ? frame.event : undefined,
      id: typeof frame.id === "string" ? frame.id : undefined,
      data: frame.data,
    };
  }
  return { data: raw };
}

function streamFrameCursor(frame: EmployeeStreamFrame): string | null {
  if (typeof frame.id === "string" && frame.id.trim()) return frame.id;
  if (frame.data && typeof frame.data === "object") {
    const sequence = (frame.data as { sequence_number?: unknown })
      .sequence_number;
    if (typeof sequence === "number" && Number.isFinite(sequence)) {
      return String(sequence);
    }
  }
  return null;
}

function streamControlErrorMessage(data: unknown): string | null {
  if (data && typeof data === "object" && "error" in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

function isRunLiveStateEvent(value: unknown): value is RunLiveStateEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.deployment_id === "string" &&
    typeof event.latest_sequence === "number" &&
    typeof event.pending_approval_count === "number" &&
    typeof event.phase === "string" &&
    typeof event.run_id === "string" &&
    typeof event.started_at === "string" &&
    typeof event.status === "string" &&
    typeof event.terminal === "boolean" &&
    typeof event.updated_at === "string"
  );
}

function applyRunLiveState(raw: unknown, callbacks: RunCallbacks): void {
  if (!isRunLiveStateEvent(raw)) return;
  callbacks.onRunState?.(raw);
}

type StreamStep =
  | { kind: "value"; value: unknown }
  | { kind: "done" }
  | { kind: "idle" };

// Read the next stream frame, racing the underlying async iterator against an
// idle timeout. Returns "idle" if no frame arrives in time so the caller can
// fall back to polling instead of blocking forever on a stalled connection.
async function nextStreamFrame(
  iterator: AsyncIterator<unknown>,
  idleTimeoutMs: number,
  signal: AbortSignal,
): Promise<StreamStep> {
  const next = iterator
    .next()
    .then(
      (result): StreamStep =>
        result.done ? { kind: "done" } : { kind: "value", value: result.value },
    );
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return next;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<StreamStep>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "idle" }), idleTimeoutMs);
    if (signal.aborted) {
      resolve({ kind: "done" });
      return;
    }
    onAbort = () => resolve({ kind: "done" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([next, interrupt]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function createEmployeeRunManager(
  api: EmployeeRuntimeApi,
  managerOptions: EmployeeRunManagerOptions = {},
) {
  const activeRuns = new Map<string, ActiveRun>();
  const pollIntervalMs =
    managerOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = managerOptions.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const streamMaxRetryAttempts =
    managerOptions.streamMaxRetryAttempts ?? DEFAULT_STREAM_MAX_RETRY_ATTEMPTS;
  const streamIdleTimeoutMs =
    managerOptions.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const defaultStartupRetryDelayMs =
    managerOptions.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_INTERVAL_MS;
  const defaultStartupRetryTimeoutMs =
    managerOptions.startupRetryTimeoutMs ?? DEFAULT_STARTUP_RETRY_TIMEOUT_MS;

  async function cancelEmployeeRun(runKey: string): Promise<void> {
    const active = activeRuns.get(runKey);
    if (!active) return;
    active.controller.abort();
    if (!active.runId) return;
    try {
      await api.cancelRun({
        deploymentId: active.deploymentId,
        runId: active.runId,
      });
    } catch {
      // The local abort already stopped consumers.
    }
  }

  async function pollUntilTerminal(
    deploymentId: string,
    runId: string,
    signal: AbortSignal,
    state: RunState,
    callbacks: RunCallbacks,
    startedAt: number,
  ): Promise<TerminalRun> {
    while (true) {
      signal.throwIfAborted();
      const event = await api.getRun({ deploymentId, runId, signal });
      if (TERMINAL_STATUSES.has(event.status)) {
        applyRunSnapshot(event, state, callbacks, runId);
        return {
          status: event.status,
          statusMessage: event.status_message ?? null,
          output: event.output ?? null,
        };
      }
      if (Date.now() - startedAt > pollTimeoutMs) {
        throw new Error(
          `Employee run ${runId} did not complete within ${Math.round(
            pollTimeoutMs / 1000,
          )}s`,
        );
      }
      await abortableDelay(pollIntervalMs, signal);
    }
  }

  async function runEmployeeMessage(
    deploymentId: string,
    message: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const callbacks: RunCallbacks = {
      onText: options.onText,
      onThinking: options.onThinking,
      onToolCall: options.onToolCall,
      onToolResult: options.onToolResult,
      onToolAudit: options.onToolAudit,
      onRunState: options.onRunState,
      onStartupWait: options.onStartupWait,
    };
    const registryKey = options.runKey ?? options.conversationId;
    options.signal?.throwIfAborted();

    const controller = new AbortController();
    const signal = controller.signal;
    let externalAbortHandler: (() => void) | null = null;
    if (options.signal) {
      externalAbortHandler = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener("abort", externalAbortHandler, {
        once: true,
      });
    }

    const registered: ActiveRun | null = registryKey
      ? { controller, deploymentId, runId: null }
      : null;
    if (registered && registryKey) {
      const previous = activeRuns.get(registryKey);
      if (previous) {
        previous.controller.abort();
        if (previous.runId) {
          void api
            .cancelRun({
              deploymentId: previous.deploymentId,
              runId: previous.runId,
            })
            .catch(() => {});
        }
      }
      activeRuns.set(registryKey, registered);
    }

    try {
      const retryDelayMs =
        options.startupRetryDelayMs ?? defaultStartupRetryDelayMs;
      const retryTimeoutMs =
        options.startupRetryTimeoutMs ?? defaultStartupRetryTimeoutMs;
      const startupStartedAt = Date.now();
      let startupAttempt = 0;
      let invocation: EmployeeRunInvocationLike;
      let sessionId: string | null = null;
      while (true) {
        try {
          const start = await startEmployeeRun(
            api,
            deploymentId,
            message,
            options,
            signal,
          );
          invocation = start.invocation;
          sessionId = start.sessionId;
          break;
        } catch (error) {
          const startError =
            error instanceof Error ? error.message : String(error);
          const elapsedMs = Date.now() - startupStartedAt;
          if (
            !isStartupNotReadyError(startError) ||
            elapsedMs >= retryTimeoutMs
          ) {
            throw new Error(`Failed to start employee run: ${startError}`);
          }
          startupAttempt += 1;
          callbacks.onStartupWait?.({
            attempt: startupAttempt,
            elapsedMs,
            message: startError,
          });
          await abortableDelay(retryDelayMs, signal);
          signal.throwIfAborted();
        }
      }

      const runId = invocation.run_id ?? null;
      if (registered) registered.runId = runId;

      if (!runId) {
        const text = fallbackTextFromResult(invocation.result);
        const status = invocation.status ?? "completed";
        if (isFailureStatus(status) && !text) {
          throw new Error(`Run ${status} with no output`);
        }
        if (text) callbacks.onText?.(text);
        return {
          text,
          status,
          runId: null,
          sessionId,
          thinking: null,
          errorMessage: null,
        };
      }

      const state: RunState = {
        text: "",
        thinking: "",
        errorMessage: null,
        seenTextEvents: new Set<string>(),
        seenThinkingEvents: new Set<string>(),
        seenToolEvents: new Set<string>(),
      };
      let lastEventId: string | null = null;
      let shouldPoll = false;
      while (!shouldPoll) {
        try {
          const stream = await api.streamRun({
            deploymentId,
            runId,
            signal,
            maxRetryAttempts: streamMaxRetryAttempts,
            lastEventId,
          });
          const iterator = stream[Symbol.asyncIterator]();
          try {
            let live = true;
            while (live) {
              signal.throwIfAborted();
              const step = await nextStreamFrame(
                iterator,
                streamIdleTimeoutMs,
                signal,
              );
              if (step.kind === "idle") {
                shouldPoll = true;
                break;
              }
              if (step.kind === "done") {
                shouldPoll = true;
                break;
              }
              const frame = streamFrameFromMessage(step.value);
              const cursor = streamFrameCursor(frame);
              if (cursor) lastEventId = cursor;
              switch (frame.event) {
                case STREAM_EVENT_END:
                case STREAM_EVENT_TIMEOUT:
                  // Terminal/limit boundary reached. pollUntilTerminal confirms
                  // the authoritative status, output, and status message.
                  shouldPoll = true;
                  live = false;
                  break;
                case STREAM_EVENT_ERROR: {
                  const message = streamControlErrorMessage(frame.data);
                  if (message && !state.errorMessage)
                    state.errorMessage = message;
                  shouldPoll = true;
                  live = false;
                  break;
                }
                case STREAM_EVENT_REPLAY_COMPLETE:
                  // Cursor replay finished; the live tail follows. Nothing to apply.
                  break;
                case STREAM_EVENT_STATE:
                  applyRunLiveState(frame.data, callbacks);
                  break;
                case STREAM_EVENT_LOG:
                  applyEnvelope(frame.data, state, callbacks, runId);
                  break;
                default:
                  // Unnamed frame: treat it as a durable event envelope.
                  applyEnvelope(frame.data, state, callbacks, runId);
                  break;
              }
            }
          } finally {
            // Best-effort close. Do NOT await: a stalled async generator can be
            // suspended at an await that never settles, so awaiting return() would
            // re-introduce the very hang the idle timeout exists to prevent. The
            // manager's abort controller drives real cancellation.
            void Promise.resolve(iterator.return?.()).catch(() => {});
          }
          if (shouldPoll) break;
        } catch (error) {
          if (signal.aborted) throw error;
          managerOptions.onStreamOpenError?.(error);
          shouldPoll = true;
        }
      }

      // The sequenced stream emits deltas, not the terminal row. One poll
      // resolves the authoritative final status, output, and status message
      // (and reconciles any trailing events the stream missed).
      const final = await pollUntilTerminal(
        deploymentId,
        runId,
        signal,
        state,
        callbacks,
        Date.now(),
      );

      const text = state.text || final.output || "";
      const errorMessage = state.errorMessage ?? final.statusMessage ?? null;
      if (isFailureStatus(final.status)) {
        throw new Error(
          errorMessage ?? (text || `Employee run ${final.status}`),
        );
      }
      return {
        text,
        status: final.status,
        runId,
        sessionId,
        thinking: state.thinking || null,
        errorMessage,
      };
    } finally {
      if (options.signal && externalAbortHandler) {
        options.signal.removeEventListener("abort", externalAbortHandler);
      }
      if (
        registered &&
        registryKey &&
        activeRuns.get(registryKey) === registered
      ) {
        activeRuns.delete(registryKey);
      }
    }
  }

  return {
    cancelEmployeeRun,
    runEmployeeMessage,
  };
}

async function startEmployeeRun(
  api: EmployeeRuntimeApi,
  deploymentId: string,
  message: string,
  options: RunOptions,
  signal: AbortSignal,
): Promise<{
  invocation: EmployeeRunInvocationLike;
  sessionId: string | null;
}> {
  const sessionId = await resolveInteractiveSessionId(
    api,
    deploymentId,
    options,
    signal,
  );
  if (sessionId && api.postSessionMessage) {
    const clientMessageId = options.clientMessageId ?? createClientMessageId();
    const posted = await api.postSessionMessage({
      deploymentId,
      sessionId,
      content: message,
      clientMessageId,
      idempotencyKey: options.idempotencyKey ?? clientMessageId,
      metadata: options.extraPayload ?? null,
      signal,
    });
    return {
      invocation: posted.run ?? { status: "completed", run_id: null },
      sessionId,
    };
  }

  const body = {
    ...(options.extraPayload ?? {}),
    ...(message ? { message } : {}),
    ...(options.conversationId
      ? { conversation_id: options.conversationId }
      : {}),
  };
  return {
    invocation: await api.createRun({ deploymentId, body, signal }),
    sessionId: null,
  };
}

async function resolveInteractiveSessionId(
  api: EmployeeRuntimeApi,
  deploymentId: string,
  options: RunOptions,
  signal: AbortSignal,
): Promise<string | null> {
  if (!api.postSessionMessage) return null;
  if (options.interactiveSessionId) return options.interactiveSessionId;
  if (options.conversationId && api.resolveSessionId) {
    const sessionId = await api.resolveSessionId({
      deploymentId,
      conversationId: options.conversationId,
      signal,
    });
    if (sessionId) return sessionId;
  }
  if (options.createInteractiveSession && api.createSession) {
    return (
      await api.createSession({
        deploymentId,
        conversationId: options.conversationId,
        signal,
      })
    ).session_id;
  }
  return null;
}

export function messageFromInvocationPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  return stringValue(value.message) ?? stringValue(value.prompt) ?? "";
}

export function assistantTextFromRun(run: EmployeeRunEventLike): string {
  const fromEvents = textFromOutputEvents(run.output_events);
  if (fromEvents) return fromEvents;
  return run.output?.trim() ?? "";
}

export function textFromOutputEvents(value: unknown): string {
  return outputEventEnvelopes(value)
    .map((event) => (event.type === "text" ? event.text : ""))
    .join("")
    .trim();
}

export function errorTextFromOutputEvents(value: unknown): string {
  return outputEventEnvelopes(value)
    .map((event) =>
      event.type === "error"
        ? (employeeErrorTextFromCode(event.code) ??
          sanitizeEmployeeErrorText(event.message))
        : "",
    )
    .filter(Boolean)
    .filter((message, index, messages) => messages.indexOf(message) === index)
    .join("\n")
    .trim();
}

export function errorCodeFromOutputEvents(
  value: unknown,
): EmployeeRunErrorCode | undefined {
  let fallback: EmployeeRunErrorCode | undefined;
  for (const event of outputEventEnvelopes(value)) {
    if (event.type !== "error" || !event.code) continue;
    if (event.code !== "unknown") return event.code;
    fallback = "unknown";
  }
  return fallback;
}

export function employeeErrorCodeFromConversationMessage(
  message: EmployeeMessageTextInput,
): EmployeeRunErrorCode | undefined {
  return (
    errorCodeFromOutputEvents(message.events) ??
    errorCodeFromOutputEvents(message.run?.output_events)
  );
}

const TOOL_RESPONSE_ERROR_TEXT =
  "The configured model route could not process the tool response. Change this employee to a tool-capable model route in employee settings.";

const MODEL_PROVIDER_ERROR_TEXT =
  "The employee could not complete this request because the model provider rejected it.";

const MODEL_TOOL_SUPPORT_ERROR_TEXT =
  "The configured model does not support tool calls. Choose a tool-capable model route in employee settings.";

const TOOL_CONFIGURATION_ERROR_TEXT =
  "The required tool is not enabled for this employee. Enable live data or publisher tools in employee settings.";

const TOOL_PERMISSION_ERROR_TEXT =
  "This employee is not allowed to use that publisher operation. Update tool permissions in employee settings.";

const GENERIC_EMPLOYEE_ERROR_TEXT =
  "The employee could not complete this request.";

export function employeeErrorTextFromCode(
  code: string | null | undefined,
): string | undefined {
  switch (code) {
    case "tool_unavailable":
    case "tool_not_configured":
      return TOOL_CONFIGURATION_ERROR_TEXT;
    case "tool_missing_credential":
      return "This employee needs a connected account or credential before it can use the required tool. Update employee settings.";
    case "tool_permission_denied":
      return TOOL_PERMISSION_ERROR_TEXT;
    case "tool_rate_limited":
      return "The required tool is currently rate-limited. Review the connected provider limits or choose another tool route.";
    case "tool_provider_failed":
      return "The required tool failed while contacting its provider. Check the connected provider configuration.";
    case "model_tool_response_rejected":
      return TOOL_RESPONSE_ERROR_TEXT;
    case "model_tool_calls_unsupported":
      return MODEL_TOOL_SUPPORT_ERROR_TEXT;
    case "model_provider_rejected":
      return MODEL_PROVIDER_ERROR_TEXT;
    case "approval_required":
      return "This request is waiting for an approval before the employee can continue.";
    case "guardrail_blocked":
      return "This request was blocked by an employee policy or guardrail.";
    case "timeout":
      return "The employee timed out before it could complete this request.";
    case "runtime_error":
      return GENERIC_EMPLOYEE_ERROR_TEXT;
    case "unknown":
    case undefined:
    case null:
      return undefined;
    default:
      return undefined;
  }
}

export function employeeToolResultStatusLabel(
  event: Pick<ToolResultEvent, "isError" | "code">,
): string {
  if (!event.isError) return "Tool completed";
  switch (event.code) {
    case "tool_unavailable":
    case "tool_not_configured":
      return "Tool not configured";
    case "tool_missing_credential":
      return "Tool needs credentials";
    case "tool_permission_denied":
      return "Tool not allowed";
    case "tool_rate_limited":
      return "Tool rate-limited";
    case "approval_required":
      return "Tool needs approval";
    case "timeout":
      return "Tool timed out";
    case "tool_provider_failed":
      return "Tool provider failed";
    default:
      return "Tool returned an error";
  }
}

export function sanitizeEmployeeErrorText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase();

  if (looksLikeToolConfigurationError(normalized)) {
    return TOOL_CONFIGURATION_ERROR_TEXT;
  }

  if (looksLikeToolPermissionError(normalized)) {
    return TOOL_PERMISSION_ERROR_TEXT;
  }

  if (looksLikeModelToolSupportError(normalized)) {
    return MODEL_TOOL_SUPPORT_ERROR_TEXT;
  }

  if (
    normalized.includes("no tool call found for function call output") ||
    normalized.includes("function_call_output") ||
    normalized.includes("tool response could not be processed")
  ) {
    return TOOL_RESPONSE_ERROR_TEXT;
  }

  if (
    normalized.includes("guardrail") ||
    normalized.includes("policy blocked")
  ) {
    return "This request was blocked by an employee policy or guardrail.";
  }

  if (looksLikeModelProviderDetail(normalized)) {
    return MODEL_PROVIDER_ERROR_TEXT;
  }

  if (looksLikeStructuredError(trimmed)) {
    return GENERIC_EMPLOYEE_ERROR_TEXT;
  }

  return redactEmployeeErrorText(trimmed);
}

function looksLikeToolConfigurationError(value: string): boolean {
  return (
    value.includes("seren client unavailable") ||
    value.includes("tool is not supported") ||
    value.includes("tool_definitions") ||
    value.includes("only use tools that are actually declared") ||
    value.includes("unknown tool")
  );
}

function looksLikeToolPermissionError(value: string): boolean {
  return (
    value.includes("publisher operation is not allowed") ||
    value.includes("publisher operation not allowed") ||
    value.includes("allowed_publisher_operations") ||
    value.includes("publisher_tool_grants") ||
    value.includes("not granted")
  );
}

function looksLikeModelToolSupportError(value: string): boolean {
  return (
    (value.includes("tool") || value.includes("function")) &&
    (value.includes("not support") ||
      value.includes("does not support") ||
      value.includes("unsupported"))
  );
}

function looksLikeModelProviderDetail(value: string): boolean {
  return (
    value.includes("llm publisher returned") ||
    value.includes("seren models publisher returned") ||
    value.includes("provider returned error") ||
    value.includes("previous_errors") ||
    value.includes("provider_name") ||
    value.includes('"is_byok"') ||
    value.includes("azure openai") ||
    value.includes("openai:") ||
    value.includes("bedrock") ||
    value.includes("anthropic") ||
    value.includes("deploymentnotfound") ||
    value.includes("invalid_request_error")
  );
}

function redactEmployeeErrorText(value: string): string {
  const redacted = value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[email]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{10,}|seren_[A-Za-z0-9_-]{10,})\b/g,
      "[secret]",
    )
    .replace(/\b(?:token|key|secret)=\S+/gi, "[secret]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[identifier]");
  return redacted.length > 240 ? GENERIC_EMPLOYEE_ERROR_TEXT : redacted;
}

export function employeeTextFromConversationMessage(
  message: EmployeeMessageTextInput,
): string {
  if (message.role !== "assistant") return message.content?.trim() ?? "";
  const status = message.run_summary?.status ?? message.run?.status ?? "";
  const errorText = errorTextFromOutputEvents(message.events);
  const eventText = textFromOutputEvents(message.events);
  const preferredEventText =
    errorText && isFailureStatus(status) ? errorText : eventText;
  const text =
    preferredEventText ||
    message.content?.trim() ||
    message.run_summary?.status_message?.trim() ||
    message.run?.status_message?.trim() ||
    assistantTextFromRunOutput(message.run) ||
    "";
  return isFailureStatus(status) ? sanitizeEmployeeErrorText(text) : text;
}

function looksLikeStructuredError(value: string): boolean {
  if (value.length > 500 && /[{[]/.test(value)) return true;
  if (!value.startsWith("{") && !value.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return false;
    return JSON.stringify(parsed).toLowerCase().includes('"error"');
  } catch {
    return false;
  }
}

function assistantTextFromRunOutput(
  run: EmployeeMessageRunInput | null | undefined,
): string {
  if (!run) return "";
  const fromEvents = textFromOutputEvents(run.output_events);
  if (fromEvents) return fromEvents;
  return run.output?.trim() ?? "";
}

export function outputEventEnvelopes(
  value: unknown,
): EmployeeOutputEventEnvelope[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isEmployeeOutputEventEnvelope);
}

export function isEmployeeOutputEventEnvelope(
  value: unknown,
): value is EmployeeOutputEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "text":
    case "thinking":
      return typeof event.text === "string";
    case "tool_call":
      return typeof event.id === "string" && typeof event.name === "string";
    case "tool_result":
      return (
        typeof event.id === "string" &&
        typeof event.content === "string" &&
        typeof event.is_error === "boolean"
      );
    case "tool_audit":
      return (
        typeof event.id === "string" &&
        typeof event.tool === "string" &&
        typeof event.reason === "string"
      );
    case "approval_wait":
      return true;
    case "approval_decision":
      return typeof event.decision === "string";
    case "workflow":
      return typeof event.state === "string";
    case "guardrail_fail":
      return (
        typeof event.action === "string" &&
        typeof event.name === "string" &&
        typeof event.message === "string"
      );
    case "handoff":
      return typeof event.to_agent === "string";
    case "artifact":
      return typeof event.id === "string" && typeof event.kind === "string";
    case "error":
      return typeof event.message === "string";
    default:
      return false;
  }
}

export function toolAuditEventFromEnvelope(
  event: Extract<EmployeeOutputEventEnvelope, { type: "tool_audit" }>,
): ToolAuditEvent {
  return {
    id: event.id,
    tool: event.tool,
    reason: event.reason,
    toolRefKind: event.tool_ref_kind ?? null,
    action: event.action ?? null,
    leaseRef: event.lease_ref ?? null,
    status: event.status ?? null,
    inputBytes: event.input_bytes ?? null,
    outputBytes: event.output_bytes ?? null,
    latencyMs: event.latency_ms ?? null,
    sequenceNumber: event.sequence_number ?? null,
    eventType: event.event_type ?? null,
    eventKind: event.kind ?? null,
    itemId: event.item_id ?? null,
  };
}

export function groupEmployeeRunsByConversation<
  TRun extends EmployeeRunEventLike,
  TEmployee extends EmployeeHistoryEmployeeLike,
>(runs: TRun[], employees: TEmployee[]): TRun[][] {
  const employeeById = new Map(
    employees.map((employee) => [employee.id, employee]),
  );
  const grouped = new Map<string, TRun[]>();

  for (const run of runs) {
    if (!employeeById.has(run.deployment_id)) continue;
    const conversationId = run.conversation_id?.trim();
    if (!conversationId) continue;
    const key = `${run.deployment_id}:${conversationId}`;
    const group = grouped.get(key) ?? [];
    group.push(run);
    grouped.set(key, group);
  }

  return Array.from(grouped.values());
}

export function truncateTitle(value: string, maxLength = 48): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export function isFailureStatus(status: string): boolean {
  return FAILURE_STATUSES.has(status);
}

export function employeeModelPolicyLabel(policy: string | null | undefined) {
  if (policy === "fast") return "Fast model";
  if (policy === "deep") return "Deep model";
  return "Balanced model";
}

export function employeeApprovalPolicyLabel(policy: string | null | undefined) {
  if (policy === "allow_mutations") return "Actions allowed";
  return "Read-only tools";
}

export function employeeToolPresetLabel(preset: string): string {
  if (preset === "live_data") return "Live data";
  if (preset === "publisher_actions") return "Publisher actions";
  if (preset === "database") return "Database";
  return preset.replace(/_/g, " ");
}

export function employeeCapabilityBadges(
  input: EmployeeCapabilityInput,
): EmployeeCapabilityBadge[] {
  const toolPresets = input.toolPresets ?? [];
  const resolvedTools = input.resolvedTools ?? [];
  const allowedOperations = input.allowedPublisherOperations ?? [];
  const hasTools = resolvedTools.length > 0 || toolPresets.length > 0;
  const badges: EmployeeCapabilityBadge[] = [
    {
      label: employeeModelPolicyLabel(input.modelPolicy),
      tone: "neutral",
      title: input.modelId
        ? `Model ${input.modelId}`
        : "Standard managed model policy",
    },
  ];

  if (toolPresets.length > 0) {
    badges.push(
      ...toolPresets.map((preset) => ({
        label: employeeToolPresetLabel(preset),
        tone: "success" as const,
        title: "Enabled employee tool preset",
      })),
    );
  } else {
    badges.push({
      label: "No tool presets",
      tone: "warning",
      title:
        "Enable a tool preset when the employee needs live data, publishers, or database access",
    });
  }

  badges.push({
    label: employeeApprovalPolicyLabel(input.approvalPolicy),
    tone: input.approvalPolicy === "allow_mutations" ? "warning" : "neutral",
    title:
      input.approvalPolicy === "allow_mutations"
        ? "This employee can run mutating publisher operations"
        : "This employee can only run read-only publisher operations",
  });

  badges.push({
    label: hasTools
      ? `${resolvedTools.length || toolPresets.length} ${
          resolvedTools.length === 1 || toolPresets.length === 1
            ? "tool"
            : "tools"
        }`
      : "No tools",
    tone: hasTools ? "neutral" : "warning",
    title: hasTools
      ? `${resolvedTools.length || toolPresets.length} resolved employee tools`
      : "No runtime tools are currently enabled",
  });

  if (allowedOperations.length > 0) {
    badges.push({
      label:
        allowedOperations.length === 1
          ? "1 publisher permission"
          : `${allowedOperations.length} publisher permissions`,
      tone: "neutral",
      title: "Allowed publisher operation count",
    });
  }

  return badges;
}

export function employeeToolGroupSummaries(
  groups: readonly EmployeeToolGroupInput[] | null | undefined,
): EmployeeToolGroupSummary[] {
  return [...(groups ?? [])].map((group) => {
    const toolNames = group.tool_names ?? [];
    const toolCount = group.tool_count ?? toolNames.length;
    const actionCapable = Boolean(group.side_effecting);
    const approvalLabel = employeeToolPolicyLabel(
      group.effective_policy,
      group.approval_type,
    );
    const tone = employeeToolPolicyTone(group.effective_policy, actionCapable);
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      toolCount,
      toolPreview: employeeToolPreview(toolNames, toolCount),
      modeLabel: actionCapable ? "Action-capable" : "Read-only",
      approvalLabel,
      tone,
    };
  });
}

export function employeeToolPolicyLabel(
  policy: EmployeeToolEffectivePolicyInput | null | undefined,
  fallbackApprovalType?: string | null,
): string {
  const status = policy?.status;
  const conditional = policy?.conditional_status;
  if (status === "blocked") return "Blocked";
  if (status === "requires_approval") return "Approval required";
  if (status === "audited") {
    return conditional === "requires_approval"
      ? "Audited + conditional"
      : "Audited";
  }
  if (conditional === "requires_approval") return "Conditional approval";
  if (conditional === "audited") return "Conditional audit";
  return employeeApprovalTypeLabel(fallbackApprovalType);
}

function employeeToolPolicyTone(
  policy: EmployeeToolEffectivePolicyInput | null | undefined,
  actionCapable: boolean,
): "neutral" | "success" | "warning" {
  if (
    policy?.status === "blocked" ||
    policy?.status === "requires_approval" ||
    policy?.conditional_status === "requires_approval"
  ) {
    return "warning";
  }
  if (
    policy?.status === "audited" ||
    policy?.conditional_status === "audited"
  ) {
    return "neutral";
  }
  return actionCapable ? "warning" : "success";
}

export function employeeCapabilityGuidanceForError(
  code: EmployeeRunErrorCode | string | null | undefined,
  input: EmployeeCapabilityInput,
): string | undefined {
  const toolPresets = input.toolPresets ?? [];
  const hasLiveData = toolPresets.includes("live_data");
  const hasPublisherActions = toolPresets.includes("publisher_actions");
  const hasAnyTool =
    toolPresets.length > 0 || (input.resolvedTools?.length ?? 0) > 0;

  switch (code) {
    case "tool_unavailable":
    case "tool_not_configured":
      if (!hasAnyTool) {
        return "No tool groups are enabled for this employee. Enable Live data for web research, Publisher actions for connected tools, or SerenDB queries for database access.";
      }
      if (!hasLiveData && !hasPublisherActions) {
        return "This employee only has limited tool access. Enable Live data for web research or Publisher actions for connected tools.";
      }
      if (!hasLiveData) {
        return "Live data is not enabled. Enable it when this employee needs web research, publisher discovery, or read-only external data.";
      }
      if (!hasPublisherActions) {
        return "Publisher actions are not enabled. Enable them when this employee needs to call connected tools or write to external systems.";
      }
      return "Review this employee's enabled tool groups and connected accounts.";
    case "tool_missing_credential":
      return "Connect the required account or credential in employee settings before using that tool.";
    case "tool_permission_denied":
      return input.approvalPolicy === "allow_mutations"
        ? "Review the allowed publisher operations and connected account grants for this employee."
        : "Tool permissions are read-only. Switch permissions to Allow actions if this employee should write to external systems.";
    case "model_tool_calls_unsupported":
    case "model_tool_response_rejected":
      return "This employee's model route is not completing tool calls. Use a tool-capable model route before relying on web or connector tools.";
    default:
      return undefined;
  }
}

function employeeToolPreview(
  toolNames: readonly string[],
  toolCount: number,
): string {
  if (toolCount <= 0) return "No tools";
  const visible = toolNames.slice(0, 3).map(formatEmployeeToolName);
  // A group can report a count without names (e.g. future count-only custom
  // groups); render the count rather than a nameless "+ N more".
  if (visible.length === 0) {
    return `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  }
  const remaining = Math.max(0, toolCount - visible.length);
  return remaining > 0
    ? `${visible.join(", ")} + ${remaining} more`
    : visible.join(", ");
}

function employeeApprovalTypeLabel(value: string | null | undefined): string {
  if (value === "required") return "Approval required";
  if (value === "audit") return "Audited";
  return "No approval";
}

function formatEmployeeToolName(name: string): string {
  return name.replace(/^seren_/, "").replace(/_/g, " ");
}

export function runStatusLabel(
  status: string,
  statusMessage: string | null,
): string | undefined {
  if (status === "completed") return undefined;
  return statusMessage || status.replace(/_/g, " ");
}

export function runLiveStateLabel(
  state: RunLiveStateEvent,
): string | undefined {
  if (state.current_tool && state.current_step === "Using tool") {
    return `Using ${state.current_tool}`;
  }
  if (state.current_tool && state.current_step === "Tool audited") {
    return `${state.current_tool} reviewed`;
  }
  if (state.current_tool && state.phase === "handoff") {
    return `Handing off to ${state.current_tool}`;
  }
  if (state.current_step) return state.current_step;
  return runStatusLabel(
    state.phase || state.status,
    state.status_message ?? null,
  );
}

export interface ToolAuditFormatOptions {
  escapeMarkdown?: boolean;
}

export function formatToolAuditEvent(
  event: ToolAuditEvent,
  options: ToolAuditFormatOptions = {},
): string {
  const reason = formatToolAuditText(event.reason, options);
  const tool = formatToolAuditText(event.tool, options) || "tool";
  const action = formatToolAuditText(event.action, options);
  const leaseRef = formatToolAuditText(event.leaseRef, options);
  const details = [
    formatToolAuditText(event.toolRefKind, options),
    action ? `action ${action}` : null,
    leaseRef ? `lease ${leaseRef}` : null,
    formatToolAuditText(event.status, options),
    formatToolAuditBytes("in", event.inputBytes),
    formatToolAuditBytes("out", event.outputBytes),
    typeof event.latencyMs === "number" &&
    Number.isFinite(event.latencyMs) &&
    event.latencyMs >= 0
      ? `${event.latencyMs}ms`
      : null,
  ].filter((part): part is string => Boolean(part));
  const suffix = details.length > 0 ? ` (${details.join(" - ")})` : "";
  return reason ? `${tool}: ${reason}${suffix}` : `${tool}${suffix}`;
}

function applyEnvelope(
  raw: unknown,
  state: RunState,
  callbacks: RunCallbacks,
  runId?: string,
): void {
  if (!isEmployeeOutputEventEnvelope(raw)) return;
  switch (raw.type) {
    case "text":
      if (hasSeenTextEvent("text", raw, state.seenTextEvents)) break;
      if (raw.text.length > 0) {
        state.text += raw.text;
        callbacks.onText?.(raw.text);
      }
      break;
    case "thinking":
      if (hasSeenTextEvent("thinking", raw, state.seenThinkingEvents)) break;
      if (raw.text.length > 0) {
        state.thinking += raw.text;
        callbacks.onThinking?.(raw.text);
      }
      break;
    case "tool_call": {
      const key = toolEventDedupeKey("call", raw);
      if (state.seenToolEvents.has(key)) break;
      state.seenToolEvents.add(key);
      callbacks.onToolCall?.({
        id: raw.id,
        name: raw.name,
        arguments: raw.arguments ?? null,
        status: raw.status ?? null,
        runId,
        sequenceNumber: raw.sequence_number ?? null,
        eventType: raw.event_type ?? null,
        eventKind: raw.kind ?? null,
        itemId: raw.item_id ?? null,
      });
      break;
    }
    case "tool_result": {
      const key = toolEventDedupeKey("result", raw);
      if (state.seenToolEvents.has(key)) break;
      state.seenToolEvents.add(key);
      callbacks.onToolResult?.({
        id: raw.id,
        content: raw.content,
        isError: raw.is_error,
        code: raw.code ?? null,
        retryable: raw.retryable ?? null,
        runId,
        sequenceNumber: raw.sequence_number ?? null,
        eventType: raw.event_type ?? null,
        eventKind: raw.kind ?? null,
        itemId: raw.item_id ?? null,
      });
      break;
    }
    case "tool_audit": {
      const key = toolEventDedupeKey("audit", raw);
      if (state.seenToolEvents.has(key)) break;
      state.seenToolEvents.add(key);
      callbacks.onToolAudit?.({
        ...toolAuditEventFromEnvelope(raw),
        runId,
      });
      break;
    }
    case "error":
      if (!state.errorMessage) state.errorMessage = raw.message;
      break;
    default:
      break;
  }
}

function hasSeenTextEvent(
  channel: string,
  event: Extract<EmployeeOutputEventEnvelope, { type: "text" | "thinking" }>,
  seenEvents: Set<string>,
): boolean {
  const key = textEventDedupeKey(channel, event);
  if (!key) return false;
  if (seenEvents.has(key)) return true;
  seenEvents.add(key);
  return false;
}

function textEventDedupeKey(
  channel: string,
  event: Extract<EmployeeOutputEventEnvelope, { type: "text" | "thinking" }>,
): string | null {
  if (
    typeof event.sequence_number === "number" &&
    Number.isFinite(event.sequence_number)
  ) {
    return `${channel}:seq:${event.sequence_number}`;
  }
  return `${channel}:content:${JSON.stringify([
    event.event_type ?? null,
    event.kind ?? null,
    event.item_id ?? null,
    event.text,
  ])}`;
}

// Dedupe identity is content-based (channel + id + fingerprint), independent of
// sequence_number. Snapshots are cumulative, so the same event reappears in
// every snapshot; keying on content collapses those replays. We deliberately do
// NOT key on sequence_number alone: it can be null in one cumulative snapshot
// and backfilled in a later one for the same logical event, which would defeat
// dedupe and double-fire the callback. sequence_number is still forwarded to
// callbacks for ordering.
function toolEventDedupeKey(
  channel: string,
  event: ToolEventDedupeEnvelope,
): string {
  return `${channel}:event:${event.id ?? "noid"}:${legacyToolEventFingerprint(event)}`;
}

function legacyToolEventFingerprint(event: ToolEventDedupeEnvelope): string {
  const common = [
    event.item_id ?? null,
    event.kind ?? null,
    event.event_type ?? null,
  ];
  switch (event.type) {
    case "tool_call":
      return JSON.stringify([
        ...common,
        event.name,
        event.status ?? "",
        event.arguments ?? "",
      ]);
    case "tool_result":
      return JSON.stringify([
        ...common,
        event.is_error ? "error" : "ok",
        event.content,
      ]);
    case "tool_audit":
      return JSON.stringify([
        ...common,
        event.tool,
        event.reason,
        event.status ?? "",
        event.action ?? "",
        event.lease_ref ?? "",
        event.input_bytes ?? null,
        event.output_bytes ?? null,
        event.latency_ms ?? null,
      ]);
  }
}

function isStartupNotReadyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return STARTUP_NOT_READY_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createClientMessageId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatToolAuditText(
  value: unknown,
  options: ToolAuditFormatOptions,
): string {
  const clean = (text: string) =>
    options.escapeMarkdown
      ? text
          .replace(/\s+/g, " ")
          .trim()
          .replace(/[`*>]/g, (character) => `\\${character}`)
      : text.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return clean(JSON.stringify(value));
  } catch {
    return clean(String(value));
  }
}

function formatToolAuditBytes(label: string, value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${label} ${value}B`
    : null;
}
