// ABOUTME: Focused guard for #2904 — Codex spawn must block on upgrading old CLIs.
// ABOUTME: Prevents regressing to unverified ensureCli while GPT-5.6 defaults require a newer Codex.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentRegistrySource = readFileSync(
  new URL("../../bin/browser-local/agent-registry.mjs", import.meta.url),
  "utf8",
);

describe("#2904 Codex CLI upgrade gate", () => {
  it("Codex ensureCli uses the blocking updater before provider spawn", () => {
    const registryStart = agentRegistrySource.indexOf(
      "export function createBrowserLocalAgentRegistry",
    );
    const codexDefStart = agentRegistrySource.indexOf("codex: {", registryStart);
    const claudeDefStart = agentRegistrySource.indexOf(
      '"claude-code": {',
      codexDefStart,
    );
    const codexDefinition = agentRegistrySource.slice(
      codexDefStart,
      claudeDefStart,
    );

    expect(codexDefinition).toContain("async ensureCli()");
    expect(codexDefinition).toContain("return ensureCodexCliViaUpdater(emit)");
    expect(codexDefinition).not.toContain("return ensureGlobalNpmPackage({");
  });

  it("the Codex updater delegates to the shared baseline gate", () => {
    const wrapperStart = agentRegistrySource.indexOf(
      "async function ensureCodexCliViaUpdater",
    );
    const wrapperEnd = agentRegistrySource.indexOf(
      "async function ensureClaudeCodeCli",
    );
    const wrapper = agentRegistrySource.slice(wrapperStart, wrapperEnd);

    expect(wrapper).toContain("ensureCliBaselineViaUpdater(emit");
    expect(wrapper).toContain('packageName: "@openai/codex"');
    expect(wrapper).toContain("resolveBinary: resolveInstalledCodexBinary");
  });

  it("the shared baseline gate uses the verified update path and fails closed", () => {
    const helperStart = agentRegistrySource.indexOf(
      "async function ensureCliBaselineViaUpdater",
    );
    const helperEnd = agentRegistrySource.indexOf(
      "async function ensureCodexCliViaUpdater",
    );
    const helper = agentRegistrySource.slice(helperStart, helperEnd);

    expect(helper).toContain("CLI_MIN_VERSION_BASELINE");
    expect(helper).toContain("isBelowBaseline");
    expect(helper).toContain("_backgroundUpdateCli");
    expect(helper).toContain("force: true");
    expect(helper).toContain("provider://cli-update-action-required");
    expect(helper).toContain('outcome.outcome !== "success"');
  });
});
