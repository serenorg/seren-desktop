export const EMPLOYEE_RUN_SOURCE_API = "api";

const DEFAULT_POLL_INTERVAL_MS = 600;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_MAX_RETRY_ATTEMPTS = 1;
const DEFAULT_STARTUP_RETRY_INTERVAL_MS = 2_000;
const DEFAULT_STARTUP_RETRY_TIMEOUT_MS = 2 * 60 * 1000;

const STARTUP_NOT_READY_MARKERS = ["deployment is still starting"];

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
}

export interface EmployeeInteractiveSessionMessageLike {
  run?: EmployeeRunInvocationLike | null;
}

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

export interface RunCallbacks {
  onText?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolCall?: (event: ToolCallEvent) => void;
  onToolResult?: (event: ToolResultEvent) => void;
  onToolAudit?: (event: ToolAuditEvent) => void;
  onStartupWait?: (event: StartupWaitEvent) => void;
}

export interface RunOptions extends RunCallbacks {
  signal?: AbortSignal;
  conversationId?: string;
  runKey?: string;
  extraPayload?: Record<string, unknown>;
  interactiveSessionId?: string | null;
  createInteractiveSession?: boolean;
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
  }): Promise<AsyncIterable<unknown>>;
  cancelRun(input: { deploymentId: string; runId: string }): Promise<void>;
}

export interface EmployeeRunManagerOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  streamMaxRetryAttempts?: number;
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
  seenToolEvents: Set<string>;
}

interface TerminalRun {
  status: string;
  statusMessage: string | null;
  output: string | null;
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
        const recovered: RunState = {
          text: "",
          thinking: "",
          errorMessage: null,
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
        seenToolEvents: new Set<string>(),
      };
      try {
        const stream = await api.streamRun({
          deploymentId,
          runId,
          signal,
          maxRetryAttempts: streamMaxRetryAttempts,
        });
        for await (const raw of stream) {
          signal.throwIfAborted();
          applyEnvelope(raw, state, callbacks, runId);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        managerOptions.onStreamOpenError?.(error);
      }

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
    const posted = await api.postSessionMessage({
      deploymentId,
      sessionId,
      content: message,
      clientMessageId: createClientMessageId(),
      idempotencyKey: createClientMessageId(),
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
    return (await api.createSession({ deploymentId, signal })).session_id;
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

export function runStatusLabel(
  status: string,
  statusMessage: string | null,
): string | undefined {
  if (status === "completed") return undefined;
  return statusMessage || status.replace(/_/g, " ");
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
      if (raw.text.length > 0) {
        state.text += raw.text;
        callbacks.onText?.(raw.text);
      }
      break;
    case "thinking":
      if (raw.text.length > 0) {
        state.thinking += raw.text;
        callbacks.onThinking?.(raw.text);
      }
      break;
    case "tool_call": {
      const key = `call:${raw.id}:${raw.kind ?? ""}`;
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
      const key = `result:${raw.id}:${raw.kind ?? ""}`;
      if (state.seenToolEvents.has(key)) break;
      state.seenToolEvents.add(key);
      callbacks.onToolResult?.({
        id: raw.id,
        content: raw.content,
        isError: raw.is_error,
        runId,
        sequenceNumber: raw.sequence_number ?? null,
        eventType: raw.event_type ?? null,
        eventKind: raw.kind ?? null,
        itemId: raw.item_id ?? null,
      });
      break;
    }
    case "tool_audit": {
      const key = `audit:${raw.id}:${raw.kind ?? ""}`;
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
