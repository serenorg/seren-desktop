// ABOUTME: Guards Happy bridge recovery when a stable relay tag returns metadata
// ABOUTME: that the restarted data-key client can no longer decrypt.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { getOrCreateUsableHappySession } from "../../bin/happy-bridge/happy-layer.mjs";

describe("Happy relay session recovery", () => {
  it("replaces an existing session whose metadata is unreadable", async () => {
    const metadata = { path: "/advertised/project" };
    const calls: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const replacement = { id: "replacement", metadata };
    const api = {
      getOrCreateSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return calls.length === 1 ? { id: "stale", metadata: null } : replacement;
      },
    };

    await expect(
      getOrCreateUsableHappySession({
        api,
        tag: "seren-local-session",
        metadata,
        state: { controlledByUser: true },
        debugLog: (message: string) => logs.push(message),
        replacementTag: () => "seren-recovery-test",
      }),
    ).resolves.toBe(replacement);
    expect(calls.map((call) => call.tag)).toEqual([
      "seren-local-session",
      "seren-recovery-test",
    ]);
    expect(logs).toEqual(["replacing Happy session with unreadable metadata"]);
  });

  it("fails closed when the replacement session is also unreadable", async () => {
    const api = {
      getOrCreateSession: async () => ({ id: "stale", metadata: null }),
    };

    await expect(
      getOrCreateUsableHappySession({
        api,
        tag: "seren-local-session",
        metadata: { path: "/advertised/project" },
        state: { controlledByUser: true },
        replacementTag: () => "seren-recovery-test",
      }),
    ).resolves.toBeNull();
  });
});
