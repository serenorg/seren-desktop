// ABOUTME: Critical regression guards for Antigravity behind the durable Gemini agent ID.
// ABOUTME: Asserts runtime, registry, dispatcher, UI, and OAuth boundaries.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const providersMjs = readFileSync(
  resolve("bin/browser-local/providers.mjs"),
  "utf-8",
);
const agentRegistryMjs = readFileSync(
  resolve("bin/browser-local/agent-registry.mjs"),
  "utf-8",
);
const geminiRuntimeMjs = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);
const antigravityBinaryMjs = readFileSync(
  resolve("bin/browser-local/antigravity-binary.mjs"),
  "utf-8",
);
const agentStoreTs = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const compactionTs = readFileSync(
  resolve("src/lib/agent/compaction.ts"),
  "utf-8",
);
const bootstrapContextTs = readFileSync(
  resolve("src/lib/agent/bootstrap-context.ts"),
  "utf-8",
);
const threadStoreTs = readFileSync(
  resolve("src/stores/thread.store.ts"),
  "utf-8",
);
const threadTabBarTsx = readFileSync(
  resolve("src/components/layout/ThreadTabBar.tsx"),
  "utf-8",
);
const threadSidebarTsx = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf-8",
);
const providerIndexTs = readFileSync(
  resolve("src/lib/providers/index.ts"),
  "utf-8",
);
const providerTypesTs = readFileSync(
  resolve("src/lib/providers/types.ts"),
  "utf-8",
);

describe("Gemini Agent — runtime wiring (#1471)", () => {
  it("providers.mjs spawnSession dispatcher routes 'gemini' to the gemini runtime", () => {
    // Look for the dispatcher pattern: must include both the type guard and
    // the delegation. Whitespace-tolerant.
    expect(providersMjs).toMatch(
      /if\s*\(\s*agentType\s*===\s*"gemini"\s*\)\s*\{[^}]*geminiRuntime\.spawnSession/s,
    );
  });

  it("providers.mjs handlers fall back to gemini runtime via hasSession", () => {
    // Each per-session handler (sendPrompt, cancelPrompt, terminateSession,
    // setPermissionMode, respondToPermission) must check geminiRuntime.hasSession
    // before falling through to claude. We assert the call appears multiple
    // times rather than counting precise locations.
    const matches = providersMjs.match(/geminiRuntime\.hasSession/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

});

describe("Antigravity Agent — registry definition (#3648)", () => {
  it("agent-registry.mjs defines a 'gemini' entry", () => {
    expect(agentRegistryMjs).toContain("gemini: {");
    expect(agentRegistryMjs).toContain('type: "gemini"');
    expect(agentRegistryMjs).toContain('name: "Antigravity"');
    expect(agentRegistryMjs).toContain('command: "agy"');
  });

  it("uses the verified native installer, never the retired Gemini npm package", () => {
    const geminiSection = agentRegistryMjs.slice(
      agentRegistryMjs.indexOf("gemini: {"),
    );
    expect(geminiSection).toContain("ensureAntigravityCli");
    expect(geminiSection).toContain("launchInteractiveCommand");
    expect(geminiSection).not.toContain("@google/gemini-cli");
    expect(antigravityBinaryMjs).toContain('createHash("sha512")');
    expect(antigravityBinaryMjs).toContain("storage.googleapis.com");
  });
});

describe("Antigravity Agent — structured headless runtime (#3648)", () => {
  it("keeps the serialized gemini route while removing the deprecated ACP transport", () => {
    expect(geminiRuntimeMjs).toContain("export function createGeminiRuntime");
    expect(geminiRuntimeMjs).toContain('agentType: "gemini"');
    expect(geminiRuntimeMjs).not.toContain("createAcpRuntime");
    expect(geminiRuntimeMjs).not.toContain('"--acp"');
  });

  it("spawns Antigravity stream-json and resumes its conversation ID", () => {
    expect(geminiRuntimeMjs).toContain('"--output-format"');
    expect(geminiRuntimeMjs).toContain('"stream-json"');
    expect(geminiRuntimeMjs).toContain('"--conversation"');
    expect(geminiRuntimeMjs).toContain("session.agentSessionId");
  });

  it("translates typed stream events to the existing provider event surface", () => {
    expect(geminiRuntimeMjs).toContain('type === "init"');
    expect(geminiRuntimeMjs).toContain('type === "step_update"');
    expect(geminiRuntimeMjs).toContain('type === "result"');
    expect(geminiRuntimeMjs).toContain('"provider://message-chunk"');
    expect(geminiRuntimeMjs).toContain('"provider://tool-call"');
    expect(geminiRuntimeMjs).toContain('"provider://prompt-complete"');
  });
});

describe("Gemini Agent — agent.store.ts wiring (#1471)", () => {
  it("agentDisplayName has a 'gemini' case", () => {
    expect(bootstrapContextTs).toMatch(
      /case\s+"gemini":\s*\n\s*return\s+"Antigravity"/,
    );
  });

  it("CLI ensure dispatcher routes gemini to providerService.ensureGeminiCli", () => {
    expect(agentStoreTs).toContain("providerService.ensureGeminiCli");
  });

  it("contextWindowSize defaults to 1M for gemini", () => {
    // Gemini 2.5 Pro has a 1M+ context window — defaulting to 200k like
    // Claude would silently throttle the agent. Regression guard.
    // #1749: this default now lives in defaultContextWindowFor; the spawn
    // block delegates via that helper. Assert the helper still maps gemini
    // to 1M.
    const helperStart = compactionTs.indexOf(
      "function defaultContextWindowFor(",
    );
    expect(helperStart, "defaultContextWindowFor must exist").toBeGreaterThan(0);
    const helperEnd = compactionTs.indexOf("\n}\n", helperStart);
    const helperBody = compactionTs.slice(helperStart, helperEnd);
    expect(helperBody).toMatch(
      /agentType\s*===\s*"gemini"\)?\s*return\s*1_000_000/,
    );
  });

  it("DB type guard accepts 'gemini' as a valid agentType from disk", () => {
    expect(agentStoreTs).toContain('convo.agent_type === "gemini"');
  });
});

describe("Gemini Agent — thread.store.ts auto-detect (#1471)", () => {
  it("getBestAgent considers gemini in the availability fallback chain", () => {
    expect(threadStoreTs).toContain(
      'a.type === "gemini" && canAutoSelectAgent(a)',
    );
    expect(threadStoreTs).toContain('agentType: "gemini"');
  });
});

describe("LM Studio Agent — thread.store.ts auto-detect (#2451)", () => {
  it("only auto-selects LM Studio when it is reachable or startable", () => {
    expect(threadStoreTs).toContain(
      'agent.available && (agent.type !== "lmstudio" || agent.authenticated)',
    );
    expect(threadStoreTs).toContain(
      'a.type === "lmstudio" && canAutoSelectAgent(a)',
    );
  });
});

describe("Gemini Agent — UI surface (#1471)", () => {
  it("ThreadTabBar '+ New' menu includes an Antigravity button", () => {
    // Label dropped the "Agent" suffix in #1832 once the chip vocabulary was added —
    // the chip + section header now convey the kind. Wiring = testid + handler.
    expect(threadTabBarTsx).toContain("allowsGeminiAgent");
    expect(threadTabBarTsx).toContain('data-testid="new-gemini-agent"');
    expect(threadTabBarTsx).toContain('handleNewAgent("gemini")');
    expect(threadTabBarTsx).toContain("Antigravity");
  });

  it("ThreadSidebar agent launcher includes an Antigravity button", () => {
    expect(threadSidebarTsx).toContain("allowsGeminiAgent");
    expect(threadSidebarTsx).toContain('data-testid="new-gemini-agent"');
    expect(threadSidebarTsx).toContain('handleNewAgent("gemini")');
    expect(threadSidebarTsx).toContain("Antigravity");
    // Helper still routes to threadStore.createAgentThread under the hood.
    expect(threadSidebarTsx).toMatch(
      /threadStore\.createAgentThread\(\s*agentType\s*,\s*cwd\s*\)/,
    );
  });

  it("handleNewAgent type signature accepts 'gemini'", () => {
    expect(threadTabBarTsx).toMatch(
      /agentType:[\s\S]{0,120}"claude-code"[\s\S]{0,120}"codex"[\s\S]{0,120}"gemini"/,
    );
  });
});

describe("Gemini OAuth removal (#1471)", () => {
  it("ProviderId union no longer includes 'gemini'", () => {
    // The Gemini OAuth provider was removed in favor of the Gemini Agent.
    // The ProviderId union should NOT contain a 'gemini' member anymore.
    // We assert the literal string `| "gemini"` is gone from the union block.
    const unionBlock = providerTypesTs.slice(
      providerTypesTs.indexOf("export type ProviderId"),
      providerTypesTs.indexOf("/**", providerTypesTs.indexOf("export type ProviderId")),
    );
    expect(unionBlock).not.toContain('"gemini"');
  });

  it("OAUTH_PROVIDERS is empty (gemini OAuth removed)", () => {
    expect(providerTypesTs).toMatch(/OAUTH_PROVIDERS:\s*ProviderId\[\]\s*=\s*\[\s*\]/);
  });

  it("CONFIGURABLE_PROVIDERS no longer includes gemini", () => {
    const block = providerTypesTs.slice(
      providerTypesTs.indexOf("CONFIGURABLE_PROVIDERS"),
    );
    const arrayBlock = block.slice(0, block.indexOf("]") + 1);
    expect(arrayBlock).not.toContain('"gemini"');
  });

  it("provider registry in index.ts no longer imports geminiProvider", () => {
    expect(providerIndexTs).not.toContain("geminiProvider");
    expect(providerIndexTs).not.toContain('from "./gemini"');
  });
});
