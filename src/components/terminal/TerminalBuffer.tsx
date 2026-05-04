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
  // Number of rows preserved in scrollback above the live screen.
  // Backend skips serializing when zero.
  scrollbackLen?: number;
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
 * resync via a full snapshot. A diff may cover multiple feed seqs
 * when Rust coalesces high-throughput output; baseSeq is the grid
 * seq included by the previous diff drain.
 */
interface GridDiffRow {
  row: number;
  cells: GridCell[];
}
interface GridScroll {
  top: number;
  bottom: number;
  delta: number;
}
interface GridDiffEvent {
  bufferId: string;
  baseSeq: number;
  seq: number;
  scrolls?: GridScroll[];
  rows: GridDiffRow[];
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  cursorKeysApp: boolean;
  bracketedPaste: boolean;
  rowsTotal: number;
  colsTotal: number;
  // Current scrollback length. Frontend uses the delta between diffs
  // to keep the viewport anchored when in scroll-back mode.
  scrollbackLen?: number;
}

interface ScrollbackWindow {
  start: number;
  rows: GridCell[][];
  scrollbackLen: number;
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

interface CellPos {
  row: number;
  col: number;
}
interface SelectionRange {
  /** Cell where the user pressed mousedown. Stays put across drag. */
  anchor: CellPos;
  /** Cell where the mouse currently is (or last was on mouseup). */
  head: CellPos;
}

const SELECTION_OVERLAY_FILL = "rgba(80, 130, 200, 0.4)";

/**
 * Normalize a SelectionRange so the returned [start, end] pair is in
 * row-major order regardless of which way the user dragged.
 */
function normalizeSelection(sel: SelectionRange): [CellPos, CellPos] {
  const a = sel.anchor;
  const b = sel.head;
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return [a, b];
  }
  return [b, a];
}

/**
 * Walk the selected cells row-by-row and build a string. Wide-char
 * continuation cells (width=0) are skipped so a CJK glyph counts
 * once. Empty cells (ch=0) become spaces. Trailing whitespace per
 * line is trimmed; rows are joined with newlines.
 */
function selectionText(grid: GridSnapshot, sel: SelectionRange): string {
  const [start, end] = normalizeSelection(sel);
  const lines: string[] = [];
  for (let r = start.row; r <= end.row && r < grid.rows; r++) {
    const startCol = r === start.row ? start.col : 0;
    const endCol = r === end.row ? end.col : grid.cols - 1;
    let line = "";
    for (let c = startCol; c <= endCol && c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      if (!cell) continue;
      if (cell.width === 0) continue;
      line += cell.ch ? String.fromCodePoint(cell.ch) : " ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

/**
 * Best-effort clipboard write. Tauri's webview generally exposes the
 * Async Clipboard API, but some platforms / configurations don't, so
 * fall back to a hidden textarea + execCommand("copy").
 */
async function writeClipboard(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall through to execCommand fallback.
  }
  // Capture the current focus so we can restore it after the textarea
  // hijack. Without this, the user's next keystroke after a copy would
  // be lost - the surface div lost focus when the textarea took it.
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-1000px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // Out of options; nothing to do.
  }
  document.body.removeChild(ta);
  previousFocus?.focus();
}

export const TerminalBuffer: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let surfaceRef: HTMLDivElement | undefined;
  const [grid, setGrid] = createSignal<GridSnapshot | null>(null);
  // Last grid seq applied to the local grid signal. Rust may coalesce
  // many feed seqs into one diff, so applyDiff accepts any diff whose
  // baseSeq is already covered by this local seq; a baseSeq newer than
  // this local seq means we missed a diff and must resync.
  const [gridSeq, setGridSeq] = createSignal(0);
  const [cellW, setCellW] = createSignal(0);
  const [cellH, setCellH] = createSignal(0);
  const [selection, setSelection] = createSignal<SelectionRange | null>(null);

  let unlistenDiff: UnlistenFn | null = null;
  let resizeObserver: ResizeObserver | null = null;
  // Snapshot fetch in flight - serialize to one outstanding so a burst
  // of resync requests doesn't pile up IPC.
  let inFlightSnapshot = false;
  let pendingResync = false;
  let canvasPixelWidth = 0;
  let canvasPixelHeight = 0;
  let canvasCssWidth = 0;
  let canvasCssHeight = 0;
  // Diff coalescing. The Rust side caps emits to ~60fps, but on a
  // maximized terminal each diff still carries up to ~20k cells and the
  // canvas repaint is O(grid_size). Without coalescing, sustained
  // torrents (find ~) overflow the webview event queue: per-event work
  // exceeds frame budget, events pile up unbounded, GC pressure mounts,
  // throughput collapses. The handler enqueues; a single rAF drains the
  // queue and triggers one paint per frame.
  let pendingDiffs: GridDiffEvent[] = [];
  // Rows that changed since the last paint. Lets the painter redraw
  // only those rows instead of all 12k+ cells.
  const pendingRepaintRows = new Set<number>();
  // Scroll regions that can be shifted in the canvas backing store before
  // repainting inserted/dirty rows. This avoids repainting the whole visible
  // scroll region for every bottom scroll.
  let pendingCanvasScrolls: GridScroll[] = [];
  // Forces the next paint to redraw every cell. Set on snapshot reset,
  // resize, selection change, cell-metric change, and overflow recovery.
  let needsFullRepaint = true;
  let rafHandle: number | null = null;
  // Hard cap on queued diffs. If rAF is starved (background tab) we
  // drop the queue and resync via snapshot instead of growing forever.
  const MAX_PENDING_DIFFS = 240;
  // Selection drag tracking. dragAnchor non-null means a left-button
  // drag is in progress. dragMoved distinguishes drag-to-select from
  // a plain click (which clears the selection).
  let dragAnchor: CellPos | null = null;
  let dragMoved = false;

  // Scrollback viewport. `viewportOffset` is the number of rows above
  // the live bottom that the user has scrolled up; 0 means the live
  // grid is fully visible. `scrollbackLen` mirrors the backend's
  // current history length and is the upper bound on viewportOffset.
  // The cache is keyed by absolute scrollback row index (0 = oldest)
  // so the same row stays valid even as the live screen scrolls.
  const [viewportOffset, setViewportOffset] = createSignal(0);
  const [scrollbackLen, setScrollbackLen] = createSignal(0);
  const scrollbackCache = new Map<number, GridCell[]>();
  const scrollbackInFlight = new Set<number>();
  // How many wheel-delta units accumulate to one row of scroll. Wheel
  // events report deltaY in pixels (line/page modes are normalized by
  // the browser); 40px per cell row matches macOS / Linux defaults.
  const WHEEL_PIXELS_PER_ROW = 40;
  let wheelAccumulator = 0;

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
        // Snapshot supersedes any queued diffs - they're either older
        // (already in the snapshot) or newer (will arrive after the
        // emitter's next tick and apply cleanly on top).
        pendingDiffs = [];
        pendingRepaintRows.clear();
        pendingCanvasScrolls = [];
        needsFullRepaint = true;
        setGrid(snap.payload);
        setGridSeq(snap.seq);
        setScrollbackLen(snap.payload.scrollbackLen ?? 0);
        scheduleFrame();
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

  type ApplyResult = "ok" | "noop" | "resync";

  /**
   * Apply an incremental grid diff in place and record which rows need
   * repainting. Mutates the existing cells array (no slice) to avoid
   * allocating ~20k objects per diff under torrent load - that
   * allocation rate was the dominant source of GC pressure and the
   * compounding slowdown.
   *
   * Returns "noop" when the diff is older than current state, "resync"
   * when the diff's baseSeq is past current (we missed a diff and have
   * to refetch), and "ok" when applied. Caller should NOT call setGrid
   * for "ok" results - the snapshot reference stays the same and the
   * paint loop reads its updated fields directly.
   */
  const applyDiffInternal = (diff: GridDiffEvent): ApplyResult => {
    const current = grid();
    if (!current) return "resync";
    const currentSeq = gridSeq();
    if (diff.seq <= currentSeq) return "noop";
    if (diff.baseSeq > currentSeq) return "resync";
    const dimsChanged =
      diff.rowsTotal !== current.rows || diff.colsTotal !== current.cols;
    if (dimsChanged) {
      // Dim changes invalidate every cached row; rebuild from scratch
      // and force a full repaint on the next frame. Resize is rare
      // (window edge drag, font change) so the alloc here is fine.
      const cells: GridCell[] = new Array(diff.rowsTotal * diff.colsTotal);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = { ch: 0, width: 1 };
      }
      const cols = diff.colsTotal;
      applyScrolls(cells, cols, diff);
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
      needsFullRepaint = true;
      pendingRepaintRows.clear();
      pendingCanvasScrolls = [];
      return "ok";
    }
    // Same dims: mutate the existing cells in place. Track every row
    // touched (scrolled, written, or holding the old/new cursor) so the
    // partial-repaint pass redraws exactly those rows and nothing else.
    const cells = current.cells;
    const cols = current.cols;
    const scrolls = diff.scrolls;
    if (scrolls && scrolls.length > 0) {
      applyScrolls(cells, cols, diff);
      if (selection()) {
        // Keep selection overlays anchored to screen coordinates. Blitting
        // would copy the old translucent pixels along with the scrolled
        // content, so fall back to repainting the affected region.
        for (const scroll of scrolls) {
          const top = Math.max(0, Math.min(scroll.top, current.rows - 1));
          const bottom = Math.max(0, Math.min(scroll.bottom, current.rows - 1));
          for (let r = top; r <= bottom; r++) {
            pendingRepaintRows.add(r);
          }
        }
      } else {
        for (const scroll of scrolls) {
          shiftPendingRepaintRowsForScroll(scroll, current.rows);
        }
        pendingCanvasScrolls.push(...scrolls);
      }
    }
    for (const row of diff.rows) {
      const base = row.row * cols;
      for (let i = 0; i < row.cells.length; i++) {
        cells[base + i] = row.cells[i];
      }
      pendingRepaintRows.add(row.row);
    }
    // Cursor moves between cells without dirtying either row's contents.
    // Both the previous and new cursor rows must repaint so the old
    // cursor block clears and the new one shows up.
    pendingRepaintRows.add(current.cursorRow);
    pendingRepaintRows.add(diff.cursorRow);
    current.cursorRow = diff.cursorRow;
    current.cursorCol = diff.cursorCol;
    current.cursorVisible = diff.cursorVisible;
    current.cursorKeysApp = diff.cursorKeysApp;
    current.bracketedPaste = diff.bracketedPaste;
    setGridSeq(diff.seq);
    // Track scrollback growth and keep the user's view anchored to the
    // same historical rows. When new lines scroll off in the live grid,
    // the absolute scrollback row indices we are showing should not
    // move - so bump the offset by however much the history grew. If
    // the user is at the live view (offset 0), this is a no-op.
    const nextLen = diff.scrollbackLen ?? 0;
    const prevLen = scrollbackLen();
    if (nextLen !== prevLen) {
      setScrollbackLen(nextLen);
      const offset = viewportOffset();
      if (offset > 0 && nextLen > prevLen) {
        const delta = nextLen - prevLen;
        const next = Math.min(offset + delta, nextLen);
        if (next !== offset) {
          setViewportOffset(next);
          needsFullRepaint = true;
        }
      } else if (offset > nextLen) {
        // Scrollback shrank past our position (e.g. resize trim). Clamp.
        setViewportOffset(nextLen);
        needsFullRepaint = true;
      }
    }
    return "ok";
  };

  // Apply scroll deltas to a flat cells array in place. Shared between
  // the dim-changed (fresh array) and same-dim (existing array) paths.
  const applyScrolls = (
    cells: GridCell[],
    cols: number,
    diff: GridDiffEvent,
  ) => {
    if (!diff.scrolls || diff.scrolls.length === 0) return;
    for (const scroll of diff.scrolls) {
      const top = Math.max(0, Math.min(scroll.top, diff.rowsTotal - 1));
      const bottom = Math.max(0, Math.min(scroll.bottom, diff.rowsTotal - 1));
      if (bottom < top || scroll.delta === 0) continue;
      const height = bottom - top + 1;
      const count = Math.min(Math.abs(scroll.delta), height);
      const start = top * cols;
      const end = (bottom + 1) * cols;
      const blankCount = count * cols;
      if (scroll.delta > 0) {
        cells.copyWithin(start, start + blankCount, end);
        for (let i = end - blankCount; i < end; i++) {
          cells[i] = { ch: 0, width: 1 };
        }
      } else {
        cells.copyWithin(start + blankCount, start, end - blankCount);
        for (let i = start; i < start + blankCount; i++) {
          cells[i] = { ch: 0, width: 1 };
        }
      }
    }
  };

  const shiftPendingRepaintRowsForScroll = (
    scroll: GridScroll,
    rowsTotal: number,
  ) => {
    const top = Math.max(0, Math.min(scroll.top, rowsTotal - 1));
    const bottom = Math.max(0, Math.min(scroll.bottom, rowsTotal - 1));
    if (bottom < top || scroll.delta === 0) return;
    const height = bottom - top + 1;
    const count = Math.min(Math.abs(scroll.delta), height);
    const shifted = new Set<number>();
    for (const row of pendingRepaintRows) {
      if (row < top || row > bottom) {
        shifted.add(row);
      } else if (scroll.delta > 0) {
        const next = row - count;
        if (next >= top) shifted.add(next);
      } else {
        const next = row + count;
        if (next <= bottom) shifted.add(next);
      }
    }
    pendingRepaintRows.clear();
    for (const row of shifted) {
      pendingRepaintRows.add(row);
    }
  };

  /**
   * Snap the viewport back to the live screen. Called whenever user
   * input would target the live grid (typing, paste, Ctrl+C signal),
   * matching xterm's sticky-bottom behavior.
   */
  const snapToBottom = () => {
    if (viewportOffset() === 0) return;
    setViewportOffset(0);
    needsFullRepaint = true;
    scheduleFrame();
  };

  /**
   * Fetch a window of scrollback rows starting at absolute index
   * `start`. Skipped when an overlapping window is already in flight
   * (the next paint will pick up cached rows when they land).
   */
  const fetchScrollbackWindow = async (start: number, count: number) => {
    const id = threadStore.activeThreadId;
    if (!id || count <= 0) return;
    if (scrollbackInFlight.has(start)) return;
    scrollbackInFlight.add(start);
    try {
      const win = await invoke<ScrollbackWindow>("terminal_grid_scrollback", {
        bufferId: id,
        start,
        count,
      });
      if (id !== threadStore.activeThreadId) return;
      // Trust the window's own start - the live emitter may have
      // grown scrollback between request and reply, but absolute
      // indices remain stable until the cap evicts.
      for (let i = 0; i < win.rows.length; i++) {
        scrollbackCache.set(win.start + i, win.rows[i]);
      }
      if (win.scrollbackLen !== scrollbackLen()) {
        setScrollbackLen(win.scrollbackLen);
      }
      if (viewportOffset() > 0) {
        needsFullRepaint = true;
        scheduleFrame();
      }
    } catch {
      // Buffer killed mid-flight; nothing useful to do.
    } finally {
      scrollbackInFlight.delete(start);
    }
  };

  /**
   * Ensure the cache covers every scrollback row visible in the
   * current viewport. Issues at most one fetch per call (covering the
   * contiguous missing window) - the IPC overhead per round-trip is
   * higher than fetching slightly more rows than strictly needed.
   */
  const ensureScrollbackForViewport = () => {
    const offset = viewportOffset();
    if (offset === 0) return;
    const len = scrollbackLen();
    const g = grid();
    if (!g || len === 0) return;
    const visibleRows = Math.min(offset, g.rows);
    const firstAbsolute = Math.max(0, len - offset);
    let missingStart = -1;
    let missingEnd = -1;
    for (let i = 0; i < visibleRows; i++) {
      const abs = firstAbsolute + i;
      if (abs >= len) break;
      if (!scrollbackCache.has(abs) && !scrollbackInFlight.has(abs)) {
        if (missingStart === -1) missingStart = abs;
        missingEnd = abs;
      }
    }
    if (missingStart !== -1) {
      void fetchScrollbackWindow(missingStart, missingEnd - missingStart + 1);
    }
  };

  const onSurfaceWheel = (e: WheelEvent) => {
    const len = scrollbackLen();
    const offset = viewportOffset();
    // No history and already at live: nothing to consume; let the page
    // scroll if any ancestor cares. We don't preventDefault unless we
    // actually changed the viewport.
    if (len === 0 && offset === 0) return;
    // Browsers report deltaY in pixels for line/page wheel modes when
    // the event target is a non-scrollable element; the values are
    // already normalized. Negative = wheel-up = scroll back into history.
    wheelAccumulator += e.deltaY;
    const rowsDelta = Math.trunc(wheelAccumulator / WHEEL_PIXELS_PER_ROW);
    if (rowsDelta === 0) return;
    wheelAccumulator -= rowsDelta * WHEEL_PIXELS_PER_ROW;
    // Up (negative deltaY) increases offset toward len; down decreases
    // toward 0. clamp.
    const next = Math.max(0, Math.min(len, offset - rowsDelta));
    if (next !== offset) {
      e.preventDefault();
      setViewportOffset(next);
      needsFullRepaint = true;
      ensureScrollbackForViewport();
      scheduleFrame();
    }
  };

  /**
   * Schedule a single rAF that drains queued diffs and paints. Multiple
   * scheduleFrame calls within one animation frame collapse to one
   * paint - this is the load-bearing piece of the coalescing fix.
   */
  const scheduleFrame = () => {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      runFrame();
    });
  };

  const runFrame = () => {
    if (pendingDiffs.length > 0) {
      const queued = pendingDiffs;
      pendingDiffs = [];
      let resync = false;
      for (const diff of queued) {
        const result = applyDiffInternal(diff);
        if (result === "resync") {
          resync = true;
          break;
        }
      }
      if (resync) {
        pendingDiffs = [];
        pendingRepaintRows.clear();
        pendingCanvasScrolls = [];
        needsFullRepaint = true;
        void fetchGridSnapshot();
        return;
      }
    }
    paintCanvas();
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

  /**
   * Translate a mouse event's clientX/clientY into grid (row, col)
   * coordinates. Returns null if cell metrics aren't known yet (font
   * not measured) or the surface element is gone. Both row and col
   * are clamped to grid bounds so a drag past the canvas edges
   * extends to the row/col edge instead of going negative.
   */
  const canvasMouseToCell = (e: MouseEvent): CellPos | null => {
    if (!surfaceRef) return null;
    const w = cellW();
    const h = cellH();
    if (w === 0 || h === 0) return null;
    const g = grid();
    const rect = surfaceRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const maxRow = g ? g.rows - 1 : Number.MAX_SAFE_INTEGER;
    const maxCol = g ? g.cols - 1 : Number.MAX_SAFE_INTEGER;
    return {
      row: Math.max(0, Math.min(maxRow, Math.floor(y / h))),
      col: Math.max(0, Math.min(maxCol, Math.floor(x / w))),
    };
  };

  const onWindowMouseMove = (e: MouseEvent) => {
    if (!dragAnchor) return;
    const cell = canvasMouseToCell(e);
    if (!cell) return;
    if (cell.row !== dragAnchor.row || cell.col !== dragAnchor.col) {
      dragMoved = true;
    }
    setSelection({ anchor: dragAnchor, head: cell });
  };

  const onWindowMouseUp = () => {
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("mouseup", onWindowMouseUp);
    if (!dragMoved) {
      // Plain click without drag - clear any prior selection so the
      // user can dismiss a selection by clicking on the canvas.
      setSelection(null);
    }
    dragAnchor = null;
    dragMoved = false;
  };

  const onSurfaceMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return; // left button only; right opens context menu
    // preventScroll: the surface can be a sub-pixel taller than its flex
    // container; without this, the first focus call after open scrolls
    // the canvas up and clips the top rows out of view.
    surfaceRef?.focus({ preventScroll: true });
    const cell = canvasMouseToCell(e);
    if (!cell) return;
    dragAnchor = cell;
    dragMoved = false;
    setSelection({ anchor: cell, head: cell });
    // Listen on window so a drag that leaves the canvas still tracks.
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
  };

  const clearCanvas = () => {
    if (!canvasRef) return;
    canvasPixelWidth = 0;
    canvasPixelHeight = 0;
    canvasCssWidth = 0;
    canvasCssHeight = 0;
    canvasRef.width = 0;
    canvasRef.height = 0;
    canvasRef.style.width = "0px";
    canvasRef.style.height = "0px";
  };

  // Paint logic. Called from the rAF in runFrame() and from the
  // signal-watching effect below for selection/metric changes. Repaints
  // ALL rows when needsFullRepaint is set (snapshot reset, resize,
  // selection change, cell-metric change); otherwise only the rows in
  // pendingRepaintRows. The partial path is the primary win for
  // sustained torrents - it bounds frame work to O(changed_rows × cols)
  // instead of O(rows × cols).
  const paintCanvas = () => {
    const g = grid();
    const w = cellW();
    const h = cellH();
    if (!g) {
      clearCanvas();
      pendingRepaintRows.clear();
      pendingCanvasScrolls = [];
      needsFullRepaint = true;
      return;
    }
    if (!canvasRef || w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = g.cols * w;
    const pxH = g.rows * h;
    const nextPixelWidth = Math.round(pxW * dpr);
    const nextPixelHeight = Math.round(pxH * dpr);
    // Resizing the canvas backing store clears its contents, so it
    // implicitly forces a full repaint of every row.
    if (
      canvasPixelWidth !== nextPixelWidth ||
      canvasPixelHeight !== nextPixelHeight
    ) {
      canvasRef.width = nextPixelWidth;
      canvasRef.height = nextPixelHeight;
      canvasPixelWidth = nextPixelWidth;
      canvasPixelHeight = nextPixelHeight;
      needsFullRepaint = true;
    }
    if (canvasCssWidth !== pxW) {
      canvasRef.style.width = `${pxW}px`;
      canvasCssWidth = pxW;
    }
    if (canvasCssHeight !== pxH) {
      canvasRef.style.height = `${pxH}px`;
      canvasCssHeight = pxH;
    }
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scrollback view: when offset > 0 the top `offset` visible rows
    // come from history and the bottom rows come from the live grid.
    // Defer to full repaint and skip the blit/partial paths - they
    // assume a 1:1 visible<->live mapping.
    const offset = viewportOffset();
    const inScrollback = offset > 0;
    if (inScrollback) {
      pendingCanvasScrolls = [];
      pendingRepaintRows.clear();
      needsFullRepaint = true;
    }
    const cellAt = (visibleRow: number, col: number): GridCell | undefined => {
      if (!inScrollback) return g.cells[visibleRow * g.cols + col];
      if (visibleRow < offset) {
        const absolute = scrollbackLen() - offset + visibleRow;
        if (absolute < 0) return undefined;
        return scrollbackCache.get(absolute)?.[col];
      }
      const liveRow = visibleRow - offset;
      if (liveRow >= g.rows) return undefined;
      return g.cells[liveRow * g.cols + col];
    };

    // Decide which rows to paint this frame. A full repaint clears the
    // entire backing store first; a partial repaint clears only the
    // strip for each dirty row before painting it.
    const sel = selection();
    let rowsToPaint: Iterable<number>;
    if (needsFullRepaint) {
      pendingCanvasScrolls = [];
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, pxW, pxH);
      rowsToPaint = Array.from({ length: g.rows }, (_, row) => row);
    } else {
      for (const scroll of pendingCanvasScrolls) {
        const top = Math.max(0, Math.min(scroll.top, g.rows - 1));
        const bottom = Math.max(0, Math.min(scroll.bottom, g.rows - 1));
        if (bottom < top || scroll.delta === 0) continue;
        const height = bottom - top + 1;
        const count = Math.min(Math.abs(scroll.delta), height);
        const rowsToCopy = height - count;
        const sourceRow = scroll.delta > 0 ? top + count : top;
        const destRow = scroll.delta > 0 ? top : top + count;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (rowsToCopy > 0) {
          ctx.drawImage(
            canvasRef,
            0,
            Math.round(sourceRow * h * dpr),
            canvasPixelWidth,
            Math.round(rowsToCopy * h * dpr),
            0,
            Math.round(destRow * h * dpr),
            canvasPixelWidth,
            Math.round(rowsToCopy * h * dpr),
          );
        }
        if (scroll.delta > 0) {
          for (let r = bottom - count + 1; r <= bottom; r++) {
            pendingRepaintRows.add(r);
          }
        } else {
          for (let r = top; r < top + count; r++) {
            pendingRepaintRows.add(r);
          }
        }
        // Clear any uncovered source strip immediately. The row repaint below
        // paints inserted rows, but this keeps the backing store correct even
        // if the backend emits a scroll without explicit row payloads.
        ctx.fillStyle = COLOR_BG;
        ctx.fillRect(
          0,
          Math.round((scroll.delta > 0 ? bottom - count + 1 : top) * h * dpr),
          canvasPixelWidth,
          Math.round(count * h * dpr),
        );
        ctx.restore();
      }
      pendingCanvasScrolls = [];
      // The selection overlay has to repaint along with any row in its
      // range, otherwise scrolled-in rows under a live selection lose
      // the highlight. Cheap: a Set merge.
      if (sel) {
        const [s, e] = normalizeSelection(sel);
        for (let r = s.row; r <= e.row && r < g.rows; r++) {
          pendingRepaintRows.add(r);
        }
      }
      rowsToPaint = pendingRepaintRows;
    }

    // Pass 1: backgrounds. For non-reverse cells, skip default-bg so we
    // don't repaint over the cleared canvas. For reverse cells, the
    // background is the cell's foreground (or COLOR_FG when fg is also
    // default) - ALWAYS paint it, even when fg is default, otherwise
    // `\x1b[7mtext` would render with the canvas's normal background
    // and the swap would be invisible. Partial repaints clear the row
    // strip first since we no longer have a clean canvas under it.
    for (const r of rowsToPaint) {
      if (r >= g.rows) continue;
      const y = r * h;
      if (!needsFullRepaint) {
        ctx.fillStyle = COLOR_BG;
        ctx.fillRect(0, y, pxW, h);
      }
      for (let c = 0; c < g.cols; c++) {
        const cell = cellAt(r, c);
        if (!cell) continue;
        const reverse = ((cell.attrs ?? 0) & ATTR_REVERSE) !== 0;
        if (reverse) {
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
    for (const r of rowsToPaint) {
      if (r >= g.rows) continue;
      const y = r * h;
      for (let c = 0; c < g.cols; c++) {
        const cell = cellAt(r, c);
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
        const defaultFill = reverse ? COLOR_BG : COLOR_FG;
        const fill = resolveColor(fgPacked, defaultFill);
        if ((attrs & ATTR_DIM) !== 0) {
          ctx.globalAlpha = 0.6;
        }
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

    // Selection overlay over repainted rows. Drawn AFTER glyphs so the
    // highlight blends with text but BEFORE the cursor block.
    if (sel) {
      const [start, end] = normalizeSelection(sel);
      ctx.fillStyle = SELECTION_OVERLAY_FILL;
      for (const r of rowsToPaint) {
        if (r < start.row || r > end.row || r >= g.rows) continue;
        const startCol = r === start.row ? start.col : 0;
        const endCol = r === end.row ? end.col : g.cols - 1;
        const x = startCol * w;
        const y = r * h;
        const width = (Math.min(endCol, g.cols - 1) - startCol + 1) * w;
        if (width > 0) {
          ctx.fillRect(x, y, width, h);
        }
      }
    }

    // Cursor: inverted block at (cursorRow, cursorCol). The cursor row
    // is always in pendingRepaintRows after applyDiffInternal so it
    // gets cleared and repainted along with everything else. In
    // scrollback view the cursor is hidden - it tracks the LIVE
    // bottom and would be misleading if drawn over historical text.
    const cursorVisible = (g.cursorVisible ?? true) && !inScrollback;
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

    pendingRepaintRows.clear();
    needsFullRepaint = false;
  };

  // Trigger a full repaint when something orthogonal to the diff stream
  // changes: snapshot reset (grid signal swapped), selection change,
  // cell-metric change. The effect doesn't paint inline - it just
  // schedules a frame, so multiple signal changes in one tick collapse
  // to one paint.
  createEffect(() => {
    void grid();
    void selection();
    void cellW();
    void cellH();
    needsFullRepaint = true;
    scheduleFrame();
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
        // buffer can't apply to the new one. Also drop any queued
        // diffs - they belong to the old buffer. Scrollback cache is
        // per-buffer too; flush it so the new buffer doesn't render
        // history rows from the previous one.
        pendingDiffs = [];
        pendingRepaintRows.clear();
        pendingCanvasScrolls = [];
        needsFullRepaint = true;
        scrollbackCache.clear();
        scrollbackInFlight.clear();
        setScrollbackLen(0);
        setViewportOffset(0);
        wheelAccumulator = 0;
        setGrid(null);
        setGridSeq(0);
        setSelection(null);
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

    // Cmd+C (macOS) or Ctrl+Shift+C (Linux/Windows) is a copy chord.
    // Always swallow it so it never falls through to the SIGINT or
    // Ctrl-letter chord branches below - critical for Ctrl+Shift+C
    // without a selection, which would otherwise match the
    // Ctrl-letter chord at the bottom and erroneously send 0x03 to
    // the PTY. With no selection there's nothing to write; we simply
    // preventDefault and return.
    const isCopyChord =
      (k === "c" || k === "C") &&
      (event.metaKey || (event.ctrlKey && event.shiftKey));
    if (isCopyChord) {
      event.preventDefault();
      const sel = selection();
      const g = grid();
      if (sel && g) {
        await writeClipboard(selectionText(g, sel));
      }
      return;
    }

    // Ctrl+C (no shift) goes through the signal path so raw-mode TUIs
    // receive SIGINT rather than just a 0x03 byte the line discipline
    // ignores.
    if (event.ctrlKey && !event.shiftKey && (k === "c" || k === "C")) {
      event.preventDefault();
      snapToBottom();
      await terminalStore.signal(id, "interrupt");
      return;
    }

    // Other Ctrl-letter chords map to control bytes 0x01-0x1A.
    if (event.ctrlKey && k.length === 1 && /[a-zA-Z]/.test(k)) {
      event.preventDefault();
      snapToBottom();
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
      snapToBottom();
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
    snapToBottom();
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
    snapToBottom();
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
    // foreground canvas doesn't render them). The handler is hot under
    // torrent loads; do NOTHING expensive here - just enqueue and let
    // rAF drain on the next frame. This is the load-bearing piece of
    // the coalescing fix: without it, every IPC event triggered a full
    // canvas repaint synchronously, the JS thread fell behind the emit
    // rate, the webview event queue grew without bound, and throughput
    // collapsed.
    unlistenDiff = await listen<GridDiffEvent>(
      "terminal://grid-diff",
      (event) => {
        const diff = event.payload;
        if (diff.bufferId !== threadStore.activeThreadId) return;
        // Overflow guard: if rAF is starved (background tab, devtools
        // paused, etc) drop everything and fall back to snapshot resync
        // when the tab becomes active again.
        if (pendingDiffs.length >= MAX_PENDING_DIFFS) {
          pendingDiffs = [];
          pendingRepaintRows.clear();
          pendingCanvasScrolls = [];
          needsFullRepaint = true;
          void fetchGridSnapshot();
          return;
        }
        pendingDiffs.push(diff);
        scheduleFrame();
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
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    pendingDiffs = [];
    pendingRepaintRows.clear();
    pendingCanvasScrolls = [];
    // If the user unmounts mid-drag, the window-level mouse listeners
    // would otherwise leak. Removing them is a no-op when not bound.
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("mouseup", onWindowMouseUp);
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
              onMouseDown={onSurfaceMouseDown}
              onWheel={onSurfaceWheel}
            >
              <canvas ref={canvasRef} class="block" />
            </div>
          </>
        )}
      </Show>
    </div>
  );
};
