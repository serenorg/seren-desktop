// ABOUTME: Regression coverage for Happy-triggered agent archive invalidation.
// ABOUTME: Ensures an archived conversation cannot remain selectable or receive late runtime events.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HappyArchiveFence,
  planHappyArchiveInvalidation,
  planHappyProviderArchiveInvalidation,
  retireHappyArchivedSiblingProvider,
} from "@/stores/agent.store";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf8",
);

describe("Happy conversation archive invalidation", () => {
  it("fences stale async commits and filters delayed refresh results", async () => {
    const fence = new HappyArchiveFence();
    const generation = fence.capture("archived-conversation");
    const delayedRows = Promise.resolve([
      { id: "archived-conversation" },
      { id: "remaining-conversation" },
    ]);

    expect(fence.allows("archived-conversation", generation)).toBe(true);
    const archiveGeneration = fence.archive("archived-conversation");
    expect(fence.archive("archived-conversation")).toBe(archiveGeneration);
    expect(fence.allows("archived-conversation", generation)).toBe(false);
    expect(fence.filterVisible(await delayedRows)).toEqual([
      { id: "remaining-conversation" },
    ]);
  });

  it("plans eviction of serving and standby sessions and selects another live conversation", () => {
    const plan = planHappyArchiveInvalidation(
      {
        serving: {
          conversationId: "archived-conversation",
          role: "serving",
          standbySessionId: "standby",
        },
        standby: {
          conversationId: "standby-runtime-id",
          role: "standby",
        },
        remaining: { conversationId: "remaining-conversation", role: "serving" },
      },
      "serving",
      "archived-conversation",
    );

    expect(plan).toEqual({
      archivedSessionIds: ["serving", "standby"],
      nextActiveSessionId: "remaining",
    });
    expect(
      planHappyArchiveInvalidation(
        {
          standby: {
            conversationId: "standby-runtime-id",
            archiveOwnerConversationId: "archived-conversation",
            role: "standby",
          },
        },
        null,
        "archived-conversation",
      ),
    ).toEqual({ archivedSessionIds: ["standby"], nextActiveSessionId: null });
    expect(
      planHappyArchiveInvalidation(
        {
          promoted: {
            conversationId: "archived-conversation",
            role: "serving",
          },
        },
        "promoted",
        "archived-conversation",
      ),
    ).toEqual({ archivedSessionIds: ["promoted"], nextActiveSessionId: null });
    expect(
      planHappyArchiveInvalidation(
        { remaining: { conversationId: "remaining-conversation", role: "serving" } },
        "remaining",
        "archived-conversation",
      ),
    ).toEqual({ archivedSessionIds: [], nextActiveSessionId: "remaining" });
  });

  it("evicts only an unowned provider and releases its serving back-reference", () => {
    expect(
      planHappyProviderArchiveInvalidation(
        {
          serving: {
            role: "serving",
            standbySessionId: "unowned-standby",
          },
          "unowned-standby": { role: "standby" },
          remaining: { role: "serving" },
        },
        "unowned-standby",
        "unowned-standby",
      ),
    ).toEqual({
      archivedSessionIds: ["unowned-standby"],
      linkedServingSessionIds: ["serving"],
      nextActiveSessionId: "serving",
    });
  });

  it("durably fences before considering a sibling retired", async () => {
    const calls: string[] = [];
    let fenceAttempts = 0;
    const result = await retireHappyArchivedSiblingProvider(
      "archived-sibling",
      1234,
      {
        fence: async () => {
          calls.push("fence");
          fenceAttempts += 1;
          if (fenceAttempts === 1) throw new Error("temporary database error");
        },
        terminate: async () => {
          calls.push("terminate");
        },
        forceKill: async () => {
          calls.push("force-kill");
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      fenced: true,
      retired: true,
      forceKilled: false,
    });
    expect(calls).toEqual(["fence", "fence", "terminate"]);
  });

  it("uses the PID-guarded force-kill as soon as sibling termination fails", async () => {
    const forceKilledPids: number[] = [];
    const result = await retireHappyArchivedSiblingProvider(
      "archived-sibling",
      4321,
      {
        fence: async () => {},
        terminate: async () => {
          throw new Error("provider runtime disconnected");
        },
        forceKill: async (pid) => {
          forceKilledPids.push(pid);
          return true;
        },
      },
    );

    expect(result).toMatchObject({
      fenced: true,
      retired: true,
      forceKilled: true,
    });
    expect(forceKilledPids).toEqual([4321]);
  });

  it("evicts the cached thread through a Happy-only disposable side-channel listener", () => {
    const listenerStart = agentStoreSource.indexOf(
      "function subscribeToAgentConversationArchived()",
    );
    expect(listenerStart).toBeGreaterThan(0);
    const listenerEnd = agentStoreSource.indexOf(
      "function subscribeToClaudeMemoryIntercepts()",
      listenerStart,
    );
    const listenerBody = agentStoreSource.slice(
      listenerStart,
      listenerEnd > listenerStart ? listenerEnd : listenerStart + 9000,
    );

    expect(listenerBody).toContain('"happy-bridge://conversation-archived"');
    expect(listenerBody).toContain("happyArchiveFence.archive(conversationId)");
    expect(listenerBody).toContain("row.id !== conversationId");
    expect(listenerBody).toContain("terminatedSessionIds.add(sessionId)");
    expect(listenerBody).toContain("payload.targetProviderSessionId");
    expect(listenerBody).toContain("planHappyProviderArchiveInvalidation(");
    expect(listenerBody).toContain("serving.standbySessionId = null");
    expect(listenerBody).toContain("serving.predictiveCompactInFlight = false");
    expect(listenerBody).toContain(
      "predictiveCompactMutex.releaseCurrentForAny(",
    );
    expect(listenerBody).toContain("sessionId !== targetProviderSessionId");
    expect(listenerBody).toContain("retireHappyArchivedSiblingProvider(");
    expect(listenerBody).toContain("fenceHappyProviderSessionArchive");
    expect(listenerBody).toContain("timeoutMs: 5_000");
    expect(listenerBody).toContain("forceKill: providerService.forceKillSession");
    expect(listenerBody).toContain("clearChunkBuf(sessionId)");
    expect(listenerBody).toContain("restartTimers.delete(conversationId)");
    expect(listenerBody).toContain('setState("pendingPermissions"');
    expect(listenerBody).toContain("delete draft.sessions[sessionId]");
    expect(listenerBody).toContain("delete draft.threadStates[conversationId]");
    expect(listenerBody).toContain("planHappyArchiveInvalidation(");
    expect(listenerBody).toContain('setState("activeSessionId", nextActiveSessionId)');

    expect(agentStoreSource).toContain(
      "subscribeToAgentConversationArchived();",
    );
    const disposeStart = agentStoreSource.indexOf(
      "function disposeAgentStoreSideChannelListeners()",
    );
    const disposeBody = agentStoreSource.slice(disposeStart, disposeStart + 900);
    expect(disposeBody).toContain(
      "agentConversationArchivedListener = null;",
    );
    expect(disposeBody).toContain(
      'disposeTauriListener(archivedListener, "agent-conversation archived")',
    );
  });

  it("guards late spawn and reattach commits and terminates their providers", () => {
    const spawnStart = agentStoreSource.indexOf("async spawnSession(");
    const spawnEnd = agentStoreSource.indexOf(
      "async ensureAgentEventSubscription()",
      spawnStart,
    );
    const spawnBody = agentStoreSource.slice(spawnStart, spawnEnd);
    expect(spawnBody).toContain("happyArchiveAllowsCommit");
    expect(spawnBody).toContain("happyArchiveOwnerConversationId");
    expect(spawnBody).toContain("persistedConversation?.is_archived");
    expect(spawnBody).toContain("discardLateArchivedProviderSession(");
    expect(spawnBody.indexOf("happyArchiveAllowsCommit()")).toBeLessThan(
      spawnBody.indexOf('setState("sessions", info.id, session)'),
    );

    const reattachStart = agentStoreSource.indexOf(
      "async reattachLiveSession(",
    );
    const reattachEnd = agentStoreSource.indexOf(
      "async resumeAgentConversation(",
      reattachStart,
    );
    const reattachBody = agentStoreSource.slice(reattachStart, reattachEnd);
    expect(reattachBody).toContain("happyArchiveFence.allows(");
    expect(reattachBody).toContain("convo?.is_archived");
    expect(reattachBody).toContain("discardLateArchivedProviderSession(");

    const refreshStart = agentStoreSource.indexOf(
      "async refreshRecentAgentConversations(",
    );
    const refreshEnd = agentStoreSource.indexOf(
      "async loadMoreRemoteSessions(",
      refreshStart,
    );
    const refreshBody = agentStoreSource.slice(refreshStart, refreshEnd);
    expect(refreshBody.match(/happyArchiveFence\.filterVisible\(/g)).toHaveLength(
      2,
    );
    expect(
      agentStoreSource.match(
        /role: "standby",\n\s+archiveOwnerConversationId: conversationId,/g,
      ),
    ).toHaveLength(2);
  });
});
