// ABOUTME: Exhaustively verifies neutral session events become Happy messages.
// ABOUTME: It also locks the generic push copy required by the accepted trust model.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  composeApprovalNotification,
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
