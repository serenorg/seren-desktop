// ABOUTME: Regression guard for #1887 — Gemini session/new must receive a populated mcpServers array.
// ABOUTME: Verifies the ACP wire shape: discriminated union on type, headers/env as [{name,value}] arrays, capability gate honored.

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
  env: { FOO: "bar" },
};

async function loadModule() {
  vi.resetModules();
  return await import(MODULE_PATH);
}

describe("#1887 — buildProviderMcpConfig emits Gemini-shaped mcpServers", () => {
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

  it("empty input → returns [] (never undefined, never null)", async () => {
    const { buildProviderMcpConfig } = await loadModule();
    const { geminiMcpServers } = buildProviderMcpConfig({ apiKey: null, mcpServers: [] });
    expect(typeof geminiMcpServers).toBe("function");
    expect(geminiMcpServers({ http: true })).toEqual([]);
  });

  it("stdio: emits ACP shape (type/name/command/args/env-as-pairs) and applies #1883 node resolution", async () => {
    process.env.SEREN_EMBEDDED_NODE_BIN = EMBEDDED_NODE;
    const { buildProviderMcpConfig } = await loadModule();

    const { geminiMcpServers } = buildProviderMcpConfig({
      apiKey: null,
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    const result = geminiMcpServers({ http: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "stdio",
      name: "playwright",
      command: EMBEDDED_NODE,
      args: [PLAYWRIGHT_SCRIPT],
      env: [{ name: "FOO", value: "bar" }],
    });
  });

  it("http: emits seren-mcp entry with headers-as-pairs when mcpCapabilities.http=true", async () => {
    const { buildProviderMcpConfig } = await loadModule();

    const { geminiMcpServers } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [],
    });

    const result = geminiMcpServers({ http: true });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("http");
    expect(result[0].name).toBe("seren-mcp");
    expect(result[0].url).toMatch(/^https?:\/\//);
    expect(result[0].headers).toEqual([
      { name: "Authorization", value: "Bearer ${SEREN_API_KEY}" },
    ]);
  });

  it("http: drops seren-mcp when mcpCapabilities.http is false (capability gate)", async () => {
    const { buildProviderMcpConfig } = await loadModule();

    const { geminiMcpServers } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [PLAYWRIGHT_SERVER],
    });

    const result = geminiMcpServers({ http: false });
    // Only the stdio entry should remain; the HTTP seren-mcp is dropped.
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("stdio");
    expect(result[0].name).toBe("playwright");
  });

  it("childEnv carries SEREN_API_KEY so the gemini-cli child can resolve the Authorization header", async () => {
    const { buildProviderMcpConfig } = await loadModule();

    const { childEnv } = buildProviderMcpConfig({
      apiKey: "test-key",
      mcpServers: [],
    });

    expect(childEnv.SEREN_API_KEY).toBe("test-key");
  });
});
