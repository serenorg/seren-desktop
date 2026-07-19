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
