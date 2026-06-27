// ABOUTME: Critical-path coverage for transcript chunking used by semantic search.
// ABOUTME: Chunks must drop gaps/empties and preserve the seq range for jump-to-source.

import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/services/meetings";
import { chunkTranscript } from "@/services/transcript-search";

const seg = (
  seq: number,
  text: string,
  over: Partial<TranscriptSegment> = {},
): TranscriptSegment => ({
  id: `s${seq}`,
  meetingId: "m",
  seq,
  speaker: "me",
  text,
  startMs: 0,
  endMs: 0,
  status: "ok",
  createdAt: 0,
  ...over,
});

describe("chunkTranscript", () => {
  it("drops gaps/empties and preserves seq range + speaker labels", () => {
    const chunks = chunkTranscript([
      seg(0, "hello", { speaker: "me" }),
      seg(1, "   ", { status: "ok" }),
      seg(2, "world", { speaker: "them", status: "gap" }),
      seg(3, "again", { speaker: "them" }),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].seqStart).toBe(0);
    expect(chunks[0].seqEnd).toBe(3);
    expect(chunks[0].text).toBe("Me: hello\nThem: again");
  });

  it("splits into contiguous, non-overlapping chunks past the segment cap", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      seg(index, `turn ${index}`),
    );
    const chunks = chunkTranscript(many);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].seqStart).toBe(0);
    expect(chunks[1].seqStart).toBe(chunks[0].seqEnd + 1);
  });
});
