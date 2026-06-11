// ABOUTME: Regression test for #2335 — untitled meetings in the same minute must not collide.
// ABOUTME: The auto-generated fallback title disambiguates by second; explicit titles win verbatim.

import { describe, expect, it } from "vitest";
import { meetingTitle } from "@/lib/meeting-format";
import type { Meeting } from "@/services/meetings";

function makeMeeting(overrides: Partial<Meeting>): Meeting {
  return {
    id: "m",
    title: "",
    sourceApp: null,
    startedAt: 0,
    endedAt: null,
    status: "notes_ready",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("meetingTitle (#2335)", () => {
  it("uses an explicit title verbatim, trimmed", () => {
    expect(meetingTitle(makeMeeting({ title: "  Standup June 11  " }))).toBe(
      "Standup June 11",
    );
  });

  it("keeps the 'Meeting' prefix for untitled meetings", () => {
    expect(meetingTitle(makeMeeting({ startedAt: 0 }))).toMatch(/^Meeting /);
  });

  it("distinguishes two untitled meetings started in the same minute", () => {
    // Two captures 36 seconds apart share the same clock-minute (05:46). The
    // minute-precision fallback collided ("Meeting 05:46 AM" twice); the fix
    // disambiguates by second so the list rows stay distinct.
    const first = new Date(2026, 5, 11, 5, 46, 12).getTime();
    const second = new Date(2026, 5, 11, 5, 46, 48).getTime();
    expect(meetingTitle(makeMeeting({ startedAt: first }))).not.toBe(
      meetingTitle(makeMeeting({ startedAt: second })),
    );
  });
});
