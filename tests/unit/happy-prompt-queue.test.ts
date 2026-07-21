// ABOUTME: Protects Happy phone prompts submitted while a local agent turn is active.
// ABOUTME: The queued prompt must wait for readiness and then run exactly once.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDeferredPromptQueue,
  isPromptBusyError,
} from "../../bin/happy-bridge/happy-layer.mjs";

describe("Happy deferred prompt queue", () => {
  it("delivers a phone prompt once after the active provider turn becomes ready", async () => {
    const sent: string[] = [];
    const queue = createDeferredPromptQueue({
      send: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
      },
    });

    queue.setBusy("session-1", true);
    const delivered = queue.enqueue("session-1", "phone prompt");
    await Promise.resolve();
    expect(sent).toEqual([]);

    queue.setBusy("session-1", false);

    await expect(delivered).resolves.toBe(true);
    expect(sent).toEqual(["phone prompt"]);
  });

  it("defers on the busy error every runtime actually throws", () => {
    // Read the sentences out of the runtimes rather than restating them, so a
    // provider that words its message differently fails here instead of
    // silently dropping the phone's prompt. #3145
    const runtimes = [
      "claude-runtime.mjs",
      "acp-runtime.mjs",
      "lmstudio-runtime.mjs",
      "paired-runtime.mjs",
      "providers.mjs",
    ];
    const thrown = runtimes.flatMap((file) => {
      const source = readFileSync(
        join(process.cwd(), "bin/browser-local", file),
        "utf8",
      );
      return [...source.matchAll(/"(Another prompt is already active[^"]*)"/g)]
        .map((match) => match[1]);
    });

    expect(thrown.length).toBe(runtimes.length);
    for (const message of thrown) {
      expect(isPromptBusyError(new Error(message))).toBe(true);
    }

    // Unrelated failures must still surface rather than being retried forever.
    expect(isPromptBusyError(new Error("Session not found."))).toBe(false);
    expect(isPromptBusyError("not an error")).toBe(false);
  });
});
