// ABOUTME: Imports cloud-backed employee run history into local chat threads.
// ABOUTME: Keeps desktop employee chats aligned with web-created employee conversations.

import {
  type CloudDeploymentRunEvent,
  type CloudRunOutputEventEnvelope,
  serenCloudDeploymentRuns,
} from "@/api/seren-cloud";
import { formatApiError } from "@/lib/api-errors";
import type { EmployeeSummary } from "@/lib/employees/types";
import {
  createConversation,
  getConversation,
  getMessages,
  type Conversation as StoredConversation,
  type StoredMessage,
  saveMessage,
} from "@/lib/tauri-bridge";
import {
  formatToolAuditEvent,
  type ToolAuditEvent,
} from "@/services/employees-runtime";
import { conversationStore } from "@/stores/conversation.store";
import { serializeMetadata, type UnifiedMessage } from "@/types/conversation";

const CLOUD_HISTORY_LIMIT = 100;
const EXISTING_MESSAGE_LIMIT = 2_000;
const DEFAULT_EMPLOYEE_MODEL = "arcee-ai/trinity-large-thinking";

interface CloudMessageDraft {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model: string | null;
  timestamp: number;
  metadata: string | null;
  provider: string | null;
}

interface SyncCloudEmployeeChatsOptions {
  shouldContinue?: () => boolean;
}

export async function syncCloudEmployeeChats(
  employees: EmployeeSummary[],
  options: SyncCloudEmployeeChatsOptions = {},
): Promise<void> {
  if (employees.length === 0) return;
  if (options.shouldContinue?.() === false) return;
  const employeeById = new Map(
    employees.map((employee) => [employee.id, employee]),
  );
  const runs = await fetchEmployeeRuns(employees);
  if (options.shouldContinue?.() === false) return;

  const grouped = new Map<string, CloudDeploymentRunEvent[]>();
  for (const run of runs) {
    if (!employeeById.has(run.deployment_id)) continue;
    const conversationId = run.conversation_id?.trim();
    if (!conversationId) continue;
    const key = `${run.deployment_id}:${conversationId}`;
    const group = grouped.get(key) ?? [];
    group.push(run);
    grouped.set(key, group);
  }

  for (const group of grouped.values()) {
    if (options.shouldContinue?.() === false) return;
    group.sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at),
    );
    const first = group[0];
    const employee = employeeById.get(first.deployment_id);
    const conversationId = first.conversation_id?.trim();
    if (!employee || !conversationId) continue;
    await ensureEmployeeConversation(conversationId, employee, first);
    if (options.shouldContinue?.() === false) return;
    const existingMessages = await existingMessageMap(conversationId);
    if (options.shouldContinue?.() === false) return;
    for (const run of group) {
      if (options.shouldContinue?.() === false) return;
      await persistRunMessages(conversationId, employee, run, existingMessages);
    }
    await conversationStore.loadMessagesFor(conversationId);
  }
}

async function fetchEmployeeRuns(
  employees: EmployeeSummary[],
): Promise<CloudDeploymentRunEvent[]> {
  const results = await Promise.all(
    employees.map(async (employee) => {
      const runs: CloudDeploymentRunEvent[] = [];
      for (let offset = 0; ; offset += CLOUD_HISTORY_LIMIT) {
        const { data, error, response } = await serenCloudDeploymentRuns({
          path: { id: employee.id },
          query: {
            limit: CLOUD_HISTORY_LIMIT,
            offset,
          },
          throwOnError: false,
        });
        if (error) {
          throw new Error(
            `Failed to sync employee chats for ${employee.name}: ${formatApiError(
              error,
              response,
              "",
            )}`,
          );
        }
        const page = data?.data ?? [];
        runs.push(...page);
        if (page.length < CLOUD_HISTORY_LIMIT) break;
      }
      return runs;
    }),
  );
  return results.flat();
}

async function ensureEmployeeConversation(
  conversationId: string,
  employee: EmployeeSummary,
  run: CloudDeploymentRunEvent,
): Promise<void> {
  if (conversationStore.conversations.some((c) => c.id === conversationId)) {
    return;
  }
  try {
    const row = await createConversation(
      conversationId,
      titleFromRun(run, employee),
      DEFAULT_EMPLOYEE_MODEL,
      "seren",
      undefined,
      employee.id,
    );
    conversationStore.upsertFromDb(row as StoredConversation);
  } catch (error) {
    if (!isDuplicateConversationError(error)) throw error;
    const row = await getConversation(conversationId);
    if (row) {
      conversationStore.upsertFromDb(row);
    }
  }
}

async function persistRunMessages(
  conversationId: string,
  employee: EmployeeSummary,
  run: CloudDeploymentRunEvent,
  existingMessages: Map<string, StoredMessage>,
): Promise<void> {
  for (const message of buildRunMessageDrafts(conversationId, employee, run)) {
    await saveCloudMessage(message, existingMessages);
  }
}

async function saveCloudMessage(
  message: CloudMessageDraft,
  existingMessages: Map<string, StoredMessage>,
): Promise<void> {
  const existing = existingMessages.get(message.id);
  if (existing && storedMessageMatches(existing, message)) return;
  try {
    await saveMessage(
      message.id,
      message.conversationId,
      message.role,
      message.content,
      message.model,
      message.timestamp,
      message.metadata,
      message.provider,
    );
    existingMessages.set(message.id, {
      id: message.id,
      conversation_id: message.conversationId,
      role: message.role,
      content: message.content,
      model: message.model,
      timestamp: message.timestamp,
      metadata: message.metadata,
      provider: message.provider,
    });
  } catch (error) {
    if (!isDuplicateWriteError(error)) throw error;
  }
}

async function existingMessageMap(
  conversationId: string,
): Promise<Map<string, StoredMessage>> {
  const messages = await getMessages(conversationId, EXISTING_MESSAGE_LIMIT);
  return new Map(messages.map((message) => [message.id, message]));
}

function storedMessageMatches(
  stored: StoredMessage,
  message: CloudMessageDraft,
): boolean {
  return (
    stored.conversation_id === message.conversationId &&
    stored.role === message.role &&
    stored.content === message.content &&
    (stored.model ?? null) === message.model &&
    stored.timestamp === message.timestamp &&
    (stored.metadata ?? null) === message.metadata &&
    (stored.provider ?? null) === message.provider
  );
}

function isDuplicateConversationError(error: unknown): boolean {
  return isDuplicateWriteError(error);
}

function isDuplicateWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("unique");
}

function titleFromRun(
  run: CloudDeploymentRunEvent,
  employee: EmployeeSummary,
): string {
  const message = messageFromInvocationPayload(run.invocation_payload);
  if (message) return truncateTitle(message);
  return run.run_name?.trim() || employee.name;
}

function messageFromInvocationPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  return stringValue(value.message) ?? stringValue(value.prompt) ?? "";
}

function assistantTextFromRun(run: CloudDeploymentRunEvent): string {
  const fromEvents = textFromOutputEvents(run.output_events);
  if (fromEvents) return fromEvents;
  return run.output?.trim() ?? "";
}

function textFromOutputEvents(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((event) => {
      if (!event || typeof event !== "object") return "";
      const object = event as Record<string, unknown>;
      if (object.type !== "text") return "";
      return stringValue(object.text) ?? "";
    })
    .join("")
    .trim();
}

function buildRunMessageDrafts(
  conversationId: string,
  employee: EmployeeSummary,
  run: CloudDeploymentRunEvent,
): CloudMessageDraft[] {
  const messages: CloudMessageDraft[] = [];
  const startedAt = timestampMs(run.started_at);
  const completedAt = timestampMs(run.completed_at ?? run.updated_at);
  const userText = messageFromInvocationPayload(run.invocation_payload);
  if (userText) {
    messages.push(
      draftFromUnifiedMessage(
        {
          id: `${run.id}:user`,
          type: "user",
          role: "user",
          content: userText,
          timestamp: startedAt,
          status: "complete",
          request: {
            prompt: userText,
            employeeId: employee.id,
            runId: run.id,
          },
        },
        conversationId,
        null,
      ),
    );
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const eventDrafts = new Map<string, CloudMessageDraft>();
  const eventOrder: string[] = [];
  const events = outputEventEnvelopes(run.output_events);

  const setEventDraft = (draft: CloudMessageDraft) => {
    if (!eventDrafts.has(draft.id)) eventOrder.push(draft.id);
    eventDrafts.set(draft.id, draft);
  };

  events.forEach((event, index) => {
    const timestamp = eventTimestamp(startedAt, index);
    const request = cloudEventRequest(employee.id, run.id, event);
    switch (event.type) {
      case "text":
        textParts.push(event.text);
        break;
      case "thinking":
        thinkingParts.push(event.text);
        break;
      case "tool_call": {
        const id = `${run.id}:tool_call:${event.id}`;
        const parameters = parseJsonObject(event.arguments);
        const previous = eventDrafts.get(id);
        const previousToolCall = previous
          ? toolCallFromMetadata(previous.metadata)
          : null;
        setEventDraft(
          draftFromUnifiedMessage(
            {
              id,
              type: "tool_call",
              role: "assistant",
              content: event.name,
              timestamp,
              status:
                event.status && event.status !== "running"
                  ? "complete"
                  : "streaming",
              workerType: "employee",
              toolCallId: event.id,
              toolCall: {
                toolCallId: event.id,
                title: event.name,
                kind: "",
                status: event.status ?? previousToolCall?.status ?? "running",
                name: event.name,
                arguments: event.arguments ?? previousToolCall?.arguments,
                parameters: parameters ?? previousToolCall?.parameters,
                result: previousToolCall?.result,
                isError: previousToolCall?.isError,
              },
              request,
            },
            conversationId,
            "seren",
          ),
        );
        break;
      }
      case "tool_result": {
        const callId = `${run.id}:tool_call:${event.id}`;
        const existing = eventDrafts.get(callId);
        if (existing) {
          const existingToolCall = toolCallFromMetadata(existing.metadata);
          setEventDraft(
            draftFromUnifiedMessage(
              {
                id: callId,
                type: "tool_call",
                role: "assistant",
                content: existing.content,
                timestamp: existing.timestamp,
                status: "complete",
                workerType: "employee",
                toolCallId: event.id,
                toolCall: {
                  toolCallId: event.id,
                  title: existingToolCall?.title ?? existing.content,
                  kind: existingToolCall?.kind ?? "",
                  status: event.is_error ? "error" : "completed",
                  name: existingToolCall?.name,
                  arguments: existingToolCall?.arguments,
                  parameters: existingToolCall?.parameters,
                  result: event.content,
                  isError: event.is_error,
                },
                request,
              },
              conversationId,
              "seren",
            ),
          );
        }
        setEventDraft(
          draftFromUnifiedMessage(
            {
              id: `${run.id}:tool_result:${event.id}:${eventKey(event, index)}`,
              type: "tool_result",
              role: "assistant",
              content: event.content,
              timestamp,
              status: "complete",
              workerType: "employee",
              toolCallId: event.id,
              toolCall: {
                toolCallId: event.id,
                title: "",
                kind: "",
                status: event.is_error ? "error" : "completed",
                isError: event.is_error,
                result: event.content,
              },
              request,
            },
            conversationId,
            "seren",
          ),
        );
        break;
      }
      case "tool_audit":
        setEventDraft(
          advisoryDraft(
            conversationId,
            run,
            employee,
            `tool_audit:${event.id}:${eventKey(event, index)}`,
            `> **Tool audit:** ${formatToolAuditEvent(
              toolAuditEventFromEnvelope(event),
              { escapeMarkdown: true },
            )}`,
            timestamp,
            request,
          ),
        );
        break;
      case "approval_wait":
      case "approval_decision":
      case "workflow":
      case "guardrail_fail":
      case "handoff":
      case "artifact":
      case "error": {
        const content = advisoryText(event);
        if (content) {
          setEventDraft(
            advisoryDraft(
              conversationId,
              run,
              employee,
              `${event.type}:${eventKey(event, index)}`,
              content,
              timestamp,
              request,
            ),
          );
        }
        break;
      }
      default:
        break;
    }
  });

  messages.push(
    ...eventOrder.flatMap((id) => {
      const draft = eventDrafts.get(id);
      return draft ? [draft] : [];
    }),
  );

  const assistantText = textParts.join("").trim() || assistantTextFromRun(run);
  if (assistantText || run.status_message || thinkingParts.length > 0) {
    messages.push(
      draftFromUnifiedMessage(
        {
          id: `${run.id}:assistant`,
          type: "assistant",
          role: "assistant",
          content: assistantText || run.status_message || "",
          timestamp: completedAt,
          status: isFailureStatus(run.status) ? "error" : "complete",
          workerType: "employee",
          provider: "seren",
          thinking: thinkingParts.join("").trim() || undefined,
          request: {
            prompt: userText,
            employeeId: employee.id,
            runId: run.id,
          },
        },
        conversationId,
        "seren",
      ),
    );
  }

  return messages;
}

function draftFromUnifiedMessage(
  message: UnifiedMessage,
  conversationId: string,
  provider: string | null,
): CloudMessageDraft {
  return {
    id: message.id,
    conversationId,
    role: message.role,
    content: message.content,
    model: message.modelId ?? null,
    timestamp: message.timestamp,
    metadata: serializeMetadata(message),
    provider,
  };
}

function outputEventEnvelopes(value: unknown): CloudRunOutputEventEnvelope[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCloudRunOutputEventEnvelope);
}

function isCloudRunOutputEventEnvelope(
  value: unknown,
): value is CloudRunOutputEventEnvelope {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function cloudEventRequest(
  employeeId: string,
  runId: string,
  event: CloudRunOutputEventEnvelope,
): UnifiedMessage["request"] {
  return {
    prompt: "",
    employeeId,
    runId,
    sequenceNumber: event.sequence_number ?? undefined,
    eventType: event.event_type ?? undefined,
    eventKind: event.kind ?? undefined,
    itemId: event.item_id ?? undefined,
  };
}

function eventTimestamp(startedAt: number, index: number): number {
  return startedAt + index;
}

function eventKey(event: CloudRunOutputEventEnvelope, index: number): string {
  return String(event.sequence_number ?? event.item_id ?? event.kind ?? index);
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolCallFromMetadata(metadata: string | null) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as {
      tool_call?: UnifiedMessage["toolCall"];
    };
    if (parsed.tool_call && typeof parsed.tool_call === "object") {
      const tc = parsed.tool_call as unknown as Record<string, unknown>;
      return {
        title: typeof tc.title === "string" ? tc.title : undefined,
        kind: typeof tc.kind === "string" ? tc.kind : undefined,
        status: typeof tc.status === "string" ? tc.status : undefined,
        name: typeof tc.name === "string" ? tc.name : undefined,
        arguments: typeof tc.arguments === "string" ? tc.arguments : undefined,
        parameters:
          tc.parameters && typeof tc.parameters === "object"
            ? (tc.parameters as Record<string, unknown>)
            : undefined,
        result: typeof tc.result === "string" ? tc.result : undefined,
        isError: typeof tc.is_error === "boolean" ? tc.is_error : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function toolAuditEventFromEnvelope(
  event: Extract<CloudRunOutputEventEnvelope, { type: "tool_audit" }>,
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
  };
}

function advisoryDraft(
  conversationId: string,
  run: CloudDeploymentRunEvent,
  employee: EmployeeSummary,
  suffix: string,
  content: string,
  timestamp: number,
  request: UnifiedMessage["request"],
): CloudMessageDraft {
  return draftFromUnifiedMessage(
    {
      id: `${run.id}:${suffix}`,
      type: "assistant",
      role: "assistant",
      content,
      timestamp,
      status: "complete",
      workerType: "employee",
      provider: "seren",
      request: {
        ...request,
        prompt: request?.prompt ?? "",
        employeeId: employee.id,
        runId: run.id,
      },
    },
    conversationId,
    "seren",
  );
}

function advisoryText(event: CloudRunOutputEventEnvelope): string {
  switch (event.type) {
    case "approval_wait":
      return `> **Approval required:** ${event.reason ?? "The employee is waiting for approval."}`;
    case "approval_decision":
      return `> **Approval ${event.decision}:** ${event.reason ?? "Decision recorded."}`;
    case "workflow":
      return `> **Workflow:** ${event.state}`;
    case "guardrail_fail":
      return `> **Guardrail ${event.action}:** ${event.name} ${event.message}`;
    case "handoff":
      return `> **Handoff:** ${event.from_agent ? `${event.from_agent} -> ` : ""}${event.to_agent}${event.reason ? ` (${event.reason})` : ""}`;
    case "artifact":
      return `> **Artifact:** ${event.kind} ${event.uri ?? event.id}`;
    case "error":
      return `> **Run error:** ${event.message}`;
    default:
      return "";
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 48) return trimmed;
  return `${trimmed.slice(0, 45)}...`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function isFailureStatus(status: string): boolean {
  return [
    "failed",
    "cancelled",
    "canceled",
    "timeout",
    "blocked",
    "error",
  ].includes(status);
}
