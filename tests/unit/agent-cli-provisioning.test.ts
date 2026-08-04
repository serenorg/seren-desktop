// ABOUTME: Completeness guard for automatic coding-agent CLI provisioning across the live roster.
// ABOUTME: Verifies every desktop OS resolves the same writable Seren-managed install prefix.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registryModule = new URL(
  "../../bin/browser-local/agent-registry.mjs",
  import.meta.url,
).href;
const cliPathsModule = new URL(
  "../../bin/browser-local/cli-paths.mjs",
  import.meta.url,
).href;

const {
  _AGENT_CLI_PROVISIONING: provisioning,
  _assertAgentCliProvisioningComplete: assertAgentCliProvisioningComplete,
} = await import(/* @vite-ignore */ registryModule);
const { managedCliBinary, managedCliPrefix } = await import(
  /* @vite-ignore */ cliPathsModule
);

const registrySource = readFileSync(
  new URL("../../bin/browser-local/agent-registry.mjs", import.meta.url),
  "utf8",
);
const claudeRuntimeSource = readFileSync(
  new URL("../../bin/browser-local/claude-runtime.mjs", import.meta.url),
  "utf8",
);
const grokResolverSource = readFileSync(
  new URL("../../bin/browser-local/grok-binary.mjs", import.meta.url),
  "utf8",
);

describe("#3680 complete automatic CLI provisioning roster", () => {
  it("classifies every CLI-backed agent enumerated by the live registry", () => {
    expect(provisioning).toEqual({
      codex: { kind: "npm", target: "codex" },
      "claude-code": { kind: "npm", target: "claude" },
      "claude-codex": {
        kind: "derived",
        dependencies: ["claude-code", "codex"],
      },
      gemini: { kind: "verified-artifact", target: "antigravity" },
      grok: { kind: "npm", target: "grok" },
      lmstudio: { kind: "external-app", target: "lmstudio" },
    });
  });

  it("fails closed when the runtime roster and provisioning source drift", () => {
    const completeDefinitions = Object.fromEntries(
      Object.keys(provisioning).map((agentType) => [agentType, {}]),
    );
    expect(() =>
      assertAgentCliProvisioningComplete(completeDefinitions, provisioning),
    ).not.toThrow();
    expect(() =>
      assertAgentCliProvisioningComplete(
        { ...completeDefinitions, futureAgent: {} },
        provisioning,
      ),
    ).toThrow(/provisioning is incomplete/);
  });

  it("derives startup provisioning from the roster instead of a partial hardcoded list", () => {
    expect(registrySource).toContain(
      "Object.values(AGENT_CLI_PROVISIONING)",
    );
    expect(registrySource).toContain(
      "assertAgentCliProvisioningComplete(definitions, AGENT_CLI_PROVISIONING)",
    );
    expect(registrySource).toContain("for (const target of new Set(managedNpmTargets))");
    expect(registrySource).not.toContain('void runCliUpdate("codex")');
    expect(registrySource).not.toContain('void runCliUpdate("claude")');
  });

  it("routes install, availability, and runtime spawn through the managed prefix", () => {
    expect(registrySource).toContain('managedCliBinary("claude")');
    expect(registrySource).toContain('managedCliBinary("codex")');
    expect(registrySource).toContain("installPrefix: managedCliPrefix()");
    expect(claudeRuntimeSource).toContain('managedCliBinary("claude")');
    expect(grokResolverSource).toContain("managedCliPrefix");
    expect(grokResolverSource).toContain("managedNative");
  });

  it("keeps Seren's verified Claude copy ahead of stale user-managed installs", () => {
    for (const source of [registrySource, claudeRuntimeSource]) {
      const managedPositions = [
        ...source.matchAll(/managedCliBinary\("claude"\)/g),
      ].map((match) => match.index);
      const userManagedPositions = [
        ...source.matchAll(
          /path\.join\(home, "\.claude", "bin", "claude(?:\.exe)?"\)/g,
        ),
      ].map((match) => match.index);
      expect(managedPositions).toHaveLength(2);
      expect(userManagedPositions).toHaveLength(2);
      expect(managedPositions[0]).toBeLessThan(userManagedPositions[0]);
      expect(managedPositions[1]).toBeLessThan(userManagedPositions[1]);
    }
  });

  it.each([
    {
      platform: "win32",
      home: "C:\\Users\\person",
      appData: "C:\\Users\\person\\AppData\\Roaming",
      expectedPrefix:
        "C:\\Users\\person\\AppData\\Roaming\\Seren\\cli-tools",
      expectedBinary:
        "C:\\Users\\person\\AppData\\Roaming\\Seren\\cli-tools\\codex.cmd",
    },
    {
      platform: "darwin",
      home: "/Users/person",
      appData: "",
      expectedPrefix: "/Users/person/.seren/cli-tools",
      expectedBinary: "/Users/person/.seren/cli-tools/bin/codex",
    },
    {
      platform: "linux",
      home: "/home/person",
      appData: "",
      expectedPrefix: "/home/person/.seren/cli-tools",
      expectedBinary: "/home/person/.seren/cli-tools/bin/codex",
    },
  ])("uses a per-user managed prefix on $platform", (fixture) => {
    const prefix = managedCliPrefix(fixture);
    expect(prefix).toBe(fixture.expectedPrefix);
    expect(
      managedCliBinary("codex", {
        platform: fixture.platform,
        prefix,
      }),
    ).toBe(fixture.expectedBinary);
  });
});
