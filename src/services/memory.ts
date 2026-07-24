// ABOUTME: Typed desktop service for the Seren Memory engine.
// ABOUTME: Uses the generated Hey API client for the Seren Memory REST surface.

import {
  type MemoryOutput as ApiMemoryOutput,
  appendMemory as appendMemoryApi,
  type DeleteMemoryResponse,
  deleteMemory as deleteMemoryApi,
  type ForgetMemoryResponse,
  forgetMemory as forgetMemoryApi,
  getMemory as getMemoryApi,
  type ListMemoriesResponse,
  learnFromError,
  listMemories as listMemoriesApi,
  type MemoryEdge,
  memoryTimeline,
  processConversation,
  type RememberOutput,
  recall,
  remember,
  sessionBootstrap,
} from "@/api/seren-memory";
import { authStore } from "@/stores/auth.store";
import { privacyStore } from "@/stores/privacy.store";
import { projectStore } from "@/stores/project.store";
import { settingsStore } from "@/stores/settings.store";
import type {
  MessageMemoryDetail,
  MessageMemoryMetadata,
} from "@/types/conversation";

// Conversation-level source URI shared by every retained turn in a conversation.
// The memory service treats `source_uri` as the conversation grouping key and
// matches it exactly, so `delete_memories_by_source` can erase the whole
// conversation's retained sources in one call. `source_external_id` stays
// per-message. The Rust delete cascade rebuilds this same string
// (`conversation_source_uri` in `src-tauri/src/commands/chat.rs`) - keep both in
// sync.
export function conversationSourceUri(conversationId: string): string {
  return `seren://desktop/conversations/${conversationId}`;
}
export interface MemoryRef {
  id?: string;
  content: string;
}

export type RecallResult = Pick<
  ApiMemoryOutput,
  "id" | "content" | "memory_type" | "relevance_score"
>;

/** Loosely-shaped memory row accepted by {@link detailFromRecord}. */
type MemoryRecord = Partial<ApiMemoryOutput> & {
  memory_id?: string;
  type?: string;
  confidence?: number;
  source?: unknown;
  provenance?: unknown;
};

export interface MemorySessionBootstrapResult {
  prompt: string;
  totalMemories: number;
  source: string;
  memoriesByType: Record<string, MemoryRef[]>;
  messageMemory?: MessageMemoryMetadata;
}

export interface ProcessConversationInput {
  transcript: string;
  conversationId?: string;
  projectContext?: string;
  projectId?: string | null;
  sessionId?: string;
  orgId?: string;
  retainSource?: boolean;
  sourceExternalId?: string;
  sourceRevision?: string;
  sourceUri?: string;
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
  conversationId?: string;
  model?: string;
  userQuery?: string;
  sessionId?: string;
  projectContext?: string;
  sourceExternalId?: string;
  sourceRevision?: string;
  sourceUri?: string;
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

/** A memory the operator excluded from one answer, without changing the store. */
export interface SuppressedMemory {
  memoryId: string;
  messageId: string;
  reason: string;
}

export interface MemoryCorrectionResult {
  /** Operator-facing description of what the correction did. */
  notice: string;
  /**
   * Memory the answer must stop citing: either suppressed for this answer only
   * or removed from the store outright.
   */
  droppedMemoryId?: string;
}

/** Memory types the engine accepts; anything else is rejected as a 400. */
const MEMORY_TYPES = new Set([
  "episodic",
  "semantic",
  "procedural",
  "code",
  "error_fix",
  "preference",
  "skill",
]);

function normalizeMemoryType(value: string | undefined): string {
  return value && MEMORY_TYPES.has(value) ? value : "semantic";
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

function memoryApiError(operation: string, error: unknown): Error {
  const detail = isObject(error)
    ? (asString(error.message) ?? asString(error.error))
    : asString(error);
  return new Error(
    detail ? `Failed to ${operation}: ${detail}` : `Failed to ${operation}`,
  );
}

function requireApiData<T>(
  operation: string,
  response: { data: T } | undefined,
  error: unknown,
): T {
  if (error || !response) {
    throw memoryApiError(operation, error);
  }
  return response.data;
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

/**
 * `ExtractionResult` group keys paired with the `memory_type` the engine
 * stores them under. The order must match the engine's insert order in
 * `process_conversation`, because `stored_memory_ids` is a positional list
 * over the concatenation of these groups.
 */
const EXTRACTION_GROUPS = [
  ["episodic", "episodic"],
  ["semantic", "semantic"],
  ["procedural", "procedural"],
  ["error_fixes", "error_fix"],
  ["preferences", "preference"],
] as const;

function storedMemoryIds(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.stored_memory_ids)
    ? raw.stored_memory_ids
        .map(asString)
        .filter((id): id is string => id !== undefined)
    : [];
}

function collectProcessRecords(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw)) return [];
  const extracted = EXTRACTION_GROUPS.flatMap(([key, memoryType]) =>
    collectRecordArray(raw[key]).map((record) => ({
      ...record,
      memory_type: memoryType,
    })),
  );

  // Positional correlation only holds when the engine stored every extracted
  // memory. A shorter or longer id list means the response took a different
  // path (a deduplicated conversation source, for example), and pairing by
  // index would label memories with an unrelated memory's id.
  const ids = storedMemoryIds(raw);
  if (ids.length !== extracted.length) return extracted;
  return extracted.map((record, index) => ({ ...record, id: ids[index] }));
}

function extractionCount(
  raw: unknown,
  captured: MessageMemoryDetail[],
): number {
  if (!isObject(raw)) return captured.length;
  const ids = storedMemoryIds(raw);
  return ids.length > 0 ? ids.length : captured.length;
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
    asString(record.prompt) ??
    asString(record.assembled_prompt) ??
    Object.entries(memoriesByType)
      .flatMap(([type, memories]) =>
        memories.map((memory) => `- [${type}] ${memory.content}`),
      )
      .join("\n");
  const totalMemories =
    asNumber(record.total_memories) ??
    asNumber(record.totalMemories) ??
    Object.values(memoriesByType).reduce((sum, refs) => sum + refs.length, 0);

  return {
    prompt: prompt ? `## Relevant memories\n${prompt}` : "",
    totalMemories,
    source: asString(record.source) ?? "seren-memory",
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

  const body = {
    content,
    memory_type: options.memoryType ?? "semantic",
    project_id: getProjectId(),
    metadata: options.metadata,
    pin: options.pin,
    session_id: options.sessionId,
    skip_conflict_check: options.skipConflictCheck,
    skip_enrichment: options.skipEnrichment,
  };
  const { data, error } = await remember({
    body,
    throwOnError: false,
  });
  return requireApiData("remember memory", data, error).memory_id;
}

export async function recallMemories(
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<RecallResult[]> {
  if (!isMemoryAvailable()) {
    return [];
  }

  try {
    const { data, error } = await recall({
      body: {
        query,
        project_id: getProjectId(),
        limit,
      },
      signal,
      throwOnError: false,
    });
    return requireApiData("recall memories", data, error).memories.map(
      (memory) => ({
        id: memory.id,
        content: memory.content,
        memory_type: memory.memory_type,
        relevance_score: memory.relevance_score,
      }),
    );
  } catch (error) {
    console.warn("[Memory] Failed to recall memories:", error);
    return [];
  }
}

export async function recallMemoryContext(
  query: string,
  limit = 5,
  deadlineMs = 2500,
): Promise<{ prompt: string; details: MessageMemoryDetail[] } | null> {
  if (!isMemoryAvailable() || !query.trim()) {
    return null;
  }

  const startedAt = performance.now();
  const abort = new AbortController();
  const results = await raceWithDeadline(
    recallMemories(query, limit, abort.signal),
    deadlineMs,
  );
  if (results === null) {
    // Nothing will read the response once the deadline passes; releasing the
    // request also cancels the Rust-side Gateway stream in the desktop shell.
    abort.abort();
    console.warn(
      `[Memory] recall deadline ${deadlineMs}ms exceeded — proceeding without recalled context`,
    );
    return null;
  }

  const details = results
    .map((record) =>
      detailFromRecord(
        {
          id: record.id,
          content: record.content,
          memory_type: record.memory_type,
        },
        record.memory_type,
      ),
    )
    .filter((detail): detail is MessageMemoryDetail => detail !== null);
  if (details.length === 0) {
    console.info(
      `[Memory] recall injected 0 memories in ${Math.round(performance.now() - startedAt)}ms`,
    );
    return null;
  }

  const prompt = [
    "## Relevant memories for this request",
    ...details.map((detail) => `- [${detail.type}] ${detail.summary}`),
  ].join("\n");
  console.info(
    `[Memory] recall injected ${details.length} memories in ${Math.round(performance.now() - startedAt)}ms`,
  );
  return { prompt, details };
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
): Promise<ListMemoriesResponse> {
  requireMemoryAvailable();
  const scoped = mergeProjectContext(input);
  const { data, error } = await listMemoriesApi({
    query: {
      memory_type: scoped.memoryType,
      is_pinned: scoped.isPinned,
      is_consolidated: scoped.isConsolidated,
      project_id: scoped.projectId ?? undefined,
      org_id: scoped.orgId,
      limit: scoped.limit,
      offset: scoped.offset,
    },
    throwOnError: false,
  });
  return requireApiData("list memories", data, error);
}

export async function getMemory(
  memoryId: string,
): Promise<ApiMemoryOutput | null> {
  requireMemoryAvailable();
  const { data, error } = await getMemoryApi({
    path: { id: memoryId },
    throwOnError: false,
  });
  return requireApiData("get memory", data, error);
}

/**
 * Append text to an existing memory. The engine concatenates the addition onto
 * the stored content and records a new revision — it does not replace content,
 * and the REST surface has no metadata-only or pin-only update. Use
 * {@link supersedeMemory} when the stored content is wrong rather than
 * incomplete.
 */
export async function appendToMemory(
  memoryId: string,
  addition: string,
): Promise<ApiMemoryOutput> {
  requireMemoryAvailable();
  if (!addition.trim()) {
    throw new Error("Appending to a memory requires content");
  }
  const { data, error } = await appendMemoryApi({
    path: { id: memoryId },
    body: { content: addition },
    throwOnError: false,
  });
  return requireApiData("append to memory", data, error);
}

export interface SupersedeMemoryResult {
  /** Id of the newly stored correction. */
  memoryId: string;
  /** False when the correction was stored but the replaced memory survived. */
  replacedMemoryForgotten: boolean;
}

/**
 * Replace a memory whose content is wrong. The REST surface has no in-place
 * content update, so the correction is stored as a new memory and the
 * incorrect one is soft-deleted.
 *
 * The correction is written first because `forget` has no REST inverse: if the
 * write failed after forgetting, both the original detail and the correction
 * would be lost. Storing first fails safe - the original survives and the
 * caller sees the error.
 *
 * Conflict resolution is skipped because the caller already identified the
 * memory being replaced. Left enabled, the engine compares the correction
 * against live memories of the same type and treats a close match as a
 * duplicate, reinforcing that memory and storing nothing - which would discard
 * the correction while still removing the detail it was meant to replace.
 */
export async function supersedeMemory(
  memoryId: string,
  correction: string,
  options: { memoryType?: string; metadata?: Record<string, unknown> } = {},
): Promise<SupersedeMemoryResult> {
  requireMemoryAvailable();
  const storedMemoryId = await rememberMemory(correction, {
    memoryType: normalizeMemoryType(options.memoryType),
    metadata: { ...options.metadata, supersedes_memory_id: memoryId },
    skipConflictCheck: true,
  });

  try {
    await forgetMemory(memoryId);
    return { memoryId: storedMemoryId, replacedMemoryForgotten: true };
  } catch (error) {
    console.warn(
      `[Memory] stored correction ${storedMemoryId} but could not forget ${memoryId}:`,
      error,
    );
    return { memoryId: storedMemoryId, replacedMemoryForgotten: false };
  }
}

export async function forgetMemory(
  memoryId: string,
): Promise<ForgetMemoryResponse> {
  requireMemoryAvailable();
  const { data, error } = await forgetMemoryApi({
    body: { memory_id: memoryId },
    throwOnError: false,
  });
  return requireApiData("forget memory", data, error);
}

export async function deleteMemory(
  memoryId: string,
  options: DeleteMemoryOptions,
): Promise<DeleteMemoryResponse> {
  if (!options.confirm) {
    throw new Error("Permanent memory delete requires confirmation");
  }
  requireMemoryAvailable();
  const { data, error } = await deleteMemoryApi({
    path: { id: memoryId },
    throwOnError: false,
  });
  return requireApiData("delete memory", data, error);
}

export async function getMemoryTimeline(
  memoryId: string,
  asOf?: string,
): Promise<MemoryEdge[]> {
  requireMemoryAvailable();
  const { data, error } = await memoryTimeline({
    path: { id: memoryId },
    query: { as_of: asOf },
    throwOnError: false,
  });
  return requireApiData("get memory timeline", data, error);
}

export async function learnFromErrorMemory(input: {
  errorContent: string;
  fixContent: string;
  metadata?: unknown;
  orgId?: string;
  projectId?: string | null;
}): Promise<RememberOutput> {
  requireMemoryAvailable();
  const scoped = mergeProjectContext(input);
  const { data, error } = await learnFromError({
    body: {
      error_content: scoped.errorContent,
      fix_content: scoped.fixContent,
      metadata: scoped.metadata,
      org_id: scoped.orgId,
      project_id: scoped.projectId,
    },
    throwOnError: false,
  });
  return requireApiData("learn from error", data, error);
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
  const abort = new AbortController();
  try {
    const response = await raceWithDeadline(
      sessionBootstrap({
        body: {
          project_id: getProjectId(input.projectId),
          org_id: input.orgId,
          token_budget: input.tokenBudget,
        },
        signal: abort.signal,
        throwOnError: false,
      }),
      deadlineMs,
    );
    if (response === null) {
      // See recallMemoryContext: release the abandoned request.
      abort.abort();
      console.warn(
        `[Memory] bootstrap deadline ${deadlineMs}ms exceeded — proceeding without memory context`,
      );
      return null;
    }
    const raw = requireApiData(
      "bootstrap memory context",
      response.data,
      response.error,
    );
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
  if (
    input.conversationId &&
    privacyStore.isMemoryExcluded(input.conversationId)
  ) {
    return null;
  }
  if (!isMemoryAvailable()) {
    return null;
  }
  if (!input.transcript.trim()) {
    return null;
  }

  const { data, error } = await processConversation({
    body: {
      transcript: input.transcript,
      project_id: getProjectId(input.projectId),
      session_id: input.sessionId,
      org_id: input.orgId,
      project_context: input.projectContext,
      retain_source: input.retainSource,
      source_external_id: input.sourceExternalId,
      source_revision: input.sourceRevision,
      source_uri: input.sourceUri,
    },
    throwOnError: false,
  });
  const raw = requireApiData("process conversation", data, error);
  const messageMemory = messageMemoryFromProcessResult(raw);
  const captured = messageMemory?.captured ?? [];
  return {
    raw,
    messageMemory,
    extractedCount: extractionCount(raw, captured),
  };
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
  const sourceExternalId = context?.sourceExternalId;
  return processConversationMemory({
    transcript: `${content}${metadata}`,
    conversationId: context?.conversationId,
    sessionId: context?.sessionId,
    projectContext: context?.projectContext,
    retainSource:
      sourceExternalId !== undefined &&
      settingsStore.get("sourceRetentionEnabled") === true,
    sourceExternalId,
    sourceRevision: context?.sourceRevision,
    sourceUri: context?.sourceUri,
  });
}

export const storeAssistantResponse = processAssistantResponseMemory;

/**
 * Stop a memory from being cited for one answer without changing the stored
 * memory. Suppression is scoped to a single message, and the memory service
 * has no per-answer suppression concept, so the record is kept on the message
 * the caller persists. Use {@link forgetMemory} to remove the memory itself.
 */
export function suppressMemoryForAnswer(
  memoryId: string,
  messageId: string,
  reason?: string,
): SuppressedMemory {
  return {
    memoryId,
    messageId,
    reason: reason ?? "operator requested contextual suppression",
  };
}

export async function correctAnswerMemory(
  input: MemoryCorrectionInput,
): Promise<MemoryCorrectionResult> {
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
    return { notice: "Learned the error fix for future runs." };
  }

  if (target?.id && /\b(forget|remove|delete|wrong|false)\b/.test(lower)) {
    await forgetMemory(target.id);
    return {
      notice: "Forgot the incorrect remembered detail.",
      droppedMemoryId: target.id,
    };
  }

  if (
    target?.id &&
    /\b(do not use|don't use|not here|suppress)\b/.test(lower)
  ) {
    const suppressed = suppressMemoryForAnswer(
      target.id,
      input.messageId,
      correction,
    );
    return {
      notice: "Suppressed that memory for this answer context.",
      droppedMemoryId: suppressed.memoryId,
    };
  }

  if (target?.id) {
    const { replacedMemoryForgotten } = await supersedeMemory(
      target.id,
      correction,
      {
        memoryType: target.type,
        metadata: { corrected_from_answer: input.messageId },
      },
    );
    // The outdated detail is still recallable when forgetting failed, so the
    // answer keeps citing it rather than reporting a removal that did not
    // happen.
    return replacedMemoryForgotten
      ? {
          notice: "Replaced the remembered detail with your correction.",
          droppedMemoryId: target.id,
        }
      : {
          notice:
            "Stored your correction, but the outdated detail could not be removed.",
        };
  }

  await rememberMemory(correction, {
    memoryType: "preference",
    metadata: { corrected_from_answer: input.messageId },
  });
  return { notice: "Stored the correction for future answers." };
}
