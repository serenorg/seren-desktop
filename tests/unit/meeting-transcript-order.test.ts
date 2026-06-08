// ABOUTME: Regression test for #2163 — live transcript orders by capture time, not completion-order seq.
// ABOUTME: Fast Me (whisper-1) vs slow Them (diarize) streams must not interleave scrambled.

import { beforeEach, describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

let idCounter = 0;
function seg(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  idCounter += 1;
  return {
    id: `seg-${idCounter}`,
    meetingId: "m1",
    seq: 0,
    speaker: "me",
    text: "x",
    startMs: 0,
    endMs: 0,
    status: "ok",
    createdAt: 0,
    ...overrides,
  };
}

describe("meetingStore.appendLiveSegment ordering (#2163)", () => {
  beforeEach(async () => {
    // setActiveMeeting(null) clears liveSegments (no runtime needed).
    await meetingStore.setActiveMeeting(null);
  });

  it("orders by startMs even when seq (completion order) disagrees", () => {
    // Them spoke first (startMs 0) but its slow transcription returned last
    // (seq 2). Me spoke later (startMs 1000) but returned first (seq 1).
    // Capture order must win: Them ("b") before Me ("a").
    meetingStore.appendLiveSegment(
      seg({ id: "a", speaker: "me", startMs: 1000, seq: 1 }),
    );
    meetingStore.appendLiveSegment(
      seg({ id: "b", speaker: "them", startMs: 0, seq: 2 }),
    );

    expect(meetingStore.state.liveSegments.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("breaks exact startMs ties by seq", () => {
    meetingStore.appendLiveSegment(seg({ id: "x", startMs: 500, seq: 4 }));
    meetingStore.appendLiveSegment(seg({ id: "y", startMs: 500, seq: 3 }));

    expect(meetingStore.state.liveSegments.map((s) => s.id)).toEqual(["y", "x"]);
  });
});
