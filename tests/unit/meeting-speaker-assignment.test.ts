// ABOUTME: Critical speaker-assignment resolution coverage for Meeting Mode.
// ABOUTME: Segment corrections must beat meeting-wide corrections without losing raw labels.

import { describe, expect, it } from "vitest";
import {
  formatRawTranscriptSpeakerLabel,
  formatTranscriptSpeakerLabel,
} from "@/lib/meeting-format";
import {
  applySpeakerAssignmentsToSegments,
  type MeetingSpeakerAssignment,
  type TranscriptSegment,
} from "@/services/meetings";

function segment(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "s1",
    meetingId: "m1",
    seq: 1,
    speaker: "them",
    text: "roadmap",
    startMs: 0,
    endMs: 100,
    status: "ok",
    speakerLabel: "A",
    speakerSource: "diarization",
    createdAt: 0,
    ...over,
  };
}

function assignment(
  over: Partial<MeetingSpeakerAssignment> = {},
): MeetingSpeakerAssignment {
  return {
    id: "a1",
    meetingId: "m1",
    source: "diarization",
    sourceKey: "A",
    displayName: "Ada Lovelace",
    attendeeEmail: null,
    scope: "meeting",
    segmentId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("meeting speaker assignments", () => {
  it("prefers segment assignment, then meeting assignment, then raw label", () => {
    const raw = segment();
    expect(formatTranscriptSpeakerLabel(raw)).toBe("Them · Speaker A");
    expect(formatRawTranscriptSpeakerLabel(raw)).toBe("Them · Speaker A");

    const meetingAssigned = applySpeakerAssignmentsToSegments(rawArray(raw), [
      assignment(),
    ])[0];
    expect(formatTranscriptSpeakerLabel(meetingAssigned)).toBe("Ada Lovelace");

    const segmentAssigned = applySpeakerAssignmentsToSegments(rawArray(raw), [
      assignment(),
      assignment({
        id: "a2",
        displayName: "Grace Hopper",
        scope: "segment",
        segmentId: "s1",
      }),
    ])[0];
    expect(formatTranscriptSpeakerLabel(segmentAssigned)).toBe("Grace Hopper");
    expect(formatRawTranscriptSpeakerLabel(segmentAssigned)).toBe(
      "Them · Speaker A",
    );
  });

  it("keeps channel-wide assignments after diarization labels arrive", () => {
    const assigned = applySpeakerAssignmentsToSegments(rawArray(segment()), [
      assignment({
        source: "channel",
        sourceKey: "them",
        displayName: "Customer",
      }),
    ])[0];

    expect(formatTranscriptSpeakerLabel(assigned)).toBe("Customer");
    expect(formatRawTranscriptSpeakerLabel(assigned)).toBe("Them · Speaker A");
  });
});

function rawArray(segment: TranscriptSegment): TranscriptSegment[] {
  return [segment];
}
