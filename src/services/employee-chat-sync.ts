// ABOUTME: Imports cloud-backed employee run history into local chat threads.
// ABOUTME: Keeps desktop employee chats aligned with web-created employee conversations.

import {
  type EmployeeOutputEventEnvelope,
  formatToolAuditEvent,
  isFailureStatus,
  outputEventEnvelopes,
  timestampMs,
  toolAuditEventFromEnvelope,
  truncateTitle,
} from "@seren/employees-core";
import {
  type CloudConversationMessageResponse,
  type CloudConversationResponse,
  serenCloudGetConversationMessages,
  serenCloudListConversations,
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
const CLOUD_MESSAGE_PAGE_SIZE = 200;
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

interface CloudEmployeeConversation {
  conversation: CloudConversationResponse;
  messages: CloudConversationMessageResponse[];
}

export async function syncCloudEmployeeChats(
  employees: EmployeeSummary[],
  options: SyncCloudEmployeeChatsOptions = {},
): Promise<void> {
  if (employees.length === 0) return;
  if (options.shouldContinue?.() === false) return;
  const conversations = await fetchEmployeeConversations(employees);
  if (options.shouldContinue?.() === false) return;

  for (const item of conversations) {
    if (options.shouldContinue?.() === false) return;
    const employee = employees.find(
      (candidate) => candidate.id === item.conversation.deployment_id,
    );
    if (!employee) continue;
    const conversationId = item.conversation.conversation_id;
    await ensureEmployeeConversation(conversationId, employee, item);
    if (options.shouldContinue?.() === false) return;
    const existingMessages = await existingMessageMap(conversationId);
    if (options.shouldContinue?.() === false) return;
    for (const message of item.messages) {
      if (options.shouldContinue?.() === false) return;
      await persistConversationMessage(
        conversationId,
        employee,
        message,
        existingMessages,
      );
    }
    await conversationStore.loadMessagesFor(conversationId);
  }
}

async function fetchEmployeeConversations(
  employees: EmployeeSummary[],
): Promise<CloudEmployeeConversation[]> {
  const results = await Promise.all(
    employees.map(async (employee) => {
      const conversations: CloudEmployeeConversation[] = [];
      let cursor: string | undefined;
      while (true) {
        const { data, error, response } = await serenCloudListConversations({
          path: { id: employee.id },
          query: {
            limit: CLOUD_HISTORY_LIMIT,
            cursor,
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
        const page = data?.data.conversations ?? [];
        for (const conversation of page) {
          conversations.push({
            conversation,
            messages: await fetchEmployeeConversationMessages(
              employee,
              conversation,
            ),
          });
        }
        const nextCursor = data?.data.next_cursor ?? undefined;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      return conversations;
    }),
  );
  return results.flat();
}

async function fetchEmployeeConversationMessages(
  employee: EmployeeSummary,
  conversation: CloudConversationResponse,
): Promise<CloudConversationMessageResponse[]> {
  const messages: CloudConversationMessageResponse[] = [];
  let cursor: string | undefined;
  while (true) {
    const { data, error, response } = await serenCloudGetConversationMessages({
      path: {
        id: employee.id,
        conversation_id: conversation.conversation_id,
      },
      query: {
        limit: CLOUD_MESSAGE_PAGE_SIZE,
        cursor,
        // Desktop bulk sync persists messages in chronological order.
        order: "asc",
        include_run: false,
      },
      throwOnError: false,
    });
    if (error) {
      throw new Error(
        `Failed to sync employee chat ${conversation.conversation_id} for ${employee.name}: ${formatApiError(
          error,
          response,
          "",
        )}`,
      );
    }
    const page = data?.data;
    if (!page) break;
    messages.push(...page.messages);
    const nextCursor = page.next_cursor ?? undefined;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return messages;
}

async function ensureEmployeeConversation(
  conversationId: string,
  employee: EmployeeSummary,
  item: CloudEmployeeConversation,
): Promise<void> {
  if (conversationStore.conversations.some((c) => c.id === conversationId)) {
    return;
  }
  try {
    const row = await createConversation(
      conversationId,
      titleFromConversation(item, employee),
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

async function persistConversationMessage(
  conversationId: string,
  employee: EmployeeSummary,
  message: CloudConversationMessageResponse,
  existingMessages: Map<string, StoredMessage>,
): Promise<void> {
  if (message.role === "assistant") {
    for (const draft of buildAssistantMessageDrafts(
      conversationId,
      employee,
      message,
    )) {
      await saveCloudMessage(draft, existingMessages);
    }
    return;
  }
  if (message.content.trim()) {
    const runId =
      message.run_id ?? message.run_summary?.run_id ?? message.run?.id ?? null;
    await saveCloudMessage(
      draftFromUnifiedMessage(
        {
          id:
            message.role === "user" && runId
              ? `${runId}:user`
              : message.message_id,
          type: message.role === "user" ? "user" : "assistant",
          role: message.role === "user" ? "user" : "assistant",
          content: message.content,
          timestamp: timestampMs(message.created_at),
          status: "complete",
          request: {
            prompt: message.content,
            employeeId: employee.id,
            runId: runId ?? undefined,
          },
        },
        conversationId,
        null,
      ),
      existingMessages,
    );
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

function titleFromConversation(
  item: CloudEmployeeConversation,
  employee: EmployeeSummary,
): string {
  if (item.conversation.title?.trim()) return item.conversation.title;
  const firstMessage = item.messages.find((message) => message.content.trim());
  if (firstMessage) return truncateTitle(firstMessage.content);
  return employee.name;
}

function buildAssistantMessageDrafts(
  conversationId: string,
  employee: EmployeeSummary,
  message: CloudConversationMessageResponse,
): CloudMessageDraft[] {
  const messages: CloudMessageDraft[] = [];
  const run = message.run ?? null;
  const runSummary = message.run_summary ?? null;
  const runId = message.run_id ?? runSummary?.run_id ?? run?.id ?? null;
  const turnId = runId ?? message.message_id;
  const startedAt = timestampMs(
    runSummary?.started_at ?? run?.started_at ?? message.created_at,
  );
  const completedAt = timestampMs(
    runSummary?.completed_at ??
      run?.completed_at ??
      runSummary?.updated_at ??
      run?.updated_at ??
      message.updated_at,
  );
  const runStatus = runSummary?.status ?? run?.status ?? "completed";
  const statusMessage = runSummary?.status_message ?? run?.status_message ?? "";
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const eventDrafts = new Map<string, CloudMessageDraft>();
  const eventOrder: string[] = [];
  const events = outputEventEnvelopes(
    message.events.length > 0 ? message.events : run?.output_events,
  );

  const setEventDraft = (draft: CloudMessageDraft) => {
    if (!eventDrafts.has(draft.id)) eventOrder.push(draft.id);
    eventDrafts.set(draft.id, draft);
  };

  events.forEach((event, index) => {
    const timestamp = eventTimestamp(startedAt, index);
    const request = cloudEventRequest(employee.id, runId, event);
    switch (event.type) {
      case "text":
        textParts.push(event.text);
        break;
      case "thinking":
        thinkingParts.push(event.text);
        break;
      case "tool_call": {
        const id = `${turnId}:tool_call:${event.id}`;
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
        const callId = `${turnId}:tool_call:${event.id}`;
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
              id: `${turnId}:tool_result:${event.id}:${eventKey(event, index)}`,
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
            turnId,
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
              turnId,
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

  const assistantText = textParts.join("").trim() || message.content.trim();
  if (assistantText || statusMessage || thinkingParts.length > 0) {
    messages.push(
      draftFromUnifiedMessage(
        {
          id: runId ? `${runId}:assistant` : message.message_id,
          type: "assistant",
          role: "assistant",
          content: assistantText || statusMessage,
          timestamp: completedAt,
          status: isFailureStatus(runStatus) ? "error" : "complete",
          workerType: "employee",
          provider: "seren",
          thinking: thinkingParts.join("").trim() || undefined,
          request: {
            prompt: "",
            employeeId: employee.id,
            runId: runId ?? undefined,
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
  runId: string | null,
  event: EmployeeOutputEventEnvelope,
): UnifiedMessage["request"] {
  return {
    prompt: "",
    employeeId,
    runId: runId ?? undefined,
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
  turnId: string,
  employee: EmployeeSummary,
  suffix: string,
  content: string,
  timestamp: number,
  request: UnifiedMessage["request"],
): CloudMessageDraft {
  return draftFromUnifiedMessage(
    {
      id: `${turnId}:${suffix}`,
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
