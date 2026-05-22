// ABOUTME: Critical regression guard for the themed Claude Code CLI terminal pill (#2004).
// ABOUTME: Trust contract — the billing-pool label must only render when the buffer was
// ABOUTME: spawned via `command: "claude"` (no flags), which is the interactive-pool boundary.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const terminalBufferTsx = readFileSync(
  resolve("src/components/terminal/TerminalBuffer.tsx"),
  "utf-8",
);

describe("TerminalBuffer — Claude Code CLI billing pill (#2004)", () => {
  it("conditions the themed chrome on command === 'claude'", () => {
    // The trust signal: the launcher entry at ThreadSidebar.tsx:702 spawns
    // with { command: "claude" } and no flags (locked by launcher-redesign.test.ts).
    // The pill must key off the SAME signal so anyone who later adds `-p` or
    // `--output-format stream-json` to the command silently loses the pill —
    // making the regression visible.
    expect(terminalBufferTsx).toMatch(/command\s*===\s*"claude"/);
  });

  it("renders the 'Subscription · Pro/Max' label as the billing pill copy", () => {
    // This copy is the user-facing trust contract. Per Anthropic's June 15, 2026
    // classification, interactive `claude` in a terminal draws from the user's
    // Pro/Max subscription quota — not the Agent SDK credit pool. If this string
    // drifts, users get misled about which pool their session uses.
    expect(terminalBufferTsx).toContain("Subscription · Pro/Max");
  });
});
