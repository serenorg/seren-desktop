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

  it("submits only one accepted prompt until the provider reports ready again", async () => {
    const sent: string[] = [];
    const queue = createDeferredPromptQueue({
      send: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        return { accepted: true };
      },
    });

    const first = queue.enqueue("session-1", "first");
    const second = queue.enqueue("session-1", "second");
    await expect(first).resolves.toBe(true);
    expect(sent).toEqual(["first"]);

    queue.setBusy("session-1", false);
    await expect(second).resolves.toBe(true);
    expect(sent).toEqual(["first", "second"]);
    await queue.close();
  });

  it("preserves an authoritative ready event that overtakes prompt acceptance", async () => {
    const sent: string[] = [];
    let acceptFirst: (() => void) | undefined;
    const queue = createDeferredPromptQueue({
      send: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        if (prompt === "first") {
          await new Promise<void>((resolve) => {
            acceptFirst = resolve;
          });
        }
        return { accepted: true };
      },
    });

    const first = queue.enqueue("session-1", "first");
    const second = queue.enqueue("session-1", "second");
    await Promise.resolve();
    expect(sent).toEqual(["first"]);

    // Provider completion and the submit RPC response use independent frames.
    queue.setBusy("session-1", false);
    acceptFirst?.();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(sent).toEqual(["first", "second"]);
    await queue.close();
  });

  it("retries when provider readiness overtakes a busy rejection", async () => {
    const sent: string[] = [];
    let rejectFirst: ((error: Error) => void) | undefined;
    const queue = createDeferredPromptQueue({
      send: (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        if (sent.length > 1) return Promise.resolve({ accepted: true });
        return new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      },
      shouldRetry: isPromptBusyError,
    });

    const delivered = queue.enqueue("session-1", "first");
    await Promise.resolve();
    queue.setBusy("session-1", false);
    rejectFirst?.(new Error("Another prompt is already active for this session."));

    await expect(delivered).resolves.toBe(true);
    expect(sent).toEqual(["first", "first"]);
    await queue.close();
  });

  it("does not advance to a later prompt after a non-acceptance failure", async () => {
    const sent: string[] = [];
    const failure = new Error("provider rejected the prompt");
    const queue = createDeferredPromptQueue({
      send: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        throw failure;
      },
    });

    const first = queue.enqueue("session-1", "first");
    const second = queue.enqueue("session-1", "second");
    await expect(first).rejects.toBe(failure);
    queue.setBusy("session-1", false);
    await Promise.resolve();
    expect(sent).toEqual(["first"]);

    await queue.close();
    await expect(second).resolves.toBe(false);
  });

  it("waits for an in-flight acceptance before clearing unsent prompts on close", async () => {
    let accept: (() => void) | undefined;
    const queue = createDeferredPromptQueue({
      send: () => new Promise<void>((resolve) => {
        accept = resolve;
      }),
    });
    const first = queue.enqueue("session-1", "first");
    const second = queue.enqueue("session-1", "second");
    const closing = queue.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    accept?.();
    await closing;
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
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
