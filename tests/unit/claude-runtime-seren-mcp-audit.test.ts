// ABOUTME: Critical guard for #2802 — detecting a Seren gateway that connected
// ABOUTME: but registered zero tools, and locking in the in-place reconnect recovery.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";
import {
  _countSerenMcpTools as countSerenMcpTools,
  _SEREN_MCP_TOOL_PREFIX as SEREN_MCP_TOOL_PREFIX,
} from "../../bin/browser-local/claude-runtime.mjs";

const claudeRuntimeSource = readSource("bin/browser-local/claude-runtime.mjs");

// A realistic `system init` `tools` array with built-ins + a healthy playwright
// stdio server + the Seren gateway's publisher meta-tools registered.
const HEALTHY_TOOLS = [
  "Task",
  "Bash",
  "Read",
  "mcp__playwright__playwright_navigate",
  "mcp__playwright__playwright_click",
  "mcp__seren-mcp__list_agent_publishers",
  "mcp__seren-mcp__call_publisher",
];

// The #2802 failure: the gateway completed its MCP `initialize` (so its
// instructions loaded) but its `tools/list` failed, so NOT ONE
// `mcp__seren-mcp__*` tool is present even though other servers registered.
const DEGRADED_TOOLS = [
  "Task",
  "Bash",
  "Read",
  "mcp__playwright__playwright_navigate",
  "mcp__playwright__playwright_click",
];

describe("#2802 — seren-mcp zero-tool detection", () => {
  it("uses the exact hyphen-preserving gateway tool prefix", () => {
    // Claude Code sanitizes MCP server names with /[^a-zA-Z0-9_-]/ → "_",
    // which PRESERVES hyphens, so "seren-mcp" tools register as
    // `mcp__seren-mcp__*` (NOT `mcp__seren_mcp__*`). Getting this wrong makes
    // every tool miss the filter and reports a permanent false degradation.
    expect(SEREN_MCP_TOOL_PREFIX).toBe("mcp__seren-mcp__");
  });

  it("counts the gateway tools when the gateway registered them", () => {
    expect(countSerenMcpTools(HEALTHY_TOOLS)).toBe(2);
  });

  it("returns 0 when the gateway connected but registered no tools", () => {
    // This is the state the whole fix hinges on: other servers registered,
    // seren-mcp did not. It must read as zero so recovery fires.
    expect(countSerenMcpTools(DEGRADED_TOOLS)).toBe(0);
  });

  it("never counts another server's tools as the gateway's", () => {
    expect(
      countSerenMcpTools([
        "mcp__playwright__playwright_navigate",
        "mcp__seren-mcp-other__x",
        "mcp__notseren-mcp__y",
      ]),
    ).toBe(0);
  });

  it("treats a missing or malformed tools list as zero, not a crash", () => {
    expect(countSerenMcpTools(undefined)).toBe(0);
    expect(countSerenMcpTools(null)).toBe(0);
    expect(countSerenMcpTools("not-an-array")).toBe(0);
    expect(countSerenMcpTools([undefined, 42, { name: "x" }])).toBe(0);
  });
});

describe("#2802 — audit is wired into spawn and recovery flow", () => {
  it("audits the gateway on the first streamed `system init`", () => {
    // The tool registry is only fully resolved at the first `system init`, so
    // that is the one place the audit can run. A pre-prompt probe can read a
    // still-connecting registry and false-trigger.
    const initCase = claudeRuntimeSource.slice(
      claudeRuntimeSource.indexOf('case "init": {'),
      claudeRuntimeSource.indexOf('case "status":'),
    );
    expect(initCase).toContain("maybeAuditSerenMcpTools(emit, session, payload)");
  });

  it("only audits sessions spawned with the gateway configured, exactly once", () => {
    const fnStart = claudeRuntimeSource.indexOf(
      "function maybeAuditSerenMcpTools(",
    );
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain(
      "if (!session.serenMcpConfigured || session.serenMcpToolsChecked)",
    );
    expect(fnBody).toContain("session.serenMcpToolsChecked = true");
  });

  it("lets a still-connecting gateway settle before judging it degraded", () => {
    // The remote gateway is often still `pending` at the first `system init`,
    // so it must be given a settle window (cheap mcp_status polls) to register
    // tools before any reconnect — otherwise healthy-but-slow gateways get
    // needlessly reconnected on every spawn.
    const fnStart = claudeRuntimeSource.indexOf(
      "async function settleAndRecoverSerenMcpTools(",
    );
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnStart + 1400);
    expect(fnBody).toContain("SEREN_MCP_SETTLE_TIMEOUT_MS");
    // A gateway that registers tools during the settle window is healthy — no
    // reconnect churn.
    expect(fnBody).toContain("if (status.toolCount > 0)");
    expect(fnBody).toContain("return; // healthy");
    expect(fnBody).toContain("recoverSerenMcpTools(emit, session)");
  });

  it("recovers in place via bounded mcp_reconnect + mcp_status re-check", () => {
    const fnStart = claudeRuntimeSource.indexOf(
      "async function recoverSerenMcpTools(",
    );
    expect(fnStart).toBeGreaterThan(0);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnStart + 2000);
    // Single-server reconnect (no full-process respawn) with a bounded loop.
    expect(fnBody).toContain('subtype: "mcp_reconnect"');
    expect(fnBody).toContain("serverName: SEREN_MCP_SERVER_NAME");
    expect(fnBody).toContain("attempt <= SEREN_MCP_RECONNECT_MAX_ATTEMPTS");
    // Verifies the reconnect actually restored tools before declaring success —
    // a reconnect ACK means "connected", not "tools present".
    expect(fnBody).toContain("serenMcpStatus(session)");
    expect(fnBody).toContain("status.toolCount > 0");
  });

  it("surfaces a degraded state only after recovery is exhausted", () => {
    const fnStart = claudeRuntimeSource.indexOf(
      "async function recoverSerenMcpTools(",
    );
    const fnBody = claudeRuntimeSource.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain('emit("provider://mcp-degraded"');
  });
});
