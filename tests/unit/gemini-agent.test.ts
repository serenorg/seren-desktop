// ABOUTME: Critical regression guards for the Gemini Agent integration (#1471).
// ABOUTME: Asserts wiring across runtime, agent registry, dispatcher, and OAuth-removal sites.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type AgentType,
  supportsConversationFork,
} from "@/services/providers";

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
const providersTs = readFileSync(
  resolve("src/services/providers.ts"),
  "utf-8",
);
const agentStoreTs = readFileSync(
  resolve("src/stores/agent.store.ts"),
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

describe("Gemini Agent — TypeScript surface (#1471)", () => {
  it("AgentType union includes 'gemini'", () => {
    // Compile-time check via assignment — if the union doesn't include
    // "gemini", this file won't compile.
    const t: AgentType = "gemini";
    expect(t).toBe("gemini");
  });

  it("supportsConversationFork accepts gemini without throwing", () => {
    expect(supportsConversationFork("gemini")).toBe(true);
  });

  it("services/providers.ts exports ensureGeminiCli helper", () => {
    expect(providersTs).toMatch(/export async function ensureGeminiCli\(/);
    expect(providersTs).toContain('agentType: "gemini"');
  });
});

describe("Gemini Agent — runtime wiring (#1471)", () => {
  it("providers.mjs imports createGeminiRuntime", () => {
    expect(providersMjs).toContain(
      'import { createGeminiRuntime } from "./gemini-runtime.mjs"',
    );
  });

  it("providers.mjs instantiates the gemini runtime alongside claude", () => {
    expect(providersMjs).toContain("const geminiRuntime = createGeminiRuntime");
  });

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

  it("providers.mjs listSessions includes gemini sessions", () => {
    expect(providersMjs).toContain("await geminiRuntime.listSessions()");
  });
});

describe("Gemini Agent — registry definition (#1471)", () => {
  it("agent-registry.mjs defines a 'gemini' entry", () => {
    expect(agentRegistryMjs).toContain("gemini: {");
    expect(agentRegistryMjs).toContain('type: "gemini"');
    expect(agentRegistryMjs).toContain('packageName: "@google/gemini-cli"');
  });

  it("agent-registry.mjs uses ensureGlobalNpmPackage for gemini install", () => {
    // Same install pattern as Codex — npm global, not the Claude native installer.
    const geminiSection = agentRegistryMjs.slice(
      agentRegistryMjs.indexOf("gemini: {"),
    );
    expect(geminiSection).toContain("ensureGlobalNpmPackage");
    expect(geminiSection).toContain('command: "gemini"');
  });
});

describe("Gemini Agent — gemini-runtime.mjs ACP client (#1471)", () => {
  it("exports createGeminiRuntime factory matching the claude-runtime contract", () => {
    expect(geminiRuntimeMjs).toContain("export function createGeminiRuntime");
    // Must expose hasSession so providers.mjs fallback chain works.
    expect(geminiRuntimeMjs).toContain("hasSession(sessionId)");
    // Public RPC surface.
    expect(geminiRuntimeMjs).toContain("spawnSession");
    expect(geminiRuntimeMjs).toContain("sendPrompt");
    expect(geminiRuntimeMjs).toContain("cancelPrompt");
    expect(geminiRuntimeMjs).toContain("terminateSession");
    expect(geminiRuntimeMjs).toContain("respondToPermission");
  });

  it("spawns gemini-cli with the --acp flag", () => {
    // The whole point of this PR — gemini-cli must be invoked in ACP mode,
    // not interactive TUI mode.
    expect(geminiRuntimeMjs).toContain('"--acp"');
  });

  it("speaks ACP method names verbatim from the schema", () => {
    // Catches accidental rename to e.g. "session/newSession" or "newSession".
    expect(geminiRuntimeMjs).toContain('"initialize"');
    expect(geminiRuntimeMjs).toContain('"session/new"');
    expect(geminiRuntimeMjs).toContain('"session/prompt"');
    expect(geminiRuntimeMjs).toContain('"session/cancel"');
    expect(geminiRuntimeMjs).toContain('"session/request_permission"');
  });

  it("translates ACP session/update notifications to provider:// events", () => {
    // The session/update branch must handle each ACP update type and emit
    // the existing provider:// events the desktop already knows.
    expect(geminiRuntimeMjs).toContain('"agent_message_chunk"');
    expect(geminiRuntimeMjs).toContain('"agent_thought_chunk"');
    expect(geminiRuntimeMjs).toContain('"tool_call"');
    expect(geminiRuntimeMjs).toContain('"tool_call_update"');
    expect(geminiRuntimeMjs).toContain('"plan"');
    expect(geminiRuntimeMjs).toContain('"provider://message-chunk"');
    expect(geminiRuntimeMjs).toContain('"provider://tool-call"');
    expect(geminiRuntimeMjs).toContain('"provider://prompt-complete"');
  });

  it("declares an ACP protocol version constant", () => {
    expect(geminiRuntimeMjs).toContain("ACP_PROTOCOL_VERSION");
  });
});

describe("Gemini Agent — agent.store.ts wiring (#1471)", () => {
  it("agentDisplayName has a 'gemini' case", () => {
    // Whitespace-tolerant: case "gemini": ... return "Gemini";
    expect(agentStoreTs).toMatch(/case\s+"gemini":\s*\n\s*return\s+"Gemini"/);
  });

  it("CLI ensure dispatcher routes gemini to providerService.ensureGeminiCli", () => {
    expect(agentStoreTs).toContain("providerService.ensureGeminiCli");
  });

  it("contextWindowSize defaults to 1M for gemini", () => {
    // Gemini 2.5 Pro has a 1M+ context window — defaulting to 200k like
    // Claude would silently throttle the agent. Regression guard.
    expect(agentStoreTs).toMatch(
      /resolvedAgentType\s*===\s*"gemini"[^?]*\?\s*1_000_000/,
    );
  });

  it("DB type guard accepts 'gemini' as a valid agentType from disk", () => {
    expect(agentStoreTs).toContain('convo.agent_type === "gemini"');
  });
});

describe("Gemini Agent — thread.store.ts auto-detect (#1471)", () => {
  it("getBestAgent considers gemini in the availability fallback chain", () => {
    expect(threadStoreTs).toContain('a.type === "gemini" && a.available');
    expect(threadStoreTs).toContain('agentType: "gemini"');
  });
});

describe("Gemini Agent — UI surface (#1471)", () => {
  it("ThreadTabBar '+ New' menu includes a Gemini Agent button", () => {
    expect(threadTabBarTsx).toContain("allowsGeminiAgent");
    expect(threadTabBarTsx).toContain("Gemini Agent");
    expect(threadTabBarTsx).toContain('handleNewAgent("gemini")');
  });

  it("ThreadSidebar agent launcher includes a Gemini Agent button", () => {
    expect(threadSidebarTsx).toContain("allowsGeminiAgent");
    expect(threadSidebarTsx).toContain("Gemini Agent");
    expect(threadSidebarTsx).toContain(
      'threadStore.createAgentThread("gemini"',
    );
  });

  it("handleNewAgent type signature accepts 'gemini'", () => {
    expect(threadTabBarTsx).toMatch(
      /agentType:\s*"claude-code"\s*\|\s*"codex"\s*\|\s*"gemini"/,
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
