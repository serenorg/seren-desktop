// ABOUTME: Critical fallback coverage for transcript semantic search failures.
// ABOUTME: Ensures exact matches remain visible while the UI gets an actionable reason.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "@/services/meetings";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  embedText: vi.fn<(text: string) => Promise<number[]>>(),
  embedTexts: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/services/seren-embed", () => ({
  embedText: mocks.embedText,
  embedTexts: mocks.embedTexts,
}));

describe("searchTranscripts fallback reason", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps exact matches and returns a concise reason when semantic embedding fails", async () => {
    const exactHit = {
      meetingId: "meeting-1",
      seqStart: 1,
      seqEnd: 2,
      text: "Me: reconciliation plan",
      distance: 0,
    };
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "search_transcripts_like") {
        return Promise.resolve([exactHit]);
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    mocks.embedText.mockRejectedValue(
      new Error("Embedding publisher upstream error: 402"),
    );

    const { searchTranscripts } = await import("@/services/transcript-search");
    const result = await searchTranscripts("reconciliation", 20);

    expect(result.hits).toEqual([exactHit]);
    expect(result.semanticUnavailable).toBe(true);
    expect(result.semanticUnavailableReason).toBe(
      "embedding publisher needs payment or balance",
    );
  });

  it("widens retrieval and applies speaker, date, and attendee filters", async () => {
    const jan10 = new Date("2026-01-10T12:00:00").getTime();
    const exactHits = [
      {
        meetingId: "wrong-speaker",
        seqStart: 1,
        seqEnd: 1,
        text: "Me: budget plan",
        distance: 0,
      },
      {
        meetingId: "match",
        seqStart: 2,
        seqEnd: 3,
        text: "Them · Speaker A: budget plan\nMe: follow up",
        distance: 0,
      },
      {
        meetingId: "wrong-attendee",
        seqStart: 4,
        seqEnd: 5,
        text: "Them: budget plan",
        distance: 0,
      },
    ];
    const meeting = (
      id: string,
      startedAt: number,
      attendees: string[],
    ): Meeting => ({
      id,
      title: id,
      sourceApp: null,
      startedAt,
      endedAt: startedAt + 1,
      status: "done",
      templateId: null,
      routedSkillSlug: null,
      agentConversationId: null,
      notesMarkdown: null,
      notesStructJson: null,
      attendeesJson: JSON.stringify(attendees),
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    mocks.invoke.mockImplementation((command: string) => {
      if (command === "search_transcripts_like") {
        return Promise.resolve(exactHits);
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    mocks.embedText.mockRejectedValue(new Error("network"));

    const { searchTranscripts } = await import("@/services/transcript-search");
    const result = await searchTranscripts("budget", {
      limit: 2,
      meetings: [
        meeting("wrong-speaker", jan10, ["Ada Lovelace"]),
        meeting("match", jan10, ["Ada Lovelace"]),
        meeting("wrong-attendee", jan10, ["Grace Hopper"]),
      ],
      filters: {
        speaker: "them",
        startedAfterMs: new Date("2026-01-10T00:00:00").getTime(),
        startedBeforeMs: new Date("2026-01-10T23:59:59.999").getTime(),
        attendee: "ada",
      },
    });

    expect(mocks.invoke).toHaveBeenCalledWith("search_transcripts_like", {
      query: "budget",
      limit: 100,
    });
    expect(result.hits).toEqual([exactHits[1]]);
  });
});
