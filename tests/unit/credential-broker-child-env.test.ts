// ABOUTME: Guards the #3194 invariant that no real Seren credential reaches an agent child process.
// ABOUTME: Covers the MCP config builder, the broker capability resolver, and the lease bridge shape.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/mcp-config.mjs",
  import.meta.url,
).href;
const { buildProviderMcpConfig, resolveBrokeredSerenCredential } = await import(
  /* @vite-ignore */ modulePath
);

const BROKER_MCP_URL = "http://127.0.0.1:51234/deadbeef/mcp";
const BROKER_API_BASE_URL = "http://127.0.0.1:51234/deadbeef/api/";
const CAPABILITY = "opaque-session-capability";

describe("brokered agent credentials (#3194)", () => {
  it("puts only the opaque capability in the child environment", () => {
    const { childEnv } = buildProviderMcpConfig({
      serenCapability: CAPABILITY,
      serenMcpGatewayUrl: BROKER_MCP_URL,
      mcpServers: [],
    });

    expect(childEnv).toEqual({ SEREN_MCP_CAPABILITY_TOKEN: CAPABILITY });
    // A Seren API key is formatted `seren_<id>_<secret>`. None may appear here.
    expect(JSON.stringify(childEnv)).not.toMatch(/seren_[A-Za-z0-9_-]+_/);
  });

  it("points the seren-mcp server at the loopback broker, never the gateway", () => {
    const { claudeMcpConfigJson } = buildProviderMcpConfig({
      serenCapability: CAPABILITY,
      serenMcpGatewayUrl: BROKER_MCP_URL,
      mcpServers: [],
    });

    const config = JSON.parse(claudeMcpConfigJson);
    expect(config.mcpServers["seren-mcp"].url).toBe(BROKER_MCP_URL);
    expect(claudeMcpConfigJson).not.toContain("mcp.serendb.com");
    // The config carries an env reference, not a resolved secret.
    expect(claudeMcpConfigJson).toContain("${SEREN_MCP_CAPABILITY_TOKEN}");
    expect(claudeMcpConfigJson).not.toContain(CAPABILITY);
  });

  it("configures no Seren MCP server when the broker endpoints are absent", () => {
    // Without a broker there is no safe place for a credential, so the gateway
    // must simply be unavailable rather than fall back to a raw key.
    const { childEnv, claudeMcpConfigJson } = buildProviderMcpConfig({
      serenCapability: CAPABILITY,
      serenMcpGatewayUrl: undefined,
      mcpServers: [],
    });

    expect(childEnv).toEqual({ SEREN_MCP_CAPABILITY_TOKEN: CAPABILITY });
    expect(claudeMcpConfigJson).toBeNull();
  });

  it("resolves a spawn credential only when every broker field is present", () => {
    expect(
      resolveBrokeredSerenCredential({
        serenCapability: CAPABILITY,
        serenMcpUrl: BROKER_MCP_URL,
        serenApiBaseUrl: BROKER_API_BASE_URL,
      }),
    ).toEqual({
      capability: CAPABILITY,
      mcpUrl: BROKER_MCP_URL,
      apiBaseUrl: BROKER_API_BASE_URL,
    });

    expect(
      resolveBrokeredSerenCredential({
        serenCapability: CAPABILITY,
        serenMcpUrl: BROKER_MCP_URL,
      }),
    ).toBeNull();
    expect(resolveBrokeredSerenCredential({})).toBeNull();
    expect(resolveBrokeredSerenCredential(undefined)).toBeNull();
  });
});
