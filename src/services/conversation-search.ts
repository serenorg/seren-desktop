// ABOUTME: Conversation history search service combining exact FTS and semantic hits.
// ABOUTME: Owns all IPC and embedding calls for chat/agent history search UI.

import { invoke } from "@tauri-apps/api/core";
import { embedText, embedTexts } from "@/services/seren-embed";

export type ConversationKind = "chat" | "agent";
export type ConversationMatchType = "exact" | "semantic";

interface RawConversationHit {
  messageId: string;
  conversationId: string;
  kind: ConversationKind;
  role: string;
  title: string | null;
  agentType: string | null;
  projectRoot: string | null;
  timestamp: number;
  seq: number;
  text: string;
  distance: number;
}

export interface ConversationHit extends RawConversationHit {
  matchType: ConversationMatchType;
}

export interface ConversationSearchFilters {
  kinds?: ConversationKind[];
  projectRoot?: string | null;
  afterMs?: number | null;
  beforeMs?: number | null;
  includeArchived?: boolean;
}

export interface ConversationSearchOptions {
  limit?: number;
  filters?: ConversationSearchFilters;
}

export interface ConversationSearchResult {
  hits: ConversationHit[];
  semanticUnavailable: boolean;
  semanticUnavailableReason?: string;
}

interface UnembeddedConversationChunk {
  chunkId: number;
  text: string;
}

function normalizeFilters(
  filters: ConversationSearchFilters | undefined,
): ConversationSearchFilters {
  return {
    kinds: filters?.kinds ?? [],
    projectRoot: filters?.projectRoot?.trim() || null,
    afterMs: filters?.afterMs ?? null,
    beforeMs: filters?.beforeMs ?? null,
    includeArchived: filters?.includeArchived ?? false,
  };
}

function describeSemanticSearchFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = message.toLowerCase();

  if (
    lower.includes("not authenticated") ||
    lower.includes("unauthorized") ||
    lower.includes("401")
  ) {
    return "sign in is required";
  }
  if (
    lower.includes("402") ||
    lower.includes("balance") ||
    lower.includes("payment") ||
    lower.includes("out of balance") ||
    lower.includes("insufficient")
  ) {
    return "embedding publisher needs payment or balance";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "embedding endpoint was not found";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("failed to fetch")
  ) {
    return "could not reach the embedding publisher";
  }

  return "embedding request failed";
}

function withMatchType(
  hits: RawConversationHit[],
  matchType: ConversationMatchType,
): ConversationHit[] {
  return hits.map((hit) => ({ ...hit, matchType }));
}

function hitKey(hit: ConversationHit): string {
  return `${hit.messageId}:${hit.seq}`;
}

function mergeHits(
  exact: ConversationHit[],
  semantic: ConversationHit[],
  limit: number,
): ConversationHit[] {
  const out = exact.slice(0, limit);
  const seen = new Set(out.map(hitKey));
  for (const hit of semantic) {
    if (out.length >= limit) break;
    const key = hitKey(hit);
    if (seen.has(key)) continue;
    out.push(hit);
    seen.add(key);
  }
  return out;
}

export async function searchConversations(
  query: string,
  options: ConversationSearchOptions = {},
): Promise<ConversationSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], semanticUnavailable: false };

  const limit = options.limit ?? 20;
  const filters = normalizeFilters(options.filters);
  const exactRaw = await invoke<RawConversationHit[]>(
    "search_conversations_fts",
    {
      query: trimmed,
      filters,
      limit,
    },
  ).catch(() => [] as RawConversationHit[]);
  const exact = withMatchType(exactRaw, "exact");

  let semantic: ConversationHit[] = [];
  let semanticUnavailable = false;
  let semanticUnavailableReason: string | undefined;
  try {
    const queryEmbedding = await embedText(trimmed);
    const semanticRaw = await invoke<RawConversationHit[]>(
      "search_conversations",
      {
        queryEmbedding,
        filters,
        limit,
      },
    );
    semantic = withMatchType(semanticRaw, "semantic");
  } catch (error) {
    semanticUnavailable = true;
    semanticUnavailableReason = describeSemanticSearchFailure(error);
  }

  return {
    hits: mergeHits(exact, semantic, limit),
    semanticUnavailable,
    semanticUnavailableReason,
  };
}

export async function backfillConversationFts(): Promise<number> {
  return invoke<number>("backfill_conversation_fts").catch(() => 0);
}

export async function deleteConversationIndex(
  conversationId: string,
): Promise<void> {
  await invoke("delete_conversation_index", { conversationId }).catch(() => {});
}

const BATCH_SIZE = 20;
const MAX_BACKFILL_ATTEMPTS = 3;
const backfillAttempts = new Map<number, number>();

export async function backfillConversationIndex(): Promise<void> {
  while (true) {
    const pending = await invoke<UnembeddedConversationChunk[]>(
      "unembedded_conversation_chunks",
      { limit: BATCH_SIZE },
    ).catch(() => [] as UnembeddedConversationChunk[]);
    if (pending.length === 0) return;

    const eligible = pending.filter(
      (chunk) =>
        (backfillAttempts.get(chunk.chunkId) ?? 0) < MAX_BACKFILL_ATTEMPTS,
    );
    if (eligible.length === 0) return;

    let embeddings: Awaited<ReturnType<typeof embedTexts>>;
    try {
      embeddings = await embedTexts(eligible.map((chunk) => chunk.text));
    } catch {
      for (const chunk of eligible) {
        backfillAttempts.set(
          chunk.chunkId,
          (backfillAttempts.get(chunk.chunkId) ?? 0) + 1,
        );
      }
      return;
    }

    for (const [index, chunk] of eligible.entries()) {
      try {
        await invoke("index_conversation_embeddings", {
          chunkId: chunk.chunkId,
          embedding: embeddings.data[index].embedding,
        });
        backfillAttempts.delete(chunk.chunkId);
      } catch {
        backfillAttempts.set(
          chunk.chunkId,
          (backfillAttempts.get(chunk.chunkId) ?? 0) + 1,
        );
      }
    }
  }
}
