// ABOUTME: Guards the provider runtime auth-status surface used by backend one-shot routing.
// ABOUTME: Prevents regressions where install availability is mistaken for CLI subscription login.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const registrySource = readSource("bin/browser-local/agent-registry.mjs");
const runtimeSource = readSource("bin/provider-runtime.mjs");
const providersSource = readSource("bin/browser-local/providers.mjs");
const providerServiceSource = readSource("src/services/providers.ts");

describe("provider agent authentication status", () => {
  it("reports authenticated separately from availability", () => {
    expect(registrySource).toContain("function isAgentAuthenticated(agentType)");
    expect(registrySource).toContain("authenticated: isAgentAuthenticated");
    expect(registrySource).toContain('path.join(home, ".claude", ".credentials.json")');
    expect(registrySource).toContain('path.join(home, ".codex", "auth.json")');
    expect(registrySource).toContain('path.join(home, ".gemini", "oauth_creds.json")');
  });

  it("exposes a provider_check_agent_authenticated RPC", () => {
    expect(runtimeSource).toContain("provider_check_agent_authenticated");
    expect(providersSource).toContain("checkAgentAuthenticated({ agentType })");
    expect(providerServiceSource).toContain("authenticated?: boolean");
    expect(providerServiceSource).toContain("provider_check_agent_authenticated");
  });
});
