// ABOUTME: Critical regression test for #1731 — AskUserQuestion has no
// ABOUTME: stream-json transport in Seren so the harness denies it with a
// ABOUTME: structured message instead of letting the CLI auto-resolve empty.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntime = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#1731 AskUserQuestion is denied with a structured message before auto-allow can fire", () => {
  it("handlePermissionRequest short-circuits AskUserQuestion before autoPermissionDecision", () => {
    // The CLI's built-in AskUserQuestion picker has no stream-json render
    // path. If autoPermissionDecision returns "allow_once" (bypassPermissions
    // mode, or a prior allow_session on the tool), the CLI executes the
    // tool with no UI and returns an empty answer payload. The agent then
    // proceeds as if the user "chose nothing." The guard must run BEFORE
    // autoPermissionDecision so it covers the bypass path too.
    const fnIdx = claudeRuntime.indexOf("function handlePermissionRequest(");
    expect(fnIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(fnIdx, fnIdx + 4000);

    const askIdx = region.indexOf("AskUserQuestion");
    const autoIdx = region.indexOf("autoPermissionDecision(");
    expect(askIdx, "AskUserQuestion must be referenced in the handler").toBeGreaterThan(0);
    expect(autoIdx, "autoPermissionDecision call must exist").toBeGreaterThan(0);
    expect(
      askIdx,
      "AskUserQuestion guard must run BEFORE autoPermissionDecision",
    ).toBeLessThan(autoIdx);
  });

  it("the deny path responds to the control request and emits a tool result the agent can read", () => {
    // Two pieces both must fire: respondToControlRequest with behavior:"deny"
    // (so the CLI never executes AskUserQuestion and the deny message
    // becomes the agent-visible tool result), AND emitToolResult (so the
    // UI's tool call doesn't sit in "pending" forever). Skipping either one
    // produces a worse symptom than the bug it replaces.
    const fnIdx = claudeRuntime.indexOf("function handlePermissionRequest(");
    const region = claudeRuntime.slice(fnIdx, fnIdx + 4000);
    const askIdx = region.indexOf("AskUserQuestion");
    expect(askIdx).toBeGreaterThan(0);
    const guardBlock = region.slice(askIdx, askIdx + 1500);

    expect(guardBlock).toMatch(/respondToControlRequest\(/);
    expect(guardBlock).toMatch(/behavior:\s*"deny"/);
    expect(guardBlock).toMatch(/emitToolResult\(/);
    // The deny message must explain the surface limit so the agent can
    // pivot to plain-text Q&A intentionally instead of acting on empty
    // selections. We don't pin the exact wording — just that a
    // human-readable explanation accompanies the deny.
    expect(guardBlock).toMatch(/(plain[ -]text|not supported|surface)/i);
  });
});
