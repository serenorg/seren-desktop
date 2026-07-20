// ABOUTME: Critical wiring guards for selected OAuth identities in native agent MCP clients.
// ABOUTME: Ensures every direct Seren gateway runtime routes through the per-session proxy.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(resolve(relativePath), "utf8");
}

describe("native agent selected OAuth identity routing", () => {
  const claudeSource = readSource("bin/browser-local/claude-runtime.mjs");
  const acpSource = readSource("bin/browser-local/acp-runtime.mjs");
  const lmStudioSource = readSource("bin/browser-local/lmstudio-runtime.mjs");

  it.each([
    ["Claude", claudeSource],
    ["ACP agents", acpSource],
    ["LM Studio", lmStudioSource],
  ])("routes %s Seren MCP calls through a session proxy", (_name, source) => {
    expect(source).toContain("createSerenMcpOAuthProxy");
    expect(source).toContain("serenMcpProxy?.url");
    expect(source).toContain("serenMcpProxy?.setRouting(routing)");
    expect(source).toContain("serenMcpProxy?.close()");
  });

  it("does not close Claude's shared proxy when an initialization process is replaced", () => {
    const listenerStart = claudeSource.indexOf("function attachProcessListeners");
    const listenerEnd = claudeSource.indexOf(
      "export function createClaudeRuntime",
      listenerStart,
    );
    const listenerSource = claudeSource.slice(listenerStart, listenerEnd);
    const guardIndex = listenerSource.indexOf("if (!wasTracked)");
    const closeIndex = listenerSource.indexOf("serenMcpProxy?.close()");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(guardIndex);
  });
});
