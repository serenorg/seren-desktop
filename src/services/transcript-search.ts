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
  const usable = segments.filter(
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
export async function indexMeeting(meetingId: string): Promise<number> {
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
  return invoke("index_meeting_transcript", { meetingId, chunks: payload });
}

/** Semantic search across all indexed transcripts. Empty query → no results. */
export async function searchTranscripts(
  query: string,
  limit = 20,
): Promise<TranscriptHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const queryEmbedding = await embedText(trimmed);
  return invoke("search_transcripts", { queryEmbedding, limit });
}

/** Index any of the given meetings that aren't already indexed (best-effort). */
export async function backfillTranscriptIndex(
  meetingIds: string[],
): Promise<void> {
  const indexed = new Set(
    await invoke<string[]>("indexed_transcript_meeting_ids").catch(() => []),
  );
  for (const meetingId of meetingIds) {
    if (!indexed.has(meetingId)) {
      await indexMeeting(meetingId).catch(() => {});
    }
  }
}
