// ABOUTME: Guards stable Happy session keys and one-time recovery from pre-fix
// ABOUTME: relay rows whose process-local data key is no longer available.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { getOrCreateUsableHappySession } from "../../bin/happy-bridge/happy-layer.mjs";

describe("Happy relay session recovery", () => {
  it("keeps provider RPC available until Happy lifecycle cleanup finishes", () => {
    const source = readFileSync(resolve("bin/happy-bridge.mjs"), "utf8");
    const shutdownStart = source.indexOf("async function shutdown(");
    const shutdownBody = source.slice(shutdownStart, shutdownStart + 1600);
    const happyClose = shutdownBody.indexOf("happyLayer?.close()");
    const providerClose = shutdownBody.indexOf("client?.close()");

    expect(happyClose).toBeGreaterThan(0);
    expect(providerClose).toBeGreaterThan(happyClose);
    expect(shutdownBody).toContain("await Promise.allSettled([happyLayer?.close()])");
    expect(shutdownBody).toContain("await Promise.allSettled([client?.close()])");
    expect(shutdownBody).toContain("CLOSE_TIMEOUT_MS");
  });

  it("persists recovery state before replacing an unreadable legacy row", async () => {
    const metadata = { path: "/advertised/project" };
    const calls: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    const logs: string[] = [];
    const replacement = { id: "replacement", metadata };
    const encryptionKey = new Uint8Array(32).fill(9);
    const api = {
      getOrCreateSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        order.push(`get:${String(input.tag)}`);
        return calls.length === 1 ? { id: "stale", metadata: null } : replacement;
      },
      deactivateSession: async (id: string) => {
        order.push(`deactivate:${id}`);
        return true;
      },
    };

    await expect(
      getOrCreateUsableHappySession({
        api,
        tag: "seren-local-session",
        metadata,
        state: { controlledByUser: true },
        encryptionKey,
        allowLegacyReplacement: true,
        debugLog: (message: string) => logs.push(message),
        replacementTag: "seren-v2-machine-local-session",
        persistReplacementTag: async (tag: string) => {
          order.push(`persist-tag:${tag}`);
        },
        persistReady: async (sessionId: string) => {
          order.push(`persist-ready:${sessionId}`);
        },
      }),
    ).resolves.toBe(replacement);
    expect(calls.map((call) => call.tag)).toEqual([
      "seren-local-session",
      "seren-v2-machine-local-session",
    ]);
    expect(calls.every((call) => call.encryptionKey === encryptionKey)).toBe(true);
    expect(order).toEqual([
      "get:seren-local-session",
      "deactivate:stale",
      "persist-tag:seren-v2-machine-local-session",
      "get:seren-v2-machine-local-session",
      "persist-ready:replacement",
    ]);
    expect(logs).toEqual(["retiring Happy session with unreadable metadata"]);
  });

  it("fails closed instead of exposing a replacement beside an unretired row", async () => {
    const api = {
      getOrCreateSession: async () => ({ id: "stale", metadata: null }),
      deactivateSession: async () => false,
    };

    await expect(
      getOrCreateUsableHappySession({
        api,
        tag: "seren-local-session",
        metadata: { path: "/advertised/project" },
        state: { controlledByUser: true },
        encryptionKey: new Uint8Array(32),
        allowLegacyReplacement: true,
        replacementTag: "seren-v2-machine-local-session",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when a ready binding resolves to another relay row", async () => {
    let persisted = false;
    let deactivatedSessionId: string | null = null;
    const api = {
      getOrCreateSession: async () => ({ id: "unexpected-row", metadata: { path: "/safe" } }),
      deactivateSession: async (sessionId: string) => {
        deactivatedSessionId = sessionId;
        return true;
      },
    };

    await expect(
      getOrCreateUsableHappySession({
        api,
        tag: "stored-recovery-tag",
        metadata: { path: "/advertised/project" },
        state: { controlledByUser: true },
        encryptionKey: new Uint8Array(32),
        expectedSessionId: "expected-row",
        persistReady: async () => {
          persisted = true;
        },
      }),
    ).resolves.toBeNull();
    expect(persisted).toBe(false);
    expect(deactivatedSessionId).toBe("unexpected-row");
  });
});
