// ABOUTME: Stage 3 canvas-based UI for the Rust-backed terminal grid.
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
  // Stage 2.5 SGR fields. Backend skips serializing these when default,
  // so a missing field means "use the renderer default".
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
}

interface TerminalSnapshotGrid {
  seq: number;
  kind: "grid";
  payload: GridSnapshot;
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
 * Stage 2.5 ignores Dim's font effect; we render Dim by halving the
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
// 32ms = ~30fps. Stage 3 polls the grid via terminal_grid_snapshot on a
// debounced trigger from terminal://output events. Stage 4 will swap this
// for a Rust-side coalesced grid-diff event channel.
const SNAPSHOT_DEBOUNCE_MS = 32;

export const TerminalBuffer: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let surfaceRef: HTMLDivElement | undefined;
  const [grid, setGrid] = createSignal<GridSnapshot | null>(null);
  const [cellW, setCellW] = createSignal(0);
  const [cellH, setCellH] = createSignal(0);

  let unlistenOutput: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let snapshotTimer: number | null = null;
  let inFlightSnapshot = false;
  // Set when a fetch is requested while one is already in flight. The
  // in-flight fetch's `finally` re-arms the debounced timer so the
  // latest grid state always lands on the canvas, even when the source
  // event burst stops before the in-flight resolves. Without this a
  // burst of `terminal://output` events that all collapse into a single
  // bailed scheduleFetch leaves the canvas stale until the next chunk.
  let pendingFetch = false;

  const buffer = createMemo(() =>
    terminalStore.getBuffer(threadStore.activeThreadId),
  );

  const fetchGridSnapshot = async () => {
    const id = threadStore.activeThreadId;
    if (!id) return;
    if (inFlightSnapshot) {
      pendingFetch = true;
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
      }
    } catch {
      // Buffer may have been killed between trigger and fetch.
    } finally {
      inFlightSnapshot = false;
      if (pendingFetch) {
        pendingFetch = false;
        scheduleFetch();
      }
    }
  };

  const scheduleFetch = () => {
    if (snapshotTimer !== null) return;
    snapshotTimer = window.setTimeout(() => {
      snapshotTimer = null;
      void fetchGridSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  };

  const measureCell = () => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.font = CELL_FONT;
    const m = ctx.measureText("M");
    const w = m.width;
    // measureText's actualBounding* are sometimes undefined in older
    // engines; fall back to the font's nominal cell height.
    const ascent = m.actualBoundingBoxAscent ?? 13;
    const descent = m.actualBoundingBoxDescent ?? 3;
    const h = ascent + descent + 2;
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
    void terminalStore.resize(id, cols, rows).then(scheduleFetch);
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
    if (!g || !canvasRef || w === 0 || h === 0) return;
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
        // shift toward grey. Acceptable approximation for Stage 2.5.
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
    if (g.cursorRow < g.rows && g.cursorCol < g.cols) {
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
        setGrid(null);
        if (!id) return;
        // Re-measure pushes resize; pushResize calls scheduleFetch on its
        // own success. Always also do an immediate fetch so a switched-to
        // idle buffer (no resize delta) still paints.
        pushResize();
        void fetchGridSnapshot();
      },
    ),
  );

  /**
   * Translate a KeyboardEvent into the byte sequence the PTY expects and
   * write it to the active buffer. Stage 3 minimum coverage: printable
   * chars, Enter, Backspace, Tab, Esc, arrow keys (no DECCKM mode tracking
   * yet so xterm-default sequences only), and Ctrl+C via the signal API.
   * Stage 4 will swap this for terminput-driven encoding with full
   * modifier and Kitty keyboard protocol support.
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
        bytes = "\x1b[A";
        break;
      case "ArrowDown":
        bytes = "\x1b[B";
        break;
      case "ArrowRight":
        bytes = "\x1b[C";
        break;
      case "ArrowLeft":
        bytes = "\x1b[D";
        break;
      case "Home":
        bytes = "\x1b[H";
        break;
      case "End":
        bytes = "\x1b[F";
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

    // Filter to the active buffer: a noisy background terminal would
    // otherwise force repeated snapshots/repaints of the foreground
    // terminal even though its grid hasn't changed.
    unlistenOutput = await listen<{ bufferId: string }>(
      "terminal://output",
      (event) => {
        if (event.payload.bufferId !== threadStore.activeThreadId) return;
        scheduleFetch();
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
    unlistenOutput?.();
    resizeObserver?.disconnect();
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
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
                  <Show when={(grid()?.unhandledActions ?? 0) > 0}>
                    <span
                      class="ml-2 text-[10px] text-amber-400/70"
                      title="Some terminal escape sequences are not yet handled by the Stage 2 grid; output may render incompletely."
                    >
                      ({grid()?.unhandledActions} unhandled)
                    </span>
                  </Show>
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
