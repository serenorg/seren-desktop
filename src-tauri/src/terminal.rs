// ABOUTME: In-memory terminal buffer runtime backed by local pseudoterminals.
// ABOUTME: Owns PTY state plus a rolling raw-output buffer and exposes snapshot/diff IPC.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use termwiz::escape::{
    Action, ControlCode,
    csi::{CSI, Cursor, Edit, EraseInDisplay, EraseInLine},
    parser::Parser,
};
use unicode_width::UnicodeWidthChar;
use uuid::Uuid;

const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_EXIT_EVENT: &str = "terminal://exit";
const TERMINAL_BUFFER_CAP: usize = 200_000;

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
    output: Arc<Mutex<RawOutputBuffer>>,
    /// Stage 2 parsed grid, fed in parallel with the raw output buffer. The
    /// raw buffer remains the authoritative source for the existing <pre>
    /// renderer; the grid is what Stage 3's canvas renderer will read.
    grid: Arc<Mutex<TerminalGrid>>,
}

/// Authoritative rolling buffer of decoded PTY output. Stage 1 holds raw text
/// behind a sequence counter so the frontend can rehydrate after a remount
/// without losing chunks that arrived between snapshot and event-listener
/// install. Stage 2 will swap the body for parsed terminal grid state behind
/// the same snapshot/diff API.
struct RawOutputBuffer {
    data: String,
    seq: u32,
    cap: usize,
}

impl RawOutputBuffer {
    fn new(cap: usize) -> Self {
        Self {
            data: String::new(),
            seq: 0,
            cap,
        }
    }

    /// Append a chunk and return the new sequence number. Trims the head when
    /// the buffer exceeds `cap`, aligning the new start to a UTF-8 char
    /// boundary so subsequent slices stay valid.
    fn append(&mut self, chunk: &str) -> u32 {
        self.data.push_str(chunk);
        if self.data.len() > self.cap {
            let target_start = self.data.len() - self.cap;
            let mut start = target_start;
            while start < self.data.len() && !self.data.is_char_boundary(start) {
                start += 1;
            }
            self.data.replace_range(..start, "");
        }
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    fn snapshot(&self) -> TerminalSnapshot {
        TerminalSnapshot {
            seq: self.seq,
            body: TerminalSnapshotBody::RawText {
                data: self.data.clone(),
            },
        }
    }
}

/// Stage 2 emulator grid. Owns a termwiz `Parser` that turns raw PTY bytes
/// into structured `Action`s, and an apply loop that mutates a 2D cell grid.
/// The action set we interpret is intentionally limited for Stage 2 (see
/// `apply_action`); unhandled actions are dropped and noted in `unhandled`
/// counters so we can grow coverage as Stage 3's renderer surfaces real
/// output gaps. The parser is a pure function of byte history, so dropping
/// an action only loses that one mutation - the next action that arrives
/// applies cleanly against the current state.
struct TerminalGrid {
    parser: Parser,
    rows: u16,
    cols: u16,
    cells: Vec<Vec<GridCell>>,
    cursor_row: u16,
    cursor_col: u16,
    seq: u32,
    /// Counts actions we received but did not interpret. Surfaced in the
    /// snapshot so Stage 3 can warn the user when the rendered grid is
    /// expected to be incomplete versus the source PTY stream.
    unhandled_actions: u32,
}

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
}

impl Default for GridCell {
    fn default() -> Self {
        Self { ch: 0, width: 1 }
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
            cursor_row: 0,
            cursor_col: 0,
            seq: 0,
            unhandled_actions: 0,
        }
    }

    /// Parse `bytes` and apply each emitted Action against the grid. Each
    /// chunk increments seq once regardless of how many actions it produced
    /// so callers can dedupe at chunk granularity (matches the RawOutputBuffer
    /// model).
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
        }
    }

    /// Resize the grid, preserving overlapping cells. New cells are blank,
    /// dropped cells are gone. Cursor clamps to the new bounds. Bumps `seq`
    /// because rows/cols/cells/cursor have all visibly changed - Stage 3's
    /// snapshot/diff dedupe must observe a resize-only state change as a
    /// new revision rather than a no-op tied to the last byte chunk's seq.
    fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(1);
        let cols = cols.max(1);
        if rows == self.rows && cols == self.cols {
            return;
        }
        let mut new_cells = vec![vec![GridCell::default(); cols as usize]; rows as usize];
        let copy_rows = (rows.min(self.rows)) as usize;
        let copy_cols = (cols.min(self.cols)) as usize;
        for (new_row, old_row) in new_cells
            .iter_mut()
            .zip(self.cells.iter())
            .take(copy_rows)
        {
            new_row[..copy_cols].copy_from_slice(&old_row[..copy_cols]);
        }
        self.cells = new_cells;
        self.rows = rows;
        self.cols = cols;
        self.cursor_row = self.cursor_row.min(rows.saturating_sub(1));
        self.cursor_col = self.cursor_col.min(cols.saturating_sub(1));
        self.seq = self.seq.wrapping_add(1);
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
            // Stage 2 deliberately ignores Esc (single-char escape sequences
            // like DECALN, RIS), DeviceControl, OSC (titles, hyperlinks),
            // Sixel/KittyImage, and XtGetTcap. Each is its own well-bounded
            // expansion. Counted so the gap is visible in snapshots.
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn write_char(&mut self, c: char) {
        let width = UnicodeWidthChar::width(c).unwrap_or(1) as u16;
        if width == 0 {
            // Combining marks / zero-width-joiner / variation selectors. A
            // proper emulator merges these onto the previous cell as part of
            // the same grapheme cluster; Stage 2's flat one-codepoint-per-
            // cell DTO can't represent that yet, so we drop them rather
            // than corrupting the next cell with an invisible mark.
            // Counted so the gap is visible in snapshots.
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
        // Defensive bounds: resize races could in theory leave the cursor
        // out of range until the next clamp; just no-op rather than panic.
        if row < self.cells.len() && col < self.cells[row].len() {
            self.cells[row][col] = GridCell {
                ch: c as u32,
                width: width as u8,
            };
            // Width-2 char occupies col and col+1. Mark col+1 as a
            // continuation slot (width=0) so the renderer doesn't try to
            // draw a glyph there independently. Also evicts whatever
            // single-cell glyph used to live in col+1.
            if width == 2 && col + 1 < self.cells[row].len() {
                self.cells[row][col + 1] = GridCell { ch: 0, width: 0 };
            }
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
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
        }
    }

    fn apply_csi(&mut self, csi: CSI) {
        match csi {
            CSI::Cursor(c) => self.apply_cursor(c),
            CSI::Edit(e) => self.apply_edit(e),
            // SGR (colors / attrs), Mode (alt-screen, mouse, etc.), Window,
            // Mouse, Keyboard, Device deferred. Every additional handler
            // here is one step closer to "flawless codex/claude".
            _ => {
                self.unhandled_actions = self.unhandled_actions.saturating_add(1);
            }
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

    fn erase_in_line(&mut self, mode: EraseInLine) {
        let row = self.cursor_row as usize;
        if row >= self.cells.len() {
            return;
        }
        let col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let blank = GridCell::default();
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
    }

    fn erase_in_display(&mut self, mode: EraseInDisplay) {
        let blank = GridCell::default();
        match mode {
            EraseInDisplay::EraseToEndOfDisplay => {
                self.erase_in_line(EraseInLine::EraseToEndOfLine);
                let next_row = self.cursor_row as usize + 1;
                for r in next_row..self.cells.len() {
                    for c in 0..self.cols as usize {
                        self.cells[r][c] = blank;
                    }
                }
            }
            EraseInDisplay::EraseToStartOfDisplay => {
                let row = self.cursor_row as usize;
                for r in 0..row.min(self.cells.len()) {
                    for c in 0..self.cols as usize {
                        self.cells[r][c] = blank;
                    }
                }
                self.erase_in_line(EraseInLine::EraseToStartOfLine);
            }
            EraseInDisplay::EraseDisplay | EraseInDisplay::EraseScrollback => {
                for row in &mut self.cells {
                    for cell in row.iter_mut() {
                        *cell = blank;
                    }
                }
            }
        }
    }

    /// Move cursor down one row; if we'd fall off the bottom, scroll the
    /// grid up by one row (oldest row drops, new blank row appended).
    fn line_feed(&mut self) {
        if self.cursor_row + 1 < self.rows {
            self.cursor_row += 1;
        } else {
            self.cells.remove(0);
            self.cells.push(vec![GridCell::default(); self.cols as usize]);
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
struct TerminalOutputEvent {
    buffer_id: String,
    seq: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    buffer_id: String,
}

/// Versioned snapshot envelope. Stage 1 only emits `RawText`; Stage 2 will
/// add a `Grid` variant carrying parsed cell state, cursor, modes, and
/// image placements. The discriminator + payload split keeps that future
/// addition from being a breaking IPC change for callers that already
/// pattern-match on `kind`.
///
/// Wire shape (Stage 1):
///   { "seq": 5, "kind": "raw-text", "payload": { "data": "..." } }
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
    RawText { data: String },
    /// Stage 2: parsed grid. Wire shape:
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

    let output = Arc::new(Mutex::new(RawOutputBuffer::new(TERMINAL_BUFFER_CAP)));
    let grid = Arc::new(Mutex::new(TerminalGrid::new(rows, cols)));

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
                writer: Arc::new(Mutex::new(writer)),
                child: Arc::new(Mutex::new(child)),
                output: Arc::clone(&output),
                grid: Arc::clone(&grid),
            },
        );
    }

    if let Err(spawn_err) =
        spawn_reader_thread(app.clone(), id.clone(), reader, output, grid)
    {
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
    // reads cells at the new dimensions on the next snapshot.
    if let Ok(mut g) = process.grid.lock() {
        g.resize(rows, cols);
    }
    Ok(process.info.clone())
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

#[tauri::command]
pub fn terminal_snapshot(
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
    let output = Arc::clone(&process.output);
    drop(buffers);

    let snapshot = output
        .lock()
        .map(|buffer| buffer.snapshot())
        .map_err(|err| format!("Terminal output mutex poisoned: {err}"))?;
    Ok(snapshot)
}

/// Stage 2: returns the parsed grid snapshot. Stage 3's canvas renderer
/// will call this on mount and then subscribe to grid diff events; the
/// existing `terminal_snapshot` (raw text) stays alive so the current
/// `<pre>` renderer keeps working unchanged during the migration.
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
    output: Arc<Mutex<RawOutputBuffer>>,
    grid: Arc<Mutex<TerminalGrid>>,
) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("terminal-reader-{buffer_id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            // Carries trailing bytes that look like an incomplete UTF-8 sequence
            // across PTY reads, so multi-byte characters split at chunk boundaries
            // do not surface as replacement characters.
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Feed the parser the RAW bytes (it manages its own
                        // partial-sequence carry internally and does not care
                        // about UTF-8 chunk boundaries). The grid mutation is
                        // independent of the raw-text path's UTF-8 buffering.
                        if let Ok(mut g) = grid.lock() {
                            g.feed(&buf[..n]);
                        }
                        let data = drain_utf8(&mut carry, &buf[..n]);
                        if !data.is_empty() {
                            // Append to the authoritative buffer first so a
                            // concurrent terminal_snapshot caller observes the
                            // chunk before the same chunk's event reaches the
                            // frontend; the seq returned here is what the
                            // frontend uses to dedupe against the snapshot.
                            let seq = output
                                .lock()
                                .map_or(0, |mut buffer| buffer.append(&data));
                            let _ = app.emit(
                                TERMINAL_OUTPUT_EVENT,
                                TerminalOutputEvent {
                                    buffer_id: buffer_id.clone(),
                                    seq,
                                    data,
                                },
                            );
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }

            if !carry.is_empty() {
                let tail = String::from_utf8_lossy(&carry).into_owned();
                let seq = output
                    .lock()
                    .map_or(0, |mut buffer| buffer.append(&tail));
                let _ = app.emit(
                    TERMINAL_OUTPUT_EVENT,
                    TerminalOutputEvent {
                        buffer_id: buffer_id.clone(),
                        seq,
                        data: tail,
                    },
                );
            }

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
fn drain_utf8(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let split = utf8_complete_prefix(carry);
    if split == 0 {
        return String::new();
    }
    let complete: Vec<u8> = carry.drain(..split).collect();
    String::from_utf8_lossy(&complete).into_owned()
}

/// Returns the length of the prefix of `buf` that contains only complete UTF-8
/// sequences. The remaining suffix (length 0..=3) may be the start of a
/// multi-byte character whose continuation bytes have not arrived yet.
fn utf8_complete_prefix(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }
    // Walk back at most 3 bytes from the end to find the start of the last
    // potentially incomplete codepoint.
    let max_back = len.min(4);
    for i in 1..=max_back {
        let idx = len - i;
        let b = buf[idx];
        if b < 0x80 {
            // Single-byte ASCII codepoint; the trailing region after it
            // contains only ASCII bytes (i == 1) or continuation bytes that
            // belong to no leader, which lossy decode will replace.
            return len;
        }
        if b < 0xC0 {
            // Continuation byte; keep walking back to the lead byte.
            continue;
        }
        let needed = if b < 0xE0 {
            1
        } else if b < 0xF0 {
            2
        } else {
            3
        };
        let trailing = len - idx - 1;
        return if trailing >= needed { len } else { idx };
    }
    // Buffer is all continuation bytes with no lead in range; let lossy decode
    // handle them rather than buffering forever.
    len
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

    #[test]
    fn utf8_prefix_full_when_only_ascii() {
        assert_eq!(utf8_complete_prefix(b"hello"), 5);
    }

    #[test]
    fn utf8_prefix_holds_back_partial_lead() {
        // 0xE2 starts a 3-byte sequence but only 1 of 2 continuation bytes is here.
        let buf = [b'a', 0xE2, 0x82];
        assert_eq!(utf8_complete_prefix(&buf), 1);
    }

    #[test]
    fn utf8_prefix_releases_when_sequence_complete() {
        // Full euro sign: 0xE2 0x82 0xAC
        let buf = [b'a', 0xE2, 0x82, 0xAC];
        assert_eq!(utf8_complete_prefix(&buf), 4);
    }

    fn snapshot_data(snap: &TerminalSnapshot) -> &str {
        match &snap.body {
            TerminalSnapshotBody::RawText { data } => data.as_str(),
            TerminalSnapshotBody::Grid(_) => panic!("expected raw-text snapshot"),
        }
    }

    #[test]
    fn raw_buffer_increments_seq_per_append() {
        let mut buf = RawOutputBuffer::new(1024);
        assert_eq!(buf.append("hello"), 1);
        assert_eq!(buf.append(" world"), 2);
        let snap = buf.snapshot();
        assert_eq!(snap.seq, 2);
        assert_eq!(snapshot_data(&snap), "hello world");
    }

    #[test]
    fn raw_buffer_trims_at_char_boundary() {
        // cap=4 forces a trim. Multi-byte chars must not be split mid-codepoint.
        let mut buf = RawOutputBuffer::new(4);
        let seq1 = buf.append("ab");
        let seq2 = buf.append("\u{20AC}\u{20AC}"); // two euro signs, 3 bytes each
        assert_eq!(seq1, 1);
        assert_eq!(seq2, 2);
        let snap = buf.snapshot();
        // Buffer was "ab\u{20AC}\u{20AC}" (8 bytes). target_start = 8 - 4 = 4
        // lands inside the first euro (bytes 2..5); the loop walks forward to
        // index 5, the start of the second euro. Result: a single euro,
        // exactly 3 bytes - within the cap, never overshooting by more than
        // (largest UTF-8 codepoint - 1) = 3 bytes.
        let data = snapshot_data(&snap);
        assert_eq!(data, "\u{20AC}");
        assert_eq!(data.len(), 3);
        assert!(data.len() <= 4 + 3);
        assert!(data.is_char_boundary(0));
        assert!(data.is_char_boundary(data.len()));
        assert_eq!(snap.seq, 2);
    }

    #[test]
    fn raw_buffer_trim_overshoots_cap_by_at_most_three() {
        // Pathological case: append a single 4-byte codepoint to a cap=1
        // buffer. target_start = 4 - 1 = 3 falls inside the codepoint; the
        // loop walks to index 4 (== data.len(), always a char boundary), so
        // the buffer is emptied rather than producing an over-cap result.
        let mut buf = RawOutputBuffer::new(1);
        buf.append("\u{1F600}"); // 4-byte UTF-8
        let snap = buf.snapshot();
        // After trim the codepoint is gone - we don't keep partial chars.
        assert_eq!(snapshot_data(&snap), "");
    }

    #[test]
    fn snapshot_serializes_with_versioned_envelope() {
        // Wire shape contract: { seq, kind: "raw-text", payload: { data } }.
        // Stage 2's grid variant will plug in as another `kind` without
        // breaking callers that pattern-match on this discriminator.
        let mut buf = RawOutputBuffer::new(1024);
        buf.append("hello");
        let snap = buf.snapshot();
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["seq"], 1);
        assert_eq!(json["kind"], "raw-text");
        assert_eq!(json["payload"]["data"], "hello");
        // The pre-1.5 flat shape (`{ seq, data }`) must NOT round-trip; if
        // the envelope flattens accidentally callers won't notice until
        // Stage 2 lands and breaks.
        assert!(json.get("data").is_none());
    }

    #[test]
    fn drain_utf8_carries_partial_then_releases() {
        let mut carry = Vec::new();
        let first = drain_utf8(&mut carry, &[b'a', 0xE2, 0x82]);
        assert_eq!(first, "a");
        assert_eq!(carry, vec![0xE2, 0x82]);

        let second = drain_utf8(&mut carry, &[0xAC, b'b']);
        assert_eq!(second, "\u{20AC}b");
        assert!(carry.is_empty());
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
        // SGR (color) and OSC (window title) are not interpreted yet; both
        // should increment the counter rather than being applied silently.
        grid.feed(b"\x1b[31mred text\x1b[0m");
        grid.feed(b"\x1b]0;new title\x07");
        let snap = grid.snapshot();
        // The text portion is still printed; only the SGR / OSC frames go
        // unhandled.
        assert!(row_string(&snap, 0).contains("red text"));
        assert!(snap.unhandled_actions > 0);
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
        // does not jump back to the previous row (we don't implement reverse
        // wrap in Stage 2 - matches xterm default for plain BS).
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
        // U+0301 (combining acute accent, width 0). Stage 2's flat cell DTO
        // can't merge it with the previous cell, so we drop it and bump the
        // unhandled counter rather than corrupting the grid.
        let mut grid = TerminalGrid::new(1, 4);
        grid.feed("e\u{0301}".as_bytes());
        let snap = grid.snapshot();
        assert_eq!(snap.cells[0].ch, b'e' as u32);
        assert_eq!(snap.cells[0].width, 1);
        assert_eq!(snap.cursor_col, 1);
        assert!(snap.unhandled_actions >= 1);
    }

    #[test]
    fn grid_resize_bumps_seq() {
        // Stage 3's snapshot/diff dedupe will key on seq; a resize-only
        // state change (rows/cols/cursor clamp) must observe a new seq or
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
}
