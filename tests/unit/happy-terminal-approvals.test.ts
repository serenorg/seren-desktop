// ABOUTME: Verifies terminal approval prompts reach the phone and can be answered.
// ABOUTME: Drives the real terminal source against a scripted supervisor channel.

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  classifyApprovalOption,
  createTerminalSource,
} from "../../bin/happy-bridge/terminal-source.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";

const APPROVAL = {
  requestId: "terminal-approval-abc123",
  question: "Do you want to create approval-test.txt?",
  options: [
    { optionId: "1", label: "Yes" },
    { optionId: "2", label: "Yes, allow all edits during this session" },
    { optionId: "3", label: "No" },
  ],
};

function supervisor(state: { approval: unknown }) {
  const answered: Array<Record<string, string>> = [];
  return {
    answered,
    call: vi.fn(async (method: string, params: Record<string, string>) => {
      if (method === "terminal_list_sessions") {
        return {
          sessions: [
            {
              sessionId: SESSION,
              agentType: "claude-code",
              cwd: "/workspace/project",
              title: "Claude Code CLI",
            },
          ],
        };
      }
      if (method === "terminal_transcript_path") return {};
      if (method === "terminal_pending_approval") {
        return state.approval ? { approval: state.approval } : {};
      }
      if (method === "terminal_respond_to_approval") {
        answered.push(params);
        return { ok: true };
      }
      throw new Error(`unexpected supervisor method: ${method}`);
    }),
  };
}

describe("terminal approval prompts", () => {
  it("classifies option labels so a plain approve or deny picks the right one", () => {
    expect(classifyApprovalOption("Yes")).toBe("allow_once");
    expect(classifyApprovalOption("Yes, allow all edits during this session")).toBe(
      "allow_always",
    );
    expect(
      classifyApprovalOption("Yes, and don't ask again for commands that start with `rm`"),
    ).toBe("allow_always");
    expect(classifyApprovalOption("No")).toBe("reject_once");
    expect(classifyApprovalOption("No, and tell Codex what to do differently")).toBe(
      "reject_once",
    );
  });

  it("publishes a pending approval as an actionable request", async () => {
    const state = { approval: APPROVAL };
    const channel = supervisor(state);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    source.subscribe(
      (event: { kind: string; payload: Record<string, unknown> }) => events.push(event),
    );

    await vi.waitFor(
      () => {
        expect(events.some((event) => event.kind === "permission-request")).toBe(true);
      },
      { timeout: 8000 },
    );

    const request = events.find((event) => event.kind === "permission-request");
    expect(request?.payload.requestId).toBe(APPROVAL.requestId);
    expect(request?.payload.description).toBe(APPROVAL.question);
    expect(request?.payload.options).toEqual([
      { optionId: "1", name: "Yes", kind: "allow_once" },
      {
        optionId: "2",
        name: "Yes, allow all edits during this session",
        kind: "allow_always",
      },
      { optionId: "3", name: "No", kind: "reject_once" },
    ]);
    source.close();
  }, 15000);

  it("publishes exactly one request while the same prompt stays on screen", async () => {
    const state = { approval: APPROVAL };
    const channel = supervisor(state);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string }> = [];
    source.subscribe((event: { kind: string }) => events.push(event));

    await vi.waitFor(
      () => {
        expect(events.filter((e) => e.kind === "permission-request").length).toBe(1);
      },
      { timeout: 8000 },
    );
    // Several more polls must not re-announce the same prompt.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(events.filter((e) => e.kind === "permission-request").length).toBe(1);
    source.close();
  }, 20000);

  it("resolves the card when the approval is answered on the desktop", async () => {
    const state: { approval: unknown } = { approval: APPROVAL };
    const channel = supervisor(state);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    source.subscribe(
      (event: { kind: string; payload: Record<string, unknown> }) => events.push(event),
    );

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.kind === "permission-request")).toBe(true);
      },
      { timeout: 8000 },
    );
    state.approval = null;
    await vi.waitFor(
      () => {
        expect(events.some((e) => e.kind === "permission-resolved")).toBe(true);
      },
      { timeout: 8000 },
    );
    expect(
      events.find((e) => e.kind === "permission-resolved")?.payload.requestId,
    ).toBe(APPROVAL.requestId);
    source.close();
  }, 20000);

  it("answers the approval through the supervisor and clears the card", async () => {
    const state = { approval: APPROVAL };
    const channel = supervisor(state);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    source.subscribe(
      (event: { kind: string; payload: Record<string, unknown> }) => events.push(event),
    );
    await vi.waitFor(
      () => {
        expect(events.some((e) => e.kind === "permission-request")).toBe(true);
      },
      { timeout: 8000 },
    );

    await expect(
      source.respondToPermission(SESSION, APPROVAL.requestId, "3"),
    ).resolves.toEqual({ ok: true });

    expect(channel.answered).toEqual([
      { sessionId: SESSION, requestId: APPROVAL.requestId, optionId: "3" },
    ]);
    expect(
      events.some(
        (e) =>
          e.kind === "permission-resolved" && e.payload.requestId === APPROVAL.requestId,
      ),
    ).toBe(true);
    source.close();
  }, 15000);
});
