// ABOUTME: Critical regression guard for the themed Claude Code CLI terminal pill (#2004, #2006).
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

describe("TerminalBuffer — remaining #2004 scope items (#2006)", () => {
  it("declares a sky-400 cursor color constant for claude threads", () => {
    // Plain Terminal threads keep #d7dde8 (COLOR_CURSOR). Claude threads
    // get sky-400 (#38bdf8) so the cursor matches the rest of the themed
    // chrome. Drifting off this exact hex would silently lose the visual
    // bond between cursor and the Subscription pill / glow ring.
    expect(terminalBufferTsx).toMatch(/COLOR_CURSOR_CLAUDE\s*=\s*"#38bdf8"/);
  });

  it("declares a sky-400 selection overlay constant for claude threads", () => {
    // Plain Terminal threads keep the muted blue (SELECTION_OVERLAY_FILL).
    // Claude threads use sky-400 alpha so selection blends with the
    // accent. The alpha must stay low (~0.25) so selected glyphs remain
    // readable on the dark canvas.
    expect(terminalBufferTsx).toMatch(
      /SELECTION_OVERLAY_FILL_CLAUDE\s*=\s*"rgba\(56,\s*189,\s*248,/,
    );
  });

  it("applies a 1.6 line-height multiplier for claude threads", () => {
    // Default terminal convention is 1.4. The #2004 scope explicitly
    // bumps to ~1.6 for claude threads so the JetBrains Mono body has
    // breathing room matching the rest of the app's typography. Both
    // the fontBoundingBox branch and the fallback must respect it.
    expect(terminalBufferTsx).toMatch(/fontSize\s*\*\s*1\.6/);
  });

  it("renders a radial sky-400 wash on the canvas surface for claude threads", () => {
    // The wash is CSS-only on the surface host div (not the canvas
    // itself, which is painted by JS). Gated on isClaudeCli() so plain
    // Terminal threads stay flat.
    expect(terminalBufferTsx).toMatch(
      /radial-gradient\([^)]*rgba\(56,\s*189,\s*248,/,
    );
  });

  it("renders a version pill with copy 'claude X.Y.Z' for claude threads", () => {
    // The version pill sits next to the Subscription pill in the
    // header. Copy starts with the literal "claude " so users can
    // tell which interpreter version their thread bound to.
    expect(terminalBufferTsx).toMatch(/data-testid="claude-cli-version-pill"/);
    expect(terminalBufferTsx).toMatch(/`claude \$\{[^}]+\}`/);
  });
});
