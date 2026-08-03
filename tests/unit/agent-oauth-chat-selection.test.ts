// ABOUTME: Guards the runtime-to-renderer handoff for chat-selected OAuth accounts.
// ABOUTME: Ensures an explicit publisher selector becomes the owning thread's active account.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("chat-selected OAuth account persistence (#3589)", () => {
  it("subscribes to the runtime selection event and persists by provider", () => {
    const providers = read("src/services/providers.ts");
    const store = read("src/stores/agent.store.ts");
    const caseStart = store.indexOf('case "oauthAccountSelected":');
    const caseEnd = store.indexOf('case "error":', caseStart);
    const selectionCase = store.slice(caseStart, caseEnd);

    expect(providers).toContain(
      'oauthAccountSelected: "oauth-account-selected"',
    );
    expect(caseStart).toBeGreaterThan(0);
    expect(selectionCase).toContain("resolveOAuthProviderForPublisher");
    expect(selectionCase).toContain("setThreadOAuthConnectionId");
    expect(selectionCase).toContain("refreshAgentOAuthRouting");
  });

  it("wires every native Seren MCP proxy to the selection event", () => {
    const runtimeSources = [
      "bin/browser-local/providers.mjs",
      "bin/browser-local/claude-runtime.mjs",
      "bin/browser-local/acp-runtime.mjs",
      "bin/browser-local/lmstudio-runtime.mjs",
    ];

    for (const path of runtimeSources) {
      const source = read(path);
      expect(source, path).toContain("createOAuthSelectionEventEmitter");
      expect(source, path).toContain("onConnectionSelected:");
    }
  });
});
