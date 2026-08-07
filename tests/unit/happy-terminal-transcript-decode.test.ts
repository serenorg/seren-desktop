// ABOUTME: Verifies transcript text survives a multi-byte character on a read boundary.
// ABOUTME: Drives the real terminal source against a real file written to disk.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { createTerminalSource } from "../../bin/happy-bridge/terminal-source.mjs";

const SESSION = "33333333-3333-4333-8333-333333333333";
/** Mirrors READ_CHUNK_BYTES in terminal-source.mjs. */
const READ_CHUNK_BYTES = 1024 * 1024;

function supervisor(transcriptPath: string) {
  return {
    call: vi.fn(async (method: string) => {
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
      if (method === "terminal_transcript_path") return { path: transcriptPath };
      if (method === "terminal_pending_approval") return {};
      throw new Error(`unexpected supervisor method: ${method}`);
    }),
  };
}

describe("terminal transcript decoding", () => {
  it("keeps a multi-byte character that straddles a read boundary intact", async () => {
    // Measured on real data: 16 of 716 Codex transcripts larger than one chunk
    // have a UTF-8 continuation byte sitting exactly on a 1 MiB boundary.
    // Decoding each chunk on its own turned both halves into U+FFFD.
    const dir = mkdtempSync(path.join(tmpdir(), "seren-decode-"));
    const transcript = path.join(dir, "session.jsonl");

    // `isMeta` lines publish nothing, so they pad the file to the boundary
    // without adding events the assertions would have to skip.
    const metaPrefix =
      '{"isMeta":true,"type":"user","message":{"role":"user","content":"';
    const metaSuffix = '"}}\n';
    const targetPrefix = '{"type":"user","message":{"role":"user","content":"';

    // Land the first byte of a 3-byte character one byte before the boundary so
    // the read splits it. Written unescaped, because it is the raw bytes on
    // disk that get split — a `…` escape would be plain ASCII and prove
    // nothing.
    const padBytes = READ_CHUNK_BYTES - 1 - targetPrefix.length;
    const padding =
      metaPrefix +
      "a".repeat(padBytes - metaPrefix.length - metaSuffix.length) +
      metaSuffix;
    const text = "… boundary survived";
    const contents = `${padding}${targetPrefix}${text}"}}\n`;
    writeFileSync(transcript, contents);

    // The character must genuinely straddle the boundary, or this test proves
    // nothing about the bug it guards.
    const bytes = Buffer.from(contents, "utf8");
    expect(bytes.length).toBeGreaterThan(READ_CHUNK_BYTES);
    expect(bytes[READ_CHUNK_BYTES] & 0xc0).toBe(0x80);

    const source = createTerminalSource({
      supervisorChannel: supervisor(transcript),
    });
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    source.subscribe(
      (event: { kind: string; payload: Record<string, unknown> }) =>
        events.push(event),
    );

    await vi.waitFor(
      () => {
        expect(
          events.filter((event) => event.kind === "user-message").length,
        ).toBe(1);
      },
      { timeout: 10_000 },
    );

    const [message] = events.filter((event) => event.kind === "user-message");
    expect(message.payload.text).toBe(text);
    expect(String(message.payload.text)).not.toContain("�");
    source.close();
  }, 20_000);
});
