// ABOUTME: Typed desktop service for the Seren Memory engine.
// ABOUTME: Wraps all live seren-memory MCP tools plus local fallback paths exposed by Tauri.

import { invoke } from "@tauri-apps/api/core";
import { authStore } from "@/stores/auth.store";
import { projectStore } from "@/stores/project.store";
import { settingsStore } from "@/stores/settings.store";
import type {
  MessageMemoryDetail,
  MessageMemoryMetadata,
} from "@/types/conversation";

export const MEMORY_TOOL_NAMES = [
  "session_bootstrap",
  "remember",
  "create_memory",
  "recall",
  "process_conversation",
  "learn_from_error",
  "list_memories",
  "get_memory",
  "update_memory",
  "forget",
  "delete_memory",
  "get_memory_graph",
  "consolidate",
  "configure_publishers",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

export interface MemoryRef {
  id?: string;
  content: string;
}

export interface RecallResult {
  id?: string;
  content: string;
  memory_type: string;
  relevance_score: number;
  vector_score?: number;
  bm25_score?: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

export interface MemoryRecord {
  id?: string;
  memory_id?: string;
  content?: string;
  summary?: string;
  memory_type?: string;
  type?: string;
  confidence?: number;
  relevance_score?: number;
  created_at?: string;
  updated_at?: string;
  source?: unknown;
  provenance?: unknown;
  metadata?: unknown;
}

export interface MemorySessionBootstrapResult {
  prompt: string;
  totalMemories: number;
  source: string;
  memoriesByType: Record<string, MemoryRef[]>;
  messageMemory?: MessageMemoryMetadata;
}

export interface ProcessConversationInput {
  transcript: string;
  projectContext?: string;
  projectId?: string | null;
  sessionId?: string;
  orgId?: string;
}

export interface ProcessConversationResult {
  raw: unknown;
  messageMemory?: MessageMemoryMetadata;
  extractedCount: number;
}

export interface RememberMemoryOptions {
  memoryType?: string;
  metadata?: unknown;
  pin?: boolean;
  sessionId?: string;
  skipConflictCheck?: boolean;
  skipEnrichment?: boolean;
}

export interface AssistantMemoryContext {
  model?: string;
  userQuery?: string;
  sessionId?: string;
  projectContext?: string;
}

export interface DeleteMemoryOptions {
  confirm: boolean;
}

export interface MemoryCorrectionInput {
  messageId: string;
  correction: string;
  memories: MessageMemoryDetail[];
  errorContent?: string;
  fixContent?: string;
}

function isMemoryAvailable(): boolean {
  return settingsStore.get("memoryEnabled") && authStore.isAuthenticated;
}

function requireMemoryAvailable(): void {
  if (!isMemoryAvailable()) {
    throw new Error("Memory feature not available - sign in to Seren");
  }
}

function getProjectId(explicit?: string | null): string | null {
  return explicit ?? projectStore.activeProject?.id ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sourceLabel(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (!isObject(source)) return undefined;
  return (
    asString(source.conversation_id) ??
    asString(source.session_id) ??
    asString(source.message_id) ??
    asString(source.title)
  );
}

function detailFromRecord(
  record: MemoryRecord | Record<string, unknown>,
  fallbackType?: string,
): MessageMemoryDetail | null {
  const raw = record as Record<string, unknown>;
  const id = asString(raw.id) ?? asString(raw.memory_id);
  const metadata = isObject(raw.metadata) ? raw.metadata : undefined;
  const provenance = raw.provenance ?? raw.source ?? metadata?.source;
  const summary =
    asString(raw.summary) ?? asString(raw.content) ?? asString(raw.text);
  if (!summary) return null;

  return {
    id,
    type:
      asString(raw.memory_type) ??
      asString(raw.type) ??
      fallbackType ??
      "memory",
    summary,
    confidence: asNumber(raw.confidence) ?? asNumber(raw.relevance_score),
    recency: asString(raw.updated_at) ?? asString(raw.created_at),
    source:
      sourceLabel(provenance) ??
      sourceLabel(metadata?.provenance) ??
      sourceLabel(metadata),
  };
}

function normalizeMemoryRef(value: unknown): MemoryRef | null {
  if (typeof value === "string") {
    return { content: value };
  }
  if (!isObject(value)) return null;
  const content = asString(value.content) ?? asString(value.summary);
  if (!content) return null;
  return {
    id: asString(value.id) ?? asString(value.memory_id),
    content,
  };
}

function collectRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject);
}

function collectProcessRecords(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw)) return [];
  const directKeys = [
    "memories",
    "created",
    "created_memories",
    "updated",
    "updated_memories",
    "extracted",
    "extracted_memories",
    "records",
    "results",
  ];
  const records = directKeys.flatMap((key) => {
    const value = raw[key];
    if (Array.isArray(value)) return collectRecordArray(value);
    if (isObject(value)) {
      return Object.values(value).flatMap((nested) =>
        collectRecordArray(nested),
      );
    }
    return [];
  });

  const single = isObject(raw.memory) ? [raw.memory] : [];
  return [...records, ...single];
}

function extractionCount(
  raw: unknown,
  captured: MessageMemoryDetail[],
): number {
  if (!isObject(raw)) return captured.length;
  return (
    asNumber(raw.extracted_count) ??
    asNumber(raw.created_count) ??
    asNumber(raw.memory_count) ??
    captured.length
  );
}

function messageMemoryFromProcessResult(
  raw: unknown,
): MessageMemoryMetadata | undefined {
  const captured = collectProcessRecords(raw)
    .map((record) => detailFromRecord(record))
    .filter((detail): detail is MessageMemoryDetail => detail !== null);
  if (captured.length === 0) return undefined;
  return {
    used: [],
    captured,
    captureStatus: "remembered",
  };
}

function messageMemoryFromBootstrap(
  memoriesByType: Record<string, MemoryRef[]>,
): MessageMemoryMetadata | undefined {
  const used = Object.entries(memoriesByType).flatMap(([type, refs]) =>
    refs
      .map((ref) =>
        detailFromRecord(
          {
            id: ref.id,
            content: ref.content,
            memory_type: type,
          },
          type,
        ),
      )
      .filter((detail): detail is MessageMemoryDetail => detail !== null),
  );
  if (used.length === 0) return undefined;
  return { used };
}

function normalizeBootstrapResult(raw: unknown): MemorySessionBootstrapResult {
  const record = isObject(raw) ? raw : {};
  const rawMemories =
    record.memories_by_type ?? record.memoriesByType ?? record.memories ?? {};
  const memoriesByType: Record<string, MemoryRef[]> = {};
  if (isObject(rawMemories)) {
    for (const [type, values] of Object.entries(rawMemories)) {
      const refs = Array.isArray(values)
        ? values
            .map(normalizeMemoryRef)
            .filter((ref): ref is MemoryRef => ref !== null)
        : [];
      if (refs.length > 0) memoriesByType[type] = refs;
    }
  }
  const prompt =
    asString(record.prompt) ?? asString(record.assembled_prompt) ?? "";
  const totalMemories =
    asNumber(record.total_memories) ??
    asNumber(record.totalMemories) ??
    Object.values(memoriesByType).reduce((sum, refs) => sum + refs.length, 0);

  return {
    prompt,
    totalMemories,
    source: asString(record.source) ?? "unknown",
    memoriesByType,
    messageMemory: messageMemoryFromBootstrap(memoriesByType),
  };
}

function mergeProjectContext<T extends { projectId?: string | null }>(
  input?: T,
): T & { projectId: string | null } {
  return {
    ...(input ?? ({} as T)),
    projectId: getProjectId(input?.projectId),
  };
}

export async function rememberMemory(
  content: string,
  memoryTypeOrOptions: string | RememberMemoryOptions = "semantic",
): Promise<string> {
  requireMemoryAvailable();
  const options =
    typeof memoryTypeOrOptions === "string"
      ? { memoryType: memoryTypeOrOptions }
      : memoryTypeOrOptions;

  const args: Record<string, unknown> = {
    content,
    memoryType: options.memoryType ?? "semantic",
    projectId: getProjectId(),
  };
  if (options.metadata !== undefined) args.metadata = options.metadata;
  if (options.pin !== undefined) args.pin = options.pin;
  if (options.sessionId !== undefined) args.sessionId = options.sessionId;
  if (options.skipConflictCheck !== undefined) {
    args.skipConflictCheck = options.skipConflictCheck;
  }
  if (options.skipEnrichment !== undefined) {
    args.skipEnrichment = options.skipEnrichment;
  }
  return invoke<string>("memory_remember", args);
}

export async function createMemory(input: {
  content: string;
  memoryType: string;
  metadata?: unknown;
  sessionId?: string;
  orgId?: string;
  projectId?: string | null;
}): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_create_memory", mergeProjectContext(input));
}

export async function recallMemories(
  query: string,
  limit = 5,
): Promise<RecallResult[]> {
  if (!isMemoryAvailable()) {
    return [];
  }

  try {
    return await invoke<RecallResult[]>("memory_recall", {
      query,
      projectId: getProjectId(),
      limit,
    });
  } catch (error) {
    console.warn("[Memory] Failed to recall memories:", error);
    return [];
  }
}

export async function listMemories(
  input: {
    memoryType?: string;
    isPinned?: boolean;
    isConsolidated?: boolean;
    sessionId?: string;
    orgId?: string;
    projectId?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_list_memories", mergeProjectContext(input));
}

export async function getMemory(memoryId: string): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_get_memory", { memoryId });
}

export async function updateMemory(
  memoryId: string,
  updates: {
    content?: string;
    summary?: string;
    metadata?: unknown;
    isPinned?: boolean;
  },
): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_update_memory", { memoryId, ...updates });
}

export async function forgetMemory(memoryId: string): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_forget", { memoryId });
}

export async function deleteMemory(
  memoryId: string,
  options: DeleteMemoryOptions,
): Promise<unknown> {
  if (!options.confirm) {
    throw new Error("Permanent memory delete requires confirmation");
  }
  requireMemoryAvailable();
  return invoke("memory_delete_memory", { memoryId, confirm: true });
}

export async function getMemoryGraph(
  memoryId: string,
  depth?: number,
): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_get_memory_graph", { memoryId, depth });
}

export async function consolidateMemories(
  input: {
    projectId?: string | null;
    olderThanDays?: number;
    staleAgeDays?: number;
    staleMaxRelevance?: number;
    minClusterSize?: number;
  } = {},
): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_consolidate", mergeProjectContext(input));
}

export async function learnFromErrorMemory(input: {
  errorContent: string;
  fixContent: string;
  metadata?: unknown;
  orgId?: string;
  projectId?: string | null;
}): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_learn_from_error", mergeProjectContext(input));
}

export async function configureMemoryPublishers(input: {
  publishers: Array<{
    publisher_slug: string;
    role: string;
    enabled: boolean;
    config?: unknown;
    trigger_conditions?: unknown;
  }>;
  orgId?: string;
}): Promise<unknown> {
  requireMemoryAvailable();
  return invoke("memory_configure_publishers", input);
}

export async function syncMemories(): Promise<SyncResult | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const userId = authStore.user?.id ?? null;
  const projectId = getProjectId();

  try {
    return await invoke<SyncResult>("memory_sync", {
      userId,
      projectId,
    });
  } catch (error) {
    console.warn("[Memory] Failed to sync memories:", error);
    return null;
  }
}

export function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        settled = true;
        resolve(null);
      },
      Math.max(0, deadlineMs),
    );

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function bootstrapMemoryContextDetails(
  input: {
    tokenBudget?: number;
    orgId?: string;
    projectId?: string | null;
    deadlineMs?: number;
  } = {},
): Promise<MemorySessionBootstrapResult | null> {
  if (!isMemoryAvailable()) {
    return null;
  }

  const deadlineMs = input.deadlineMs ?? 2500;
  const startedAt = performance.now();
  try {
    const raw = await raceWithDeadline(
      invoke("memory_session_bootstrap", {
        projectId: getProjectId(input.projectId),
        orgId: input.orgId,
        tokenBudget: input.tokenBudget,
      }),
      deadlineMs,
    );
    if (raw === null) {
      console.warn(
        `[Memory] bootstrap deadline ${deadlineMs}ms exceeded — proceeding without memory context`,
      );
      return null;
    }
    const result = normalizeBootstrapResult(raw);
    console.info(
      `[Memory] bootstrap served from ${result.source} in ${Math.round(performance.now() - startedAt)}ms`,
    );
    return result.prompt || result.totalMemories > 0 ? result : null;
  } catch (error) {
    console.warn("[Memory] Failed to bootstrap memory context:", error);
    return null;
  }
}

export async function bootstrapMemoryContext(): Promise<string | null> {
  const result = await bootstrapMemoryContextDetails();
  return result?.prompt || null;
}

export async function processConversationMemory(
  input: ProcessConversationInput,
): Promise<ProcessConversationResult | null> {
  if (!isMemoryAvailable()) {
    return null;
  }
  if (!input.transcript.trim()) {
    return null;
  }

  const raw = await invoke("memory_process_conversation", {
    transcript: input.transcript,
    projectId: getProjectId(input.projectId),
    sessionId: input.sessionId,
    orgId: input.orgId,
    projectContext: input.projectContext,
  });
  const messageMemory = messageMemoryFromProcessResult(raw);
  const captured = messageMemory?.captured ?? [];
  return {
    raw,
    messageMemory,
    extractedCount: extractionCount(raw, captured),
  };
}

export async function processConversationTurn(
  userMessage: string,
  assistantMessage: string,
  context?: AssistantMemoryContext,
): Promise<ProcessConversationResult | null> {
  if (!assistantMessage.trim()) {
    return null;
  }
  const metadata = context?.model
    ? `\n\nMetadata:\nModel: ${context.model}`
    : "";
  return processConversationMemory({
    transcript: `User: ${userMessage}\n\nAssistant: ${assistantMessage}${metadata}`,
    sessionId: context?.sessionId,
    projectContext: context?.projectContext,
  });
}

export async function processAssistantResponseMemory(
  response: string,
  context?: AssistantMemoryContext,
): Promise<ProcessConversationResult | null> {
  if (!response.trim()) {
    return null;
  }
  const content = context?.userQuery
    ? `User: ${context.userQuery}\n\nAssistant: ${response}`
    : `Assistant: ${response}`;
  const metadata = context?.model
    ? `\n\nMetadata:\nModel: ${context.model}`
    : "";
  return processConversationMemory({
    transcript: `${content}${metadata}`,
    sessionId: context?.sessionId,
    projectContext: context?.projectContext,
  });
}

export const storeConversationTurn = processConversationTurn;
export const storeAssistantResponse = processAssistantResponseMemory;

export async function suppressMemoryForAnswer(
  memoryId: string,
  messageId: string,
  reason?: string,
): Promise<unknown> {
  return updateMemory(memoryId, {
    metadata: {
      suppressed_for_answer: messageId,
      suppress_reason: reason ?? "operator requested contextual suppression",
    },
  });
}

export async function correctAnswerMemory(
  input: MemoryCorrectionInput,
): Promise<string> {
  const correction = input.correction.trim();
  if (!correction) {
    throw new Error("Correction is required");
  }
  const lower = correction.toLowerCase();
  const target = input.memories.find((memory) => memory.id);

  if (
    input.errorContent &&
    input.fixContent &&
    /\b(error|failure|failed|fix|tool|build|test|runtime)\b/.test(lower)
  ) {
    await learnFromErrorMemory({
      errorContent: input.errorContent,
      fixContent: input.fixContent,
      metadata: { correction, answer_id: input.messageId },
    });
    return "Learned the error fix for future runs.";
  }

  if (target?.id && /\b(forget|remove|delete|wrong|false)\b/.test(lower)) {
    await forgetMemory(target.id);
    return "Forgot the incorrect remembered detail.";
  }

  if (
    target?.id &&
    /\b(do not use|don't use|not here|suppress)\b/.test(lower)
  ) {
    await suppressMemoryForAnswer(target.id, input.messageId, correction);
    return "Suppressed that memory for this answer context.";
  }

  if (target?.id) {
    await updateMemory(target.id, {
      summary: correction,
      metadata: { corrected_from_answer: input.messageId },
    });
    return "Updated the remembered detail.";
  }

  await rememberMemory(correction, {
    memoryType: "preference",
    metadata: { corrected_from_answer: input.messageId },
  });
  return "Stored the correction for future answers.";
}
