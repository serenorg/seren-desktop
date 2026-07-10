// ABOUTME: Focused guard for #2904 — Codex spawn must block on upgrading old CLIs.
// ABOUTME: Prevents regressing to install-only ensureCli while GPT-5.6 defaults require a newer Codex.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentRegistrySource = readFileSync(
  new URL("../../bin/browser-local/agent-registry.mjs", import.meta.url),
  "utf8",
);

describe("#2904 Codex CLI upgrade gate", () => {
  it("Codex ensureCli uses the blocking updater before provider spawn", () => {
    const codexDefStart = agentRegistrySource.indexOf("codex: {");
    const claudeDefStart = agentRegistrySource.indexOf('"claude-code": {');
    const codexDefinition = agentRegistrySource.slice(
      codexDefStart,
      claudeDefStart,
    );

    expect(codexDefinition).toContain("async ensureCli()");
    expect(codexDefinition).toContain("return ensureCodexCliViaUpdater(emit)");
    expect(codexDefinition).not.toContain("return ensureGlobalNpmPackage({");
  });

  it("the Codex updater runs codex update and fails closed if still below baseline", () => {
    const helperStart = agentRegistrySource.indexOf(
      "async function ensureCodexCliViaUpdater",
    );
    const helperEnd = agentRegistrySource.indexOf(
      "async function ensureClaudeCodeViaNativeInstaller",
    );
    const helper = agentRegistrySource.slice(helperStart, helperEnd);

    expect(helper).toContain("CLI_MIN_VERSION_BASELINE");
    expect(helper).toContain("isBelowBaseline");
    expect(helper).toContain("runCodexSelfUpdate");
    expect(helper).toContain('Run "codex update" manually');
  });
});
