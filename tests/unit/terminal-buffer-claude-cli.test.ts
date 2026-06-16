// ABOUTME: Critical regression guard for the themed Claude Code CLI terminal pill (#2004, #2006).
// ABOUTME: Trust contract — the billing-pool label must only render when the buffer was
// ABOUTME: spawned via Claude CLI launch metadata, including flagged startup modes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const terminalBufferTsx = readFileSync(
  resolve("src/components/terminal/TerminalBuffer.tsx"),
  "utf-8",
);

describe("TerminalBuffer — Claude Code CLI billing pill (#2004)", () => {
  it("conditions the themed chrome on cliKind === 'claude'", () => {
    // CLI startup flags are command details; the user-facing terminal chrome
    // keys off the launch metadata so Claude normal and YOLO modes match.
    expect(terminalBufferTsx).toMatch(/cliKind\s*===\s*"claude"/);
  });

  it("renders the 'Subscription · Pro/Max' label as the billing pill copy", () => {
    // This copy is the user-facing trust contract. Per Anthropic's June 15, 2026
    // classification, interactive `claude` in a terminal draws from the user's
    // Pro/Max subscription quota — not the Agent SDK credit pool. If this string
    // drifts, users get misled about which pool their session uses.
    expect(terminalBufferTsx).toContain("Subscription · Pro/Max");
  });

  it("renders a single YOLO launch-mode toggle in the terminal header", () => {
    expect(terminalBufferTsx).not.toContain(
      'data-testid="terminal-yolo-mode-pill"',
    );
    expect(terminalBufferTsx).toContain(
      'data-testid="terminal-launch-mode-toggle"',
    );
    expect(terminalBufferTsx).toMatch(/>\s*YOLO\s*</);
    expect(terminalBufferTsx).toContain("Turn on YOLO mode");
    expect(terminalBufferTsx).toContain("Turn off YOLO mode");
  });
});

describe("App entry — JetBrains Mono webfont actually loads (#2010)", () => {
  it("imports @fontsource/jetbrains-mono in src/index.tsx so the canvas font stack resolves", () => {
    // The themed Claude Code CLI terminal (#2004) names "JetBrains Mono"
    // as the first family in both `--font-mono` (styles.css:121) and the
    // canvas `CELL_FONT_FAMILY` (TerminalBuffer.tsx:123). Without a real
    // @font-face registration the browser silently falls through to SF
    // Mono / Menlo and the signature typography never reaches the user,
    // which is what made the post-#2007 theme still read as "the old
    // theme". The npm package vendors the woff2 files + @font-face CSS;
    // importing it at the app entry registers the font before first
    // paint. Drop this import and the bug returns silently.
    const indexTsx = readFileSync(resolve("src/index.tsx"), "utf-8");
    expect(indexTsx).toMatch(
      /import\s+["']@fontsource\/jetbrains-mono(?:\/[\w\-./]+)?["']/,
    );
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
