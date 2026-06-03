// ABOUTME: Critical regression guard for the Claude Code CLI copy/paste UX (#2091).
// ABOUTME: Locks the two wiring invariants that make Edit > Copy and right-click work:
// ABOUTME: (1) the terminal surface owns oncontextmenu and renders a ContextMenu,
// ABOUTME: (2) the terminal selection is mirrored into a hidden DOM range so the
// ABOUTME: system Edit > Copy / PredefinedMenuItem::copy path produces real text.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const terminalBufferTsx = readFileSync(
  resolve("src/components/terminal/TerminalBuffer.tsx"),
  "utf-8",
);

describe("TerminalBuffer — right-click context menu (#2091)", () => {
  it("imports the shared ContextMenu primitive", () => {
    // Reusing src/components/common/ContextMenu.tsx instead of forking a
    // bespoke popover keeps the keyboard/escape/scroll-close behavior
    // identical to FileTree and AgentChat's existing menus.
    expect(terminalBufferTsx).toMatch(
      /from\s+["']@\/components\/common\/ContextMenu["']/,
    );
  });

  it("attaches an onContextMenu handler to the terminal surface div", () => {
    // The surface <div> (role="application") is where the user right-clicks.
    // Without this handler, Tauri's default webview context menu wins and
    // ships only "Reload" / "Inspect Element" — the exact regression in
    // the bug report.
    expect(terminalBufferTsx).toMatch(/onContextMenu=\{/);
  });

  it("renders the ContextMenu with Copy, Paste, and Select All actions", () => {
    // Lock the visible action set so a future drive-by edit can't quietly
    // delete an action and reintroduce the original UX gap.
    expect(terminalBufferTsx).toMatch(/label:\s*"Copy"/);
    expect(terminalBufferTsx).toMatch(/label:\s*"Paste"/);
    expect(terminalBufferTsx).toMatch(/label:\s*"Select All"/);
  });
});

describe("TerminalBuffer — system Edit > Copy via DOM selection mirror (#2091)", () => {
  it("declares a hidden selection-mirror span the canvas selection writes into", () => {
    // The canvas is custom-painted; the browser sees no DOM selection,
    // so PredefinedMenuItem::copy in src-tauri/src/lib.rs becomes a
    // no-op. Mirroring the terminal selection text into an off-screen
    // span and pointing window.getSelection() at it makes the system
    // Edit > Copy path produce the right text WITHOUT changing any
    // menu-bar wiring (which would otherwise regress Monaco + chat
    // inputs).
    expect(terminalBufferTsx).toMatch(/data-testid="terminal-selection-mirror"/);
  });

  it("syncs window.getSelection() to the mirror whenever the terminal selection changes", () => {
    // The mirror is dead weight unless we point the document selection
    // at it. The setBaseAndExtent call is the load-bearing line — drop
    // it and Edit > Copy silently regresses again.
    expect(terminalBufferTsx).toMatch(/window\.getSelection\(\)/);
    expect(terminalBufferTsx).toMatch(/setBaseAndExtent|addRange/);
  });
});
