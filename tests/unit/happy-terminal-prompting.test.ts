// ABOUTME: Verifies remote prompts reach a terminal pane and echo back exactly once.
// ABOUTME: Drives the real terminal source against a scripted supervisor channel.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { createTerminalSource } from "../../bin/happy-bridge/terminal-source.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const INTERRUPT = String.fromCharCode(3);

function claudeUserLine(text: string) {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  })}\n`;
}

/** Mirrors the Rust sanitizer: control characters never reach the pane. */
function typedForm(prompt: string): string {
  return [...prompt]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 32 && code !== 127) || ch === "\n" || ch === "\t";
    })
    .join("");
}

/**
 * A supervisor channel backed by a real transcript file on disk, so the source
 * exercises its actual read path rather than a stubbed one.
 */
function supervisor(transcriptPath: string | null) {
  const submitted: Array<{ sessionId: string; prompt: string }> = [];
  return {
    submitted,
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
      if (method === "terminal_transcript_path") {
        return transcriptPath ? { path: transcriptPath } : {};
      }
      if (method === "terminal_submit_prompt") {
        submitted.push({ sessionId: params.sessionId, prompt: params.prompt });
        // Rust answers with the text it actually typed. Returning the sanitized
        // form is what proves the source matches echoes against what was typed
        // rather than against what the phone sent.
        return { accepted: true, prompt: typedForm(params.prompt) };
      }
      throw new Error(`unexpected supervisor method: ${method}`);
    }),
  };
}

describe("remote prompting a terminal pane", () => {
  it("types the prompt into the pane and reports acceptance", async () => {
    const channel = supervisor(null);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string }> = [];
    source.subscribe((event: { kind: string }) => events.push(event));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));

    await expect(source.sendPrompt(SESSION, "run the tests")).resolves.toEqual({
      accepted: true,
      sessionId: SESSION,
    });
    expect(channel.submitted).toEqual([
      { sessionId: SESSION, prompt: "run the tests" },
    ]);
    source.close();
  });

  it("refuses a prompt for a pane it is not tracking", async () => {
    const channel = supervisor(null);
    const source = createTerminalSource({ supervisorChannel: channel });
    await expect(
      source.sendPrompt("22222222-2222-4222-8222-222222222222", "hi"),
    ).rejects.toThrow(/no longer available/);
    expect(channel.submitted).toEqual([]);
    source.close();
  });

  it("marks the transcript echo of its own prompt as remote so it renders once", async () => {
    // Happy already showed the peer its prompt; the CLI then writes the same
    // text into its transcript. `translate.mjs` drops a remote-origin
    // user-message, which is what stops the second bubble.
    const dir = mkdtempSync(path.join(tmpdir(), "seren-echo-"));
    const transcript = path.join(dir, "session.jsonl");
    writeFileSync(transcript, "");

    const channel = supervisor(transcript);
    const source = createTerminalSource({ supervisorChannel: channel });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    source.subscribe(
      (event: { kind: string; payload: Record<string, unknown> }) =>
        events.push(event),
    );
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));

    // The interrupt byte is stripped before typing, so the transcript records
    // the sanitized text — the echo must still be recognized.
    await source.sendPrompt(SESSION, `remote${INTERRUPT} prompt`);
    writeFileSync(
      transcript,
      claudeUserLine("remote prompt") + claudeUserLine("typed on the desktop"),
    );

    await vi.waitFor(
      () => {
        expect(
          events.filter((event) => event.kind === "user-message").length,
        ).toBe(2);
      },
      { timeout: 10_000 },
    );

    const users = events.filter((event) => event.kind === "user-message");
    expect(users[0].payload.text).toBe("remote prompt");
    expect(users[0].payload.origin).toBe("remote");
    // A prompt the desktop user typed has no echo to claim and stays visible.
    expect(users[1].payload.text).toBe("typed on the desktop");
    expect(users[1].payload.origin).toBeUndefined();
    source.close();
  }, 20_000);
});
