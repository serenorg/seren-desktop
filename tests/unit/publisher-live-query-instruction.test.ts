// ABOUTME: Regression test for #1622 — the agent system-prompt instruction
// ABOUTME: must force a live list_agent_publishers query, never embed a stale snapshot.

import { describe, expect, it } from "vitest";
import {
  PUBLISHER_LIVE_QUERY_INSTRUCTION,
  resolvePublisherLiveQueryInstruction,
} from "@/stores/agent.store";
const modulePath = new URL(
  "../../bin/browser-local/mcp-config.mjs",
  import.meta.url,
).href;
const {
  buildProviderMcpConfig,
  serenMcpToolName,
} = await import(/* @vite-ignore */ modulePath);

const CAPABILITY = "test-capability";
const MCP_URL = "http://127.0.0.1:51234/session/mcp";

describe("#1622 — PUBLISHER_LIVE_QUERY_INSTRUCTION", () => {
  it("does not embed any publisher slug or comma-separated list", () => {
    // The bug was: agent.store.ts inlined `cachedPublisherSlugs.sort().join(", ")`.
    // If a contributor regresses by reintroducing that pattern, the instruction
    // will contain comma-separated slug-looking tokens. Guard against any slug
    // we know is common in Seren's catalog appearing alongside its siblings.
    const txt = PUBLISHER_LIVE_QUERY_INSTRUCTION;

    // These slug patterns must NEVER appear as a comma-joined list in the
    // instruction body — they are enumerated examples only in prose form.
    // A regression would look like "google-docs, google-drive, gmail, ..."
    // (the exact shape of the old snapshot). We reject any dash-slug that is
    // immediately followed by ", " and another dash-slug.
    const slugListPattern = /[a-z]+-[a-z]+,\s[a-z]+-[a-z]+/;
    expect(
      txt,
      "Instruction must not contain a comma-joined dash-slug list (stale snapshot signature)",
    ).not.toMatch(slugListPattern);
  });

  it("names the registered list_agent_publishers tool before refusing", () => {
    const txt = PUBLISHER_LIVE_QUERY_INSTRUCTION;
    const { claudeMcpConfigJson, serenMcpConfigured } =
      buildProviderMcpConfig({
        serenCapability: CAPABILITY,
        serenMcpGatewayUrl: MCP_URL,
        mcpServers: [],
      });
    const registeredServer = Object.keys(
      JSON.parse(claudeMcpConfigJson).mcpServers,
    )[0];

    expect(serenMcpConfigured).toBe(true);
    expect(serenMcpToolName("list_agent_publishers")).toBe(
      `mcp__${registeredServer}__list_agent_publishers`,
    );
    expect(txt).toContain(serenMcpToolName("list_agent_publishers"));
    // Must state the rule as a MUST, not a suggestion, and must call out
    // the staleness of any prior belief — without these the model has
    // discretion and will revert to "I don't have that tool" on low confidence.
    expect(txt).toContain("MUST call");
    expect(txt.toLowerCase()).toContain("stale");
  });

  it("names the registered call_publisher tool after discovery", () => {
    expect(PUBLISHER_LIVE_QUERY_INSTRUCTION).toContain(
      serenMcpToolName("call_publisher"),
    );
  });

  it("omits the instruction when the Seren MCP server was not registered", () => {
    const { serenMcpConfigured } = buildProviderMcpConfig({
      serenCapability: CAPABILITY,
      serenMcpGatewayUrl: undefined,
      mcpServers: [],
    });

    expect(serenMcpConfigured).toBe(false);
    expect(resolvePublisherLiveQueryInstruction(serenMcpConfigured)).toBeNull();
    expect(resolvePublisherLiveQueryInstruction(true)).toBe(
      PUBLISHER_LIVE_QUERY_INSTRUCTION,
    );
  });

  it("forbids parameterized discovery failures from becoming absence claims (#2910)", () => {
    const txt = PUBLISHER_LIVE_QUERY_INSTRUCTION;
    expect(txt).toContain("filter that returned list client-side");
    expect(txt).toContain("parameterized discovery call is not evidence");
    expect(txt).toContain("Authorization or allowlist rejection");
    expect(txt).not.toContain("list_agent_publishers with slug:");
  });
});
