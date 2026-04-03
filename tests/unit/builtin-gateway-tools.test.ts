// ABOUTME: Tests that built-in Seren tools are first-class, separate from gateway publisher pipeline.
// ABOUTME: Prevents regression where SerenDB tools were mixed into the publisher tool pipeline.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("first-class Seren tools (#1422)", () => {
  const gatewaySource = readFileSync(
    resolve("src/services/mcp-gateway.ts"),
    "utf-8",
  );
  const definitionsSource = readFileSync(
    resolve("src/lib/tools/definitions.ts"),
    "utf-8",
  );
  const executorSource = readFileSync(
    resolve("src/lib/tools/executor.ts"),
    "utf-8",
  );

  it("mcp-gateway excludes built-in tools from GatewayTool pipeline", () => {
    // convertToGatewayTool must return null for unprefixed tools
    expect(gatewaySource).toContain("if (!parsed) return null");
  });

  it("mcp-gateway exports getBuiltinToolSchemas for definitions.ts", () => {
    expect(gatewaySource).toContain(
      "export function getBuiltinToolSchemas",
    );
  });

  it("mcp-gateway exports callSerenTool for direct MCP dispatch", () => {
    expect(gatewaySource).toContain("export async function callSerenTool");
  });

  it("definitions.ts includes built-in Seren tools with seren__ prefix", () => {
    expect(definitionsSource).toContain("getBuiltinToolSchemas");
    expect(definitionsSource).toContain('`seren__${schema.name}`');
  });

  it("executor.ts dispatches seren__ tools via callSerenTool", () => {
    expect(executorSource).toContain("callSerenTool");
    expect(executorSource).toContain('name.startsWith("seren__")');
  });
});
