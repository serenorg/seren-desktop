// ABOUTME: Imports cloud-backed employee run history into local chat threads.
// ABOUTME: Keeps desktop employee chats aligned with web-created employee conversations.

import {
  assistantTextFromRun,
  type EmployeeOutputEventEnvelope,
  formatToolAuditEvent,
  isFailureStatus,
  outputEventEnvelopes,
  timestampMs,
  toolAuditEventFromEnvelope,
  truncateTitle,
} from "@seren/employees-core";
import {
  type CloudDeploymentRunEvent,
  type CloudInteractiveSessionDetailResponse,
  type CloudInteractiveSessionHistoryMessage,
  serenCloudGetInteractiveSession,
  serenCloudInteractiveSessions,
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
import { conversationStore } from "@/stores/conversation.store";
import { serializeMetadata, type UnifiedMessage } from "@/types/conversation";

const CLOUD_HISTORY_LIMIT = 100;
const CLOUD_MESSAGE_PREVIEW_LIMIT = 1;
const CLOUD_MESSAGE_PAGE_SIZE = 500;
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
  const sessions = await fetchEmployeeSessions(employees);
  if (options.shouldContinue?.() === false) return;

  for (const session of sessions) {
    if (options.shouldContinue?.() === false) return;
    const employee = employees.find(
      (candidate) => candidate.id === session.session.deployment_id,
    );
    if (!employee) continue;
    const conversationId = session.session.session_id;
    await ensureEmployeeConversation(conversationId, employee, session);
    if (options.shouldContinue?.() === false) return;
    const existingMessages = await existingMessageMap(conversationId);
    if (options.shouldContinue?.() === false) return;
    for (const message of session.messages) {
      if (options.shouldContinue?.() === false) return;
      await persistSessionMessage(
        conversationId,
        employee,
        message,
        existingMessages,
      );
    }
    await conversationStore.loadMessagesFor(conversationId);
  }
}

async function fetchEmployeeSessions(
  employees: EmployeeSummary[],
): Promise<CloudInteractiveSessionDetailResponse[]> {
  const results = await Promise.all(
    employees.map(async (employee) => {
      const sessions: CloudInteractiveSessionDetailResponse[] = [];
      let offset = 0;
      while (true) {
        const { data, error, response } = await serenCloudInteractiveSessions({
          path: { id: employee.id },
          query: {
            limit: CLOUD_HISTORY_LIMIT,
            offset,
            message_limit: CLOUD_MESSAGE_PREVIEW_LIMIT,
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
        for (const session of page) {
          sessions.push(await fetchEmployeeSessionMessages(employee, session));
        }
        const pagination = data?.pagination;
        if (!pagination?.has_more) break;
        const nextOffset = pagination.offset + pagination.count;
        if (nextOffset <= offset) break;
        offset = nextOffset;
      }
      return sessions;
    }),
  );
  return results.flat();
}

async function fetchEmployeeSessionMessages(
  employee: EmployeeSummary,
  session: CloudInteractiveSessionDetailResponse,
): Promise<CloudInteractiveSessionDetailResponse> {
  const messages: CloudInteractiveSessionHistoryMessage[] = [];
  let messagePagination = session.message_pagination;
  for (let offset = 0; ; ) {
    const { data, error, response } = await serenCloudGetInteractiveSession({
      path: {
        id: employee.id,
        session_id: session.session.session_id,
      },
      query: {
        message_limit: CLOUD_MESSAGE_PAGE_SIZE,
        message_offset: offset,
        message_order: "asc",
      },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to sync employee chat ${session.session.session_id} for ${employee.name}: ${formatApiError(
          error,
          response,
          "",
        )}`,
      );
    }
    const detail = data?.data;
    if (!detail) break;
    messages.push(...detail.messages);
    messagePagination = detail.message_pagination;
    if (!messagePagination.has_more) break;
    const nextOffset = messagePagination.offset + messagePagination.count;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }
  return {
    ...session,
    messages,
    message_pagination: messagePagination,
  };
}

async function ensureEmployeeConversation(
  conversationId: string,
  employee: EmployeeSummary,
  session: CloudInteractiveSessionDetailResponse,
): Promise<void> {
  if (conversationStore.conversations.some((c) => c.id === conversationId)) {
    return;
  }
  try {
    const row = await createConversation(
      conversationId,
      titleFromSession(session, employee),
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

async function persistSessionMessage(
  conversationId: string,
  employee: EmployeeSummary,
  message: CloudInteractiveSessionHistoryMessage,
  existingMessages: Map<string, StoredMessage>,
): Promise<void> {
  if (!message.run) {
    await saveCloudMessage(
      draftFromUnifiedMessage(
        {
          id: `${message.message_id}:user`,
          type: "user",
          role: "user",
          content: message.content,
          timestamp: timestampMs(message.created_at),
          status: "complete",
          request: {
            prompt: message.content,
            employeeId: employee.id,
          },
        },
        conversationId,
        null,
      ),
      existingMessages,
    );
    return;
  }
  for (const draft of buildRunMessageDrafts(
    conversationId,
    employee,
    message.run,
    message.content,
  )) {
    await saveCloudMessage(draft, existingMessages);
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

function titleFromSession(
  session: CloudInteractiveSessionDetailResponse,
  employee: EmployeeSummary,
): string {
  const firstMessage = session.messages.find((message) =>
    message.content.trim(),
  );
  if (firstMessage) return truncateTitle(firstMessage.content);
  return employee.name;
}

function buildRunMessageDrafts(
  conversationId: string,
  employee: EmployeeSummary,
  run: CloudDeploymentRunEvent,
  userTextOverride?: string,
): CloudMessageDraft[] {
  const messages: CloudMessageDraft[] = [];
  const startedAt = timestampMs(run.started_at);
  const completedAt = timestampMs(run.completed_at ?? run.updated_at);
  const userText = userTextOverride ?? "";
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

function cloudEventRequest(
  employeeId: string,
  runId: string,
  event: EmployeeOutputEventEnvelope,
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

function eventKey(event: EmployeeOutputEventEnvelope, index: number): string {
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

function advisoryText(event: EmployeeOutputEventEnvelope): string {
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
