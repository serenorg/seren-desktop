// ABOUTME: Regression guard for #2439 — Meeting Mode must expose generation and ready states.
// ABOUTME: These helpers drive titlebar, drawer, list, and detail copy.

import { describe, expect, it } from "vitest";
import {
  isMeetingProcessingStatus,
  isMeetingReadyStatus,
  meetingProcessingLabel,
  meetingReadyLabel,
  STATUS_LABELS,
} from "@/lib/meeting-format";

describe("meeting status generation labels (#2439)", () => {
  it("classifies stopped-generation states as processing", () => {
    expect(isMeetingProcessingStatus("transcribing")).toBe(true);
    expect(isMeetingProcessingStatus("agent_running")).toBe(true);
    expect(isMeetingProcessingStatus("capturing")).toBe(false);
    expect(STATUS_LABELS.transcribing).toBe("Generating notes");
    expect(meetingProcessingLabel("transcribing")).toBe(
      "Generating notes from transcript",
    );
  });

  it("classifies transcript and notes terminal states as ready to view", () => {
    expect(isMeetingReadyStatus("transcript_ready")).toBe(true);
    expect(isMeetingReadyStatus("notes_ready")).toBe(true);
    expect(isMeetingReadyStatus("done")).toBe(true);
    expect(isMeetingReadyStatus("failed")).toBe(false);
    expect(meetingReadyLabel("transcript_ready")).toBe(
      "Transcript ready to view",
    );
  });
});
