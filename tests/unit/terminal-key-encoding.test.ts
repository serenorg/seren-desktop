// ABOUTME: Wire-level contract for the Claude Code CLI terminal's keystroke encoder (#2012).
// ABOUTME: Every byte sequence here is what the spawned CLI actually reads on stdin — if a
// ABOUTME: row drifts, raw-mode TUIs (Claude Code menus, vim, less) silently misbehave.

import { describe, expect, it } from "vitest";
import {
  type KeyEventSnapshot,
  encodeKeyEventToBytes,
} from "../../src/components/terminal/keyEncoding";

function key(overrides: Partial<KeyEventSnapshot> & { key: string }): KeyEventSnapshot {
  return {
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("encodeKeyEventToBytes — Tab and Shift+Tab (#2012)", () => {
  it("plain Tab sends a literal \\t — preserves forward-completion", () => {
    expect(encodeKeyEventToBytes(key({ key: "Tab" }), { cursorKeysApp: false })).toBe("\t");
  });

  it("Shift+Tab sends CSI Z (\\x1b[Z) — the xterm reverse-tab Claude menus need", () => {
    // terminfo capability `kcbt`. Without this byte sequence Claude Code CLI's
    // reverse-cycle in permission prompts / option pickers is unreachable.
    expect(
      encodeKeyEventToBytes(key({ key: "Tab", shiftKey: true }), { cursorKeysApp: false }),
    ).toBe("\x1b[Z");
  });

  it("Ctrl+Tab and Alt+Tab fall through to null — OS/browser owns those chords", () => {
    expect(encodeKeyEventToBytes(key({ key: "Tab", ctrlKey: true }), { cursorKeysApp: false })).toBeNull();
    expect(encodeKeyEventToBytes(key({ key: "Tab", altKey: true }), { cursorKeysApp: false })).toBeNull();
  });
});

describe("encodeKeyEventToBytes — pre-existing encoding table (regression guard)", () => {
  const opts = { cursorKeysApp: false };

  it("Enter → \\r", () => {
    expect(encodeKeyEventToBytes(key({ key: "Enter" }), opts)).toBe("\r");
  });

  it("Backspace → \\x7f (DEL, not \\b — bash and readline expect this)", () => {
    expect(encodeKeyEventToBytes(key({ key: "Backspace" }), opts)).toBe("\x7f");
  });

  it("Escape → \\x1b", () => {
    expect(encodeKeyEventToBytes(key({ key: "Escape" }), opts)).toBe("\x1b");
  });

  it("PageUp / PageDown / Delete → xterm tilde sequences", () => {
    expect(encodeKeyEventToBytes(key({ key: "PageUp" }), opts)).toBe("\x1b[5~");
    expect(encodeKeyEventToBytes(key({ key: "PageDown" }), opts)).toBe("\x1b[6~");
    expect(encodeKeyEventToBytes(key({ key: "Delete" }), opts)).toBe("\x1b[3~");
  });
});

describe("encodeKeyEventToBytes — DECCKM cursor key application mode", () => {
  it("arrows emit CSI sequences when cursorKeysApp=false (normal mode)", () => {
    const opts = { cursorKeysApp: false };
    expect(encodeKeyEventToBytes(key({ key: "ArrowUp" }), opts)).toBe("\x1b[A");
    expect(encodeKeyEventToBytes(key({ key: "ArrowDown" }), opts)).toBe("\x1b[B");
    expect(encodeKeyEventToBytes(key({ key: "ArrowRight" }), opts)).toBe("\x1b[C");
    expect(encodeKeyEventToBytes(key({ key: "ArrowLeft" }), opts)).toBe("\x1b[D");
    expect(encodeKeyEventToBytes(key({ key: "Home" }), opts)).toBe("\x1b[H");
    expect(encodeKeyEventToBytes(key({ key: "End" }), opts)).toBe("\x1b[F");
  });

  it("arrows emit SS3 sequences when cursorKeysApp=true (DECSET 1 — vim's alt screen)", () => {
    const opts = { cursorKeysApp: true };
    expect(encodeKeyEventToBytes(key({ key: "ArrowUp" }), opts)).toBe("\x1bOA");
    expect(encodeKeyEventToBytes(key({ key: "ArrowDown" }), opts)).toBe("\x1bOB");
    expect(encodeKeyEventToBytes(key({ key: "ArrowRight" }), opts)).toBe("\x1bOC");
    expect(encodeKeyEventToBytes(key({ key: "ArrowLeft" }), opts)).toBe("\x1bOD");
    expect(encodeKeyEventToBytes(key({ key: "Home" }), opts)).toBe("\x1bOH");
    expect(encodeKeyEventToBytes(key({ key: "End" }), opts)).toBe("\x1bOF");
  });
});

describe("encodeKeyEventToBytes — Ctrl-letter chords map to control bytes 0x01–0x1A", () => {
  const opts = { cursorKeysApp: false };

  it("Ctrl+A → 0x01, Ctrl+Z → 0x1A — readline word-nav and SIGTSTP", () => {
    expect(encodeKeyEventToBytes(key({ key: "a", ctrlKey: true }), opts)).toBe("\x01");
    expect(encodeKeyEventToBytes(key({ key: "z", ctrlKey: true }), opts)).toBe("\x1a");
  });

  it("Ctrl+L → 0x0C — common clear-screen chord", () => {
    expect(encodeKeyEventToBytes(key({ key: "l", ctrlKey: true }), opts)).toBe("\x0c");
  });

  it("upper-case letter with Ctrl produces the same control byte — case-insensitive", () => {
    expect(encodeKeyEventToBytes(key({ key: "A", ctrlKey: true }), opts)).toBe("\x01");
  });
});

describe("encodeKeyEventToBytes — printable characters and out-of-scope keys", () => {
  const opts = { cursorKeysApp: false };

  it("single printable char passes through", () => {
    expect(encodeKeyEventToBytes(key({ key: "a" }), opts)).toBe("a");
    expect(encodeKeyEventToBytes(key({ key: "?" }), opts)).toBe("?");
  });

  it("printable char with metaKey or altKey is null — handler routes those elsewhere or ignores them", () => {
    expect(encodeKeyEventToBytes(key({ key: "a", metaKey: true }), opts)).toBeNull();
    expect(encodeKeyEventToBytes(key({ key: "a", altKey: true }), opts)).toBeNull();
  });

  it("unknown / multi-char keys (F1, Shift, dead keys) return null", () => {
    expect(encodeKeyEventToBytes(key({ key: "F1" }), opts)).toBeNull();
    expect(encodeKeyEventToBytes(key({ key: "Shift" }), opts)).toBeNull();
    expect(encodeKeyEventToBytes(key({ key: "Dead" }), opts)).toBeNull();
  });
});
