// ABOUTME: Intercepts Claude Code auto-memory writes and redirects them to SerenDB.
// ABOUTME: Watches ~/.claude/projects/*/memory/ and persists via the existing memory stack.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::memory::{MemoryState, persist_memory_local};

/// Memory type tag persisted alongside Claude preference memories so they can be
/// filtered from ordinary conversational memories in the future.
pub const CLAUDE_PREFERENCE_MEMORY_TYPE: &str = "claude_preference";

/// Filename Claude Code itself reads at session start. We never persist user data
/// into this file directly — it is always rendered from the DB on demand.
const RENDERED_INDEX_FILENAME: &str = "MEMORY.md";

/// File we persist a stable project identifier to when no git remote is available.
/// Lives under the project's `.claude/` directory so it travels with the project.
const PROJECT_ID_FILENAME: &str = "project_id";

/// Parsed frontmatter extracted from a Claude memory markdown file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub memory_type: Option<String>,
}

/// Result of parsing a Claude memory `.md` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMemoryFile {
    pub frontmatter: MemoryFrontmatter,
    pub body: String,
}

/// Stable identity for a project directory. Survives clones and different machines
/// as long as the project has a git remote or a persisted UUID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectIdentity {
    pub identifier: String,
    pub source: ProjectIdentitySource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectIdentitySource {
    GitRemote,
    PersistedUuid,
    GeneratedUuid,
}

/// Event emitted to the frontend whenever the watcher intercepts a memory file.
#[derive(Debug, Clone, Serialize)]
pub struct InterceptEvent {
    pub path: String,
    pub name: Option<String>,
    pub memory_type: String,
    pub persisted_id: String,
    pub deleted: bool,
}

/// Global watcher state, modeled after `sync.rs` for consistency.
struct WatcherState {
    watcher: Option<RecommendedWatcher>,
    stop_sender: Option<Sender<()>>,
    roots: Vec<PathBuf>,
    running: bool,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watcher: None,
            stop_sender: None,
            roots: Vec::new(),
            running: false,
        }
    }
}

lazy_static::lazy_static! {
    static ref CLAUDE_WATCHER_STATE: Arc<Mutex<WatcherState>> =
        Arc::new(Mutex::new(WatcherState::default()));
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/// Return the `~/.claude/projects` directory, creating it if necessary.
pub fn claude_projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

/// Encode an absolute project directory the same way Claude Code does:
/// `/Users/a/b` -> `-Users-a-b`. Used by callers that want to locate the matching
/// `~/.claude/projects/<encoded>/` directory.
pub fn encode_project_dir(cwd: &Path) -> String {
    let resolved = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    let sanitized = resolved.trim_start_matches('/').replace(':', "");
    format!("-{}", sanitized.replace('/', "-"))
}

/// Resolve a stable identity for a project directory.
///
/// Priority order:
///   1. Normalized git remote URL (same repo → same identity on any machine).
///   2. UUID already persisted at `<cwd>/.claude/project_id`.
///   3. A freshly generated UUID, persisted to the same path for future calls.
pub fn resolve_project_identity(cwd: &Path) -> Result<ProjectIdentity, String> {
    if let Some(remote) = read_git_remote_url(cwd) {
        return Ok(ProjectIdentity {
            identifier: normalize_git_remote(&remote),
            source: ProjectIdentitySource::GitRemote,
        });
    }

    let dot_claude = cwd.join(".claude");
    let id_path = dot_claude.join(PROJECT_ID_FILENAME);

    if let Ok(existing) = fs::read_to_string(&id_path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(ProjectIdentity {
                identifier: trimmed,
                source: ProjectIdentitySource::PersistedUuid,
            });
        }
    }

    fs::create_dir_all(&dot_claude)
        .map_err(|e| format!("failed to create .claude directory: {e}"))?;
    let fresh = uuid::Uuid::new_v4().to_string();
    fs::write(&id_path, &fresh).map_err(|e| format!("failed to persist project_id: {e}"))?;

    Ok(ProjectIdentity {
        identifier: fresh,
        source: ProjectIdentitySource::GeneratedUuid,
    })
}

/// Read the origin remote URL from a project's `.git/config` without shelling out.
fn read_git_remote_url(cwd: &Path) -> Option<String> {
    let config = cwd.join(".git").join("config");
    let text = fs::read_to_string(&config).ok()?;
    let mut in_origin = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
            continue;
        }
        if in_origin {
            if let Some(rest) = line.strip_prefix("url") {
                let value = rest.trim_start().trim_start_matches('=').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Normalize a git remote URL into a stable identifier (scheme-independent,
/// trailing `.git` stripped, lowercased host).
///
/// Examples:
///   git@github.com:serenorg/seren-desktop.git -> github.com/serenorg/seren-desktop
///   https://github.com/serenorg/seren-desktop -> github.com/serenorg/seren-desktop
pub fn normalize_git_remote(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    // SCP-style: git@host:path
    if let Some(rest) = without_git.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("{}/{}", host.to_lowercase(), path.trim_start_matches('/'));
        }
    }

    // URL-style: strip scheme and optional userinfo.
    let after_scheme = match without_git.find("://") {
        Some(idx) => &without_git[idx + 3..],
        None => without_git,
    };
    let after_userinfo = after_scheme.rsplit_once('@').map_or(after_scheme, |t| t.1);

    // Lowercase only the host portion.
    match after_userinfo.split_once('/') {
        Some((host, path)) => format!("{}/{}", host.to_lowercase(), path),
        None => after_userinfo.to_lowercase(),
    }
}

/// Parse a Claude memory markdown file. The file format is:
///
/// ```text
/// ---
/// name: ...
/// description: ...
/// type: feedback
/// ---
/// body
/// ```
///
/// Frontmatter is optional. Unknown keys are ignored. No YAML dependency.
pub fn parse_memory_file(contents: &str) -> ParsedMemoryFile {
    let normalized = contents.replace("\r\n", "\n");
    let trimmed_start = normalized.trim_start_matches('\n');

    if !trimmed_start.starts_with("---") {
        return ParsedMemoryFile {
            frontmatter: MemoryFrontmatter::default(),
            body: normalized.trim().to_string(),
        };
    }

    // Skip the opening `---` line.
    let after_open = match trimmed_start.find('\n') {
        Some(idx) => &trimmed_start[idx + 1..],
        None => "",
    };

    // Locate the closing `---` line.
    let close_marker = "\n---";
    let (front_text, body) = match after_open.find(close_marker) {
        Some(idx) => {
            let after_close = &after_open[idx + close_marker.len()..];
            let body = match after_close.find('\n') {
                Some(nl) => &after_close[nl + 1..],
                None => "",
            };
            (&after_open[..idx], body)
        }
        None => {
            // Unterminated frontmatter — treat everything as body for safety.
            return ParsedMemoryFile {
                frontmatter: MemoryFrontmatter::default(),
                body: normalized.trim().to_string(),
            };
        }
    };

    let mut map: HashMap<String, String> = HashMap::new();
    for line in front_text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !value.is_empty() {
                map.insert(key, value);
            }
        }
    }

    ParsedMemoryFile {
        frontmatter: MemoryFrontmatter {
            name: map.remove("name"),
            description: map.remove("description"),
            memory_type: map.remove("type"),
        },
        body: body.trim().to_string(),
    }
}

/// Render a MEMORY.md file from an assembled memory prompt using an atomic write.
///
/// Claude Code reads `MEMORY.md` at session start. We guarantee the file on disk
/// is always a rendered view of the remote database — never user data straight
/// from the filesystem.
pub fn write_rendered_memory_md(
    claude_project_dir: &Path,
    rendered: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(claude_project_dir)
        .map_err(|e| format!("failed to create claude project dir: {e}"))?;

    let final_path = claude_project_dir.join(RENDERED_INDEX_FILENAME);
    let tmp_path = claude_project_dir.join(format!("{}.tmp", RENDERED_INDEX_FILENAME));

    fs::write(&tmp_path, rendered).map_err(|e| format!("failed to write temp MEMORY.md: {e}"))?;
    fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("failed to finalize MEMORY.md: {e}"))?;
    Ok(final_path)
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

/// Start the watcher. Idempotent: stops any existing watcher first.
///
/// The watcher is recursive on `~/.claude/projects`, which means it automatically
/// picks up newly-created project directories without any re-registration.
pub fn start_watcher(app: AppHandle) -> Result<PathBuf, String> {
    let root = claude_projects_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("failed to create claude projects root: {e}"))?;

    let mut state = CLAUDE_WATCHER_STATE
        .lock()
        .map_err(|e| format!("watcher state lock poisoned: {e}"))?;

    // Stop any existing watcher first.
    if state.running {
        if let Some(sender) = state.stop_sender.take() {
            let _ = sender.send(());
        }
        state.watcher = None;
        state.running = false;
    }

    let (stop_tx, stop_rx) = channel::<()>();
    let (event_tx, event_rx) = channel::<Result<Event, notify::Error>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            if let Err(e) = event_tx.send(res) {
                log::warn!("[ClaudeMemory] event channel closed: {e}");
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("failed to create claude memory watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    state.watcher = Some(watcher);
    state.stop_sender = Some(stop_tx);
    state.roots = vec![root.clone()];
    state.running = true;
    drop(state);

    let app_clone = app.clone();
    thread::spawn(move || {
        run_event_loop(app_clone, event_rx, stop_rx);
    });

    log::info!(
        "[ClaudeMemory] watcher started on {} (recursive)",
        root.display()
    );

    Ok(root)
}

/// Stop the watcher if running. Safe to call multiple times.
pub fn stop_watcher() -> Result<(), String> {
    let mut state = CLAUDE_WATCHER_STATE
        .lock()
        .map_err(|e| format!("watcher state lock poisoned: {e}"))?;

    if let Some(sender) = state.stop_sender.take() {
        let _ = sender.send(());
    }
    state.watcher = None;
    state.roots.clear();
    state.running = false;
    log::info!("[ClaudeMemory] watcher stopped");
    Ok(())
}

/// Is the watcher currently running?
pub fn is_watcher_running() -> bool {
    CLAUDE_WATCHER_STATE
        .lock()
        .map(|s| s.running)
        .unwrap_or(false)
}

fn run_event_loop(
    app: AppHandle,
    event_rx: Receiver<Result<Event, notify::Error>>,
    stop_rx: Receiver<()>,
) {
    // Lightweight debounce — the same file often gets multiple events in a burst
    // when editors save. We require a 250ms quiet period before processing.
    let debounce_window = Duration::from_millis(250);
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();

    loop {
        if stop_rx.try_recv().is_ok() {
            log::debug!("[ClaudeMemory] received stop signal, exiting event loop");
            break;
        }

        match event_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(event)) => {
                if !is_interesting_event(&event.kind) {
                    continue;
                }
                for path in event.paths {
                    if should_intercept_path(&path) {
                        pending.insert(path, Instant::now());
                    }
                }
            }
            Ok(Err(e)) => {
                log::warn!("[ClaudeMemory] watch error: {e}");
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                log::debug!("[ClaudeMemory] event channel disconnected, exiting");
                break;
            }
        }

        // Flush any paths whose quiet window has elapsed.
        let now = Instant::now();
        let ready: Vec<PathBuf> = pending
            .iter()
            .filter_map(|(path, seen)| {
                if now.duration_since(*seen) >= debounce_window {
                    Some(path.clone())
                } else {
                    None
                }
            })
            .collect();

        for path in ready {
            pending.remove(&path);
            if let Err(e) = process_memory_file(&app, &path) {
                log::warn!(
                    "[ClaudeMemory] failed to process {}: {e}",
                    path.display()
                );
            }
        }
    }
}

fn is_interesting_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
    )
}

/// Should this path be intercepted? True when it sits inside a `memory/` directory
/// under a Claude project root and is a `.md` file that is NOT `MEMORY.md`.
pub fn should_intercept_path(path: &Path) -> bool {
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return false;
    }
    let file_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };
    if file_name.eq_ignore_ascii_case(RENDERED_INDEX_FILENAME) {
        return false;
    }
    // Require a parent component named `memory`.
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| n == "memory")
        .unwrap_or(false)
}

/// Process a single memory file: read, parse, persist to the local memory cache
/// (which the existing sync engine will push to SerenDB), then delete the file.
fn process_memory_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    // The path may have been removed between the event and now.
    if !path.exists() {
        return Ok(());
    }

    let contents = fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    if contents.trim().is_empty() {
        return Ok(());
    }

    let parsed = parse_memory_file(&contents);

    let memory_type = parsed
        .frontmatter
        .memory_type
        .clone()
        .unwrap_or_else(|| CLAUDE_PREFERENCE_MEMORY_TYPE.to_string());

    // Identify the owning project (the directory Claude Code was invoked from).
    // For now we use the best-effort encoded dir name as the project_identity hint
    // in metadata — we do NOT rely on it for DB row keys (integration with the
    // existing memory stack handles that via the user's SerenDB project UUID).
    let project_hint = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_default();

    let source_file = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_default();

    let metadata = serde_json::json!({
        "source": "claude_memory_interceptor",
        "source_file": source_file,
        "claude_project_dir": project_hint,
        "frontmatter": {
            "name": parsed.frontmatter.name,
            "description": parsed.frontmatter.description,
            "type": parsed.frontmatter.memory_type,
        },
    });

    let state = app.state::<MemoryState>();
    let persisted_id = persist_memory_local(&state, contents, memory_type.clone(), metadata)?;

    // Delete the on-disk copy: the data now lives in the encrypted local cache
    // (not plaintext) and will be synced to SerenDB on the next sync pass.
    let deleted = fs::remove_file(path).is_ok();

    let _ = app.emit(
        "claude-memory-intercepted",
        InterceptEvent {
            path: path.to_string_lossy().to_string(),
            name: parsed.frontmatter.name,
            memory_type,
            persisted_id,
            deleted,
        },
    );

    log::info!(
        "[ClaudeMemory] intercepted {} (deleted={})",
        path.display(),
        deleted
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Startup migration
// ---------------------------------------------------------------------------

/// Walk every `~/.claude/projects/*/memory/` directory and intercept any `.md`
/// files already on disk. Called once on startup to migrate pre-existing files.
pub fn migrate_existing_files(app: &AppHandle) -> Result<usize, String> {
    let root = claude_projects_root()?;
    if !root.exists() {
        return Ok(0);
    }

    let mut migrated = 0usize;
    let project_dirs = match fs::read_dir(&root) {
        Ok(d) => d,
        Err(e) => return Err(format!("failed to read claude projects root: {e}")),
    };

    for entry in project_dirs.flatten() {
        let memory_dir = entry.path().join("memory");
        if !memory_dir.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&memory_dir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let path = file.path();
            if !should_intercept_path(&path) {
                continue;
            }
            match process_memory_file(app, &path) {
                Ok(()) => migrated += 1,
                Err(e) => log::warn!(
                    "[ClaudeMemory] migration skipped {}: {e}",
                    path.display()
                ),
            }
        }
    }

    log::info!("[ClaudeMemory] startup migration processed {} files", migrated);
    Ok(migrated)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parse_memory_file_extracts_frontmatter_and_body() {
        let input = "---\nname: foo\ndescription: hello world\ntype: feedback\n---\nbody line one\nbody line two\n";
        let parsed = parse_memory_file(input);
        assert_eq!(parsed.frontmatter.name.as_deref(), Some("foo"));
        assert_eq!(
            parsed.frontmatter.description.as_deref(),
            Some("hello world")
        );
        assert_eq!(parsed.frontmatter.memory_type.as_deref(), Some("feedback"));
        assert_eq!(parsed.body, "body line one\nbody line two");
    }

    #[test]
    fn parse_memory_file_handles_missing_frontmatter() {
        let input = "just a body with no frontmatter\n";
        let parsed = parse_memory_file(input);
        assert_eq!(parsed.frontmatter, MemoryFrontmatter::default());
        assert_eq!(parsed.body, "just a body with no frontmatter");
    }

    #[test]
    fn parse_memory_file_handles_unterminated_frontmatter() {
        // No closing `---` — must NOT crash, must fall through to body.
        let input = "---\nname: foo\ndescription: still going";
        let parsed = parse_memory_file(input);
        assert_eq!(parsed.frontmatter, MemoryFrontmatter::default());
        assert!(parsed.body.contains("still going"));
    }

    #[test]
    fn normalize_git_remote_handles_scp_and_https() {
        assert_eq!(
            normalize_git_remote("git@github.com:serenorg/seren-desktop.git"),
            "github.com/serenorg/seren-desktop"
        );
        assert_eq!(
            normalize_git_remote("https://github.com/serenorg/seren-desktop.git"),
            "github.com/serenorg/seren-desktop"
        );
        assert_eq!(
            normalize_git_remote("https://user:token@github.com/serenorg/seren-desktop"),
            "github.com/serenorg/seren-desktop"
        );
        assert_eq!(
            normalize_git_remote("https://GitHub.com/serenorg/seren-desktop/"),
            "github.com/serenorg/seren-desktop"
        );
    }

    #[test]
    fn resolve_project_identity_prefers_git_remote() {
        let tmp = TempDir::new().expect("tempdir");
        let git_dir = tmp.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(
            git_dir.join("config"),
            "[remote \"origin\"]\n\turl = git@github.com:serenorg/seren-desktop.git\n",
        )
        .unwrap();

        let identity = resolve_project_identity(tmp.path()).expect("identity");
        assert_eq!(identity.source, ProjectIdentitySource::GitRemote);
        assert_eq!(identity.identifier, "github.com/serenorg/seren-desktop");
    }

    #[test]
    fn resolve_project_identity_persists_uuid_fallback() {
        let tmp = TempDir::new().expect("tempdir");
        let first = resolve_project_identity(tmp.path()).expect("first identity");
        assert_eq!(first.source, ProjectIdentitySource::GeneratedUuid);
        // UUID must survive on disk for subsequent calls.
        let second = resolve_project_identity(tmp.path()).expect("second identity");
        assert_eq!(second.source, ProjectIdentitySource::PersistedUuid);
        assert_eq!(first.identifier, second.identifier);
    }

    #[test]
    fn should_intercept_path_rules() {
        let memory_dir = Path::new("/home/a/.claude/projects/-proj/memory");
        assert!(should_intercept_path(&memory_dir.join("feedback.md")));
        assert!(!should_intercept_path(&memory_dir.join("MEMORY.md")));
        assert!(!should_intercept_path(&memory_dir.join("memory.txt")));
        // Not inside a `memory/` dir.
        assert!(!should_intercept_path(Path::new(
            "/home/a/.claude/projects/-proj/foo.md"
        )));
    }

    #[test]
    fn write_rendered_memory_md_is_atomic_overwrite() {
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("-proj");
        let first = write_rendered_memory_md(&dir, "first render").expect("first");
        assert_eq!(fs::read_to_string(&first).unwrap(), "first render");
        let second = write_rendered_memory_md(&dir, "second render").expect("second");
        assert_eq!(fs::read_to_string(&second).unwrap(), "second render");
        // Temp file must not linger.
        assert!(!dir.join("MEMORY.md.tmp").exists());
    }
}
