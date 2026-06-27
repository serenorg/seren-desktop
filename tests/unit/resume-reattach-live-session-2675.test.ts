// ABOUTME: Regression checks for #2675 — re-attach must restore live runtime
// ABOUTME: approval/model/mode state and serialize concurrent adoption.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const providerServiceSource = readFileSync(
  resolve("src/services/providers.ts"),
  "utf-8",
);
const runtimeSources = [
  "bin/browser-local/claude-runtime.mjs",
  "bin/browser-local/providers.mjs",
  "bin/browser-local/gemini-runtime.mjs",
  "bin/browser-local/lmstudio-runtime.mjs",
].map((path) => [path, readFileSync(resolve(path), "utf-8")] as const);

function extractMethodBody(name: string): string {
  const start = agentStoreSource.indexOf(`async ${name}(`);
  if (start < 0) return "";
  const rest = agentStoreSource.slice(start + 1);
  const nextAsync = rest.indexOf("\n  async ");
  return nextAsync < 0 ? agentStoreSource.slice(start) : rest.slice(0, nextAsync);
}

describe("#2675 — live re-attach restores runtime state", () => {
  const reattachBody = extractMethodBody("reattachLiveSession");

  it("listSessions exposes the runtime state needed to rehydrate the UI", () => {
    expect(providerServiceSource).toContain("currentModelId?: string | null");
    expect(providerServiceSource).toContain("currentModeId?: string | null");
    expect(providerServiceSource).toContain(
      "pendingPermissions?: PermissionRequestEvent[]",
    );
  });

  it("reattachLiveSession serializes concurrent adoption for one conversation", () => {
    expect(agentStoreSource).toContain("const reattachingConversations");
    expect(reattachBody).toContain(
      "const inFlight = reattachingConversations.get(conversationId)",
    );
    expect(reattachBody).toContain("return inFlight");
    expect(reattachBody).toContain(
      "reattachingConversations.set(conversationId, attempt)",
    );
    expect(reattachBody).toContain(
      "reattachingConversations.delete(conversationId)",
    );
  });

  it("reattachLiveSession prefers live runtime model and mode over stale DB values", () => {
    const runtimeModelAt = reattachBody.indexOf("liveInfo.currentModelId");
    const runtimeModeAt = reattachBody.indexOf("liveInfo.currentModeId");
    const sessionModelAt = reattachBody.indexOf("currentModelId: runtimeModelId");
    const sessionModeAt = reattachBody.indexOf("currentModeId: runtimeModeId");

    expect(runtimeModelAt).toBeGreaterThan(-1);
    expect(runtimeModeAt).toBeGreaterThan(-1);
    expect(sessionModelAt).toBeGreaterThan(runtimeModelAt);
    expect(sessionModeAt).toBeGreaterThan(runtimeModeAt);
  });

  it("reattachLiveSession re-surfaces pending approvals without duplicates", () => {
    expect(reattachBody).toContain("liveInfo.pendingPermissions");
    expect(reattachBody).toContain('setState("pendingPermissions"');
    expect(reattachBody).toContain("seenRequestIds");
    expect(agentStoreSource).toContain("permission.requestId === permEvent.requestId");
  });

  it("browser-local runtimes snapshot pending approvals through listSessions", () => {
    for (const [path, source] of runtimeSources) {
      expect(source, path).toContain("pendingPermissions: listPendingPermissions(session)");
      expect(source, path).toContain("currentModelId: session.currentModelId");
      expect(source, path).toContain("currentModeId: session.currentModeId");
    }
  });
});
