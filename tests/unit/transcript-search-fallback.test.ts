// ABOUTME: Critical fallback coverage for transcript semantic search failures.
// ABOUTME: Ensures exact matches remain visible while the UI gets an actionable reason.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
