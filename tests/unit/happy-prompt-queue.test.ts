// ABOUTME: Protects Happy phone prompts submitted while a local agent turn is active.
// ABOUTME: The queued prompt must wait for readiness and then run exactly once.

import { describe, expect, it } from "vitest";

import { createDeferredPromptQueue } from "../../bin/happy-bridge/happy-layer.mjs";

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
});
