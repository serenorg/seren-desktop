// ABOUTME: Regression coverage for #2648 live Meeting Mode elapsed timers.
// ABOUTME: Guards the explicit reactive clock dependency used by active captures.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDuration,
  isMeetingDurationLive,
} from "@/lib/meeting-format";
import type { Meeting } from "@/services/meetings";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    title: "Cristin Debrief",
    sourceApp: "Zoom",
    startedAt: 10_000,
    endedAt: null,
    status: "capturing",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    createdAt: 10_000,
    updatedAt: 10_000,
    ...overrides,
  };
}

describe("meeting duration timers (#2648)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats live durations from an explicit clock while ended meetings stay fixed", () => {
    expect(formatDuration(meeting(), 43_000)).toBe("00:33");
    expect(formatDuration(meeting({ endedAt: 22_000 }), 43_000)).toBe("00:12");
  });

  it("identifies only pending or active captures as live timers", () => {
    expect(isMeetingDurationLive(meeting({ status: "pending_capture" }))).toBe(
      true,
    );
    expect(isMeetingDurationLive(meeting({ status: "capturing" }))).toBe(true);
    expect(
      isMeetingDurationLive(meeting({ status: "transcribing" })),
    ).toBe(false);
    expect(
      isMeetingDurationLive(meeting({ status: "capturing", endedAt: 22_000 })),
    ).toBe(false);
  });

  it("wires the live duration clock into both active recording surfaces", () => {
    const clock = source("src/lib/meeting-duration-clock.ts");
    const panel = source("src/components/meeting/MeetingPanel.tsx");
    const detail = source("src/components/meeting/MeetingDetail.tsx");

    expect(clock).toContain("createEffect");
    expect(clock).toContain("setInterval");
    expect(clock).toContain("clearInterval");
    expect(panel).toContain("createMeetingDurationClock");
    expect(panel).toContain("isMeetingDurationLive");
    expect(panel).toContain("formatDuration(meeting(), durationNow())");
    expect(panel).toContain("durationNow={durationNow()}");
    expect(detail).toContain("formatDuration(props.meeting, durationNow())");
  });
});
