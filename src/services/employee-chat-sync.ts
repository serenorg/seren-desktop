// ABOUTME: Imports cloud-backed employee run history into local chat threads.
// ABOUTME: Keeps desktop employee chats aligned with web-created employee conversations.

import {
  type CloudDeploymentRunEvent,
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
import { conversationStore } from "@/stores/conversation.store";

const CLOUD_HISTORY_LIMIT = 100;
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
      const { data, error, response } = await serenCloudDeploymentRuns({
        path: { id: employee.id },
        query: {
          limit: CLOUD_HISTORY_LIMIT,
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
      return data?.data ?? [];
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
  const userText = messageFromInvocationPayload(run.invocation_payload);
  if (userText) {
    await saveCloudMessage(
      {
        id: `${run.id}:user`,
        conversationId,
        role: "user",
        content: userText,
        model: null,
        timestamp: timestampMs(run.started_at),
        metadata: JSON.stringify({ type: "user" }),
        provider: null,
      },
      existingMessages,
    );
  }

  const assistantText = assistantTextFromRun(run);
  if (assistantText || run.status_message) {
    await saveCloudMessage(
      {
        id: `${run.id}:assistant`,
        conversationId,
        role: "assistant",
        content: assistantText || run.status_message || "",
        model: null,
        timestamp: timestampMs(run.completed_at ?? run.updated_at),
        metadata: JSON.stringify({
          type: "assistant",
          workerType: "employee",
          provider: "seren",
          request: { employeeId: employee.id, runId: run.id },
        }),
        provider: "seren",
      },
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
  const messages = await getMessages(conversationId, CLOUD_HISTORY_LIMIT * 2);
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
