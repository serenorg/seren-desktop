// ABOUTME: Tests that built-in gateway tools are included, not silently dropped.
// ABOUTME: Prevents regression where tools without mcp__ prefix were filtered out.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("built-in gateway tools inclusion", () => {
  const gatewaySource = readFileSync(
    resolve("src/services/mcp-gateway.ts"),
    "utf-8",
  );

  it("convertToGatewayTool includes unprefixed tools under seren-mcp", () => {
    // Built-in tools like call_publisher, run_sql don't have mcp__ prefix.
    // convertToGatewayTool must NOT return null for them.
    expect(gatewaySource).not.toContain(
      "if (!parsed) return null",
    );
    // Instead, they should be assigned to seren-mcp publisher
    expect(gatewaySource).toContain('publisher: "seren-mcp"');
  });
});
