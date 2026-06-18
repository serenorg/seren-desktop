// ABOUTME: Regression guard for #1883 — bare "node" stdio commands must resolve to embedded node absolute path.
// ABOUTME: Claude/Codex CLIs execvp() against their own minimal PATH; without an absolute path the MCP child silently never spawns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_PATH = "../../bin/browser-local/mcp-config.mjs";
const PLAYWRIGHT_SCRIPT = "/Applications/SerenDesktop.app/Contents/Resources/mcp-servers/playwright-stealth/dist/index.js";
const EMBEDDED_NODE = "/Applications/SerenDesktop.app/Contents/Resources/embedded-runtime/darwin-arm64/node/bin/node";

const PLAYWRIGHT_SERVER = {
  name: "playwright",
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

describe("#1883 — mcp-config resolves bare 'node' to embedded node binary", () => {
  const originalEmbeddedNode = process.env.SEREN_EMBEDDED_NODE_BIN;

  beforeEach(() => {
    delete process.env.SEREN_EMBEDDED_NODE_BIN;
  });

  afterEach(() => {
    if (originalEmbeddedNode === undefined) {
      delete process.env.SEREN_EMBEDDED_NODE_BIN;
    } else {
      process.env.SEREN_EMBEDDED_NODE_BIN = originalEmbeddedNode;
    }
  });

  it("Claude config: rewrites command:'node' to absolute path when SEREN_EMBEDDED_NODE_BIN is set", async () => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
    const { buildProviderMcpConfig } = await loadModule();

    const { claudeMcpConfigJson } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    const parsed = JSON.parse(claudeMcpConfigJson);
    expect(parsed.mcpServers.playwright).toBeDefined();
    expect(parsed.mcpServers.playwright.type).toBe("stdio");
    expect(parsed.mcpServers.playwright.command).toBe(EMBEDDED_NODE);
    expect(parsed.mcpServers.playwright.args).toEqual([PLAYWRIGHT_SCRIPT]);
  });

  it("Claude config: leaves command:'node' bare when SEREN_EMBEDDED_NODE_BIN is unset (dev fallback)", async () => {
    const { buildProviderMcpConfig } = await loadModule();

    const { claudeMcpConfigJson } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    const parsed = JSON.parse(claudeMcpConfigJson);
    expect(parsed.mcpServers.playwright.command).toBe("node");
  });

  it("Claude config: never overrides commands that are already absolute paths", async () => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
    const { buildProviderMcpConfig } = await loadModule();

    const customAbsolute = "/usr/local/bin/some-other-node";
    const { claudeMcpConfigJson } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [{ ...PLAYWRIGHT_SERVER, command: customAbsolute }],
    });

    const parsed = JSON.parse(claudeMcpConfigJson);
    expect(parsed.mcpServers.playwright.command).toBe(customAbsolute);
  });

  it("Claude config: never overrides non-node bare commands (e.g. npx, python)", async () => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
    const { buildProviderMcpConfig } = await loadModule();

    const { claudeMcpConfigJson } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [{ ...PLAYWRIGHT_SERVER, name: "py", command: "python" }],
    });

    const parsed = JSON.parse(claudeMcpConfigJson);
    expect(parsed.mcpServers.py.command).toBe("python");
  });

  it("Codex config: rewrites command:'node' to absolute path when SEREN_EMBEDDED_NODE_BIN is set", async () => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
    const { buildProviderMcpConfig } = await loadModule();

    const { codexMcpConfigOverride } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    expect(codexMcpConfigOverride).toContain(`command='${EMBEDDED_NODE}'`);
    expect(codexMcpConfigOverride).not.toContain("command='node'");
  });
});
