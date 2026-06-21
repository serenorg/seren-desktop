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

describe("TerminalBuffer — terminal selection owns browser copy (#2279)", () => {
  it("suppresses browser-native selection on the canvas surface while drag-selecting terminal cells", () => {
    // The canvas renderer owns its own cell-range selection. If the
    // browser's native selection gesture also starts, WebKit/Chromium can
    // select the entire page and Copy reads unrelated footer/status text.
    expect(terminalBufferTsx).toMatch(/const preventNativeSelection\s*=/);
    expect(terminalBufferTsx).toMatch(/onSelectStart=\{preventNativeSelection\}/);
    expect(terminalBufferTsx).toMatch(/class="[^"]*select-none/);
    expect(terminalBufferTsx).toMatch(
      /const onSurfaceMouseDown[\s\S]*e\.preventDefault\(\)[\s\S]*captureSelection\(\{ anchor: cell, head: cell \}\)/,
    );
  });

  it("copies the snapshot captured at selection time, not text re-derived from the live grid (#2279)", () => {
    // The CLI streams output, so the grid scrolls between selecting and
    // copying. Re-reading selectionText(grid(), sel) at copy time returns
    // whatever later output now occupies those viewport rows. captureSelection
    // snapshots the text when the selection is made; every clipboard path then
    // reads selectedText() instead of the live grid.
    expect(terminalBufferTsx).toMatch(/const captureSelection\s*=/);
    expect(terminalBufferTsx).toMatch(
      /setSelectedText\([\s\S]*selectionText\(g, range\)/,
    );
    expect(terminalBufferTsx).toMatch(/const text = selectedText\(\)/);
    expect(terminalBufferTsx).toMatch(/writeClipboard\(selectedText\(\)\)/);
  });

  it("handles browser copy events by writing the terminal cell selection, not the native DOM selection", () => {
    // The hidden DOM mirror makes app-menu Copy fire; this handler makes
    // the terminal selection authoritative even if the browser selection
    // would otherwise point at stale page text.
    expect(terminalBufferTsx).toMatch(/const handleCopy\s*=/);
    expect(terminalBufferTsx).toMatch(
      /clipboardData\?\.setData\("text\/plain",\s*text\)/,
    );
    expect(terminalBufferTsx).toMatch(/onCopy=\{\(e\) => handleCopy\(e\)\}/);
  });

  it("labels copy and paste shortcuts by platform without changing Ctrl+C interrupt semantics", () => {
    // macOS users see Cmd-based shortcuts; Windows/Linux users see the
    // terminal-safe Ctrl+Shift+C copy chord. Ctrl+C remains reserved for
    // SIGINT in handleKeyDown.
    expect(terminalBufferTsx).toMatch(
      /import \{ isMacPlatform \} from "@\/lib\/platform"/,
    );
    expect(terminalBufferTsx).toMatch(/const copyShortcutLabel\s*=/);
    expect(terminalBufferTsx).toContain("Ctrl+Shift+C");
    expect(terminalBufferTsx).toContain("Ctrl+Shift+V");
    expect(terminalBufferTsx).toMatch(/shortcut:\s*copyShortcutLabel\(\)/);
    expect(terminalBufferTsx).toMatch(/const isTerminalPasteChord\s*=/);
    expect(terminalBufferTsx).toMatch(/navigator\.clipboard\.readText\(\)/);
    expect(terminalBufferTsx).toMatch(/await writePromptText\(text\)/);
    expect(terminalBufferTsx).toMatch(
      /event\.ctrlKey && !event\.shiftKey && \(k === "c" \|\| k === "C"\)/,
    );
  });
});
