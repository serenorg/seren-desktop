// ABOUTME: Semantic transcript search — chunk, embed, index, and query meeting transcripts.
// ABOUTME: Embeddings come from seren-embed; vectors are stored locally via Tauri commands.

import { invoke } from "@tauri-apps/api/core";
import {
  getTranscriptSegments,
  type TranscriptSegment,
} from "@/services/meetings";
import { embedText, embedTexts } from "@/services/seren-embed";

// Window transcript segments into chunks small enough to embed but large enough
// to carry context. Non-overlapping; bounded by chars and segment count.
const CHUNK_CHAR_BUDGET = 1500;
const CHUNK_MAX_SEGMENTS = 8;

export interface TranscriptChunk {
  seqStart: number;
  seqEnd: number;
  text: string;
}

/** A semantic search hit returned by the vector store. */
export interface TranscriptHit {
  meetingId: string;
  seqStart: number;
  seqEnd: number;
  text: string;
  distance: number;
}

function speakerLabel(speaker: TranscriptSegment["speaker"]): string {
  return speaker === "me" ? "Me" : "Them";
}

/**
 * Split a transcript into embeddable chunks, preserving speaker turns and the
 * source seq range so a hit can jump back to the exact segment.
 */
export function chunkTranscript(
  segments: TranscriptSegment[],
): TranscriptChunk[] {
  // Order by capture time before windowing. `seq` is assigned when each chunk's
  // transcription request returns, so the fast Me vs slow Them streams complete
  // out of order; chunking in seq order would glue together turns that aren't
  // chronologically adjacent. startMs is the capture offset; seq only breaks
  // exact-start ties (mirrors sortSegmentsByCapture in the meeting store).
  const usable = [...segments]
    .sort((left, right) =>
      left.startMs !== right.startMs
        ? left.startMs - right.startMs
        : left.seq - right.seq,
    )
    .filter(
      (segment) => segment.status === "ok" && segment.text.trim().length > 0,
    );
  const chunks: TranscriptChunk[] = [];
  let current: TranscriptSegment[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      seqStart: current[0].seq,
      seqEnd: current[current.length - 1].seq,
      text: current
        .map(
          (segment) =>
            `${speakerLabel(segment.speaker)}: ${segment.text.trim()}`,
        )
        .join("\n"),
    });
    current = [];
    chars = 0;
  };

  for (const segment of usable) {
    current.push(segment);
    chars += segment.text.length;
    if (current.length >= CHUNK_MAX_SEGMENTS || chars >= CHUNK_CHAR_BUDGET) {
      flush();
    }
  }
  flush();
  return chunks;
}

/**
 * (Re)index one meeting's transcript: chunk it, embed the chunks via seren-embed,
 * and replace the meeting's stored vectors. Returns the number of chunks indexed.
 */
const indexing = new Set<string>();

export async function indexMeeting(meetingId: string): Promise<number> {
  if (indexing.has(meetingId)) return 0;
  indexing.add(meetingId);
  try {
    const segments = await getTranscriptSegments(meetingId);
    const chunks = chunkTranscript(segments);
    if (chunks.length === 0) {
      await invoke("delete_meeting_transcript_index", { meetingId });
      return 0;
    }
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
    const payload = chunks.map((chunk, index) => ({
      seqStart: chunk.seqStart,
      seqEnd: chunk.seqEnd,
      text: chunk.text,
      embedding: embeddings.data[index].embedding,
    }));
    return await invoke("index_meeting_transcript", {
      meetingId,
      chunks: payload,
    });
  } finally {
    indexing.delete(meetingId);
  }
}

export interface TranscriptSearchResult {
  hits: TranscriptHit[];
  /** True when semantic search failed (offline/unauthenticated/embed down) and
   *  only the local exact-match results are shown. */
  semanticUnavailable: boolean;
}

/**
 * Search transcripts, combining semantic (vector) hits with a local exact-text
 * pass. The exact pass always runs (it works offline / unauthenticated), so an
 * embedding failure degrades to exact matches rather than an empty result. Never
 * throws: callers distinguish "no matches" from "semantic unavailable" via the
 * returned flag.
 */
export async function searchTranscripts(
  query: string,
  limit = 20,
): Promise<TranscriptSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], semanticUnavailable: false };

  const exact = await invoke<TranscriptHit[]>("search_transcripts_like", {
    query: trimmed,
    limit,
  }).catch(() => [] as TranscriptHit[]);

  let semantic: TranscriptHit[] = [];
  let semanticUnavailable = false;
  try {
    const queryEmbedding = await embedText(trimmed);
    semantic = await invoke<TranscriptHit[]>("search_transcripts", {
      queryEmbedding,
      limit,
    });
  } catch {
    // Offline / unauthenticated / out of balance / seren-embed down.
    semanticUnavailable = true;
  }

  // Merge semantic + exact, guaranteeing exact matches aren't truncated away
  // when semantic saturates the limit (a literal email/name match must surface
  // even with 20 fuzzy semantic hits). Reserve up to half the slots for exact
  // hits, fill the rest with semantic, then top up from whichever side has more.
  const key = (hit: TranscriptHit) => `${hit.meetingId}:${hit.seqStart}`;
  const seen = new Set(semantic.map(key));
  const exactUnique = exact.filter((hit) => !seen.has(key(hit)));
  const reserve = Math.min(exactUnique.length, Math.floor(limit / 2));
  const merged = [
    ...semantic.slice(0, limit - reserve),
    ...exactUnique.slice(0, reserve),
  ];
  for (const hit of [
    ...semantic.slice(limit - reserve),
    ...exactUnique.slice(reserve),
  ]) {
    if (merged.length >= limit) break;
    merged.push(hit);
  }
  return { hits: merged, semanticUnavailable };
}

/** Drop a meeting's transcript vectors (best-effort; called on delete). */
export async function deleteMeetingIndex(meetingId: string): Promise<void> {
  await invoke("delete_meeting_transcript_index", { meetingId }).catch(
    () => {},
  );
}

// Per-meeting failed-attempt counter so a meeting that embeds (a paid
// seren-embed call) but then fails to persist isn't re-embedded on every
// loadMeetings(). Bounded retries cap the wasted spend; resets on app restart.
const MAX_BACKFILL_ATTEMPTS = 3;
const backfillAttempts = new Map<string, number>();

/** Index any of the given meetings that aren't already indexed (best-effort). */
export async function backfillTranscriptIndex(
  meetingIds: string[],
): Promise<void> {
  const indexed = new Set(
    await invoke<string[]>("indexed_transcript_meeting_ids").catch(() => []),
  );
  for (const meetingId of meetingIds) {
    if (indexed.has(meetingId)) continue;
    if ((backfillAttempts.get(meetingId) ?? 0) >= MAX_BACKFILL_ATTEMPTS)
      continue;
    try {
      await indexMeeting(meetingId);
      backfillAttempts.delete(meetingId);
    } catch {
      backfillAttempts.set(
        meetingId,
        (backfillAttempts.get(meetingId) ?? 0) + 1,
      );
    }
  }
}
