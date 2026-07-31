// ABOUTME: Verifies renderer streaming buffers remain isolated per orchestrator subtask.
// ABOUTME: Protects interleaved multi-task output from collapsing into one conversation buffer.

import { beforeEach, describe, expect, it } from "vitest";
import { conversationStore } from "@/stores/conversation.store";

describe("orchestrator subtask streaming", () => {
  const conversationId = "conversation-subtask-streaming";

  beforeEach(() => {
    conversationStore.resetSessionState();
  });

  it("keeps interleaved subtask output separate and preserves unkeyed streaming", () => {
    conversationStore.appendStreamingContent("a1", conversationId, "s1");
    conversationStore.appendStreamingContent("b1", conversationId, "s2");
    conversationStore.appendStreamingContent("a2", conversationId, "s1");

    expect(conversationStore.getStreamingSegmentsFor(conversationId)).toEqual([
      { key: "s1", content: "a1a2", thinking: "" },
      { key: "s2", content: "b1", thinking: "" },
    ]);
    expect(conversationStore.getStreamingContentFor(conversationId)).toBe("");

    conversationStore.clearStreamingSegment(conversationId, "s1");
    expect(conversationStore.getStreamingSegmentsFor(conversationId)).toEqual([
      { key: "s2", content: "b1", thinking: "" },
    ]);

    conversationStore.appendStreamingContent("single", conversationId);
    expect(conversationStore.getStreamingContentFor(conversationId)).toBe(
      "single",
    );
  });
});
