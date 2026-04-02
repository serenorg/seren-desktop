// ABOUTME: Tests that publisher availability context includes all callable publishers.
// ABOUTME: Prevents regression where publishers without MCP tools were omitted from context.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("publisher context construction", () => {
  const chatSource = readFileSync(resolve("src/services/chat.ts"), "utf-8");
  const gatewaySource = readFileSync(
    resolve("src/services/mcp-gateway.ts"),
    "utf-8",
  );

  it("builds publisher list from callable slugs, not just gateway tools", () => {
    // buildPublishersContext must use getCallablePublisherSlugs as the
    // canonical source — not derive publishers solely from getGatewayTools()
    expect(chatSource).toContain("getCallablePublisherSlugs");
  });

  it("mcp-gateway caches publisher slugs from list_agent_publishers", () => {
    // The full publisher slug list must be stored, not discarded after
    // tool discovery. Publishers callable via call_publisher but without
    // first-class MCP tools must still appear in the cached list.
    expect(gatewaySource).toContain("cachedPublisherSlugs");
    expect(gatewaySource).toContain("cachedPublisherSlugs = publisherSlugs");
  });

  it("exposes callable publisher slugs via getter", () => {
    expect(gatewaySource).toContain(
      "export function getCallablePublisherSlugs",
    );
  });
});
