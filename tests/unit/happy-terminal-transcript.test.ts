// ABOUTME: Verifies Claude and Codex CLI transcript lines map to neutral session events.
// ABOUTME: Fixtures mirror the real on-disk shapes both CLIs write.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
} from "../../bin/happy-bridge/terminal-transcript.mjs";

const line = (value: unknown) => JSON.stringify(value);

describe("Claude Code transcript parsing", () => {
  it("publishes a typed prompt and marks the session busy", () => {
    const events = parseClaudeTranscriptLine(
      line({ type: "user", message: { role: "user", content: "run the tests" } }),
    );
    expect(events).toEqual([
      { kind: "user-message", payload: { text: "run the tests" } },
      { kind: "status", payload: { status: "busy" } },
    ]);
  });

  it("shares one message id across the blocks of a reply so they render as one bubble", () => {
    const events = parseClaudeTranscriptLine(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_1",
          stop_reason: "end_turn",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "first" },
            { type: "text", text: " second" },
          ],
        },
      }),
    );
    // Thinking blocks outnumber assistant text three to one in real
    // transcripts and are deliberately dropped.
    expect(events.map((event: { kind: string }) => event.kind)).toEqual([
      "assistant-delta",
      "assistant-delta",
      "turn-complete",
    ]);
    expect(events[0].payload.messageId).toBe("msg_1");
    expect(events[1].payload.messageId).toBe("msg_1");
  });

  it("does not end the turn while the model is still calling tools", () => {
    const events = parseClaudeTranscriptLine(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_2",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } }],
        },
      }),
    );
    expect(events.map((event: { kind: string }) => event.kind)).toEqual(["tool-start"]);
  });

  it("drops sub-agent and bookkeeping lines that the user never typed", () => {
    const prompt = { role: "user", content: "sub-agent work" };
    expect(parseClaudeTranscriptLine(line({ type: "user", isSidechain: true, message: prompt })))
      .toEqual([]);
    expect(parseClaudeTranscriptLine(line({ type: "user", isMeta: true, message: prompt })))
      .toEqual([]);
    expect(parseClaudeTranscriptLine(line({ type: "ai-title", aiTitle: "x" }))).toEqual([]);
  });

  it("ignores a half-written final line rather than throwing", () => {
    expect(parseClaudeTranscriptLine('{"type":"user","mess')).toEqual([]);
    expect(parseClaudeTranscriptLine("")).toEqual([]);
  });
});

describe("Codex transcript parsing", () => {
  it("publishes user and agent messages from the user-facing stream", () => {
    expect(
      parseCodexTranscriptLine(
        line({ type: "event_msg", payload: { type: "user_message", message: "ship it" } }),
      ).map((event: { kind: string }) => event.kind),
    ).toEqual(["user-message", "status"]);

    expect(
      parseCodexTranscriptLine(
        line({ type: "event_msg", payload: { type: "agent_message", message: "done" } }),
      ),
    ).toEqual([{ kind: "assistant-delta", payload: { text: "done" } }]);
  });

  it("does not publish the raw model exchange a second time", () => {
    // Codex records every turn twice. `response_item/message` is the same text
    // already published from `event_msg`, so reading both would double it.
    expect(
      parseCodexTranscriptLine(
        line({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ text: "done" }] },
        }),
      ),
    ).toEqual([]);
  });

  it("ends the turn on task completion", () => {
    expect(
      parseCodexTranscriptLine(
        line({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }),
      ).map((event: { kind: string }) => event.kind),
    ).toEqual(["turn-complete"]);
  });
});
