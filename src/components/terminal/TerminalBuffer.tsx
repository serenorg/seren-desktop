// ABOUTME: Canvas-based UI for the Rust-backed terminal grid.
// ABOUTME: Reads parsed grid snapshots from terminal_grid_snapshot and pipes raw key input back to the PTY.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { terminalStore } from "@/stores/terminal.store";
import { threadStore } from "@/stores/thread.store";

interface GridCell {
  ch: number;
  width: number;
  // SGR fields. Backend skips serializing these when default, so a
  // missing field means "use the renderer default".
  fg?: number;
  bg?: number;
  attrs?: number;
}

interface GridSnapshot {
  rows: number;
  cols: number;
  cells: GridCell[];
  cursorRow: number;
  cursorCol: number;
  unhandledActions: number;
  // Mode-tracking fields. Backend skips serializing each when it
  // equals its default (cursorVisible=true, cursorKeysApp=false,
  // bracketedPaste=false), so a missing field means "default".
  cursorVisible?: boolean;
  cursorKeysApp?: boolean;
  bracketedPaste?: boolean;
}

interface TerminalSnapshotGrid {
  seq: number;
  kind: "grid";
  payload: GridSnapshot;
}

/**
 * Incremental update from terminal://grid-diff. Carries only the
 * rows that changed since the last drain plus the current cursor +
 * mode flags. The frontend applies the diff to its local grid
 * signal and tracks the seq so it can detect a missed diff and
 * resync via a full snapshot.
 */
interface GridDiffRow {
  row: number;
  cells: GridCell[];
}
interface GridDiffEvent {
  bufferId: string;
  seq: number;
  rows: GridDiffRow[];
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  cursorKeysApp: boolean;
  bracketedPaste: boolean;
  rowsTotal: number;
  colsTotal: number;
}

const CELL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", "Menlo", "Consolas", monospace';
const CELL_FONT_SIZE = 13;
const CELL_FONT = `${CELL_FONT_SIZE}px ${CELL_FONT_FAMILY}`;
const CELL_FONT_BOLD = `bold ${CELL_FONT_SIZE}px ${CELL_FONT_FAMILY}`;
const CELL_FONT_ITALIC = `italic ${CELL_FONT_SIZE}px ${CELL_FONT_FAMILY}`;
const CELL_FONT_BOLD_ITALIC = `bold italic ${CELL_FONT_SIZE}px ${CELL_FONT_FAMILY}`;

const COLOR_BG = "#090b0f";
const COLOR_FG = "#d7dde8";
const COLOR_CURSOR = "#d7dde8";
const COLOR_CURSOR_FG = "#090b0f";

// Color packing matches src-tauri/src/terminal.rs:
//   0xFFFFFFFF       = default (renderer falls back to theme)
//   0xFE000000 | idx = palette index (0..255)
//   0x00RRGGBB       = truecolor
const COLOR_DEFAULT = 0xffffffff;
const COLOR_PALETTE_TAG = 0xfe000000;

// Cell attribute bits (mirror ATTR_* in Rust).
const ATTR_BOLD = 1 << 0;
const ATTR_ITALIC = 1 << 1;
const ATTR_UNDERLINE = 1 << 2;
const ATTR_REVERSE = 1 << 3;
const ATTR_DIM = 1 << 4;
const ATTR_STRIKE = 1 << 5;

// Standard xterm-ish 16-color palette. Indices 0-7 = normal, 8-15 = bright.
// Picked to feel modern/legible against the dark theme background rather
// than slavishly matching xterm's exact tones.
const ANSI_16 = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

/**
 * Resolve a 256-color extended palette index (16..255) to a CSS color.
 * 16-231 are a 6x6x6 RGB cube; 232-255 are a 24-step grayscale ramp.
 */
function palette256(idx: number): string {
  if (idx < 16) return ANSI_16[idx];
  if (idx >= 232) {
    const v = 8 + (idx - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = idx - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const lvl = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return `rgb(${lvl(r)},${lvl(g)},${lvl(b)})`;
}

/**
 * Convert a packed cell color to a CSS color string. `defaultColor` is
 * what to return for the default sentinel (different for fg vs bg).
 *
 * NOTE: JS bitwise operators coerce to signed int32, so `(packed &
 * 0xff000000)` for any packed value with bit 31 set returns a negative
 * number while `0xfe000000` as a Number literal is positive
 * (4261412864). The `>>> 0` zero-fill shift coerces both sides to the
 * same unsigned int32 representation so the equality holds. Without it,
 * every palette-tagged color silently falls through to the truecolor
 * branch and renders as `rgb(0,0,idx)`.
 */
function resolveColor(
  packed: number | undefined,
  defaultColor: string,
): string {
  if (packed === undefined || packed === COLOR_DEFAULT) return defaultColor;
  if ((packed & 0xff000000) >>> 0 === COLOR_PALETTE_TAG) {
    return palette256(packed & 0xff);
  }
  // 24-bit RGB in the low 24 bits. Truecolor packs always have the high
  // byte as 0x00, so the signed-shift quirk above doesn't apply here.
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  return `rgb(${r},${g},${b})`;
}

/**
 * Pick the right canvas font string for a cell's bold/italic combo.
 * Dim's font effect is not used; we render Dim by halving the
 * foreground alpha at draw time instead of using a thin font weight.
 */
function fontForAttrs(attrs: number): string {
  const bold = (attrs & ATTR_BOLD) !== 0;
  const italic = (attrs & ATTR_ITALIC) !== 0;
  if (bold && italic) return CELL_FONT_BOLD_ITALIC;
  if (bold) return CELL_FONT_BOLD;
  if (italic) return CELL_FONT_ITALIC;
  return CELL_FONT;
}
export const TerminalBuffer: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let surfaceRef: HTMLDivElement | undefined;
  const [grid, setGrid] = createSignal<GridSnapshot | null>(null);
  // Last grid seq applied to the local grid signal. Diff events that
  // are not exactly seq+1 trigger a full snapshot resync; the seq is
  // monotonic per-feed in Rust so a gap means we missed an event.
  const [gridSeq, setGridSeq] = createSignal(0);
  const [cellW, setCellW] = createSignal(0);
  const [cellH, setCellH] = createSignal(0);

  let unlistenDiff: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  // Snapshot fetch in flight - serialize to one outstanding so a burst
  // of resync requests doesn't pile up IPC.
  let inFlightSnapshot = false;
  let pendingResync = false;

  const buffer = createMemo(() =>
    terminalStore.getBuffer(threadStore.activeThreadId),
  );

  const fetchGridSnapshot = async () => {
    const id = threadStore.activeThreadId;
    if (!id) return;
    if (inFlightSnapshot) {
      pendingResync = true;
      return;
    }
    inFlightSnapshot = true;
    try {
      const snap = await invoke<TerminalSnapshotGrid>(
        "terminal_grid_snapshot",
        { bufferId: id },
      );
      if (snap.kind === "grid" && id === threadStore.activeThreadId) {
        setGrid(snap.payload);
        setGridSeq(snap.seq);
      }
    } catch {
      // Buffer may have been killed between trigger and fetch.
    } finally {
      inFlightSnapshot = false;
      if (pendingResync) {
        pendingResync = false;
        void fetchGridSnapshot();
      }
    }
  };

  /**
   * Apply an incremental grid diff to the local grid signal. Returns
   * true on success; false when the diff's seq doesn't match the
   * expected next seq (caller should resync via fetchGridSnapshot).
   */
  const applyDiff = (diff: GridDiffEvent): boolean => {
    const current = grid();
    if (!current) return false;
    if (diff.seq !== gridSeq() + 1) return false;
    const dimsChanged =
      diff.rowsTotal !== current.rows || diff.colsTotal !== current.cols;
    let cells: GridCell[];
    if (dimsChanged) {
      // Resize: every row is dirty in this case so the diff carries
      // enough info to rebuild from scratch.
      cells = new Array(diff.rowsTotal * diff.colsTotal);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = { ch: 0, width: 1 };
      }
    } else {
      cells = current.cells.slice();
    }
    const cols = diff.colsTotal;
    for (const row of diff.rows) {
      const base = row.row * cols;
      for (let i = 0; i < row.cells.length; i++) {
        cells[base + i] = row.cells[i];
      }
    }
    setGrid({
      ...current,
      rows: diff.rowsTotal,
      cols: diff.colsTotal,
      cells,
      cursorRow: diff.cursorRow,
      cursorCol: diff.cursorCol,
      cursorVisible: diff.cursorVisible,
      cursorKeysApp: diff.cursorKeysApp,
      bracketedPaste: diff.bracketedPaste,
    });
    setGridSeq(diff.seq);
    return true;
  };

  const measureCell = () => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.font = CELL_FONT;
    const m = ctx.measureText("M");
    // Cell width: the FONT's ideographic width if exposed, else "M"'s
    // bounding box. Both are stable for monospace.
    const w = m.width;
    // Cell HEIGHT: must be the FONT's design metrics (fontBoundingBox*),
    // not the GLYPH's ink box (actualBoundingBox*). "M" has no descender
    // so actualBoundingBoxDescent is essentially 0, which produced a cell
    // height roughly equal to cap-height and made descenders from one
    // row overlap the caps of the next row (visible bug in vim/htop).
    // Use fontBoundingBoxAscent + fontBoundingBoxDescent when the engine
    // exposes them (modern WebKit + Chromium do), and fall back to a
    // line-height multiplier of 1.4 - the conventional terminal value
    // that gives breathing room without looking double-spaced.
    const fbAscent = m.fontBoundingBoxAscent;
    const fbDescent = m.fontBoundingBoxDescent;
    const h =
      fbAscent !== undefined && fbDescent !== undefined
        ? Math.ceil(fbAscent + fbDescent)
        : Math.ceil(CELL_FONT_SIZE * 1.4);
    setCellW(w);
    setCellH(h);
  };

  /**
   * Compute the integer cols/rows that fit in the surface element and push
   * them to the PTY via terminal_resize. Skipped if the cell metrics aren't
   * known yet or no buffer is active.
   */
  const pushResize = () => {
    if (!surfaceRef) return;
    const w = cellW();
    const h = cellH();
    if (w === 0 || h === 0) return;
    const id = threadStore.activeThreadId;
    if (!id) return;
    const cols = Math.max(2, Math.floor(surfaceRef.clientWidth / w));
    const rows = Math.max(1, Math.floor(surfaceRef.clientHeight / h));
    const current = buffer();
    if (current && current.cols === cols && current.rows === rows) {
      return;
    }
    // Resize bumps grid.seq on the Rust side and marks every row
    // dirty; the next diff event carries the new dimensions. No need
    // to manually fetch a snapshot afterwards.
    void terminalStore.resize(id, cols, rows);
  };

  const clearCanvas = () => {
    if (!canvasRef) return;
    canvasRef.width = 0;
    canvasRef.height = 0;
    canvasRef.style.width = "0px";
    canvasRef.style.height = "0px";
  };

  // Re-render the canvas whenever the grid snapshot or cell metrics
  // change. Two passes: backgrounds first (so adjacent cells with bg
  // fills have no seams), then glyphs + decorations (underline, strike).
  // Per-cell font/fillStyle changes are batched against the previous
  // cell's state so homogeneous runs don't thrash the context.
  createEffect(() => {
    const g = grid();
    const w = cellW();
    const h = cellH();
    if (!g) {
      clearCanvas();
      return;
    }
    if (!canvasRef || w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = g.cols * w;
    const pxH = g.rows * h;
    canvasRef.width = Math.round(pxW * dpr);
    canvasRef.height = Math.round(pxH * dpr);
    canvasRef.style.width = `${pxW}px`;
    canvasRef.style.height = `${pxH}px`;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, pxW, pxH);

    // Pass 1: backgrounds. For non-reverse cells, skip default-bg so we
    // don't repaint over the cleared canvas. For reverse cells, the
    // background is the cell's foreground (or COLOR_FG when fg is also
    // default) - ALWAYS paint it, even when fg is default, otherwise
    // `\x1b[7mtext` would render with the canvas's normal background
    // and the swap would be invisible.
    for (let r = 0; r < g.rows; r++) {
      const rowOffset = r * g.cols;
      const y = r * h;
      for (let c = 0; c < g.cols; c++) {
        const cell = g.cells[rowOffset + c];
        if (!cell) continue;
        const reverse = ((cell.attrs ?? 0) & ATTR_REVERSE) !== 0;
        if (reverse) {
          // Reverse: bg is the resolved foreground. Paint unconditionally
          // so the swap shows even on default-fg/default-bg cells.
          ctx.fillStyle = resolveColor(cell.fg, COLOR_FG);
          ctx.fillRect(c * w, y, w, h);
        } else {
          const bgPacked = cell.bg;
          if (bgPacked === undefined || bgPacked === COLOR_DEFAULT) continue;
          ctx.fillStyle = resolveColor(bgPacked, COLOR_BG);
          ctx.fillRect(c * w, y, w, h);
        }
      }
    }

    // Pass 2: glyphs + decorations.
    ctx.textBaseline = "top";
    let lastFont = "";
    let lastFill = "";
    for (let r = 0; r < g.rows; r++) {
      const rowOffset = r * g.cols;
      const y = r * h;
      for (let c = 0; c < g.cols; c++) {
        const cell = g.cells[rowOffset + c];
        if (!cell) continue;
        const attrs = cell.attrs ?? 0;
        const reverse = (attrs & ATTR_REVERSE) !== 0;
        const fgPacked = reverse ? cell.bg : cell.fg;
        const x = c * w;

        const font = fontForAttrs(attrs);
        if (font !== lastFont) {
          ctx.font = font;
          lastFont = font;
        }
        // Reverse swaps the role of default colors too: a reverse cell
        // with default fg/bg should render the glyph in COLOR_BG (the
        // canvas background) on top of the COLOR_FG block painted in
        // pass 1, so the inverted text reads correctly.
        const defaultFill = reverse ? COLOR_BG : COLOR_FG;
        const fill = resolveColor(fgPacked, defaultFill);
        // Dim halves alpha on the foreground; a real terminal would
        // shift toward grey. Acceptable approximation.
        if ((attrs & ATTR_DIM) !== 0) {
          ctx.globalAlpha = 0.6;
        }
        // Skip drawing the glyph for empty cells and wide-continuation
        // slots, but still emit underline/strike if the attr is set
        // (rare but possible if the prev paint left an underlined blank
        // - matches xterm behavior).
        const drawGlyph = cell.ch !== 0 && cell.width !== 0;
        if (drawGlyph) {
          if (fill !== lastFill) {
            ctx.fillStyle = fill;
            lastFill = fill;
          }
          ctx.fillText(String.fromCodePoint(cell.ch), x, y);
        }
        if ((attrs & ATTR_UNDERLINE) !== 0) {
          if (fill !== lastFill) {
            ctx.fillStyle = fill;
            lastFill = fill;
          }
          ctx.fillRect(x, y + h - 2, w, 1);
        }
        if ((attrs & ATTR_STRIKE) !== 0) {
          if (fill !== lastFill) {
            ctx.fillStyle = fill;
            lastFill = fill;
          }
          ctx.fillRect(x, y + Math.floor(h / 2), w, 1);
        }
        if ((attrs & ATTR_DIM) !== 0) {
          ctx.globalAlpha = 1.0;
        }
      }
    }

    // Cursor: inverted block at (cursorRow, cursorCol). For a wide
    // cursor cell, paint two columns wide so the cursor matches the
    // glyph. The cursor background overrides any cell bg below it.
    // Respect DECSET 25 (cursor_visible). Apps like vim, less, and
    // tmux hide the cursor in alt-screen UI; default true when the
    // backend skip-serializes the field.
    const cursorVisible = g.cursorVisible ?? true;
    if (cursorVisible && g.cursorRow < g.rows && g.cursorCol < g.cols) {
      const cell = g.cells[g.cursorRow * g.cols + g.cursorCol];
      const cursorWidth = (cell?.width ?? 1) === 2 ? 2 * w : w;
      const cx = g.cursorCol * w;
      const cy = g.cursorRow * h;
      ctx.fillStyle = COLOR_CURSOR;
      ctx.fillRect(cx, cy, cursorWidth, h);
      if (cell && cell.ch !== 0 && cell.width > 0) {
        ctx.fillStyle = COLOR_CURSOR_FG;
        ctx.font = fontForAttrs(cell.attrs ?? 0);
        ctx.fillText(String.fromCodePoint(cell.ch), cx, cy);
      }
    }
  });

  // Refetch immediately when the active buffer changes (thread switch),
  // so the canvas shows the freshly-selected terminal's state without
  // waiting for the next output event. Also clear the grid signal up
  // front so a switch never momentarily shows the previous terminal's
  // content while the new fetch is in flight.
  createEffect(
    on(
      () => threadStore.activeThreadId,
      (id) => {
        // Clear local grid + seq so a stale diff for the previous
        // buffer can't apply to the new one. The fetch below seeds
        // the new buffer's seq from the snapshot.
        setGrid(null);
        setGridSeq(0);
        if (!id) return;
        pushResize();
        void fetchGridSnapshot();
      },
    ),
  );

  /**
   * Translate a KeyboardEvent into the byte sequence the PTY expects
   * and write it to the active buffer. Covers printable chars, Enter,
   * Backspace, Tab, Esc, arrow keys (DECCKM-aware), Home/End/PageUp/
   * PageDown/Delete, Ctrl+letter chords, and Ctrl+C via the signal
   * API. Modifier-rich combinations (Shift+Arrow etc.) and the Kitty
   * keyboard protocol are not yet handled.
   */
  const handleKeyDown = async (event: KeyboardEvent) => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    const id = current.id;
    const k = event.key;

    // Ctrl+C goes through the signal path so raw-mode TUIs receive SIGINT
    // rather than just a 0x03 byte the line discipline ignores.
    if (event.ctrlKey && (k === "c" || k === "C")) {
      event.preventDefault();
      await terminalStore.signal(id, "interrupt");
      return;
    }

    // Other Ctrl-letter chords map to control bytes 0x01-0x1A.
    if (event.ctrlKey && k.length === 1 && /[a-zA-Z]/.test(k)) {
      event.preventDefault();
      const code = k.toUpperCase().charCodeAt(0) - 64;
      await terminalStore.write(id, String.fromCharCode(code));
      return;
    }

    // Arrow keys + Home/End honor DECSET 1 (DECCKM application cursor
    // keys) when the backend has it on. vim sets DECCKM as part of
    // its alt-screen entry; without this branch its cursor keys do
    // nothing. PageUp/PageDown/Delete are xterm tilde sequences
    // (`\x1b[5~`, `\x1b[6~`, `\x1b[3~`) and have no app-mode variants
    // in standard xterm, so they stay constant below.
    //
    // Modifier+arrow (Shift+Up, Ctrl+Up, etc.) currently falls through
    // to plain arrow encoding - the xterm modifyOtherKeys / CSI 1;mod
    // sequences (e.g. `\x1b[1;5A` for Ctrl+Up) are not yet generated.
    // Apps that key off modifier+arrow (tmux pane resize, some vim
    // plugins) will see only the bare arrow.
    const decckm = grid()?.cursorKeysApp ?? false;
    const arrowPrefix = decckm ? "\x1bO" : "\x1b[";

    let bytes: string | null = null;
    switch (k) {
      case "Enter":
        bytes = "\r";
        break;
      case "Backspace":
        bytes = "\x7f";
        break;
      case "Tab":
        bytes = "\t";
        break;
      case "Escape":
        bytes = "\x1b";
        break;
      case "ArrowUp":
        bytes = `${arrowPrefix}A`;
        break;
      case "ArrowDown":
        bytes = `${arrowPrefix}B`;
        break;
      case "ArrowRight":
        bytes = `${arrowPrefix}C`;
        break;
      case "ArrowLeft":
        bytes = `${arrowPrefix}D`;
        break;
      case "Home":
        bytes = decckm ? "\x1bOH" : "\x1b[H";
        break;
      case "End":
        bytes = decckm ? "\x1bOF" : "\x1b[F";
        break;
      case "PageUp":
        bytes = "\x1b[5~";
        break;
      case "PageDown":
        bytes = "\x1b[6~";
        break;
      case "Delete":
        bytes = "\x1b[3~";
        break;
      default:
        // Single printable character (may be multi-byte UTF-8 once
        // serialized; terminal_write takes a string).
        if (k.length === 1 && !event.metaKey && !event.altKey) {
          bytes = k;
        }
        break;
    }
    if (bytes !== null) {
      event.preventDefault();
      await terminalStore.write(id, bytes);
    }
  };

  /**
   * Handle a paste from the clipboard. When DECSET 2004 (bracketed
   * paste) is on, wrap the pasted text in `\x1b[200~ ... \x1b[201~`
   * so the receiving app can distinguish pasted content from typed
   * input. Otherwise send the raw text. Strips embedded `\x1b[201~`
   * markers from pasted content as a safety measure - apps would
   * otherwise see a paste-end marker mid-content and treat the
   * trailing bytes as typed.
   */
  const handlePaste = async (event: ClipboardEvent) => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text) return;
    event.preventDefault();
    // Strip embedded paste-end markers so a malicious or malformed
    // clipboard cannot inject \x1b[201~ mid-content and have the
    // receiving app treat the trailing bytes as typed input. split+join
    // instead of a regex literal so biome's no-control-char-in-regex
    // lint stays happy.
    const safe = text.split("\x1b[201~").join("");
    const bracketed = grid()?.bracketedPaste ?? false;
    const payload = bracketed ? `\x1b[200~${safe}\x1b[201~` : safe;
    await terminalStore.write(current.id, payload);
  };

  const sendInterrupt = async () => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    await terminalStore.signal(current.id, "interrupt");
  };

  const kill = async () => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    await terminalStore.kill(current.id);
  };

  onMount(async () => {
    await terminalStore.init();
    measureCell();
    pushResize();
    void fetchGridSnapshot();

    // Subscribe to incremental grid diffs. Filter by active buffer
    // (a background terminal's diffs are still emitted but the
    // foreground canvas doesn't render them). On seq mismatch, fall
    // back to a full snapshot fetch to resync.
    unlistenDiff = await listen<GridDiffEvent>(
      "terminal://grid-diff",
      (event) => {
        const diff = event.payload;
        if (diff.bufferId !== threadStore.activeThreadId) return;
        if (!applyDiff(diff)) {
          void fetchGridSnapshot();
        }
      },
    );

    if (surfaceRef) {
      resizeObserver = new ResizeObserver(() => {
        // Re-measure cell dims in case zoom or DPR changed; then push.
        measureCell();
        pushResize();
      });
      resizeObserver.observe(surfaceRef);
    }
  });

  onCleanup(() => {
    unlistenDiff?.();
    resizeObserver?.disconnect();
  });

  return (
    <div class="flex flex-col h-full min-h-0 bg-surface-0">
      <Show
        when={buffer()}
        fallback={
          <div class="flex items-center justify-center h-full text-sm text-muted-foreground">
            Terminal buffer not found
          </div>
        }
      >
        {(current) => (
          <>
            <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
              <div class="flex-1 min-w-0">
                <div class="text-[13px] font-medium text-foreground truncate">
                  {current().title}
                </div>
                <div class="text-[11px] text-muted-foreground truncate">
                  {current().cwd || "Current environment"} - {current().status}
                </div>
              </div>
              <button
                type="button"
                class="px-2 py-1 text-[12px] rounded-md border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-surface-2"
                onClick={sendInterrupt}
                disabled={current().status !== "running"}
              >
                Ctrl+C
              </button>
              <button
                type="button"
                class="px-2 py-1 text-[12px] rounded-md border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-surface-2"
                onClick={kill}
                disabled={current().status !== "running"}
              >
                Stop
              </button>
            </div>

            {/* Canvas surface. role="application" + tabIndex=0 lets the
                div receive focus + keyboard events; the application role
                tells screen readers this is a widget with its own
                keyboard model (matches xterm.js, vscode terminal, etc.).
                Focus on mousedown so users can type without Tab-ing in. */}
            <div
              ref={surfaceRef}
              class="flex-1 min-h-0 overflow-hidden bg-[#090b0f] outline-none cursor-text"
              role="application"
              aria-label="Terminal"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: terminal surfaces are interactive widgets that own their keyboard model (matches xterm.js, vscode terminal pattern)
              tabIndex={0}
              onKeyDown={(e) => void handleKeyDown(e)}
              onPaste={(e) => void handlePaste(e)}
              onMouseDown={(e) => {
                (e.currentTarget as HTMLDivElement).focus();
              }}
            >
              <canvas ref={canvasRef} class="block" />
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
