import { describe, expect, it } from "vitest";
import { _applySerenMcpOAuthRouting as applyRouting } from "../../bin/browser-local/claude-runtime.mjs";

const tool = "mcp__seren-mcp__call_publisher";

describe("spawned Claude Seren MCP OAuth routing", () => {
  it("injects the mapped connection id", () => {
    expect(
      applyRouting(
        { publishers: { gmail: "conn-alpha" }, ambiguous: {} },
        tool,
        { publisher: "gmail", tool: "post_send" },
      ),
    ).toEqual({
      input: { publisher: "gmail", tool: "post_send", connection_id: "conn-alpha" },
      denyMessage: null,
    });
  });

  it("preserves an explicit connection id", () => {
    const input = { publisher: "gmail", connection_id: "conn-explicit" };
    expect(applyRouting({ publishers: { gmail: "conn-alpha" }, ambiguous: {} }, tool, input)).toEqual({
      input,
      denyMessage: null,
    });
  });

  it("returns an actionable denial for an ambiguous publisher", () => {
    expect(
      applyRouting(
        { publishers: {}, ambiguous: { gmail: "Choose an account" } },
        tool,
        { publisher: "gmail" },
      ),
    ).toEqual({ input: { publisher: "gmail" }, denyMessage: "Choose an account" });
  });

  it("ignores non-Seren tools and unmapped publishers", () => {
    const routing = { publishers: { gmail: "conn-alpha" }, ambiguous: {} };
    const input = { publisher: "calendar" };
    expect(applyRouting(routing, "mcp__other__call", input)).toEqual({ input, denyMessage: null });
    expect(applyRouting(routing, tool, input)).toEqual({ input, denyMessage: null });
  });
});
