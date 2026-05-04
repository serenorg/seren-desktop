// ABOUTME: In-memory terminal buffer runtime backed by local pseudoterminals.
// ABOUTME: Owns PTY state plus a rolling raw-output buffer and exposes snapshot/diff IPC.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use termwiz::cell::Intensity;
use termwiz::color::ColorSpec;
use termwiz::escape::{
    Action, ControlCode, Esc, EscCode,
    csi::{
        CSI, Cursor, DecPrivateMode, DecPrivateModeCode, Edit, EraseInDisplay,
        EraseInLine, Mode, Sgr, TerminalMode, TerminalModeCode,
    },
    parser::Parser,
};
use unicode_width::UnicodeWidthChar;
use uuid::Uuid;

const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
/// Coalesced grid-diff event channel. The reader thread feeds the grid
/// as bytes arrive; a separate emitter drains dirty rows at a bounded
/// cadence and the frontend applies the diff to its local grid signal
/// incrementally. Snapshots remain the authoritative ground truth (used
/// on initial mount + on seq mismatch).
const TERMINAL_GRID_DIFF_EVENT: &str = "terminal://grid-diff";
/// Minimum interval between grid-diff emits. The reader thread feeds
/// the grid as fast as the PTY produces bytes, but a separate emitter
/// thread drains + emits at most once per tick. A torrent of output
/// (`find ~/big-tree`, `yes`, large build logs) coalesces into a
/// bounded ~60 events/sec instead of saturating the IPC channel.
/// drain_diff naturally returns the union of all rows dirtied since
/// the last drain, so collapsing N feeds into one diff is lossless.
const GRID_DIFF_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Default)]
pub struct TerminalState {
    buffers: Mutex<HashMap<String, TerminalProcess>>,
}

struct TerminalProcess {
    info: TerminalBufferInfo,
    master: Box<dyn MasterPty + Send>,
    // Arc<Mutex<>> so callers can clone-and-release the global buffers lock
    // before doing the actual write/flush, which can block on a full PTY
    // kernel buffer; otherwise a stalled paste blocks every other terminal
    // command (snapshot, resize, signal, list, kill) across all buffers.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send>>>,
    /// Parsed terminal grid consumed by the canvas renderer.
    grid: Arc<Mutex<TerminalGrid>>,
}

/// Emulator grid. Owns a termwiz `Parser` that turns raw PTY bytes
/// into structured `Action`s, and an apply loop that mutates a 2D
/// cell grid. The action interpreter is intentionally selective (see
/// `apply_action`); deliberately-ignored actions are silently
/// swallowed, while actions we'd want to handle but don't yet bump
/// the `unhandled_actions` counter for diagnostics. The parser is a
/// pure function of byte history, so dropping an action only loses
/// that one mutation - the next action applies cleanly against the
/// current state.
struct TerminalGrid {
    parser: Parser,
    rows: u16,
    cols: u16,
    /// Active screen cells. Either the main screen or the alternate
    /// screen depending on whether `alt_state` is set.
    cells: Vec<Vec<GridCell>>,
    /// Scroll operations since the last diff drain. These let the
    /// frontend shift clean rows locally and receive only rows whose
    /// cell content actually changed.
    pending_scrolls: Vec<GridScroll>,
    cursor_row: u16,
    cursor_col: u16,
    seq: u32,
    /// Counts actions we received but did not interpret. Carried in
    /// the snapshot for diagnostics; not surfaced to the user.
    unhandled_actions: u32,
    /// Current SGR (Select Graphic Rendition) state. Each subsequent
    /// `write_char` stamps these onto the new cell. Reset by Sgr::Reset
    /// (CSI 0 m) or implicitly by `RIS` if we ever handle it.
    current_fg: u32,
    current_bg: u32,
    current_attrs: u8,
    // --- Mode state -------------------------------------------------
    /// DECSET 25 - false hides the cursor (renderer must not paint it).
    cursor_visible: bool,
    /// DECSET 1 (DECCKM) - when true, arrow keys are expected in the
    /// application form (`ESC O X`) rather than ANSI form (`ESC [ X`).
    /// Tracked here, surfaced in the snapshot, consumed by the frontend
    /// key encoder.
    cursor_keys_app: bool,
    /// DECSET 2004 - frontend paste handler must wrap pasted text in
    /// `\x1b[200~ ... \x1b[201~` when this is true.
    bracketed_paste: bool,
    /// DECSTBM scroll region [top, bottom] inclusive, 0-indexed. Defaults
    /// to (0, rows-1). LF at `cursor_row == scroll_bottom` scrolls the
    /// region; LF outside the region just advances the cursor.
    scroll_top: u16,
    scroll_bottom: u16,
    /// DECSC / DECRC saved cursor (and pen). None means a future DECRC
    /// is a no-op (or homes the cursor depending on emulator policy; we
    /// pick no-op).
    saved_cursor: Option<SavedCursor>,
    /// State for DECSET 1049 alt-screen restore. None means main screen
    /// is active. Some(...) means the alt screen is active and the saved
    /// main state will be restored on DECRST 1049.
    alt_state: Option<AltState>,
    /// Bytes the emulator owes back to the PTY in response to terminal
    /// queries (DA1 `\x1b[c`, DA2/DA3, DSR `\x1b[5n` / `\x1b[6n`,
    /// XTVERSION `\x1b[>q`). Drained by the reader thread after each
    /// `feed` and written via the per-process PTY writer Arc. Without
    /// this, fish (and any shell probing terminal capabilities on
    /// startup) waits 10s for a DA1 reply and prints a warning about
    /// the terminal being incompatible.
    pending_responses: Vec<u8>,
    /// G0 / G1 character set designations and the currently shifted-in
    /// set. We honor DEC special-graphics line drawing so older TUIs
    /// that emit `\x1b(0qqq` for box characters render the real glyphs
    /// (U+250C / U+2500 / U+2510 corners and lines) instead of literal
    /// letters.
    g0_charset: CharSet,
    g1_charset: CharSet,
    /// false = G0 active (default), true = G1 active. Toggled by
    /// SI (0x0F) and SO (0x0E).
    active_g1: bool,
    /// ANSI mode 4 (IRM, Insert/Replace). When true, write_char shifts
    /// existing cells right at the cursor before stamping so the new
    /// glyph inserts rather than overwrites. Defaults to false (replace
    /// mode) which matches xterm's default and what readline-based
    /// shells expect.
    insert_mode: bool,
    /// Per-row dirty bitmap. `dirty_rows[r] == true` means row `r`'s
    /// cells (or cursor presence) changed since the last `drain_diff`
    /// call. The diff event ships only marked rows; cursor + mode
    /// state are always included on every diff regardless of dirty
    /// rows so the renderer never goes stale on a cursor move without
    /// cell content changes.
    dirty_rows: Vec<bool>,
    /// Grid seq included by the previous diff drain. A coalesced diff may
    /// cover many feed seqs; the frontend accepts it when its local seq is
    /// at or after this base.
    last_diff_seq: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharSet {
    Ascii,
    DecLineDrawing,
}

#[derive(Debug, Clone)]
struct SavedCursor {
    row: u16,
    col: u16,
    fg: u32,
    bg: u32,
    attrs: u8,
}

#[derive(Debug, Clone)]
struct AltState {
    saved_cells: Vec<Vec<GridCell>>,
    saved_cursor_row: u16,
    saved_cursor_col: u16,
    saved_fg: u32,
    saved_bg: u32,
    saved_attrs: u8,
    saved_scroll_top: u16,
    saved_scroll_bottom: u16,
    saved_cursor_visible: bool,
}

/// Sentinel value meaning "use the renderer's default fg/bg color." Since
/// truecolor RGB only occupies the low 24 bits, the high byte is free for
/// discriminator tags. 0xFFFFFFFF cannot collide with a legitimate
/// 24-bit RGB value (those have high byte 0).
pub const COLOR_DEFAULT: u32 = 0xFFFFFFFF;
/// High-byte tag for a palette-indexed color. Low byte holds the index
/// 0..255 (16 ANSI + 240-entry 256-color extended palette).
const COLOR_PALETTE_TAG: u32 = 0xFE000000;

/// Pack an 8-bit palette index into the cell's color u32.
const fn palette_color(idx: u8) -> u32 {
    COLOR_PALETTE_TAG | (idx as u32)
}

/// Pack a 24-bit RGB triple into the cell's color u32 (high byte = 0).
const fn rgb_color(r: u8, g: u8, b: u8) -> u32 {
    ((r as u32) << 16) | ((g as u32) << 8) | (b as u32)
}

// Cell attribute bitfield. Renderer reads these as a u8 mask. Order chosen
// to put the visually-impactful attrs in the low bits.
pub const ATTR_BOLD: u8 = 1 << 0;
pub const ATTR_ITALIC: u8 = 1 << 1;
pub const ATTR_UNDERLINE: u8 = 1 << 2;
pub const ATTR_REVERSE: u8 = 1 << 3;
pub const ATTR_DIM: u8 = 1 << 4;
pub const ATTR_STRIKE: u8 = 1 << 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    /// The codepoint in this cell. NUL means "empty / never written".
    /// Encoded as u32 (Unicode scalar value) for compact JSON.
    pub ch: u32,
    /// Display width in cells, per UAX#11. 1 for normal chars, 2 for wide
    /// (CJK, emoji), 0 for the right-half continuation slot of a wide-char
    /// pair to its left (renderer must skip drawing it independently).
    /// Empty cells default to width=1 so the renderer treats them as a
    /// single space slot rather than a continuation.
    pub width: u8,
    /// Foreground color packed per the COLOR_* discriminator scheme.
    /// Skipped on the wire when default so blank-screen snapshots stay
    /// compact (typical case is "all default").
    #[serde(skip_serializing_if = "GridCell::fg_is_default")]
    pub fg: u32,
    /// Background color, same packing as fg.
    #[serde(skip_serializing_if = "GridCell::bg_is_default")]
    pub bg: u32,
    /// SGR attribute bitfield (ATTR_* bits). Skipped when 0.
    #[serde(skip_serializing_if = "GridCell::attrs_is_default")]
    pub attrs: u8,
}

impl GridCell {
    fn fg_is_default(value: &u32) -> bool {
        *value == COLOR_DEFAULT
    }
    fn bg_is_default(value: &u32) -> bool {
        *value == COLOR_DEFAULT
    }
    fn attrs_is_default(value: &u8) -> bool {
        *value == 0
    }
}

impl Default for GridCell {
    fn default() -> Self {
        Self {
            ch: 0,
            width: 1,
            fg: COLOR_DEFAULT,
            bg: COLOR_DEFAULT,
            attrs: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSnapshot {
    pub rows: u16,
    pub cols: u16,
    /// Row-major cells. Length is exactly rows * cols.
    pub cells: Vec<GridCell>,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub unhandled_actions: u32,
    /// DECSET 25 state. Renderer hides the cursor block when false.
    /// Defaults to true; skipped on the wire when default to keep the
    /// snapshot compact.
    #[serde(skip_serializing_if = "GridSnapshot::cursor_visible_is_default")]
    pub cursor_visible: bool,
    /// DECSET 1 (DECCKM). Frontend key encoder picks `ESC O X` arrows
    /// when true, `ESC [ X` when false.
    #[serde(skip_serializing_if = "GridSnapshot::cursor_keys_app_is_default")]
    pub cursor_keys_app: bool,
    /// DECSET 2004. Frontend paste handler wraps the clipboard content
    /// in `\x1b[200~ ... \x1b[201~` when true.
    #[serde(skip_serializing_if = "GridSnapshot::bracketed_paste_is_default")]
    pub bracketed_paste: bool,
}

impl GridSnapshot {
    fn cursor_visible_is_default(value: &bool) -> bool {
        *value
    }
    fn cursor_keys_app_is_default(value: &bool) -> bool {
        !*value
    }
    fn bracketed_paste_is_default(value: &bool) -> bool {
        !*value
    }
}

/// Incremental grid update. Carries only the rows that changed since
/// the last `drain_diff` plus the current cursor + mode flags (always
/// included, since they're tiny and the renderer needs them every
/// tick to redraw the cursor and stay in sync with input-encoder
/// state). Wire shape:
///   { bufferId, baseSeq, seq, scrolls, rows: [{row, cells}], cursorRow,
///     cursorCol, cursorVisible, cursorKeysApp, bracketedPaste }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridDiff {
    /// Grid seq included by the previous diff drain. A coalesced diff covers
    /// `(base_seq, seq]`; consumers with local seq >= base_seq can apply it.
    pub base_seq: u32,
    /// Same monotonic counter as `GridSnapshot.seq` (TerminalGrid.seq).
    /// Frontend tracks the last-applied seq; if it is older than base_seq,
    /// it re-fetches a full snapshot to resync.
    pub seq: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scrolls: Vec<GridScroll>,
    pub rows: Vec<DiffRow>,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub cursor_keys_app: bool,
    pub bracketed_paste: bool,
    /// Total grid dimensions. Included on every diff so a resize-only
    /// change (which marks every row dirty but doesn't change cell
    /// content) carries the new size to the renderer.
    pub rows_total: u16,
    pub cols_total: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRow {
    pub row: u16,
    pub cells: Vec<GridCell>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridScroll {
    pub top: u16,
    pub bottom: u16,
    /// Positive values scroll the region up; negative values scroll down.
    pub delta: i16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GridDiffEvent {
    buffer_id: String,
    #[serde(flatten)]
    diff: GridDiff,
}

fn diff_has_changes(diff: &GridDiff) -> bool {
    diff.seq != diff.base_seq || !diff.rows.is_empty()
}

struct ClearAliveOnDrop(Arc<AtomicBool>);

impl Drop for ClearAliveOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl TerminalGrid {
    fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1);
        let cols = cols.max(1);
        let cells = vec![vec![GridCell::default(); cols as usize]; rows as usize];
        Self {
            parser: Parser::new(),
            rows,
            cols,
            cells,
            pending_scrolls: Vec::new(),
            cursor_row: 0,
            cursor_col: 0,
            seq: 0,
            unhandled_actions: 0,
            current_fg: COLOR_DEFAULT,
            current_bg: COLOR_DEFAULT,
            current_attrs: 0,
            cursor_visible: true,
            cursor_keys_app: false,
            bracketed_paste: false,
            scroll_top: 0,
            scroll_bottom: rows.saturating_sub(1),
            saved_cursor: None,
            alt_state: None,
            pending_responses: Vec::new(),
            g0_charset: CharSet::Ascii,
            g1_charset: CharSet::Ascii,
            active_g1: false,
            insert_mode: false,
            // Mark every row dirty initially so the first diff (or
            // snapshot, if the consumer asked for that) carries the
            // whole grid.
            dirty_rows: vec![true; rows as usize],
            last_diff_seq: 0,
        }
    }

    /// Take the bytes owed back to the PTY in response to terminal
    /// queries processed during the most recent `feed`. The reader
    /// thread calls this and writes the result through the writer Arc.
    fn drain_responses(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending_responses)
    }

    /// Parse `bytes` and apply each emitted Action against the grid. Each
    /// chunk increments seq once regardless of how many actions it produced,
    /// giving snapshots and diffs a common monotonic version.
    fn feed(&mut self, bytes: &[u8]) {
        let mut actions: Vec<Action> = Vec::new();
        self.parser
            .parse(bytes, |action| actions.push(action));
        for action in actions {
            self.apply_action(action);
        }
        self.seq = self.seq.wrapping_add(1);
    }

    fn snapshot(&self) -> GridSnapshot {
        let mut flat = Vec::with_capacity(self.rows as usize * self.cols as usize);
        for row in &self.cells {
            flat.extend_from_slice(row);
        }
        GridSnapshot {
            rows: self.rows,
            cols: self.cols,
            cells: flat,
            cursor_row: self.cursor_row,
            cursor_col: self.cursor_col,
            unhandled_actions: self.unhandled_actions,
            cursor_visible: self.cursor_visible,
            cursor_keys_app: self.cursor_keys_app,
            bracketed_paste: self.bracketed_paste,
        }
    }

    /// Drain the dirty-row bitmap into a `GridDiff`. Returns the diff
    /// even when no rows are dirty (the cursor or modes may still have
    /// changed) so the renderer always sees fresh cursor/mode state.
    /// Clears the bitmap as a side effect and advances `last_diff_seq`.
    /// A single diff may cover many feed seqs when the emitter coalesces
    /// high-throughput output.
    fn drain_diff(&mut self) -> GridDiff {
        let base_seq = self.last_diff_seq;
        let scrolls = std::mem::take(&mut self.pending_scrolls);
        // Count first so the rows vec gets one allocation. Under torrent
        // load (find ~) most rows are dirty and the previous push-loop
        // realloced log2(n) times per drain.
        let dirty_count = self.dirty_rows.iter().filter(|d| **d).count();
        let mut rows = Vec::with_capacity(dirty_count);
        // Disjoint borrow: hold an immutable reference to `cells` and a
        // mutable reference to `dirty_rows` so the loop both reads cells
        // and clears dirty bits in a single pass without re-walking.
        let cells = &self.cells;
        let dirty_rows = &mut self.dirty_rows;
        for (r, dirty) in dirty_rows.iter_mut().enumerate() {
            if *dirty {
                rows.push(DiffRow {
                    row: r as u16,
                    cells: cells[r].clone(),
                });
                *dirty = false;
            }
        }
        self.last_diff_seq = self.seq;
        GridDiff {
            base_seq,
            seq: self.seq,
            scrolls,
            rows,
            cursor_row: self.cursor_row,
            cursor_col: self.cursor_col,
            cursor_visible: self.cursor_visible,
            cursor_keys_app: self.cursor_keys_app,
            bracketed_paste: self.bracketed_paste,
            rows_total: self.rows,
            cols_total: self.cols,
        }
    }

    /// Resize the grid, preserving overlapping cells. New cells are
    /// blank, dropped cells are gone. Cursor clamps to the new bounds.
    /// Bumps `seq` because rows/cols/cells/cursor have all visibly
    /// changed - the snapshot/diff dedupe must observe a resize-only
    /// state change as a new revision rather than a no-op tied to the
    /// last byte chunk's seq.
    fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(1);
        let cols = cols.max(1);
        if rows == self.rows && cols == self.cols {
            return;
        }
        let new_cells = resize_cells(&self.cells, rows, cols);
        // If we're in alt mode, the saved main screen also needs to track
        // the new dimensions so a DECRST 1049 restores into a grid that
        // matches the current PTY WINSIZE rather than the original size.
        if let Some(alt) = self.alt_state.as_mut() {
            alt.saved_cells = resize_cells(&alt.saved_cells, rows, cols);
            alt.saved_cursor_row = alt.saved_cursor_row.min(rows.saturating_sub(1));
            alt.saved_cursor_col = alt.saved_cursor_col.min(cols.saturating_sub(1));
            alt.saved_scroll_top = alt.saved_scroll_top.min(rows.saturating_sub(1));
            alt.saved_scroll_bottom = rows.saturating_sub(1);
        }
        self.cells = new_cells;
        self.rows = rows;
        self.cols = cols;
        self.cursor_row = self.cursor_row.min(rows.saturating_sub(1));
        self.cursor_col = self.cursor_col.min(cols.saturating_sub(1));
        // DECSTBM resets to the full screen on resize - keeping a stale
        // narrower scroll region after a resize would confine apps to a
        // strip of the new screen.
        self.scroll_top = 0;
        self.scroll_bottom = rows.saturating_sub(1);
        if let Some(saved) = self.saved_cursor.as_mut() {
            saved.row = saved.row.min(rows.saturating_sub(1));
            saved.col = saved.col.min(cols.saturating_sub(1));
        }
        // Resize visually changes the whole grid; mark every row dirty
        // so the next diff (or snapshot fallback) carries the full new
        // dimensions to the renderer.
        self.pending_scrolls.clear();
        self.dirty_rows = vec![true; rows as usize];
        self.seq = self.seq.wrapping_add(1);
    }

    /// Mark a single row as dirty so the next diff includes its cells.
    /// Defensive bounds: silently skips if the row is out of range
    /// rather than panicking.
    fn mark_dirty(&mut self, row: u16) {
        let r = row as usize;
        if r < self.dirty_rows.len() {
            self.dirty_rows[r] = true;
        }
    }

    /// Mark every row dirty. Used by alt-screen toggle, full-screen
    /// erase, and anything that touches all rows at once.
    fn mark_all_dirty(&mut self) {
        self.pending_scrolls.clear();
        for d in self.dirty_rows.iter_mut() {
            *d = true;
        }
    }

    fn push_scroll(&mut self, top: u16, bottom: u16, delta: i16) {
        if delta == 0 {
            return;
        }
        if let Some(last) = self.pending_scrolls.last_mut() {
            if last.top == top
                && last.bottom == bottom
                && last.delta.signum() == delta.signum()
            {
                last.delta = last.delta.saturating_add(delta);
                return;
            }
        }
        self.pending_scrolls.push(GridScroll { top, bottom, delta });
    }

    fn apply_action(&mut self, action: Action) {
        match action {
            Action::Print(c) => self.write_char(c),
            Action::PrintString(s) => {
                for c in s.chars() {
                    self.write_char(c);
                }
            }
            Action::Control(code) => self.apply_control(code),
            Action::CSI(csi) => self.apply_csi(csi),
            Action::Esc(esc) => self.apply_esc(esc),
            Action::OperatingSystemCommand(osc) => self.apply_osc(*osc),
            // DeviceControl, Sixel/KittyImage, XtGetTcap deferred to later
            // stages. Counted in diagnostics if a TUI actually depends on
            // them.
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn apply_esc(&mut self, esc: Esc) {
        match esc {
            Esc::Code(EscCode::DecSaveCursorPosition) => self.save_cursor(),
            Esc::Code(EscCode::DecRestoreCursorPosition) => self.restore_cursor(),
            // Application / normal keypad mode (ESC = / ESC >). Every
            // shell sends one or the other on startup; silently
            // acknowledge so diagnostics stay focused. Numeric-keypad-
            // aware sequences are not yet wired through the encoder.
            Esc::Code(EscCode::DecApplicationKeyPad) => {}
            Esc::Code(EscCode::DecNormalKeyPad) => {}
            // Character set designation. We track G0 and G1 so DEC
            // special-graphics line drawing renders as
            // real box characters when the active set is shifted to
            // it. UK character set is treated as ASCII for our purposes
            // (the only difference is the # vs pound sign mapping
            // which the dec_special_graphics table doesn't touch).
            Esc::Code(EscCode::AsciiCharacterSetG0) => {
                self.g0_charset = CharSet::Ascii;
            }
            Esc::Code(EscCode::AsciiCharacterSetG1) => {
                self.g1_charset = CharSet::Ascii;
            }
            Esc::Code(EscCode::DecLineDrawingG0) => {
                self.g0_charset = CharSet::DecLineDrawing;
            }
            Esc::Code(EscCode::DecLineDrawingG1) => {
                self.g1_charset = CharSet::DecLineDrawing;
            }
            Esc::Code(EscCode::UkCharacterSetG0)
            | Esc::Code(EscCode::UkCharacterSetG1) => {
                // Treated as ASCII; the # -> pound difference is not
                // significant for our terminal use.
            }
            // RIS (`\x1b c`) is the Reset to Initial State sequence.
            // `clear` and some recovery scripts emit it. We don't
            // implement a full RIS today (would need to reset every
            // mode + saved cursor + scroll region + alt screen + pen
            // + grid contents), but silently acknowledge so diagnostics
            // don't count routine recovery noise.
            Esc::Code(EscCode::FullReset) => {}
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    /// Acknowledge OS Command sequences. The common-and-known variants
    /// (titles, cwd, color theme set/reset, hyperlinks, notifications,
    /// semantic prompts, vendor-proprietary) silently swallow without
    /// bumping `unhandled_actions` - every shell sends a handful of
    /// these on startup. Only `Unspecified` (an OSC termwiz couldn't
    /// classify) bumps the counter, since that is what "the emulator
    /// didn't recognize this" actually means.
    ///
    /// Future stages will lift title and cwd into TerminalGrid state so
    /// the frontend can surface them in the buffer's tab; for now the
    /// values are dropped on the floor.
    fn apply_osc(&mut self, osc: termwiz::escape::OperatingSystemCommand) {
        use termwiz::escape::OperatingSystemCommand as Osc;
        match osc {
            Osc::SetIconNameAndWindowTitle(_)
            | Osc::SetWindowTitle(_)
            | Osc::SetWindowTitleSun(_)
            | Osc::SetIconName(_)
            | Osc::SetIconNameSun(_)
            | Osc::CurrentWorkingDirectory(_)
            | Osc::SetHyperlink(_)
            | Osc::ChangeColorNumber(_)
            | Osc::ChangeDynamicColors(_, _)
            | Osc::ResetDynamicColor(_)
            | Osc::ResetColors(_)
            | Osc::ClearSelection(_)
            | Osc::QuerySelection(_)
            | Osc::SetSelection(_, _)
            | Osc::SystemNotification(_)
            | Osc::ITermProprietary(_)
            | Osc::FinalTermSemanticPrompt(_)
            | Osc::RxvtExtension(_)
            | Osc::ConEmuProgress(_) => {
                // Known sequences we deliberately don't act on yet.
                // Don't bump unhandled.
            }
            Osc::Unspecified(_) => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn write_char(&mut self, c: char) {
        // Translate via the active character set. ASCII is identity;
        // DEC line drawing remaps printable bytes 0x60..=0x7e to box-
        // drawing / math glyphs so older TUIs that emit `\x1b)0\x0eqq`
        // for a horizontal line render real glyphs instead of literal
        // 'q' characters.
        let active = if self.active_g1 {
            self.g1_charset
        } else {
            self.g0_charset
        };
        let c = if active == CharSet::DecLineDrawing {
            dec_special_graphics(c)
        } else {
            c
        };
        let width = UnicodeWidthChar::width(c).unwrap_or(1) as u16;
        if width == 0 {
            // Combining marks / zero-width-joiner / variation
            // selectors. A proper emulator merges these onto the
            // previous cell as part of the same grapheme cluster; the
            // flat one-codepoint-per-cell DTO can't represent that
            // yet, so we drop them rather than corrupting the next
            // cell with an invisible mark. Counted so the gap is
            // visible in diagnostics.
            self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            return;
        }
        // Wrap if this glyph wouldn't fit on the current row. Width=2 chars
        // at the right edge wrap rather than getting clipped.
        if self.cursor_col + width > self.cols {
            self.line_feed();
            self.cursor_col = 0;
        }
        let row = self.cursor_row as usize;
        let col = self.cursor_col as usize;
        // ANSI mode 4 (IRM): shift cells right at the cursor before
        // stamping so the new glyph inserts rather than overwrites.
        // Cells past the right margin fall off. Done before the wide-
        // char sweep so the sweep operates on the post-shift state.
        if self.insert_mode {
            self.shift_cells_right(row, col, width);
        }
        // Defensive bounds: resize races could in theory leave the cursor
        // out of range until the next clamp; just no-op rather than panic.
        if row < self.cells.len() && col < self.cells[row].len() {
            // Sweep stale wide-char partner slots before stamping the new
            // glyph. Two cases the renderer would otherwise mis-paint:
            //   (a) the target col is the right-half (width=0) of an old
            //       width=2 glyph at col-1: blank that left half so the
            //       old glyph stops claiming two columns.
            //   (b) the target col currently holds a width=2 left half:
            //       blank its right half (col+1) which is no longer a
            //       continuation slot once we overwrite the left.
            //   (c) the new glyph is itself width=2 and the cell at col+1
            //       is a width=2 left half: blank ITS right half (col+2)
            //       so the old wide glyph does not leak past the new one.
            let blank = self.erase_blank();
            if col > 0 {
                let left = &self.cells[row][col - 1];
                if left.width == 2 {
                    self.cells[row][col - 1] = blank;
                }
            }
            let target_width = self.cells[row][col].width;
            if target_width == 2 && col + 1 < self.cells[row].len() {
                self.cells[row][col + 1] = blank;
            }
            if width == 2
                && col + 1 < self.cells[row].len()
                && self.cells[row][col + 1].width == 2
                && col + 2 < self.cells[row].len()
            {
                self.cells[row][col + 2] = blank;
            }

            self.cells[row][col] = GridCell {
                ch: c as u32,
                width: width as u8,
                fg: self.current_fg,
                bg: self.current_bg,
                attrs: self.current_attrs,
            };
            // Width-2 char occupies col and col+1. Mark col+1 as a
            // continuation slot (width=0) so the renderer doesn't try to
            // draw a glyph there independently. The continuation cell
            // inherits the parent's fg/bg so background fills span the
            // wide glyph correctly.
            if width == 2 && col + 1 < self.cells[row].len() {
                self.cells[row][col + 1] = GridCell {
                    ch: 0,
                    width: 0,
                    fg: self.current_fg,
                    bg: self.current_bg,
                    attrs: self.current_attrs,
                };
            }
            // Mark this row dirty so the diff includes it.
            self.mark_dirty(row as u16);
        }
        self.cursor_col = self.cursor_col.saturating_add(width);
    }

    fn apply_control(&mut self, code: ControlCode) {
        match code {
            ControlCode::CarriageReturn => self.cursor_col = 0,
            ControlCode::LineFeed => self.line_feed(),
            ControlCode::Backspace => {
                self.cursor_col = self.cursor_col.saturating_sub(1);
            }
            ControlCode::HorizontalTab => {
                let next = (self.cursor_col / 8 + 1) * 8;
                self.cursor_col = next.min(self.cols.saturating_sub(1));
            }
            ControlCode::Bell => { /* visual bell is a UI concern, ignore */ }
            // SI / SO toggle the active character set between G0 and
            // G1. Apps that use DEC line drawing typically designate
            // it once on G1 then SO/SI around the box-drawing region:
            //   ESC ) 0   designate DEC line drawing as G1
            //   SO        shift to G1 -> subsequent bytes get the DEC
            //             special-graphics translation
            //   q         renders as horizontal line
            //   SI        shift back to G0 -> ASCII again
            ControlCode::ShiftIn => {
                self.active_g1 = false;
            }
            ControlCode::ShiftOut => {
                self.active_g1 = true;
            }
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn apply_csi(&mut self, csi: CSI) {
        match csi {
            CSI::Cursor(c) => self.apply_cursor(c),
            CSI::Edit(e) => self.apply_edit(e),
            CSI::Sgr(s) => self.apply_sgr(s),
            CSI::Mode(m) => self.apply_mode(m),
            CSI::Device(dev) => self.apply_device(*dev),
            // Window manipulation (resize / move / iconify / report
            // size). A WebView-hosted terminal can't honor these and
            // they're not visible-rendering bugs, so swallow without
            // bumping unhandled diagnostics.
            CSI::Window(_) => {}
            // Mouse + Keyboard mode/report dispatch deferred. Counted
            // because not handling these IS visible (htop column drag,
            // Kitty keyboard protocol features go silently dead).
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    /// Reply to terminal capability queries every modern shell sends
    /// on startup: DA1 (`\x1b[c`), DA2 (`\x1b[>c`), DA3 (`\x1b[=c`),
    /// DSR (`\x1b[5n`), and XTVERSION (`\x1b[>q`). Without responses
    /// fish prints a 10s timeout warning ("could not read response to
    /// Primary Device Attribute query") and disables its progressive
    /// features. SoftReset (DECSTR) and XtSmGraphics fall through to
    /// the unhandled bucket - they don't gate startup the way the
    /// queries do.
    fn apply_device(&mut self, dev: termwiz::escape::csi::Device) {
        use termwiz::escape::csi::Device;
        match dev {
            // Identify as VT220 with no extended attribute set. xterm
            // returns a longer list (`\x1b[?62;1;6;9;15;22c`) but a
            // bare VT220 reply satisfies fish, bash, zsh, vim, and
            // tmux without claiming features we don't actually have.
            Device::RequestPrimaryDeviceAttributes => {
                self.pending_responses.extend_from_slice(b"\x1b[?62;c");
            }
            // Secondary: terminal type 1 (xterm-class), firmware 0,
            // keyboard 0. Apps key off the type byte to decide which
            // extended sequences to attempt.
            Device::RequestSecondaryDeviceAttributes => {
                self.pending_responses.extend_from_slice(b"\x1b[>1;0;0c");
            }
            // Tertiary (DECRPTUI): unit ID is a hex site code; zero
            // is the conventional "anonymous" reply.
            Device::RequestTertiaryDeviceAttributes => {
                self.pending_responses
                    .extend_from_slice(b"\x1bP!|00000000\x1b\\");
            }
            // DSR 5: device status. Reply 0 = OK.
            Device::StatusReport => {
                self.pending_responses.extend_from_slice(b"\x1b[0n");
            }
            // XTVERSION: identify the emulator. Some apps (kitty's
            // graphics protocol, mpv) condition behavior on this.
            Device::RequestTerminalNameAndVersion => {
                self.pending_responses
                    .extend_from_slice(b"\x1bP>|seren-desktop\x1b\\");
            }
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    /// Apply DEC private and ANSI mode set/reset. We handle DECCKM
    /// (1, application cursor keys), ShowCursor (25), the alt-screen
    /// trio (47, 1047, 1049 - all collapsed to "switch to alt + clear"
    /// because that's what every modern TUI uses), and BracketedPaste
    /// (2004). All other modes (mouse reporting, focus events, origin
    /// mode, etc.) go to the unhandled bucket.
    fn apply_mode(&mut self, mode: Mode) {
        match mode {
            Mode::SetDecPrivateMode(DecPrivateMode::Code(code)) => {
                self.set_dec_mode(code, true);
            }
            Mode::ResetDecPrivateMode(DecPrivateMode::Code(code)) => {
                self.set_dec_mode(code, false);
            }
            // DEC private modes termwiz parsed but couldn't classify
            // are vendor extensions or rarely-used codes; treat as
            // known-unrecognized rather than as broken-rendering.
            Mode::SetDecPrivateMode(DecPrivateMode::Unspecified(_))
            | Mode::ResetDecPrivateMode(DecPrivateMode::Unspecified(_)) => {}
            // XTSAVE / XTRESTORE - tmux uses these to save/restore
            // mouse modes around shell-out. We don't track the modes
            // they save, but the operation itself is benign.
            Mode::SaveDecPrivateMode(_) | Mode::RestoreDecPrivateMode(_) => {}
            // ANSI mode 4 (IRM): insert/replace toggle. When set, the
            // next character at the cursor pushes existing cells right
            // instead of overwriting. We honor this so non-readline
            // line editors (mostly older shells, some custom REPLs)
            // render correctly. KAM and SRM are silently swallowed
            // since apps very rarely depend on them in 2024.
            Mode::SetMode(TerminalMode::Code(TerminalModeCode::Insert)) => {
                self.insert_mode = true;
            }
            Mode::ResetMode(TerminalMode::Code(TerminalModeCode::Insert)) => {
                self.insert_mode = false;
            }
            Mode::SetMode(_) | Mode::ResetMode(_) => {}
            // Mode queries (DECRQM `\x1b[?N$p`) expect a response we
            // don't emit yet. Apps that depend on them would hang.
            // Counted because the gap is real.
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn set_dec_mode(&mut self, code: DecPrivateModeCode, on: bool) {
        match code {
            DecPrivateModeCode::ApplicationCursorKeys => {
                self.cursor_keys_app = on;
            }
            DecPrivateModeCode::ShowCursor => {
                self.cursor_visible = on;
            }
            DecPrivateModeCode::BracketedPaste => {
                self.bracketed_paste = on;
            }
            // 1049 is the canonical "save cursor + switch to alt + clear"
            // combo used by vim/htop/less/tmux. 1047 is "switch + clear"
            // without the save; 47 is "switch" without clear or save.
            // Collapsing all three into the same enter/exit-alt path is
            // a deliberate simplification: real-world TUIs use 1049 and
            // the difference for the older two is negligible for our
            // visible-correctness goal here.
            DecPrivateModeCode::ClearAndEnableAlternateScreen
            | DecPrivateModeCode::OptEnableAlternateScreen
            | DecPrivateModeCode::EnableAlternateScreen => {
                if on {
                    self.enter_alt_screen();
                } else {
                    self.exit_alt_screen();
                }
            }
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    /// DECSC: save cursor position + current pen attributes.
    fn save_cursor(&mut self) {
        self.saved_cursor = Some(SavedCursor {
            row: self.cursor_row,
            col: self.cursor_col,
            fg: self.current_fg,
            bg: self.current_bg,
            attrs: self.current_attrs,
        });
    }

    /// DECRC: restore the saved cursor + pen, or no-op if nothing saved.
    fn restore_cursor(&mut self) {
        if let Some(saved) = self.saved_cursor.clone() {
            self.cursor_row = saved.row.min(self.rows.saturating_sub(1));
            self.cursor_col = saved.col.min(self.cols.saturating_sub(1));
            self.current_fg = saved.fg;
            self.current_bg = saved.bg;
            self.current_attrs = saved.attrs;
        }
    }

    /// DECSET 1049 enter: stash main screen + cursor + pen + scroll
    /// region, then switch to a freshly-blanked alt screen with the
    /// pen carried over (so colored TUIs paint into a clean slate).
    /// The blank cells are stamped via `erase_blank()` so the alt
    /// screen inherits current_bg, matching xterm's DECSET 1049 clear
    /// semantics (the clear uses the current SGR background) and the
    /// same invariant `erase_blank` enforces for explicit erase and
    /// `scroll_region_up`. Idempotent: a second 1049 while alt is
    /// active is a no-op.
    fn enter_alt_screen(&mut self) {
        if self.alt_state.is_some() {
            return;
        }
        let blank = self.erase_blank();
        let saved_cells = std::mem::replace(
            &mut self.cells,
            vec![vec![blank; self.cols as usize]; self.rows as usize],
        );
        self.alt_state = Some(AltState {
            saved_cells,
            saved_cursor_row: self.cursor_row,
            saved_cursor_col: self.cursor_col,
            saved_fg: self.current_fg,
            saved_bg: self.current_bg,
            saved_attrs: self.current_attrs,
            saved_scroll_top: self.scroll_top,
            saved_scroll_bottom: self.scroll_bottom,
            saved_cursor_visible: self.cursor_visible,
        });
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.scroll_top = 0;
        self.scroll_bottom = self.rows.saturating_sub(1);
        // Whole grid swapped; the renderer's local copy is now stale
        // for every row.
        self.mark_all_dirty();
    }

    /// DECRST 1049 exit: drop alt cells, restore the saved main state.
    /// No-op if alt was never entered.
    fn exit_alt_screen(&mut self) {
        let Some(alt) = self.alt_state.take() else {
            return;
        };
        self.cells = alt.saved_cells;
        self.cursor_row = alt.saved_cursor_row.min(self.rows.saturating_sub(1));
        self.cursor_col = alt.saved_cursor_col.min(self.cols.saturating_sub(1));
        self.current_fg = alt.saved_fg;
        self.current_bg = alt.saved_bg;
        self.current_attrs = alt.saved_attrs;
        self.scroll_top = alt.saved_scroll_top.min(self.rows.saturating_sub(1));
        self.scroll_bottom = alt
            .saved_scroll_bottom
            .min(self.rows.saturating_sub(1));
        self.cursor_visible = alt.saved_cursor_visible;
        self.mark_all_dirty();
    }

    /// Apply a Select Graphic Rendition update to the current pen state.
    /// Subsequent `write_char` calls stamp these onto each new cell.
    /// We honor Reset, Foreground, Background, Intensity (Bold + Dim),
    /// Italic, Underline (any non-None counts), Inverse, and
    /// StrikeThrough. Blink, Invisible, Font, UnderlineColor, Overline,
    /// VerticalAlign render correctly without the requested attribute
    /// and silently swallow.
    fn apply_sgr(&mut self, sgr: Sgr) {
        match sgr {
            Sgr::Reset => {
                self.current_fg = COLOR_DEFAULT;
                self.current_bg = COLOR_DEFAULT;
                self.current_attrs = 0;
            }
            Sgr::Foreground(spec) => {
                self.current_fg = color_spec_to_packed(spec);
            }
            Sgr::Background(spec) => {
                self.current_bg = color_spec_to_packed(spec);
            }
            Sgr::Intensity(Intensity::Bold) => {
                self.current_attrs = (self.current_attrs | ATTR_BOLD) & !ATTR_DIM;
            }
            Sgr::Intensity(Intensity::Half) => {
                self.current_attrs = (self.current_attrs | ATTR_DIM) & !ATTR_BOLD;
            }
            Sgr::Intensity(Intensity::Normal) => {
                self.current_attrs &= !(ATTR_BOLD | ATTR_DIM);
            }
            Sgr::Italic(true) => self.current_attrs |= ATTR_ITALIC,
            Sgr::Italic(false) => self.current_attrs &= !ATTR_ITALIC,
            Sgr::Underline(termwiz::cell::Underline::None) => {
                self.current_attrs &= !ATTR_UNDERLINE;
            }
            Sgr::Underline(_) => {
                // All underline variants (Single, Double, Curly,
                // Dotted, Dashed) collapse to a single underline attr;
                // the renderer draws one straight line under the cell.
                // Per-style underlines are a future refinement.
                self.current_attrs |= ATTR_UNDERLINE;
            }
            Sgr::Inverse(true) => self.current_attrs |= ATTR_REVERSE,
            Sgr::Inverse(false) => self.current_attrs &= !ATTR_REVERSE,
            Sgr::StrikeThrough(true) => self.current_attrs |= ATTR_STRIKE,
            Sgr::StrikeThrough(false) => self.current_attrs &= !ATTR_STRIKE,
            // SGR variants we don't render but where text still appears
            // correctly (just without the requested attribute). Silently
            // acknowledge so diagnostics stay focused. Each is a known
            // visual gap, not an unknown rendering issue.
            //   Blink: text shows steady instead of blinking
            //   Invisible: text shows instead of being hidden (rare;
            //              mostly used for password input which uses
            //              control chars instead)
            //   Overline: missing line above text (cosmetic)
            //   UnderlineColor: underline draws in fg color
            //   Font: alternate font selection (we use one font)
            //   VerticalAlign: subscript/superscript shows as baseline
            Sgr::Blink(_)
            | Sgr::Invisible(_)
            | Sgr::Overline(_)
            | Sgr::UnderlineColor(_)
            | Sgr::Font(_)
            | Sgr::VerticalAlign(_) => {}
        }
    }

    fn apply_cursor(&mut self, c: Cursor) {
        match c {
            Cursor::Position { line, col } => {
                let r = line.as_zero_based() as u16;
                let cc = col.as_zero_based() as u16;
                self.cursor_row = r.min(self.rows.saturating_sub(1));
                self.cursor_col = cc.min(self.cols.saturating_sub(1));
            }
            Cursor::Up(n) => {
                let n = n.max(1) as u16;
                self.cursor_row = self.cursor_row.saturating_sub(n);
            }
            Cursor::Down(n) => {
                let n = n.max(1) as u16;
                self.cursor_row = self
                    .cursor_row
                    .saturating_add(n)
                    .min(self.rows.saturating_sub(1));
            }
            Cursor::Left(n) => {
                let n = n.max(1) as u16;
                self.cursor_col = self.cursor_col.saturating_sub(n);
            }
            Cursor::Right(n) => {
                let n = n.max(1) as u16;
                self.cursor_col = self
                    .cursor_col
                    .saturating_add(n)
                    .min(self.cols.saturating_sub(1));
            }
            Cursor::CharacterAbsolute(col) | Cursor::CharacterPositionAbsolute(col) => {
                self.cursor_col =
                    (col.as_zero_based() as u16).min(self.cols.saturating_sub(1));
            }
            Cursor::LinePositionAbsolute(line) => {
                let line = line.saturating_sub(1) as u16;
                self.cursor_row = line.min(self.rows.saturating_sub(1));
            }
            Cursor::SaveCursor => self.save_cursor(),
            Cursor::RestoreCursor => self.restore_cursor(),
            // CNL: cursor down n lines + CR to col 0. CPL: cursor up
            // n lines + CR to col 0. Both used by some prompt
            // renderers; cheap to implement properly so we don't drop
            // semantically-meaningful cursor movement.
            Cursor::NextLine(n) => {
                let n = n.max(1) as u16;
                for _ in 0..n {
                    self.line_feed();
                }
                self.cursor_col = 0;
            }
            Cursor::PrecedingLine(n) => {
                let n = n.max(1) as u16;
                for _ in 0..n {
                    self.reverse_line_feed();
                }
                self.cursor_col = 0;
            }
            // DECSCUSR `\x1b[N q`: set cursor style (block / underline /
            // bar, blinking or steady). Fish sets a bar cursor in insert
            // mode on startup; vim toggles between styles by mode. We
            // always render a steady block; silently acknowledge so
            // diagnostics stay focused.
            Cursor::CursorStyle(_) => {}
            // CHT/CBT (forward/backward tab) and tabulation
            // set/clear/control. We don't track tab stops (cursor jumps
            // to next 8-col multiple in apply_control HT); these stop
            // sequences let an app override that grid. Rare for shells;
            // silently swallow.
            Cursor::ForwardTabulation(_)
            | Cursor::BackwardTabulation(_)
            | Cursor::TabulationClear(_)
            | Cursor::TabulationControl(_)
            | Cursor::LineTabulation(_) => {}
            // DSR 6: Cursor Position Report. Reply with the current
            // (1-based) row;col so apps that probe cursor position
            // (e.g. some prompts after paste) get a real answer.
            Cursor::RequestActivePositionReport => {
                let resp = format!(
                    "\x1b[{};{}R",
                    self.cursor_row + 1,
                    self.cursor_col + 1,
                );
                self.pending_responses.extend_from_slice(resp.as_bytes());
            }
            Cursor::SetTopAndBottomMargins { top, bottom } => {
                let last_row = self.rows.saturating_sub(1);
                let t = (top.as_zero_based() as u16).min(last_row);
                let b = (bottom.as_zero_based() as u16).min(last_row);
                // DECSTBM with bottom <= top is undefined per the spec.
                // xterm's behavior is to ignore the request entirely - no
                // change to the scroll region AND no cursor home. Our prior
                // code reset to full screen and homed the cursor, which
                // could displace a TUI cursor on a malformed CSI r. Match
                // xterm: silent ignore on inverted/empty regions.
                if b > t {
                    self.scroll_top = t;
                    self.scroll_bottom = b;
                    // DECSTBM also homes the cursor (or to scroll-region
                    // home if origin mode is set; we don't track origin
                    // mode yet).
                    self.cursor_row = self.scroll_top;
                    self.cursor_col = 0;
                }
            }
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn apply_edit(&mut self, e: Edit) {
        match e {
            Edit::EraseInLine(mode) => self.erase_in_line(mode),
            Edit::EraseInDisplay(mode) => self.erase_in_display(mode),
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    /// Cell stamped into an erased slot. xterm semantics: erase preserves the
    /// current pen's background color (and reverse-video bit, which swaps
    /// fg/bg at paint time so a "reversed erased" cell must still draw with
    /// the swapped color). Foreground and the glyph-shape attrs (bold,
    /// italic, underline, strike, dim) are dropped because there's no glyph
    /// to paint - keeping them would have no visual effect today and would
    /// surprise a future renderer that gains underline-only-on-empty-cells.
    fn erase_blank(&self) -> GridCell {
        GridCell {
            ch: 0,
            width: 1,
            fg: COLOR_DEFAULT,
            bg: self.current_bg,
            attrs: self.current_attrs & ATTR_REVERSE,
        }
    }

    fn erase_in_line(&mut self, mode: EraseInLine) {
        let row = self.cursor_row as usize;
        if row >= self.cells.len() {
            return;
        }
        let col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let blank = self.erase_blank();
        match mode {
            EraseInLine::EraseToEndOfLine => {
                for c in col..cols {
                    self.cells[row][c] = blank;
                }
            }
            EraseInLine::EraseToStartOfLine => {
                for c in 0..=col.min(cols.saturating_sub(1)) {
                    self.cells[row][c] = blank;
                }
            }
            EraseInLine::EraseLine => {
                for c in 0..cols {
                    self.cells[row][c] = blank;
                }
            }
        }
        self.mark_dirty(row as u16);
    }

    fn erase_in_display(&mut self, mode: EraseInDisplay) {
        let blank = self.erase_blank();
        match mode {
            EraseInDisplay::EraseToEndOfDisplay => {
                self.erase_in_line(EraseInLine::EraseToEndOfLine);
                let next_row = self.cursor_row as usize + 1;
                for r in next_row..self.cells.len() {
                    for c in 0..self.cols as usize {
                        self.cells[r][c] = blank;
                    }
                    self.mark_dirty(r as u16);
                }
            }
            EraseInDisplay::EraseToStartOfDisplay => {
                let row = self.cursor_row as usize;
                for r in 0..row.min(self.cells.len()) {
                    for c in 0..self.cols as usize {
                        self.cells[r][c] = blank;
                    }
                    self.mark_dirty(r as u16);
                }
                self.erase_in_line(EraseInLine::EraseToStartOfLine);
            }
            EraseInDisplay::EraseDisplay | EraseInDisplay::EraseScrollback => {
                for row in &mut self.cells {
                    for cell in row.iter_mut() {
                        *cell = blank;
                    }
                }
                self.mark_all_dirty();
            }
        }
    }

    /// Move cursor down one row; the scroll behavior depends on the
    /// DECSTBM scroll region. If the cursor sits at `scroll_bottom`,
    /// scroll the region up by one (line at `scroll_top` drops, blank
    /// inserted at `scroll_bottom`). If the cursor is below the scroll
    /// region, advance freely until the last row. Otherwise just step
    /// down. The newly inserted blank inherits the current pen's
    /// background so a scroll generated while a colored bg is active
    /// does not introduce default-bg stripes (same invariant
    /// `erase_blank` preserves for explicit erase).
    fn line_feed(&mut self) {
        if self.cursor_row == self.scroll_bottom {
            self.scroll_region_up(1);
        } else if self.cursor_row + 1 < self.rows {
            self.cursor_row += 1;
        }
    }

    /// Move cursor up one row. If the cursor sits at `scroll_top`, reverse
    /// scroll the DECSTBM region down by one (blank inserted at `scroll_top`).
    /// Outside the region, move freely until the first row.
    fn reverse_line_feed(&mut self) {
        if self.cursor_row == self.scroll_top {
            self.scroll_region_down(1);
        } else {
            self.cursor_row = self.cursor_row.saturating_sub(1);
        }
    }

    /// Scroll the DECSTBM region up by `n` rows. Lines at and above
    /// `scroll_top` are unchanged; the row at `scroll_top` is removed,
    /// blank rows (with current_bg) are inserted at `scroll_bottom`.
    fn scroll_region_up(&mut self, n: u16) {
        if self.scroll_bottom < self.scroll_top {
            return;
        }
        let blank = self.erase_blank();
        let cols = self.cols as usize;
        let top = self.scroll_top as usize;
        let bot = self.scroll_bottom as usize;
        let height = bot.saturating_sub(top).saturating_add(1);
        let count = (n as usize).min(height);
        for _ in 0..count {
            if bot >= self.cells.len() {
                break;
            }
            self.cells.remove(top);
            self.cells.insert(bot, vec![blank; cols]);
            self.dirty_rows.remove(top);
            self.dirty_rows.insert(bot, true);
        }
        if count > 0 {
            self.push_scroll(
                self.scroll_top,
                self.scroll_bottom,
                (count.min(i16::MAX as usize)) as i16,
            );
        }
    }

    /// Scroll the DECSTBM region down by `n` rows. Lines outside the region
    /// are unchanged; blank rows (with current_bg) are inserted at
    /// `scroll_top`, and rows at `scroll_bottom` drop.
    fn scroll_region_down(&mut self, n: u16) {
        if self.scroll_bottom < self.scroll_top {
            return;
        }
        let blank = self.erase_blank();
        let cols = self.cols as usize;
        let top = self.scroll_top as usize;
        let bot = self.scroll_bottom as usize;
        let height = bot.saturating_sub(top).saturating_add(1);
        let count = (n as usize).min(height);
        for _ in 0..count {
            if bot >= self.cells.len() {
                break;
            }
            self.cells.insert(top, vec![blank; cols]);
            self.cells.remove(bot + 1);
            self.dirty_rows.insert(top, true);
            self.dirty_rows.remove(bot + 1);
        }
        if count > 0 {
            self.push_scroll(
                self.scroll_top,
                self.scroll_bottom,
                -((count.min(i16::MAX as usize)) as i16),
            );
        }
    }

    /// Shift cells in `row` from `col` rightward by `n` positions, in
    /// place. Cells past the right margin fall off. Used by IRM
    /// insert mode: the caller stamps the new glyph at `col` after
    /// the shift, so that position is overwritten anyway and doesn't
    /// need explicit clearing here. Cells from the source range are
    /// NOT zeroed - they remain as duplicate references that the
    /// subsequent stamp+sweep clean up.
    fn shift_cells_right(&mut self, row: usize, col: usize, n: u16) {
        if row >= self.cells.len() || n == 0 {
            return;
        }
        let line = &mut self.cells[row];
        let cols = line.len();
        if col >= cols {
            return;
        }
        let shift = (n as usize).min(cols - col);
        if shift == 0 {
            return;
        }
        // Move [col..(cols - shift)] to [col + shift..cols] right-to-
        // left so we don't clobber source cells before reading them.
        for src in (col..(cols - shift)).rev() {
            line[src + shift] = line[src];
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBufferInfo {
    pub id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalBufferRequest {
    pub id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    buffer_id: String,
}

/// Versioned snapshot envelope. The discriminator + payload split
/// keeps adding new payload kinds (image placements etc.) from being
/// a breaking IPC change for callers that already pattern-match on
/// `kind`.
///
/// Wire shape:
///   { "seq": 5, "kind": "grid", "payload": { ... } }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub seq: u32,
    #[serde(flatten)]
    pub body: TerminalSnapshotBody,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "kebab-case")]
pub enum TerminalSnapshotBody {
    /// Parsed grid. Wire shape:
    /// { kind: "grid", payload: { rows, cols, cells, cursorRow, cursorCol, unhandledActions } }
    Grid(GridSnapshot),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalSignal {
    Interrupt,
    Quit,
    Hangup,
    Terminate,
    Kill,
}

#[cfg(unix)]
impl TerminalSignal {
    fn signum(self) -> libc::c_int {
        match self {
            TerminalSignal::Interrupt => libc::SIGINT,
            TerminalSignal::Quit => libc::SIGQUIT,
            TerminalSignal::Hangup => libc::SIGHUP,
            TerminalSignal::Terminate => libc::SIGTERM,
            TerminalSignal::Kill => libc::SIGKILL,
        }
    }
}

impl TerminalSignal {
    /// Best-effort control-code fallback for platforms (Windows ConPTY) that
    /// do not expose a foreground process group. Returns the byte sequence to
    /// inject into the master, or None when no useful translation exists.
    fn line_discipline_byte(self) -> Option<&'static [u8]> {
        match self {
            TerminalSignal::Interrupt => Some(b"\x03"),
            TerminalSignal::Quit => Some(b"\x1c"),
            _ => None,
        }
    }
}

#[tauri::command]
pub fn terminal_create_buffer(
    app: AppHandle,
    state: State<'_, TerminalState>,
    request: CreateTerminalBufferRequest,
) -> Result<TerminalBufferInfo, String> {
    let id = request.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    {
        let buffers = state
            .buffers
            .lock()
            .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
        if buffers.contains_key(&id) {
            return Err(format!("Terminal buffer already exists: {id}"));
        }
    }

    let cols = request.cols.unwrap_or(80).max(2);
    let rows = request.rows.unwrap_or(24).max(1);
    let created_at = unix_millis();
    let cwd = normalize_cwd(request.cwd)?;
    let command = request.command.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    let title = request.title.unwrap_or_else(|| {
        command
            .as_deref()
            .map(title_from_command)
            .unwrap_or_else(|| "Terminal".to_string())
    });

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("Failed to open PTY: {err}"))?;

    let mut builder = build_command(command.as_deref());
    if let Some(cwd) = &cwd {
        builder.cwd(cwd);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|err| format!("Failed to spawn terminal process: {err}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| {
            let _ = child.kill();
            let _ = child.wait();
            format!("Failed to clone PTY reader: {err}")
        })?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| {
            let _ = child.kill();
            let _ = child.wait();
            format!("Failed to take PTY writer: {err}")
        })?;

    drop(pair.slave);

    let info = TerminalBufferInfo {
        id: id.clone(),
        title,
        cwd: cwd.map(|path| path.to_string_lossy().to_string()),
        command,
        cols,
        rows,
        status: TerminalStatus::Running,
        created_at,
        updated_at: created_at,
    };

    let grid = Arc::new(Mutex::new(TerminalGrid::new(rows, cols)));
    let writer_arc = Arc::new(Mutex::new(writer));

    {
        let mut buffers = state
            .buffers
            .lock()
            .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
        if buffers.contains_key(&id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Terminal buffer already exists: {id}"));
        }
        buffers.insert(
            id.clone(),
            TerminalProcess {
                info: info.clone(),
                master: pair.master,
                writer: Arc::clone(&writer_arc),
                child: Arc::new(Mutex::new(child)),
                grid: Arc::clone(&grid),
            },
        );
    }

    // Pass the writer Arc to the reader thread too so it can write
    // emulator query responses (DA1, DSR, XTVERSION) back to the PTY
    // without going through the global buffers lock.
    if let Err(spawn_err) = spawn_reader_thread(app.clone(), id.clone(), reader, grid, writer_arc) {
        if let Ok(mut buffers) = state.buffers.lock() {
            if let Some(rolled_back) = buffers.remove(&id) {
                if let Ok(mut child) = rolled_back.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        return Err(format!(
            "Failed to spawn terminal reader thread: {spawn_err}"
        ));
    }
    Ok(info)
}

#[tauri::command]
pub fn terminal_list_buffers(
    state: State<'_, TerminalState>,
) -> Result<Vec<TerminalBufferInfo>, String> {
    let buffers = state
        .buffers
        .lock()
        .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
    Ok(buffers
        .values()
        .map(|process| process.info.clone())
        .collect())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    buffer_id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let buffers = state
            .buffers
            .lock()
            .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
        let process = buffers
            .get(&buffer_id)
            .ok_or_else(|| format!("Terminal buffer not found: {buffer_id}"))?;
        Arc::clone(&process.writer)
    };
    let mut writer = writer
        .lock()
        .map_err(|err| format!("Terminal writer mutex poisoned: {err}"))?;
    writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("Failed to write terminal input: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("Failed to flush terminal input: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    app: AppHandle,
    state: State<'_, TerminalState>,
    buffer_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalBufferInfo, String> {
    let mut buffers = state
        .buffers
        .lock()
        .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
    let process = buffers
        .get_mut(&buffer_id)
        .ok_or_else(|| format!("Terminal buffer not found: {buffer_id}"))?;
    let cols = cols.max(2);
    let rows = rows.max(1);
    process
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("Failed to resize terminal: {err}"))?;
    process.info.cols = cols;
    process.info.rows = rows;
    process.info.updated_at = unix_millis();
    // Keep the parsed grid in sync with the PTY's WINSIZE so the renderer
    // reads cells at the new dimensions on the next snapshot. Drain the
    // diff under the same lock and emit it - the reader thread only
    // emits diffs after a PTY read, so a resize that lands while the
    // PTY is idle would otherwise leave the renderer drawing at the
    // old dims until the next byte arrives. The grid.resize call bumps
    // seq and marks every row dirty, so this diff carries the new
    // dimensions and a full grid repaint to the renderer.
    let diff = process.grid.lock().ok().map(|mut g| {
        g.resize(rows, cols);
        g.drain_diff()
    });
    let info = process.info.clone();
    drop(buffers);
    if let Some(diff) = diff.filter(diff_has_changes) {
        let _ = app.emit(
            TERMINAL_GRID_DIFF_EVENT,
            GridDiffEvent {
                buffer_id: buffer_id.clone(),
                diff,
            },
        );
    }
    Ok(info)
}

#[tauri::command]
pub fn terminal_kill(
    app: AppHandle,
    state: State<'_, TerminalState>,
    buffer_id: String,
) -> Result<(), String> {
    let process = {
        let mut buffers = state
            .buffers
            .lock()
            .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
        buffers.remove(&buffer_id)
    };
    let Some(process) = process else {
        return Ok(());
    };

    let was_running = matches!(process.info.status, TerminalStatus::Running);

    if let Ok(mut child) = process.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(process);

    if was_running {
        let _ = app.emit(TERMINAL_EXIT_EVENT, TerminalExitEvent { buffer_id });
    }
    Ok(())
}

/// Returns the parsed grid snapshot. The frontend canvas calls this
/// on mount + on diff-event seq mismatch, then subscribes to
/// `terminal://grid-diff` events for incremental updates.
#[tauri::command]
pub fn terminal_grid_snapshot(
    state: State<'_, TerminalState>,
    buffer_id: String,
) -> Result<TerminalSnapshot, String> {
    let buffers = state
        .buffers
        .lock()
        .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
    let process = buffers
        .get(&buffer_id)
        .ok_or_else(|| format!("Terminal buffer not found: {buffer_id}"))?;
    let grid = Arc::clone(&process.grid);
    drop(buffers);

    let (seq, body) = grid
        .lock()
        .map(|g| (g.seq, TerminalSnapshotBody::Grid(g.snapshot())))
        .map_err(|err| format!("Terminal grid mutex poisoned: {err}"))?;
    Ok(TerminalSnapshot { seq, body })
}

/// Send `signal` to the foreground process group of the terminal's PTY when
/// the platform exposes it (Unix). Falls back to writing the line-discipline
/// control byte (e.g. `\x03` for Ctrl-C) so that cooked-mode shells still
/// receive the signal on Windows ConPTY where there is no foreground group.
#[tauri::command]
pub fn terminal_signal(
    state: State<'_, TerminalState>,
    buffer_id: String,
    signal: TerminalSignal,
) -> Result<(), String> {
    // Resolve the per-process handles we need under the buffers lock, then
    // release it before any potentially blocking call (writer.write/flush).
    // killpg itself is non-blocking so we settle that under the lock.
    let writer = {
        let buffers = state
            .buffers
            .lock()
            .map_err(|err| format!("Terminal state mutex poisoned: {err}"))?;
        let process = buffers
            .get(&buffer_id)
            .ok_or_else(|| format!("Terminal buffer not found: {buffer_id}"))?;

        #[cfg(unix)]
        {
            if let Some(pgid) = process.master.process_group_leader() {
                // SAFETY: killpg with a valid pgid sourced from tcgetpgrp on
                // a live PTY master and a constant signum is sound.
                let result = unsafe { libc::killpg(pgid, signal.signum()) };
                if result != 0 {
                    let err = std::io::Error::last_os_error();
                    // ESRCH means the target group has no live members; treat
                    // as success so callers don't have to special-case
                    // "already dead" on idempotent operations like Kill or
                    // Terminate.
                    if err.raw_os_error() == Some(libc::ESRCH) {
                        return Ok(());
                    }
                    return Err(format!(
                        "Failed to signal terminal process group {pgid}: {err}"
                    ));
                }
                return Ok(());
            }
            // No foreground group yet (race: child not finished setsid/exec).
            // For signals with a line-discipline equivalent, fall through to
            // writing the control byte as best-effort. For others, surface a
            // specific error rather than the misleading "not deliverable on
            // this platform".
            if signal.line_discipline_byte().is_none() {
                return Err(format!(
                    "Terminal has no foreground process group yet; cannot deliver {:?}",
                    signal
                ));
            }
        }

        Arc::clone(&process.writer)
    };

    let Some(bytes) = signal.line_discipline_byte() else {
        return Err(format!(
            "Terminal signal {:?} not deliverable on this platform",
            signal
        ));
    };
    let mut writer = writer
        .lock()
        .map_err(|err| format!("Terminal writer mutex poisoned: {err}"))?;
    writer
        .write_all(bytes)
        .map_err(|err| format!("Failed to inject control byte: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("Failed to flush control byte: {err}"))?;
    Ok(())
}

fn spawn_reader_thread(
    app: AppHandle,
    buffer_id: String,
    mut reader: Box<dyn Read + Send>,
    grid: Arc<Mutex<TerminalGrid>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
) -> std::io::Result<()> {
    // Coordinated shutdown + diff coalescing flags shared with the
    // emitter thread spawned below. `pending_diff` is set after every
    // feed; the emitter swaps it false when it drains. `reader_alive`
    // is cleared on EOF so the emitter exits its tick loop instead of
    // running forever.
    let pending_diff = Arc::new(AtomicBool::new(false));
    let reader_alive = Arc::new(AtomicBool::new(true));

    // Spawn the diff-emitter first. It owns the cadence: drains the
    // grid + emits a diff event at most every GRID_DIFF_INTERVAL.
    // Multiple feeds in one tick collapse because drain_diff returns
    // the union of all rows dirtied since the last drain.
    {
        let pending = Arc::clone(&pending_diff);
        let alive = Arc::clone(&reader_alive);
        let grid = Arc::clone(&grid);
        let app = app.clone();
        let buffer_id = buffer_id.clone();
        thread::Builder::new()
            .name(format!("terminal-diff-{buffer_id}"))
            .spawn(move || {
                while alive.load(Ordering::Acquire) {
                    thread::sleep(GRID_DIFF_INTERVAL);
                    if !pending.swap(false, Ordering::AcqRel) {
                        continue;
                    }
                    let diff = grid.lock().ok().map(|mut g| g.drain_diff());
                    if let Some(diff) = diff.filter(diff_has_changes) {
                        let _ = app.emit(
                            TERMINAL_GRID_DIFF_EVENT,
                            GridDiffEvent {
                                buffer_id: buffer_id.clone(),
                                diff,
                            },
                        );
                    }
                }
                // Reader signaled EOF; flush one final diff if anything
                // landed between the last tick and shutdown so the
                // renderer's last-paint state matches the PTY's.
                if pending.swap(false, Ordering::AcqRel) {
                    if let Ok(mut g) = grid.lock() {
                        let diff = g.drain_diff();
                        if diff_has_changes(&diff) {
                            let _ = app.emit(
                                TERMINAL_GRID_DIFF_EVENT,
                                GridDiffEvent { buffer_id, diff },
                            );
                        }
                    }
                }
            })?;
    }

    thread::Builder::new()
        .name(format!("terminal-reader-{buffer_id}"))
        .spawn(move || {
            let _reader_alive_guard = ClearAliveOnDrop(Arc::clone(&reader_alive));
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Feed the parser the RAW bytes. Drain query
                        // responses (DA1, DSR, XTVERSION, CPR) inline
                        // because apps wait for those replies and lag
                        // there shows up as 10s timeout warnings.
                        // The diff drain runs on the emitter thread's
                        // cadence so a torrent of output (e.g. find ~)
                        // doesn't saturate the IPC channel.
                        let responses = grid
                            .lock()
                            .map(|mut g| {
                                g.feed(&buf[..n]);
                                g.drain_responses()
                            })
                            .unwrap_or_default();
                        if !responses.is_empty() {
                            if let Ok(mut w) = writer.lock() {
                                let _ = w.write_all(&responses);
                                let _ = w.flush();
                            }
                        }
                        // Signal the emitter that the grid changed; it
                        // will pick up the dirty rows on its next tick.
                        pending_diff.store(true, Ordering::Release);
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }

            // Signal the diff emitter to exit its tick loop. It will
            // do one final flush + drain before terminating. The drop
            // guard above repeats this on unwind so the emitter does not
            // leak if the reader exits unexpectedly.
            reader_alive.store(false, Ordering::Release);

            // Reap the child and finalize status. Skip the exit event when the
            // entry has already been removed (terminal_kill emitted) or when
            // the status was set elsewhere - guarantees a single emit per buffer.
            // Clone the child Arc under the buffers lock, release it, then wait
            // outside the lock so a slow reap (grandchildren keeping the slave
            // open with the direct child not yet zombied) can't stall every
            // other terminal command.
            let child_handle = app.try_state::<TerminalState>().and_then(|state| {
                state.buffers.lock().ok().and_then(|buffers| {
                    buffers.get(&buffer_id).and_then(|process| {
                        matches!(process.info.status, TerminalStatus::Running)
                            .then(|| Arc::clone(&process.child))
                    })
                })
            });

            if let Some(child) = child_handle {
                if let Ok(mut child) = child.lock() {
                    let _ = child.wait();
                }
            }

            let mut should_emit = false;
            if let Some(state) = app.try_state::<TerminalState>() {
                if let Ok(mut buffers) = state.buffers.lock() {
                    if let Some(process) = buffers.get_mut(&buffer_id) {
                        if matches!(process.info.status, TerminalStatus::Running) {
                            process.info.status = TerminalStatus::Exited;
                            process.info.updated_at = unix_millis();
                            should_emit = true;
                        }
                    }
                }
            }
            if should_emit {
                let _ = app.emit(TERMINAL_EXIT_EVENT, TerminalExitEvent { buffer_id });
            }
        })?;
    Ok(())
}

/// Append `chunk` to `carry`, then drain everything that forms complete UTF-8
/// codepoints. Trailing bytes that could be the start of an unfinished sequence
/// are kept in `carry` for the next call. Trailing bytes that are clearly
/// invalid pass through `from_utf8_lossy` so the caller still sees output.
/// Resize a cell grid to (rows, cols), preserving overlapping content.
/// New cells are blank defaults; dropped cells are gone. Pulled out of
/// `TerminalGrid::resize` so the same logic resizes the saved alt-state
/// cells when in alt mode.
fn resize_cells(old: &[Vec<GridCell>], rows: u16, cols: u16) -> Vec<Vec<GridCell>> {
    let mut new_cells = vec![vec![GridCell::default(); cols as usize]; rows as usize];
    let copy_rows = (rows as usize).min(old.len());
    let copy_cols = (cols as usize).min(old.first().map(|r| r.len()).unwrap_or(0));
    for (new_row, old_row) in new_cells.iter_mut().zip(old.iter()).take(copy_rows) {
        new_row[..copy_cols].copy_from_slice(&old_row[..copy_cols]);
    }
    new_cells
}

/// Convert a termwiz `ColorSpec` into the cell's packed u32 color
/// representation. `Default` becomes the COLOR_DEFAULT sentinel; palette
/// indices are tagged via COLOR_PALETTE_TAG; truecolor is converted from
/// f32 sRGB to 8-bit RGB with the high byte left at 0.
/// Map a printable byte to its DEC special-graphics glyph. Bytes outside
/// the 0x60..=0x7e range pass through unchanged so ASCII text mixed with
/// line-drawing keeps rendering normally. The mapping follows the
/// VT220/xterm "DEC special-graphics character set" table - columns 6 and
/// 7 of the ROM table become box-drawing, math, and symbol glyphs.
fn dec_special_graphics(c: char) -> char {
    match c {
        '`' => '\u{25C6}', // diamond
        'a' => '\u{2592}', // checkerboard / shade
        'b' => '\u{2409}', // HT symbol
        'c' => '\u{240C}', // FF symbol
        'd' => '\u{240D}', // CR symbol
        'e' => '\u{240A}', // LF symbol
        'f' => '\u{00B0}', // degree
        'g' => '\u{00B1}', // plus-minus
        'h' => '\u{2424}', // NL symbol
        'i' => '\u{240B}', // VT symbol
        'j' => '\u{2518}', // lower-right corner
        'k' => '\u{2510}', // upper-right corner
        'l' => '\u{250C}', // upper-left corner
        'm' => '\u{2514}', // lower-left corner
        'n' => '\u{253C}', // crossing lines
        'o' => '\u{23BA}', // scan line 1
        'p' => '\u{23BB}', // scan line 3
        'q' => '\u{2500}', // horizontal line / scan 5
        'r' => '\u{23BC}', // scan line 7
        's' => '\u{23BD}', // scan line 9
        't' => '\u{251C}', // left T
        'u' => '\u{2524}', // right T
        'v' => '\u{2534}', // bottom T
        'w' => '\u{252C}', // top T
        'x' => '\u{2502}', // vertical line
        'y' => '\u{2264}', // less than or equal
        'z' => '\u{2265}', // greater than or equal
        '{' => '\u{03C0}', // pi
        '|' => '\u{2260}', // not equal
        '}' => '\u{00A3}', // pound
        '~' => '\u{00B7}', // centered dot
        other => other,
    }
}

fn color_spec_to_packed(spec: ColorSpec) -> u32 {
    match spec {
        ColorSpec::Default => COLOR_DEFAULT,
        ColorSpec::PaletteIndex(idx) => palette_color(idx),
        ColorSpec::TrueColor(srgba) => {
            let (r, g, b, _a) = srgba.to_srgb_u8();
            rgb_color(r, g, b)
        }
    }
}

fn normalize_cwd(cwd: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = cwd else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let path = PathBuf::from(trimmed);
    if !path.exists() {
        return Err(format!("Terminal cwd does not exist: {trimmed}"));
    }
    if !path.is_dir() {
        return Err(format!("Terminal cwd is not a directory: {trimmed}"));
    }
    Ok(Some(path))
}

fn build_command(initial_command: Option<&str>) -> CommandBuilder {
    let Some(command) = initial_command else {
        return CommandBuilder::new(default_shell());
    };

    if cfg!(target_os = "windows") {
        // -NoLogo / -NoExit / -Command are PowerShell-only; if COMSPEC points
        // at cmd.exe (the Windows default) the launch would fail or behave
        // incorrectly. Pin the command-launch path to PowerShell explicitly
        // and let default_shell() (which honours COMSPEC) only handle the
        // bare-shell case above.
        let mut builder = CommandBuilder::new("powershell.exe");
        builder.arg("-NoLogo");
        builder.arg("-NoExit");
        builder.arg("-Command");
        builder.arg(command);
        builder
    } else {
        let mut builder = CommandBuilder::new(default_shell());
        builder.arg("-lc");
        builder.arg(format!("exec {command}"));
        builder
    }
}

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn title_from_command(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("Terminal")
        .to_string()
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_title_uses_first_command_word() {
        assert_eq!(
            title_from_command("codex --dangerously-bypass-approvals"),
            "codex"
        );
        assert_eq!(title_from_command("   "), "Terminal");
    }

    #[test]
    fn empty_cwd_is_none() {
        assert!(normalize_cwd(Some(" ".to_string())).unwrap().is_none());
    }

    fn cell_at(snap: &GridSnapshot, row: u16, col: u16) -> char {
        let idx = row as usize * snap.cols as usize + col as usize;
        let ch = snap.cells[idx].ch;
        if ch == 0 {
            ' '
        } else {
            char::from_u32(ch).unwrap_or('?')
        }
    }

    fn row_string(snap: &GridSnapshot, row: u16) -> String {
        (0..snap.cols)
            .map(|c| cell_at(snap, row, c))
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    fn row_string_from_cells(cells: &[GridCell]) -> String {
        cells
            .iter()
            .map(|cell| {
                if cell.ch == 0 {
                    ' '
                } else {
                    char::from_u32(cell.ch).unwrap_or('?')
                }
            })
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    #[test]
    fn grid_writes_plain_text_left_to_right() {
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"hello");
        let snap = grid.snapshot();
        assert_eq!(snap.rows, 3);
        assert_eq!(snap.cols, 10);
        assert_eq!(row_string(&snap, 0), "hello");
        assert_eq!(snap.cursor_row, 0);
        assert_eq!(snap.cursor_col, 5);
    }

    #[test]
    fn grid_carriage_return_then_overwrite() {
        let mut grid = TerminalGrid::new(2, 10);
        grid.feed(b"abc\rxy");
        let snap = grid.snapshot();
        // CR returns cursor to col 0, "xy" overwrites "ab" leaving "xyc".
        assert_eq!(row_string(&snap, 0), "xyc");
        assert_eq!(snap.cursor_col, 2);
    }

    #[test]
    fn grid_line_feed_advances_row() {
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"row1\r\nrow2");
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "row1");
        assert_eq!(row_string(&snap, 1), "row2");
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 4);
    }

    #[test]
    fn grid_csi_cursor_position_is_one_based() {
        // ESC [ 2 ; 3 H -> move cursor to row=2, col=3 (1-based) = (1, 2) 0-based.
        let mut grid = TerminalGrid::new(5, 10);
        grid.feed(b"\x1b[2;3HX");
        let snap = grid.snapshot();
        assert_eq!(cell_at(&snap, 1, 2), 'X');
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 3);
    }

    #[test]
    fn grid_erase_to_end_of_line() {
        let mut grid = TerminalGrid::new(2, 10);
        grid.feed(b"hello world");
        // Wrap means the second word is on row 1; reset cursor and erase
        // from col 3 to EOL on row 0.
        grid.feed(b"\x1b[1;4H\x1b[K");
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "hel");
    }

    #[test]
    fn grid_resize_preserves_overlap_and_clamps_cursor() {
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"abcdefghij");
        grid.feed(b"\x1b[3;10H"); // cursor at (2, 9)
        grid.resize(2, 5);
        let snap = grid.snapshot();
        assert_eq!(snap.rows, 2);
        assert_eq!(snap.cols, 5);
        assert_eq!(row_string(&snap, 0), "abcde");
        // Cursor was at (2, 9); now clamped to (1, 4).
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 4);
    }

    #[test]
    fn grid_unhandled_actions_are_counted_not_panicked() {
        let mut grid = TerminalGrid::new(3, 10);
        // Pick a sequence that genuinely falls outside the action
        // interpreter's coverage. DECSET 1000 (X10 mouse reporting) is
        // a real visible-functionality gap (htop column-drag fails) so
        // it MUST bump the counter rather than getting silently
        // swallowed. Sgr::Blink and friends are now silent-swallowed
        // because text still renders correctly without the attribute.
        grid.feed(b"text\x1b[?1000h");
        let snap = grid.snapshot();
        assert!(row_string(&snap, 0).contains("text"));
        assert!(snap.unhandled_actions > 0);
    }

    #[test]
    fn grid_typical_shell_startup_keeps_unhandled_low() {
        // Lock the selective-ignore behavior so a regression that
        // re-bumps the counter on routine startup sequences fails
        // loudly. The counter stays in the snapshot for diagnostics
        // even though the user-facing badge is gone. Every sequence
        // below is a known known we deliberately don't act on.
        let mut grid = TerminalGrid::new(24, 80);
        // Device-attribute probes (handled with replies).
        grid.feed(b"\x1b[c");
        // OSC 0 window title.
        grid.feed(b"\x1b]0;~/projects\x07");
        // OSC 7 current working directory.
        grid.feed(b"\x1b]7;file:///Users/me/projects\x07");
        // ESC = application keypad mode.
        grid.feed(b"\x1b=");
        // ESC ( B designate ASCII as G0 - fish sends this.
        grid.feed(b"\x1b(B");
        // DECSCUSR cursor style (fish in insert mode).
        grid.feed(b"\x1b[5 q");
        // DECSET 25 hide / show cursor (both handled).
        grid.feed(b"\x1b[?25l\x1b[?25h");
        // CSI Window resize report (silently ignored).
        grid.feed(b"\x1b[8;24;80t");
        // XTSAVE mouse mode (silently ignored).
        grid.feed(b"\x1b[?1000s");
        // Sgr Blink + Italic + Reset (text renders without blink).
        grid.feed(b"\x1b[5;3mfancy\x1b[0m");
        let snap = grid.snapshot();
        assert_eq!(
            snap.unhandled_actions, 0,
            "shell startup probes should not surface as unhandled"
        );
    }

    #[test]
    fn grid_snapshot_serializes_with_versioned_envelope() {
        // Wire shape: { seq, kind: "grid", payload: { rows, cols, cells, ... } }
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"hi");
        let body = TerminalSnapshotBody::Grid(grid.snapshot());
        let snap = TerminalSnapshot { seq: grid.seq, body };
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["kind"], "grid");
        assert_eq!(json["payload"]["rows"], 2);
        assert_eq!(json["payload"]["cols"], 4);
        assert_eq!(json["payload"]["cursorCol"], 2);
        assert!(json["payload"]["cells"].is_array());
        assert_eq!(json["payload"]["cells"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn grid_write_wraps_at_right_edge() {
        // Writing exactly cols chars leaves the cursor "parked" at col == cols
        // (post-print position). The next char must trigger line_feed and land
        // at (row+1, 0), with the second char following at (row+1, 1).
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"abcdefg");
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "abcde");
        assert_eq!(row_string(&snap, 1), "fg");
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 2);
    }

    #[test]
    fn grid_backspace_at_col_zero_holds() {
        // BS at the left margin must not underflow; cursor stays at col 0 and
        // does not jump back to the previous row (no reverse wrap -
        // matches xterm default for plain BS).
        let mut grid = TerminalGrid::new(2, 5);
        grid.feed(b"\nx\x08\x08\x08");
        let snap = grid.snapshot();
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 0);
    }

    #[test]
    fn grid_horizontal_tab_jumps_to_next_eight_then_clamps() {
        // Tab from col 0 lands on col 8. A tab from col 9 in a 12-col grid
        // would target col 16, which clamps to cols-1 (11) - the spec allows
        // either "stop at right margin" or "wrap"; xterm-compat is clamp.
        let mut grid = TerminalGrid::new(2, 12);
        grid.feed(b"\tA");
        let snap = grid.snapshot();
        assert_eq!(cell_at(&snap, 0, 8), 'A');
        assert_eq!(snap.cursor_col, 9);

        let mut grid = TerminalGrid::new(2, 12);
        // Move to col 9 (1-based 10), then tab; should clamp to col 11.
        grid.feed(b"\x1b[1;10H\t");
        let snap = grid.snapshot();
        assert_eq!(snap.cursor_col, 11);
    }

    #[test]
    fn grid_line_feed_at_bottom_scrolls() {
        let mut grid = TerminalGrid::new(2, 5);
        grid.feed(b"top\r\nbot\r\n");
        // The trailing LF on row 1 should scroll: old row 0 ("top") is
        // dropped, "bot" moves to row 0, row 1 becomes blank.
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "bot");
        assert_eq!(row_string(&snap, 1), "");
        assert_eq!(snap.cursor_row, 1);
    }

    #[test]
    fn grid_wide_char_occupies_two_cells_and_advances_cursor_by_two() {
        // CJK ideograph U+4E2D ("zhong"/middle, width 2 per UAX#11).
        let mut grid = TerminalGrid::new(2, 6);
        grid.feed("a\u{4E2D}b".as_bytes());
        let snap = grid.snapshot();
        // col 0: 'a' (width 1), col 1+2: wide char (width 2 then continuation
        // width 0), col 3: 'b' (width 1).
        assert_eq!(snap.cells[0].ch, b'a' as u32);
        assert_eq!(snap.cells[0].width, 1);
        assert_eq!(snap.cells[1].ch, 0x4E2D);
        assert_eq!(snap.cells[1].width, 2);
        assert_eq!(snap.cells[2].ch, 0);
        assert_eq!(snap.cells[2].width, 0);
        assert_eq!(snap.cells[3].ch, b'b' as u32);
        assert_eq!(snap.cells[3].width, 1);
        assert_eq!(snap.cursor_col, 4);
    }

    #[test]
    fn grid_wide_char_at_right_edge_wraps() {
        // 5-col grid, write 4 ASCII then a wide char; the wide char would
        // need cols 4-5 but col 5 is past the end, so it wraps to row 1.
        let mut grid = TerminalGrid::new(2, 5);
        grid.feed("abcd\u{4E2D}".as_bytes());
        let snap = grid.snapshot();
        // Row 0 has "abcd" then a default cell (the wide char did NOT fit).
        assert_eq!(snap.cells[0].ch, b'a' as u32);
        assert_eq!(snap.cells[3].ch, b'd' as u32);
        assert_eq!(snap.cells[4].ch, 0);
        assert_eq!(snap.cells[4].width, 1);
        // Row 1 (idx 5..10) starts with the wide char.
        assert_eq!(snap.cells[5].ch, 0x4E2D);
        assert_eq!(snap.cells[5].width, 2);
        assert_eq!(snap.cells[6].width, 0);
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 2);
    }

    #[test]
    fn grid_combining_mark_is_dropped_and_counted() {
        // U+0301 (combining acute accent, width 0). The flat cell DTO
        // can't merge it with the previous cell, so we drop it and
        // bump the unhandled counter rather than corrupting the grid.
        let mut grid = TerminalGrid::new(1, 4);
        grid.feed("e\u{0301}".as_bytes());
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'e' as u32);
        assert_eq!(snap.cells[0].width, 1);
        assert_eq!(snap.cursor_col, 1);
        assert!(snap.unhandled_actions >= 1);
    }

    #[test]
    fn grid_sgr_truecolor_foreground_stamps_cells() {
        // CSI 38 ; 2 ; R ; G ; B m sets truecolor foreground.
        // Then "X" should carry that color; subsequent "Y" after Reset
        // should be back to default.
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"\x1b[38;2;255;100;0mX\x1b[0mY");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'X' as u32);
        assert_eq!(snap.cells[0].fg, rgb_color(255, 100, 0));
        assert_eq!(snap.cells[0].bg, COLOR_DEFAULT);
        assert_eq!(snap.cells[1].ch, b'Y' as u32);
        assert_eq!(snap.cells[1].fg, COLOR_DEFAULT);
    }

    #[test]
    fn grid_sgr_palette_background() {
        // CSI 41 m sets background to ANSI red (palette 1).
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"\x1b[41mZ");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'Z' as u32);
        assert_eq!(snap.cells[0].bg, palette_color(1));
    }

    #[test]
    fn grid_sgr_bold_then_normal() {
        let mut grid = TerminalGrid::new(1, 6);
        grid.feed(b"\x1b[1mA\x1b[22mB");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].attrs & ATTR_BOLD, ATTR_BOLD);
        // CSI 22 m clears bold AND dim.
        assert_eq!(snap.cells[1].attrs & (ATTR_BOLD | ATTR_DIM), 0);
    }

    #[test]
    fn grid_sgr_underline_italic_reverse_strike_combo() {
        let mut grid = TerminalGrid::new(1, 6);
        grid.feed(b"\x1b[3;4;7;9mC");
        let snap = grid.snapshot();
        let want = ATTR_ITALIC | ATTR_UNDERLINE | ATTR_REVERSE | ATTR_STRIKE;
        assert_eq!(snap.cells[0].attrs & want, want);
    }

    #[test]
    fn grid_sgr_reset_clears_state() {
        // Set fg, bg, bold, italic; reset; new char carries no state.
        let mut grid = TerminalGrid::new(1, 4);
        grid.feed(b"\x1b[31;42;1;3mA\x1b[0mB");
        let snap = grid.snapshot();
        assert_ne!(snap.cells[0].fg, COLOR_DEFAULT);
        assert_ne!(snap.cells[0].bg, COLOR_DEFAULT);
        assert_ne!(snap.cells[0].attrs, 0);
        assert_eq!(snap.cells[1].fg, COLOR_DEFAULT);
        assert_eq!(snap.cells[1].bg, COLOR_DEFAULT);
        assert_eq!(snap.cells[1].attrs, 0);
    }

    #[test]
    fn grid_default_cell_serializes_without_color_or_attr_fields() {
        // Wire-shape contract: default cells (the common case for blank
        // screens) ship as { ch, width } only - skip-serializing the
        // sentinel-default fg/bg/attrs keeps snapshot JSON compact.
        let cell = GridCell::default();
        let json = serde_json::to_value(&cell).unwrap();
        assert_eq!(json["ch"], 0);
        assert_eq!(json["width"], 1);
        assert!(json.get("fg").is_none());
        assert!(json.get("bg").is_none());
        assert!(json.get("attrs").is_none());
    }

    #[test]
    fn grid_styled_cell_serializes_color_and_attr_fields() {
        // Inverse of the above: a non-default cell carries fg/bg/attrs
        // on the wire so the renderer can dispatch.
        let mut grid = TerminalGrid::new(1, 2);
        grid.feed(b"\x1b[31;1mX");
        let snap = grid.snapshot();
        let json = serde_json::to_value(&snap.cells[0]).unwrap();
        assert_eq!(json["ch"], b'X' as u32);
        assert!(json.get("fg").is_some());
        assert!(json.get("attrs").is_some());
    }

    #[test]
    fn grid_erase_preserves_current_background() {
        // xterm semantics: EL/ED stamp the current pen's background
        // into erased cells (a TUI that paints a colored row then
        // erases it must keep the color).
        let mut grid = TerminalGrid::new(1, 6);
        // Set bg to ANSI red (palette 1), write "abc", then erase to EOL.
        grid.feed(b"\x1b[41mabc\x1b[K");
        let snap = grid.snapshot();
        // Cells that held glyphs keep their bg from the write; erased cells
        // 3..6 must also carry palette_color(1), not COLOR_DEFAULT.
        assert_eq!(snap.cells[0].bg, palette_color(1));
        assert_eq!(snap.cells[3].bg, palette_color(1));
        assert_eq!(snap.cells[5].bg, palette_color(1));
        // Erased cells have no glyph and no fg.
        assert_eq!(snap.cells[3].ch, 0);
        assert_eq!(snap.cells[3].fg, COLOR_DEFAULT);
    }

    #[test]
    fn grid_erase_after_reset_uses_default_bg() {
        // The complement: after Reset clears the pen, erase falls back to
        // default-bg. Guards against an over-eager "always carry bg" that
        // would re-color cleared regions.
        let mut grid = TerminalGrid::new(1, 4);
        grid.feed(b"\x1b[41mab\x1b[0m\x1b[1;1H\x1b[K");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].bg, COLOR_DEFAULT);
        assert_eq!(snap.cells[3].bg, COLOR_DEFAULT);
    }

    #[test]
    fn grid_resize_bumps_seq() {
        // The snapshot/diff dedupe keys on seq; a resize-only state
        // change (rows/cols/cursor clamp) must observe a new seq or
        // dedupe will drop the visible change.
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"hi");
        let seq_before = grid.seq;
        grid.resize(2, 5);
        assert_eq!(grid.seq, seq_before.wrapping_add(1));
        // No-op resize (same dims) must NOT bump seq.
        let seq_after_resize = grid.seq;
        grid.resize(2, 5);
        assert_eq!(grid.seq, seq_after_resize);
    }

    #[test]
    fn grid_scroll_at_bottom_preserves_current_background() {
        // line_feed at the bottom row scrolls and appends a blank
        // line. That blank line must inherit current_bg, otherwise a
        // TUI streaming colored output at the bottom row gets
        // default-bg stripes whenever the scroll fires (same
        // xterm/ECMA-48 invariant erase preserves).
        let mut grid = TerminalGrid::new(2, 4);
        // Fill row 0 with a colored bg, scroll once via LF at bottom.
        grid.feed(b"\x1b[42mAAAA\r\nBBBB\r\n");
        let snap = grid.snapshot();
        // After two LFs, row 1's blank line was filled at scroll time
        // while bg was still palette green; assert it carries that bg.
        let bottom = &snap.cells[1 * snap.cols as usize];
        assert_eq!(bottom.bg, palette_color(2));
    }

    #[test]
    fn grid_overwrite_left_half_of_wide_clears_stale_continuation() {
        // Write a wide char (occupies col 0-1), then overwrite col 0
        // with a narrow char. The old continuation cell at col 1 must
        // be cleared so the renderer doesn't keep treating col 1 as
        // an unrenderable continuation slot of a glyph that no longer
        // claims width 2.
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed("\u{4E2D}".as_bytes());
        // Cursor is now at col 2. Move back to col 0 and overwrite.
        grid.feed(b"\x1b[1;1HX");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'X' as u32);
        assert_eq!(snap.cells[0].width, 1);
        // The orphaned right half must now be a blank renderable cell,
        // not a width=0 continuation.
        assert_eq!(snap.cells[1].ch, 0);
        assert_eq!(snap.cells[1].width, 1);
    }

    #[test]
    fn grid_overwrite_continuation_clears_stale_left_half() {
        // Inverse case: write a wide char at col 0, then overwrite the
        // RIGHT half (col 1) with a narrow char. The old left-half cell
        // at col 0 must lose its width=2 claim so the renderer doesn't
        // try to span both columns from a glyph that has been broken.
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed("\u{4E2D}".as_bytes());
        grid.feed(b"\x1b[1;2HY");
        let snap = grid.snapshot();
        // Old left half at col 0 is now blank (cleared during sweep).
        assert_eq!(snap.cells[0].ch, 0);
        assert_eq!(snap.cells[0].width, 1);
        assert_eq!(snap.cells[1].ch, b'Y' as u32);
        assert_eq!(snap.cells[1].width, 1);
    }

    #[test]
    fn grid_wide_glyph_overwrites_adjacent_wide_cleanly() {
        // A new wide char written at col 1 must clear the right half
        // (col 2) of an old wide char that started at col 1, AND must
        // also evict any stale left half at col 2 that would otherwise
        // claim col 3 as its continuation.
        let mut grid = TerminalGrid::new(1, 6);
        grid.feed("\u{4E2D}\u{4E2D}".as_bytes()); // wide at 0, wide at 2
        // Move to col 1 and write another wide char.
        grid.feed(b"\x1b[1;2H");
        grid.feed("\u{4E2D}".as_bytes());
        let snap = grid.snapshot();
        // col 0 had a width=2 left half spanning 0-1; sweep cleared it.
        assert_eq!(snap.cells[0].ch, 0);
        assert_eq!(snap.cells[0].width, 1);
        // New wide at col 1 with continuation at col 2.
        assert_eq!(snap.cells[1].ch, 0x4E2D);
        assert_eq!(snap.cells[1].width, 2);
        assert_eq!(snap.cells[2].width, 0);
        // The old wide that previously sat at col 2-3 had its right
        // half (col 3) cleared by the sweep so it's now a blank cell,
        // not an orphaned continuation of a glyph that no longer exists.
        assert_eq!(snap.cells[3].ch, 0);
        assert_eq!(snap.cells[3].width, 1);
    }

    // --- Mode-tracking tests -----------------------------------------

    #[test]
    fn grid_decset_show_cursor_toggles_visibility() {
        let mut grid = TerminalGrid::new(2, 4);
        // Default visible.
        assert!(grid.snapshot().cursor_visible);
        grid.feed(b"\x1b[?25l");
        assert!(!grid.snapshot().cursor_visible);
        grid.feed(b"\x1b[?25h");
        assert!(grid.snapshot().cursor_visible);
    }

    #[test]
    fn grid_decset_application_cursor_keys_toggles_decckm() {
        let mut grid = TerminalGrid::new(2, 4);
        assert!(!grid.snapshot().cursor_keys_app);
        grid.feed(b"\x1b[?1h");
        assert!(grid.snapshot().cursor_keys_app);
        grid.feed(b"\x1b[?1l");
        assert!(!grid.snapshot().cursor_keys_app);
    }

    #[test]
    fn grid_decset_bracketed_paste_toggles() {
        let mut grid = TerminalGrid::new(2, 4);
        assert!(!grid.snapshot().bracketed_paste);
        grid.feed(b"\x1b[?2004h");
        assert!(grid.snapshot().bracketed_paste);
        grid.feed(b"\x1b[?2004l");
        assert!(!grid.snapshot().bracketed_paste);
    }

    #[test]
    fn grid_alt_screen_save_restore_main_state() {
        // Write to main, enter alt, write to alt, exit - main should be
        // intact and alt's content gone.
        let mut grid = TerminalGrid::new(2, 5);
        grid.feed(b"main!");
        grid.feed(b"\x1b[?1049h");
        // Cursor should be at (0, 0) of a fresh alt screen.
        let alt_snap = grid.snapshot();
        assert_eq!(alt_snap.cursor_row, 0);
        assert_eq!(alt_snap.cursor_col, 0);
        assert_eq!(row_string(&alt_snap, 0), "");
        grid.feed(b"alt!!");
        assert_eq!(row_string(&grid.snapshot(), 0), "alt!!");
        grid.feed(b"\x1b[?1049l");
        let restored = grid.snapshot();
        assert_eq!(row_string(&restored, 0), "main!");
        // Cursor restored to where it was before the enter (col 5 = end
        // of "main!"; but cursor advanced past the last col with each
        // write, so we just check it landed back on row 0).
        assert_eq!(restored.cursor_row, 0);
    }

    #[test]
    fn grid_alt_screen_double_enter_is_idempotent() {
        // Two DECSET 1049 in a row must not save the alt content as
        // the new "main" - the second enter should be a no-op so a
        // subsequent DECRST 1049 restores the original main.
        let mut grid = TerminalGrid::new(2, 5);
        grid.feed(b"orig!");
        grid.feed(b"\x1b[?1049h");
        grid.feed(b"alt-1");
        grid.feed(b"\x1b[?1049h"); // no-op
        grid.feed(b"\x1b[?1049l");
        assert_eq!(row_string(&grid.snapshot(), 0), "orig!");
    }

    #[test]
    fn grid_decsc_decrc_save_and_restore_cursor_and_pen() {
        // ESC 7 saves, move cursor + change pen, ESC 8 restores.
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"\x1b[2;3H"); // cursor to (1, 2)
        grid.feed(b"\x1b[31m"); // red fg
        grid.feed(b"\x1b7"); // DECSC
        grid.feed(b"\x1b[1;1H"); // move to (0, 0)
        grid.feed(b"\x1b[34m"); // blue fg
        grid.feed(b"\x1b8"); // DECRC
        let snap = grid.snapshot();
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 2);
        // After restore, write a char and check fg matches the saved red.
        grid.feed(b"X");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[1 * snap.cols as usize + 2].ch, b'X' as u32);
        assert_eq!(snap.cells[1 * snap.cols as usize + 2].fg, palette_color(1));
    }

    #[test]
    fn grid_decstbm_scroll_region_only_scrolls_inside_region() {
        // Set scroll region to rows 1-2 (0-indexed), then trigger LF at
        // the bottom of the region. Row 0 must NOT change; rows 1-2
        // scroll within themselves.
        let mut grid = TerminalGrid::new(4, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
        // DECSTBM rows 2..=3 (1-based), then home (DECSTBM also homes).
        grid.feed(b"\x1b[2;3r");
        // Cursor is at (1, 0). Move to bottom of region (row 2) and LF.
        grid.feed(b"\x1b[3;1H\n");
        let snap = grid.snapshot();
        // Row 0 unchanged, row 1 dropped (was BBBB), row 2 = CCCC,
        // bottom of region (row 2) blanked. Wait actually: scroll the
        // region means line at scroll_top (row 1, BBBB) drops, blank
        // inserted at scroll_bottom (row 2). So row 0 unchanged, row 1
        // = old row 2 (CCCC), row 2 = blank. Row 3 unchanged.
        assert_eq!(row_string(&snap, 0), "AAAA");
        assert_eq!(row_string(&snap, 1), "CCCC");
        assert_eq!(row_string(&snap, 2), "");
        assert_eq!(row_string(&snap, 3), "DDDD");
    }

    #[test]
    fn grid_cursor_next_line_scrolls_inside_region_at_bottom() {
        let mut grid = TerminalGrid::new(4, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
        grid.feed(b"\x1b[2;3r"); // region rows 1..=2, cursor homes to row 1
        grid.feed(b"\x1b[3;4H"); // bottom of region, nonzero col
        grid.feed(b"\x1b[1E"); // CNL: down one line + CR
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "AAAA");
        assert_eq!(row_string(&snap, 1), "CCCC");
        assert_eq!(row_string(&snap, 2), "");
        assert_eq!(row_string(&snap, 3), "DDDD");
        assert_eq!(snap.cursor_row, 2);
        assert_eq!(snap.cursor_col, 0);
    }

    #[test]
    fn grid_cursor_preceding_line_reverse_scrolls_inside_region_at_top() {
        let mut grid = TerminalGrid::new(4, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
        grid.feed(b"\x1b[2;3r"); // region rows 1..=2, cursor homes to row 1
        grid.feed(b"\x1b[2;4H"); // top of region, nonzero col
        grid.feed(b"\x1b[1F"); // CPL: up one line + CR
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "AAAA");
        assert_eq!(row_string(&snap, 1), "");
        assert_eq!(row_string(&snap, 2), "BBBB");
        assert_eq!(row_string(&snap, 3), "DDDD");
        assert_eq!(snap.cursor_row, 1);
        assert_eq!(snap.cursor_col, 0);
    }

    #[test]
    fn grid_alt_screen_resize_preserves_saved_main_dims() {
        // Write to main, enter alt, resize, exit alt - the saved main
        // must come back at the new dimensions, not the originals.
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"hello");
        grid.feed(b"\x1b[?1049h");
        grid.resize(2, 5);
        grid.feed(b"\x1b[?1049l");
        let snap = grid.snapshot();
        assert_eq!(snap.rows, 2);
        assert_eq!(snap.cols, 5);
        assert_eq!(row_string(&snap, 0), "hello");
    }

    #[test]
    fn grid_snapshot_skips_default_mode_fields() {
        // Wire-shape contract: a fresh grid with default mode state
        // (visible cursor, no DECCKM, no bracketed paste) must NOT ship
        // those fields - they're skip-serialized when default.
        let grid = TerminalGrid::new(2, 4);
        let body = TerminalSnapshotBody::Grid(grid.snapshot());
        let snap = TerminalSnapshot { seq: 0, body };
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json["payload"].get("cursorVisible").is_none());
        assert!(json["payload"].get("cursorKeysApp").is_none());
        assert!(json["payload"].get("bracketedPaste").is_none());
    }

    #[test]
    fn grid_snapshot_includes_non_default_mode_fields() {
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"\x1b[?25l\x1b[?1h\x1b[?2004h");
        let body = TerminalSnapshotBody::Grid(grid.snapshot());
        let snap = TerminalSnapshot { seq: 0, body };
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["payload"]["cursorVisible"], false);
        assert_eq!(json["payload"]["cursorKeysApp"], true);
        assert_eq!(json["payload"]["bracketedPaste"], true);
    }

    #[test]
    fn grid_decset_then_decrst_round_trips_to_default_wire_shape() {
        // Round-trip: flip every mode on then back off; the snapshot must
        // skip-serialize the fields again so DECRST does not leave residual
        // false/true values on the wire that defeat the compaction.
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"\x1b[?25l\x1b[?1h\x1b[?2004h");
        grid.feed(b"\x1b[?25h\x1b[?1l\x1b[?2004l");
        let body = TerminalSnapshotBody::Grid(grid.snapshot());
        let snap = TerminalSnapshot { seq: 0, body };
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json["payload"].get("cursorVisible").is_none());
        assert!(json["payload"].get("cursorKeysApp").is_none());
        assert!(json["payload"].get("bracketedPaste").is_none());
    }

    #[test]
    fn grid_decstbm_inverted_region_is_ignored() {
        // xterm convention: DECSTBM with bottom <= top is silently ignored,
        // including no cursor home. Our prior code reset to full screen
        // AND homed the cursor, which could displace a TUI cursor on a
        // malformed CSI r. Pin the silent-ignore behavior so the regression
        // can't reappear.
        let mut grid = TerminalGrid::new(4, 5);
        // Set a valid region first so we can detect that an invalid one
        // does not overwrite it.
        grid.feed(b"\x1b[2;3r"); // region rows 1..=2, cursor homes to (1, 0)
        assert_eq!(grid.cursor_row, 1);
        assert_eq!(grid.scroll_top, 1);
        assert_eq!(grid.scroll_bottom, 2);
        // Move cursor away to detect the (illegal) home that the prior
        // reset-on-inverted code would have performed.
        grid.feed(b"\x1b[4;3H");
        assert_eq!(grid.cursor_row, 3);
        assert_eq!(grid.cursor_col, 2);
        // Inverted region: bottom 2, top 4 (1-based). Must be a no-op.
        grid.feed(b"\x1b[4;2r");
        assert_eq!(grid.scroll_top, 1);
        assert_eq!(grid.scroll_bottom, 2);
        assert_eq!(grid.cursor_row, 3);
        assert_eq!(grid.cursor_col, 2);
    }

    // --- Device-query response tests ---------------------------------

    #[test]
    fn grid_da1_responds_with_vt220() {
        // Fish + bash + zsh send `\x1b[c` on startup. Without a reply
        // fish prints a 10s timeout warning. Reply with the bare
        // VT220 attribute string `\x1b[?62;c`.
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"\x1b[c");
        assert_eq!(grid.drain_responses(), b"\x1b[?62;c");
        // Drain is one-shot: a second call returns empty.
        assert!(grid.drain_responses().is_empty());
    }

    #[test]
    fn grid_da2_da3_status_xtversion_responses() {
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"\x1b[>c");
        assert_eq!(grid.drain_responses(), b"\x1b[>1;0;0c");
        grid.feed(b"\x1b[=c");
        assert_eq!(grid.drain_responses(), b"\x1bP!|00000000\x1b\\");
        grid.feed(b"\x1b[5n");
        assert_eq!(grid.drain_responses(), b"\x1b[0n");
        grid.feed(b"\x1b[>q");
        assert_eq!(
            grid.drain_responses(),
            b"\x1bP>|seren-desktop\x1b\\"
        );
    }

    #[test]
    fn grid_dsr_cpr_reports_one_based_cursor() {
        // DSR 6 (`\x1b[6n`) asks for the cursor position and expects a
        // 1-based `\x1b[<row>;<col>R` reply.
        let mut grid = TerminalGrid::new(5, 10);
        grid.feed(b"\x1b[3;7H"); // cursor to (1-based 3, 7) = (2, 6) 0-based
        grid.feed(b"\x1b[6n");
        assert_eq!(grid.drain_responses(), b"\x1b[3;7R");
    }

    #[test]
    fn grid_multiple_queries_in_one_chunk_concatenate_in_order() {
        // A single PTY chunk can carry several capability probes; the
        // responses must concatenate in arrival order so the receiving
        // shell parses them as a sequence rather than getting one reply
        // and missing the rest. Mixed in some plain-text writes and a
        // cursor move to verify queries interleave with grid mutations
        // without losing or reordering responses.
        let mut grid = TerminalGrid::new(3, 10);
        grid.feed(b"\x1b[chi\x1b[5n\x1b[2;3H\x1b[6n");
        // Expected order: DA1 reply, DSR 5 OK, DSR 6 cursor at (2, 3)
        // after the explicit move to row 2 col 3.
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(b"\x1b[?62;c");
        expected.extend_from_slice(b"\x1b[0n");
        expected.extend_from_slice(b"\x1b[2;3R");
        assert_eq!(grid.drain_responses(), expected);
        // The plain text "hi" still landed in the grid in the right
        // place (row 0 cols 0-1) before the cursor move.
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'h' as u32);
        assert_eq!(snap.cells[1].ch, b'i' as u32);
    }

    // --- DEC line drawing + IRM tests --------------------------------

    #[test]
    fn grid_dec_line_drawing_via_so_si_renders_box_glyphs() {
        // Real-world pattern: designate DEC line drawing as G1, SO to
        // shift in, write the box bytes, SI to shift back to G0.
        let mut grid = TerminalGrid::new(2, 8);
        grid.feed(b"\x1b)0\x0elqk\x0fA");
        let snap = grid.snapshot();
        // q -> horizontal line, l -> upper-left, k -> upper-right
        assert_eq!(snap.cells[0].ch, '\u{250C}' as u32);
        assert_eq!(snap.cells[1].ch, '\u{2500}' as u32);
        assert_eq!(snap.cells[2].ch, '\u{2510}' as u32);
        // After SI we're back on G0 (ASCII), so 'A' renders literally.
        assert_eq!(snap.cells[3].ch, b'A' as u32);
    }

    #[test]
    fn grid_dec_line_drawing_g0_translates_without_shift() {
        // Designating DEC line drawing as G0 means subsequent printable
        // bytes get translated immediately (no SI/SO needed - G0 is
        // already the active set by default).
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"\x1b(0qx");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, '\u{2500}' as u32); // q -> hline
        assert_eq!(snap.cells[1].ch, '\u{2502}' as u32); // x -> vline
    }

    #[test]
    fn grid_charset_reset_restores_ascii() {
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"\x1b(0q\x1b(Bq");
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, '\u{2500}' as u32);
        // After designating ASCII as G0, 'q' renders literally again.
        assert_eq!(snap.cells[1].ch, b'q' as u32);
    }

    #[test]
    fn grid_irm_insert_mode_shifts_existing_cells_right() {
        // Write "abcde", move cursor to col 2, enable IRM (ESC [ 4 h),
        // write 'X'. Result should be "abXcd" with 'e' falling off the
        // right margin since the line is 5 cols.
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"abcde");
        grid.feed(b"\x1b[1;3H"); // cursor to row 1 col 3 (1-based) = col 2
        grid.feed(b"\x1b[4hX");
        let snap = grid.snapshot();
        assert_eq!(row_string(&snap, 0), "abXcd");
        // Cursor advanced past the inserted glyph.
        assert_eq!(snap.cursor_col, 3);
    }

    #[test]
    fn grid_irm_reset_returns_to_replace_mode() {
        // Toggle IRM off (`\x1b[4l`); subsequent writes overwrite as
        // before instead of inserting.
        let mut grid = TerminalGrid::new(1, 5);
        grid.feed(b"abcde");
        grid.feed(b"\x1b[1;3H"); // col 2
        grid.feed(b"\x1b[4hX"); // insert
        grid.feed(b"\x1b[4lY"); // replace mode + write 'Y'
        let snap = grid.snapshot();
        // After insert: "abXcd". Cursor at col 3. Reset IRM. Write 'Y'
        // at col 3 in replace mode overwrites the 'c'.
        assert_eq!(row_string(&snap, 0), "abXYd");
    }

    // --- Grid-diff tests ---------------------------------------------

    #[test]
    fn grid_initial_drain_diff_marks_every_row() {
        // Fresh grid has all rows dirty so the first diff carries the
        // whole grid. After drain, all rows are clean.
        let mut grid = TerminalGrid::new(3, 5);
        let diff = grid.drain_diff();
        assert_eq!(diff.base_seq, 0);
        assert_eq!(diff.seq, 0);
        assert_eq!(diff.rows.len(), 3);
        assert_eq!(diff.rows_total, 3);
        assert_eq!(diff.cols_total, 5);
        // Second drain (no mutations) returns no rows but still
        // includes cursor + mode state.
        let diff2 = grid.drain_diff();
        assert!(diff2.rows.is_empty());
        assert_eq!(diff2.cursor_row, 0);
        assert_eq!(diff2.cursor_col, 0);
    }

    #[test]
    fn grid_write_marks_only_cursor_row_dirty() {
        let mut grid = TerminalGrid::new(3, 5);
        let _ = grid.drain_diff(); // clear initial all-dirty
        grid.feed(b"hi");
        let diff = grid.drain_diff();
        // Only row 0 should be dirty; cursor stayed on row 0.
        assert_eq!(diff.rows.len(), 1);
        assert_eq!(diff.rows[0].row, 0);
        assert_eq!(diff.rows[0].cells[0].ch, b'h' as u32);
        assert_eq!(diff.rows[0].cells[1].ch, b'i' as u32);
    }

    #[test]
    fn grid_line_feed_into_scroll_emits_scroll_op_and_inserted_row() {
        // Scroll-on-LF shifts clean rows via a scroll op instead of
        // shipping the whole region. The diff only needs the inserted
        // blank row unless some shifted row was already dirty.
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC");
        let _ = grid.drain_diff();
        grid.feed(b"\r\n"); // CR then LF at bottom triggers scroll
        let diff = grid.drain_diff();
        assert_eq!(diff.scrolls.len(), 1);
        assert_eq!(diff.scrolls[0].top, 0);
        assert_eq!(diff.scrolls[0].bottom, 2);
        assert_eq!(diff.scrolls[0].delta, 1);
        let dirty_rows: Vec<u16> = diff.rows.iter().map(|r| r.row).collect();
        assert_eq!(dirty_rows, vec![2]);
    }

    #[test]
    fn grid_scroll_dirty_rows_shift_with_scroll_op() {
        // If a row was dirty before a scroll, its dirty bit moves with the
        // row. The frontend applies the scroll op first, then patches this
        // final row index.
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC");
        let _ = grid.drain_diff();
        grid.feed(b"\x1b[2;1Hxx\x1b[3;5H\n");
        let diff = grid.drain_diff();
        let dirty_rows: Vec<u16> = diff.rows.iter().map(|r| r.row).collect();
        assert_eq!(diff.scrolls.len(), 1);
        assert_eq!(diff.scrolls[0].delta, 1);
        assert_eq!(dirty_rows, vec![0, 2]);
        assert_eq!(row_string_from_cells(&diff.rows[0].cells), "xxBB");
    }

    #[test]
    fn grid_consecutive_scrolls_coalesce() {
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"AAAA\r\nBBBB\r\nCCCC");
        let _ = grid.drain_diff();
        grid.feed(b"\n\n");
        let diff = grid.drain_diff();
        assert_eq!(diff.scrolls.len(), 1);
        assert_eq!(diff.scrolls[0].delta, 2);
    }

    #[test]
    fn grid_resize_marks_every_row_dirty_and_carries_dims() {
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"x");
        let _ = grid.drain_diff();
        grid.resize(2, 4);
        let diff = grid.drain_diff();
        assert_eq!(diff.rows.len(), 2);
        assert_eq!(diff.rows_total, 2);
        assert_eq!(diff.cols_total, 4);
    }

    #[test]
    fn grid_resize_diff_is_contiguous_with_prior_seq() {
        // terminal_resize emits a diff inline so the renderer sees the
        // new dims without waiting for the next PTY read. The diff range
        // must start at the prior drained seq and end at the resize seq.
        let mut grid = TerminalGrid::new(3, 5);
        grid.feed(b"x");
        let prior = grid.drain_diff();
        grid.resize(2, 4);
        let diff = grid.drain_diff();
        assert_eq!(diff.base_seq, prior.seq);
        assert_eq!(diff.seq, prior.seq + 1);
    }

    #[test]
    fn grid_diff_range_covers_coalesced_feed_seqs() {
        // The diff's seq must equal the grid's current seq so the
        // frontend can advance to the latest state. base_seq records the
        // seq covered by the previous drain, so one diff may safely cover
        // several feed seqs coalesced by the 60fps emitter.
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"a");
        let diff1 = grid.drain_diff();
        assert_eq!(diff1.base_seq, 0);
        assert_eq!(diff1.seq, grid.seq);
        grid.feed(b"b");
        grid.feed(b"c");
        grid.feed(b"d");
        let diff2 = grid.drain_diff();
        assert_eq!(diff2.base_seq, diff1.seq);
        assert_eq!(diff2.seq, grid.seq);
        assert_eq!(diff2.seq, diff1.seq + 3);
    }

    #[test]
    fn grid_diff_carries_current_mode_state() {
        let mut grid = TerminalGrid::new(2, 4);
        grid.feed(b"\x1b[?25l\x1b[?1h\x1b[?2004h");
        let diff = grid.drain_diff();
        assert!(!diff.cursor_visible);
        assert!(diff.cursor_keys_app);
        assert!(diff.bracketed_paste);
    }
}
