// ABOUTME: Regression guard for Windows Codex app-server MCP config argv handling.
// ABOUTME: Pins TOML literal-string output so cmd.exe cannot split or strip needed quotes.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "../../bin/browser-local/mcp-config.mjs";
const EMBEDDED_NODE = String.raw`C:\Program Files\Seren Desktop\embedded-runtime\win32-x64\node\node.exe`;
const PLAYWRIGHT_SCRIPT = String.raw`C:\Users\rebec\AppData\Local\Seren Desktop\mcp-servers\playwright-stealth\dist\index.js`;

const PLAYWRIGHT_SERVER = {
  name: "playwright-stealth",
  type: "local",
  enabled: true,
  command: "node",
  args: [PLAYWRIGHT_SCRIPT],
  env: {},
};

async function loadModule() {
  vi.resetModules();
  return await import(MODULE_PATH);
}

describe("Codex MCP config override", () => {
  const originalEmbeddedNode = process.env.SEREN_EMBEDDED_NODE_BIN;

  beforeEach(() => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
  });

  afterEach(() => {
    if (originalEmbeddedNode === undefined) {
      delete process.env.SEREN_EMBEDDED_NODE_BIN;
    } else {
      process.env.SEREN_EMBEDDED_NODE_BIN = originalEmbeddedNode;
    }
  });

  it("uses shell-stable TOML literal strings for Windows paths with spaces", async () => {
    const { buildProviderMcpConfig } = await loadModule();

    const { codexMcpConfigOverride } = buildProviderMcpConfig({
      apiKey: null,
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    expect(codexMcpConfigOverride).toBe(
      `mcp_servers={playwright-stealth={command='${EMBEDDED_NODE}',args=['${PLAYWRIGHT_SCRIPT}']}}`,
    );
  });

  it("survives shell=true argv construction when wrapped as one Windows shell arg", async () => {
    const { buildProviderMcpConfig } = await loadModule();
    const { codexMcpConfigOverride } = buildProviderMcpConfig({
      apiKey: null,
      mcpServers: [PLAYWRIGHT_SERVER],
    });
    const wrappedForWindowsShell = `"${codexMcpConfigOverride}"`;

    const probe = spawnSync(
      process.execPath,
      [resolve("tests/fixtures/argv-printer.mjs"), "app-server", "-c", wrappedForWindowsShell],
      { encoding: "utf8", shell: true },
    );

    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual([
      "app-server",
      "-c",
      codexMcpConfigOverride,
    ]);
  });
});
