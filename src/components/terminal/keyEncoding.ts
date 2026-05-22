// ABOUTME: Pure key→bytes encoder for the Claude Code CLI terminal — the wire-level
// ABOUTME: contract with the spawned subprocess. Stays free of DOM, store, and Tauri.

/**
 * Minimum surface of a DOM KeyboardEvent the encoder reads. Tests pass plain
 * objects; the React/Solid handler passes the live event directly.
 */
export type KeyEventSnapshot = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
>;

export interface KeyEncodingOptions {
  /**
   * DECCKM (DECSET 1) — when on, arrows and Home/End emit SS3 sequences
   * (`\x1bO…`) instead of CSI (`\x1b[…`). Vim's alt screen turns this on as
   * part of `:set termguicolors`-era init; without it vim cursor keys send
   * `\x1b[A` and the editor treats them as literal Esc sequences.
   */
  cursorKeysApp: boolean;
}

/**
 * Translate a single KeyboardEvent into the byte sequence the PTY expects.
 * Returns `null` when the event should be ignored by the writer (the caller
 * may still handle it via a separate path — copy chord, Ctrl+C signal, etc).
 *
 * Side-effecting branches (clipboard, SIGINT) live in the component handler
 * and run *before* this function is consulted — they are intentionally not
 * encoded here so this module can be tested in isolation.
 */
export function encodeKeyEventToBytes(
  event: KeyEventSnapshot,
  options: KeyEncodingOptions,
): string | null {
  const k = event.key;

  // Ctrl-letter chords map to control bytes 0x01–0x1A (Ctrl+A → SOH, Ctrl+Z →
  // SUB). The Ctrl+C SIGINT path is handled by the component handler before
  // this function is called, so we never see it here.
  if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    if (k.length === 1 && /[a-zA-Z]/.test(k)) {
      return String.fromCharCode(k.toUpperCase().charCodeAt(0) - 64);
    }
  }

  const arrowPrefix = options.cursorKeysApp ? "\x1bO" : "\x1b[";

  switch (k) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      // Shift+Tab → CSI Z (terminfo `kcbt`, xterm reverse-tab). Claude Code
      // CLI's permission prompts and option pickers reverse-cycle on this
      // exact byte sequence. Ctrl+Tab / Alt+Tab fall through to null because
      // the OS / browser typically owns those chords and stealing them would
      // break window/pane switchers users rely on.
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        return "\x1b[Z";
      }
      if (event.ctrlKey || event.altKey || event.metaKey) {
        return null;
      }
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return `${arrowPrefix}A`;
    case "ArrowDown":
      return `${arrowPrefix}B`;
    case "ArrowRight":
      return `${arrowPrefix}C`;
    case "ArrowLeft":
      return `${arrowPrefix}D`;
    case "Home":
      return options.cursorKeysApp ? "\x1bOH" : "\x1b[H";
    case "End":
      return options.cursorKeysApp ? "\x1bOF" : "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
    default:
      // Single printable character. Meta / Alt are excluded so OS chords
      // (Cmd+W, Alt+F, etc.) don't leak into the PTY as raw text.
      if (k.length === 1 && !event.metaKey && !event.altKey) {
        return k;
      }
      return null;
  }
}
