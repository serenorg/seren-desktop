// ABOUTME: Regression coverage for centralized logout state cleanup.
// ABOUTME: Keeps user-scoped store resets owned by one session boundary.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function readSource(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("resetUserSessionState", () => {
  it("owns user-scoped store and query-cache cleanup", () => {
    const source = readSource("src/services/session-state.ts");

    for (const call of [
      "queryClient.clear();",
      "autocompleteStore.disable();",
      "chatStore.resetSessionState();",
      "conversationStore.resetSessionState();",
      "agentStore.resetSessionState();",
      "resetMcpChatState();",
      "employeeStore.clear();",
      "threadStore.clear();",
      "workspaceStore.reset();",
      "projectStore.clear();",
      "sessionStore.clear();",
      "resetWalletState();",
      "resetAgentTasksState();",
      "indexingStore.reset();",
    ]) {
      expect(source).toContain(call);
    }
  });

  it("is used by the app auth transition instead of ad-hoc store resets", () => {
    const source = readSource("src/App.tsx");

    expect(source).toContain('from "@/services/session-state"');
    expect(source).toContain("resetUserSessionState();");
  });

  it("reloads persisted threads after signing back in", () => {
    const source = readSource("src/App.tsx");
    const authBranch = source.indexOf('console.log("[App] User authenticated');

    expect(authBranch).toBeGreaterThan(0);
    const branchBody = source.slice(authBranch, authBranch + 2000);
    expect(branchBody).toContain("void threadStore.refresh();");
  });

  it("re-initializes the agent runtime listeners on re-login", () => {
    // `resetUserSessionState()` disposes the provider-runtime / CLI-scan /
    // schema-drift listeners; without a symmetric re-subscribe on the next
    // sign-in the user would have to reload the app to see late-arriving
    // runtime events. The await block at mount handles the initial-mount
    // case; this assertion pins the re-login path.
    const source = readSource("src/App.tsx");
    const authBranch = source.indexOf('console.log("[App] User authenticated');
    expect(authBranch).toBeGreaterThan(0);
    const branchBody = source.slice(authBranch, authBranch + 2000);
    expect(branchBody).toContain("agentStore.initialize()");
    expect(branchBody).toContain("prev === false");
  });

  it("agent reset disposes runtime side-channel listeners and stale restart work", () => {
    const source = readSource("src/stores/agent.store.ts");

    const resetIdx = source.indexOf("resetSessionState()");
    expect(resetIdx).toBeGreaterThan(0);
    const resetBody = source.slice(resetIdx, resetIdx + 700);
    expect(resetBody).toContain("sessionResetGeneration += 1;");
    expect(resetBody).toContain("disposeAgentStoreRuntimeBindings();");

    const runtimeDisposeIdx = source.indexOf(
      "function disposeAgentStoreRuntimeBindings()",
    );
    expect(runtimeDisposeIdx).toBeGreaterThan(0);
    const runtimeDisposeBody = source.slice(
      runtimeDisposeIdx,
      runtimeDisposeIdx + 500,
    );
    expect(runtimeDisposeBody).toContain(
      "disposeAgentStoreSideChannelListeners();",
    );

    const sideChannelDisposeIdx = source.indexOf(
      "function disposeAgentStoreSideChannelListeners()",
    );
    expect(sideChannelDisposeIdx).toBeGreaterThan(0);
    const sideChannelDisposeBody = source.slice(
      sideChannelDisposeIdx,
      sideChannelDisposeIdx + 900,
    );
    expect(sideChannelDisposeBody).toContain(
      "providerRuntimeReadyListener = null;",
    );
    expect(sideChannelDisposeBody).toContain(
      "providerRuntimeRestartedListener = null;",
    );
    expect(sideChannelDisposeBody).toContain("cliScanRejectedUnsub?.();");
    expect(sideChannelDisposeBody).toContain(
      "syntheticSchemaDriftUnsub?.();",
    );

    const restartListenerIdx = source.indexOf(
      "function subscribeToProviderRuntimeRestarted()",
    );
    expect(restartListenerIdx).toBeGreaterThan(0);
    const restartListenerBody = source.slice(
      restartListenerIdx,
      restartListenerIdx + 4200,
    );
    expect(restartListenerBody).toContain(
      "const restartGeneration = sessionResetGeneration;",
    );
    expect(restartListenerBody).toContain(
      "restartGeneration !== sessionResetGeneration",
    );
    expect(restartListenerBody).toContain(
      "providerService.terminateSession(newId)",
    );
  });
});
