// ABOUTME: Exhaustively verifies neutral session events become Happy messages.
// ABOUTME: It also locks the generic push copy required by the accepted trust model.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  composeApprovalNotification,
  createAssistantMessageCoalescer,
  createFileReadSummarizer,
  createTurnCorrelator,
  translateNeutralEvent,
} from "../../bin/happy-bridge/translate.mjs";

const payload = {
  text: "assistant text",
  messageId: "message-1",
  toolCallId: "call-1",
  name: "Bash",
  kind: "shell",
  title: "Run command",
  description: "Needs approval",
  parameters: { command: "pwd" },
  result: "done",
  path: "/workspace/project/file.ts",
  oldText: "old",
  newText: "new",
  proposalId: "proposal-1",
  requestId: "request-1",
  toolName: "Bash",
  options: [{ optionId: "allow-once" }],
  entries: [{ content: "step", status: "pending" }],
  status: "ready",
  stopReason: "end_turn",
  error: "failed",
};

describe("neutral-to-Happy session translation", () => {
  it.each([
    ["assistant-delta", "session"],
    ["user-message", "session"],
    ["tool-start", "agent"],
    ["tool-end", "agent"],
    ["file-diff", "agent"],
    ["diff-proposal", "agent"],
    ["diff-proposal-resolved", "session"],
    ["plan-update", "session"],
    ["permission-request", "agent"],
    ["permission-resolved", "session"],
    ["turn-complete", "session"],
    ["status", "session"],
    ["error", "session"],
  ])("maps %s to the %s transport", (kind, transport) => {
    const messages = translateNeutralEvent({ kind, sessionId: "session-1", payload });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].transport).toBe(transport);
  });

  it("drops an unknown neutral event", () => {
    expect(translateNeutralEvent({ kind: "unknown", sessionId: "session-1", payload })).toEqual([]);
  });

  it("does not republish a Happy-originated user message back to Happy", () => {
    expect(
      translateNeutralEvent({
        kind: "user-message",
        sessionId: "session-1",
        payload: { text: "remote prompt", origin: "remote" },
      }),
    ).toEqual([]);
  });

  it("correlates a suppressed Happy prompt with its assistant response", () => {
    let sequence = 0;
    const correlator = createTurnCorrelator({
      createTurnId: () => `turn-remote-${++sequence}`,
    });
    const coalescer = createAssistantMessageCoalescer({
      createMessageId: () => "message-remote-1",
    });
    const remotePrompt = correlator.correlate({
      kind: "user-message",
      sessionId: "session-1",
      payload: { text: "remote prompt", origin: "remote" },
    });
    const [turnStartEvent] = coalescer.consume(correlator.correlate({
      kind: "status",
      sessionId: "session-1",
      payload: { status: "prompting" },
    }));
    for (const text of ["TURN", "315", "7", "FIX", "ED"]) {
      expect(coalescer.consume(correlator.correlate({
        kind: "assistant-delta",
        sessionId: "session-1",
        payload: { text },
      }))).toEqual([]);
    }
    const [assistantEvent, turnEndEvent] = coalescer.consume(correlator.correlate({
      kind: "turn-complete",
      sessionId: "session-1",
      payload: { stopReason: "end_turn" },
    }));
    const [turnStart] = translateNeutralEvent(turnStartEvent);
    const [assistant] = translateNeutralEvent(assistantEvent);
    const [turnEnd] = translateNeutralEvent(turnEndEvent);

    expect(translateNeutralEvent(remotePrompt)).toEqual([]);
    expect(turnStart.envelope.turn).toBe("turn-remote-1");
    expect(assistant.envelope.turn).toBe("turn-remote-1");
    expect(assistant.envelope.id).toBe("message-remote-1");
    expect(assistant.envelope.ev.text).toBe("TURN3157FIXED");
    expect(turnEnd.envelope.turn).toBe("turn-remote-1");
  });

  it("bounds tool output for mobile while retaining more error context", () => {
    const success = translateNeutralEvent({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "call-success", result: "x".repeat(6_000) },
    })[0].body;
    const error = translateNeutralEvent({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "call-error", error: "e".repeat(3_000) },
    })[0].body;

    expect(success).toMatchObject({ callId: "call-success", id: "call-success" });
    expect(success.output).toHaveLength(1_200);
    expect(success.output).toContain("[truncated for Happy Mobile]");
    expect(error).toMatchObject({
      callId: "call-error",
      id: "call-error",
      isError: true,
      output: "e".repeat(3_000),
    });
  });

  it("summarizes a completed file read body while keeping the read visible", () => {
    const summarizer = createFileReadSummarizer();
    const body = "line one\nline two\nline three";

    // The read announces itself on tool-start (claude-code emits kind "fileRead").
    const startEvent = summarizer.annotate({
      kind: "tool-start",
      sessionId: "session-1",
      payload: {
        toolCallId: "read-1",
        kind: "fileRead",
        title: "Read: /workspace/project/app.ts",
        parameters: { file_path: "/workspace/project/app.ts" },
      },
    });
    const [startMessage] = translateNeutralEvent(startEvent);
    expect(startMessage.body).toMatchObject({ type: "tool-call", callId: "read-1" });

    // tool-end carries only the body; it is replaced with a line-count summary.
    const endEvent = summarizer.annotate({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "read-1", result: body },
    });
    const [endMessage] = translateNeutralEvent(endEvent);
    expect(endMessage.body.output).toBe("[3 lines hidden on Happy Mobile]");
    expect(endMessage.body.output).not.toContain("line two");
  });

  it("summarizes an ACP `read` result the same way", () => {
    const summarizer = createFileReadSummarizer();
    summarizer.annotate({
      kind: "tool-start",
      sessionId: "session-1",
      payload: { toolCallId: "read-2", kind: "read" },
    });
    const endEvent = summarizer.annotate({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "read-2", result: "only one line" },
    });
    expect(translateNeutralEvent(endEvent)[0].body.output).toBe(
      "[1 line hidden on Happy Mobile]",
    );
  });

  it("leaves a failed read and a non-read result untouched", () => {
    const summarizer = createFileReadSummarizer();
    // A read that errored keeps its short, diagnostic failure text.
    summarizer.annotate({
      kind: "tool-start",
      sessionId: "session-1",
      payload: { toolCallId: "read-err", kind: "fileRead" },
    });
    const failed = summarizer.annotate({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "read-err", error: "ENOENT: no such file" },
    });
    expect(translateNeutralEvent(failed)[0].body).toMatchObject({
      isError: true,
      output: "ENOENT: no such file",
    });

    // A shell command's output is not a read and stays on the character-cap path.
    summarizer.annotate({
      kind: "tool-start",
      sessionId: "session-1",
      payload: { toolCallId: "run-1", kind: "shell" },
    });
    const command = summarizer.annotate({
      kind: "tool-end",
      sessionId: "session-1",
      payload: { toolCallId: "run-1", result: "build succeeded" },
    });
    expect(translateNeutralEvent(command)[0].body.output).toBe("build succeeded");
  });

  it("bounds tool input without flattening its shape", () => {
    // A `Write` call carries the whole file body in its parameters. Left
    // unbounded it went to the relay and onto the phone in full, while the
    // diff the same write produces was capped.
    const [message] = translateNeutralEvent({
      kind: "tool-start",
      sessionId: "session-1",
      payload: {
        toolCallId: "call-write",
        name: "Write",
        parameters: {
          file_path: "/workspace/project/file.ts",
          content: "x".repeat(2_000_000),
          replacements: [{ old: "y".repeat(5_000), count: 3 }],
        },
      },
    });

    expect(message.body.input.file_path).toBe("/workspace/project/file.ts");
    expect(message.body.input.content).toHaveLength(2_000);
    expect(message.body.input.content).toContain("[truncated for Happy Mobile]");
    expect(message.body.input.replacements[0].old).toHaveLength(2_000);
    expect(message.body.input.replacements[0].count).toBe(3);
  });

  it.each([
    ["file-diff", "toolCallId", "file-change-1"],
    ["diff-proposal", "proposalId", "proposal-1"],
  ])("summarizes %s snapshots and caps its mobile diff", (kind, idField, id) => {
    const newText = Array.from({ length: 400 }, (_, index) => `new line ${index}`).join("\n");
    const [message] = translateNeutralEvent({
      kind,
      sessionId: "session-1",
      payload: {
        [idField]: id,
        path: "/workspace/project/file.ts",
        oldText: "old line 1\nold line 2",
        newText,
      },
    });

    expect(message.body).toMatchObject({
      id,
      oldContent: "[2 lines hidden on Happy Mobile]",
      newContent: "[400 lines hidden on Happy Mobile]",
    });
    expect(message.body.diff).toHaveLength(2_000);
    expect(message.body.diff).toContain("[truncated for Happy Mobile]");
    expect(message.body.oldContent).not.toContain("old line 1");
  });

  it.each([
    ["prompting", "turn-start"],
    ["ready", "turn-end"],
    ["error", "turn-end"],
  ])("maps status %s to a Happy %s event", (status, eventType) => {
    const [message] = translateNeutralEvent({
      kind: "status",
      sessionId: "session-1",
      payload: { status },
    });
    expect(message.envelope.ev.t).toBe(eventType);
  });

  it("keeps approval push copy free of session metadata", () => {
    const output = JSON.stringify(composeApprovalNotification({
      sessionTitle: "Project title",
      toolName: "Bash",
      projectName: "Project name",
      cwd: "/workspace/project",
      url: "https://relay.invalid/session",
    }));
    for (const forbidden of ["Project title", "Bash", "Project name", "/workspace/project", "https://relay.invalid/session"]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain("Approval needed");
  });
});
