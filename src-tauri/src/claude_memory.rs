// ABOUTME: Intercepts Claude Code auto-memory writes and persists them to SerenDB.
// ABOUTME: Watches ~/.claude/projects/*/memory/ and awaits a real cloud write per file.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;

use seren_memory_sdk::client::MemoryClient;

use crate::commands::memory::MemoryState;

const AUTH_STORE: &str = "auth.json";
const AUTH_TOKEN_KEY: &str = "token";
const RENDERED_INDEX_FILENAME: &str = "MEMORY.md";
const PROJECT_ID_FILENAME: &str = "project_id";
const DEFAULT_MEMORY_TYPE: &str = "claude_preference";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Parsed frontmatter block from a Claude memory `.md` file.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub memory_type: Option<String>,
}

/// Result of parsing a memory file: the frontmatter plus the body text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMemoryFile {
    pub frontmatter: MemoryFrontmatter,
    pub body: String,
}

/// Stable identity for a project directory (git remote or persisted UUID).
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

/// Event emitted to the frontend after a successful SerenDB write.
#[derive(Debug, Clone, Serialize)]
pub struct InterceptSuccessEvent {
    pub path: String,
    pub name: Option<String>,
    pub memory_type: String,
    pub serendb_response: String,
}

/// Event emitted when the cloud write fails; the file is left on disk so the
/// watcher can retry on the next event (or after an app restart).
#[derive(Debug, Clone, Serialize)]
pub struct InterceptFailureEvent {
    pub path: String,
    pub memory_type: String,
    pub error: String,
}

/// Global watcher handle so we can start / stop / inspect from Tauri commands.
struct WatcherSlot {
    watcher: Option<RecommendedWatcher>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    running: bool,
    project_id: Option<Uuid>,
}

impl Default for WatcherSlot {
    fn default() -> Self {
        Self {
            watcher: None,
            stop_tx: None,
            task: None,
            running: false,
            project_id: None,
        }
    }
}

lazy_static::lazy_static! {
    static ref WATCHER_SLOT: Arc<Mutex<WatcherSlot>> =
        Arc::new(Mutex::new(WatcherSlot::default()));
}

// ---------------------------------------------------------------------------
// Path / filesystem helpers
// ---------------------------------------------------------------------------

/// Return `~/.claude/projects`, creating it on demand.
pub fn claude_projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

/// Encode an absolute project directory the same way Claude Code does:
/// `/Users/a/b` → `-Users-a-b`.
pub fn encode_project_dir(cwd: &Path) -> String {
    let resolved = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    let sanitized = resolved.trim_start_matches('/').replace(':', "");
    format!("-{}", sanitized.replace('/', "-"))
}

/// True when `path` is a `.md` file inside a Claude project's `memory/` subdir
/// **and** is not the rendered `MEMORY.md` index file.
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
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| n == "memory")
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Project identity
// ---------------------------------------------------------------------------

/// Resolve a stable identifier for a project directory:
///   1. git remote URL (same repo → same identity across machines)
///   2. UUID persisted at `<cwd>/.claude/project_id`
///   3. A freshly generated UUID written to the same path
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
    let fresh = Uuid::new_v4().to_string();
    fs::write(&id_path, &fresh).map_err(|e| format!("failed to persist project_id: {e}"))?;

    Ok(ProjectIdentity {
        identifier: fresh,
        source: ProjectIdentitySource::GeneratedUuid,
    })
}

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
/// trailing `.git` stripped, host lowercased).
pub fn normalize_git_remote(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);

    if let Some(rest) = without_git.strip_prefix("git@") {
        if let Some((host, path)) = rest.split_once(':') {
            return format!("{}/{}", host.to_lowercase(), path.trim_start_matches('/'));
        }
    }

    let after_scheme = match without_git.find("://") {
        Some(idx) => &without_git[idx + 3..],
        None => without_git,
    };
    let after_userinfo = after_scheme.rsplit_once('@').map_or(after_scheme, |t| t.1);

    match after_userinfo.split_once('/') {
        Some((host, path)) => format!("{}/{}", host.to_lowercase(), path),
        None => after_userinfo.to_lowercase(),
    }
}

// ---------------------------------------------------------------------------
// Frontmatter parser (no YAML dep)
// ---------------------------------------------------------------------------

/// Parse a Claude memory `.md` file:
///
/// ```text
/// ---
/// name: foo
/// description: short blurb
/// type: feedback
/// ---
/// body...
/// ```
///
/// Frontmatter is optional. Unterminated frontmatter falls through to body.
pub fn parse_memory_file(contents: &str) -> ParsedMemoryFile {
    let normalized = contents.replace("\r\n", "\n");
    let trimmed_start = normalized.trim_start_matches('\n');

    if !trimmed_start.starts_with("---") {
        return ParsedMemoryFile {
            frontmatter: MemoryFrontmatter::default(),
            body: normalized.trim().to_string(),
        };
    }

    let after_open = match trimmed_start.find('\n') {
        Some(idx) => &trimmed_start[idx + 1..],
        None => "",
    };

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

// ---------------------------------------------------------------------------
// MEMORY.md rendering
// ---------------------------------------------------------------------------

/// Atomically write a rendered `MEMORY.md` (write tmp, then rename).
pub fn write_rendered_memory_md(
    claude_project_dir: &Path,
    rendered: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(claude_project_dir)
        .map_err(|e| format!("failed to create claude project dir: {e}"))?;

    let final_path = claude_project_dir.join(RENDERED_INDEX_FILENAME);
    let tmp_path = claude_project_dir.join(format!("{RENDERED_INDEX_FILENAME}.tmp"));

    fs::write(&tmp_path, rendered).map_err(|e| format!("failed to write temp MEMORY.md: {e}"))?;
    fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("failed to finalize MEMORY.md: {e}"))?;
    Ok(final_path)
}

// ---------------------------------------------------------------------------
// Core interception logic (testable without Tauri)
// ---------------------------------------------------------------------------

/// Read a single memory file, push it to SerenDB via the supplied
/// authenticated [`MemoryClient`], and delete the file **only** on cloud
/// success. On failure the file is left on disk so the watcher can retry.
///
/// This is the single unit of work for the interceptor — the tokio event
/// loop calls it, the startup migration calls it, and the SerenDB
/// round-trip integration test calls it. It does NOT touch the local
/// `seren-memory-sdk` cache or any other memory stack.
pub async fn process_memory_file(
    path: &Path,
    client: &MemoryClient,
    project_id: Option<Uuid>,
) -> Result<ProcessOutcome, String> {
    if !path.exists() {
        return Ok(ProcessOutcome::Skipped);
    }

    let contents = fs::read_to_string(path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    if contents.trim().is_empty() {
        return Ok(ProcessOutcome::Skipped);
    }

    let parsed = parse_memory_file(&contents);
    let memory_type = parsed
        .frontmatter
        .memory_type
        .clone()
        .unwrap_or_else(|| DEFAULT_MEMORY_TYPE.to_string());

    // Await the REAL cloud write. On Err we return without deleting the file.
    let serendb_response = client
        .remember(&contents, &memory_type, project_id, None)
        .await
        .map_err(|e| format!("serendb remember failed: {e}"))?;

    // Cloud write succeeded — now remove the plaintext file.
    fs::remove_file(path).map_err(|e| format!("failed to delete {}: {e}", path.display()))?;

    Ok(ProcessOutcome::Persisted {
        name: parsed.frontmatter.name,
        memory_type,
        serendb_response,
    })
}

/// Outcome of a single [`process_memory_file`] call.
#[derive(Debug, Clone)]
pub enum ProcessOutcome {
    Skipped,
    Persisted {
        name: Option<String>,
        memory_type: String,
        serendb_response: String,
    },
}

// ---------------------------------------------------------------------------
// Tauri-facing auth + client bootstrap
// ---------------------------------------------------------------------------

fn read_auth_token(app: &AppHandle) -> Result<String, String> {
    use tauri_plugin_store::StoreExt;
    let token = app
        .store(AUTH_STORE)
        .map_err(|e| e.to_string())?
        .get(AUTH_TOKEN_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    if token.is_empty() {
        return Err("unauthorized".to_string());
    }
    Ok(token)
}

fn build_client(app: &AppHandle) -> Result<MemoryClient, String> {
    let token = read_auth_token(app)?;
    let base_url = app.state::<MemoryState>().base_url().to_string();
    Ok(MemoryClient::new(base_url, token))
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

/// Start watching `~/.claude/projects` recursively. Any `.md` write inside a
/// `memory/` subdirectory will be intercepted, pushed to SerenDB, and deleted.
///
/// `project_id` is the user's active SerenDB project UUID — this is the same
/// project the rest of the app uses for memory operations.
pub fn start_watcher(app: AppHandle, project_id: Option<Uuid>) -> Result<PathBuf, String> {
    // Validate credentials up-front so the user sees the error in the UI
    // instead of discovering it via a silent watcher failure later.
    let _ = build_client(&app)?;

    let root = claude_projects_root()?;
    fs::create_dir_all(&root).map_err(|e| format!("failed to create claude projects root: {e}"))?;

    let mut slot = WATCHER_SLOT
        .lock()
        .map_err(|e| format!("watcher lock poisoned: {e}"))?;

    // Idempotent: tear down any existing watcher first.
    tear_down_locked(&mut slot);

    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<PathBuf>();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let tx_for_callback = event_tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !is_interesting_event(&event.kind) {
                return;
            }
            for path in event.paths {
                if should_intercept_path(&path) {
                    // Unbounded tokio channel; send() is sync and non-blocking,
                    // so this is safe on the notify thread.
                    let _ = tx_for_callback.send(path);
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("failed to create watcher: {e}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("failed to watch {}: {e}", root.display()))?;

    // Spawn the async consumer. The channel is drained and each path is
    // processed with a fresh MemoryClient (so token rotations are picked up).
    let app_for_task = app.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                maybe_path = event_rx.recv() => {
                    match maybe_path {
                        Some(path) => {
                            handle_event(&app_for_task, path, project_id).await;
                        }
                        None => break,
                    }
                }
                _ = &mut stop_rx => {
                    log::debug!("[ClaudeMemory] stop signal received; draining and exiting");
                    break;
                }
            }
        }
    });

    slot.watcher = Some(watcher);
    slot.stop_tx = Some(stop_tx);
    slot.task = Some(task);
    slot.running = true;
    slot.project_id = project_id;
    drop(slot);

    log::info!(
        "[ClaudeMemory] watcher started on {} (project_id={:?})",
        root.display(),
        project_id
    );
    Ok(root)
}

/// Stop the watcher if running. Safe to call repeatedly.
pub fn stop_watcher() -> Result<(), String> {
    let mut slot = WATCHER_SLOT
        .lock()
        .map_err(|e| format!("watcher lock poisoned: {e}"))?;
    tear_down_locked(&mut slot);
    log::info!("[ClaudeMemory] watcher stopped");
    Ok(())
}

fn tear_down_locked(slot: &mut WatcherSlot) {
    if let Some(tx) = slot.stop_tx.take() {
        let _ = tx.send(());
    }
    if let Some(task) = slot.task.take() {
        task.abort();
    }
    slot.watcher = None;
    slot.running = false;
    slot.project_id = None;
}

/// Is the watcher currently running?
pub fn is_watcher_running() -> bool {
    WATCHER_SLOT.lock().map(|s| s.running).unwrap_or(false)
}

fn is_interesting_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
    )
}

async fn handle_event(app: &AppHandle, path: PathBuf, project_id: Option<Uuid>) {
    let memory_type_fallback = DEFAULT_MEMORY_TYPE.to_string();

    let client = match build_client(app) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[ClaudeMemory] skipping {}: cannot build SerenDB client: {e}",
                path.display()
            );
            let _ = app.emit(
                "claude-memory-intercept-failed",
                InterceptFailureEvent {
                    path: path.to_string_lossy().to_string(),
                    memory_type: memory_type_fallback,
                    error: e,
                },
            );
            return;
        }
    };

    match process_memory_file(&path, &client, project_id).await {
        Ok(ProcessOutcome::Persisted {
            name,
            memory_type,
            serendb_response,
        }) => {
            log::info!(
                "[ClaudeMemory] persisted {} to SerenDB and removed plaintext file",
                path.display()
            );
            let _ = app.emit(
                "claude-memory-intercepted",
                InterceptSuccessEvent {
                    path: path.to_string_lossy().to_string(),
                    name,
                    memory_type,
                    serendb_response,
                },
            );
        }
        Ok(ProcessOutcome::Skipped) => {}
        Err(e) => {
            log::warn!(
                "[ClaudeMemory] {} left on disk — cloud write failed: {e}",
                path.display()
            );
            let _ = app.emit(
                "claude-memory-intercept-failed",
                InterceptFailureEvent {
                    path: path.to_string_lossy().to_string(),
                    memory_type: memory_type_fallback,
                    error: e,
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Startup migration
// ---------------------------------------------------------------------------

/// Walk every `~/.claude/projects/*/memory/` directory and push any pre-existing
/// `.md` files to SerenDB. Returns the number successfully persisted. Files
/// whose cloud write fails are left on disk and counted in `failures`.
pub async fn migrate_existing_files(
    app: &AppHandle,
    project_id: Option<Uuid>,
) -> Result<MigrationReport, String> {
    let client = build_client(app)?;
    let root = claude_projects_root()?;
    if !root.exists() {
        return Ok(MigrationReport::default());
    }

    let mut report = MigrationReport::default();
    let project_dirs = fs::read_dir(&root)
        .map_err(|e| format!("failed to read claude projects root: {e}"))?;

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
            match process_memory_file(&path, &client, project_id).await {
                Ok(ProcessOutcome::Persisted { .. }) => report.persisted += 1,
                Ok(ProcessOutcome::Skipped) => {}
                Err(e) => {
                    log::warn!(
                        "[ClaudeMemory] migration failed for {}: {e}",
                        path.display()
                    );
                    report.failures += 1;
                }
            }
        }
    }

    log::info!(
        "[ClaudeMemory] migration finished: persisted={} failures={}",
        report.persisted,
        report.failures
    );
    Ok(report)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MigrationReport {
    pub persisted: usize,
    pub failures: usize,
}

// ---------------------------------------------------------------------------
// Pure-function tests (no network, no SDK internals)
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
        let parsed = parse_memory_file("just a body with no frontmatter\n");
        assert_eq!(parsed.frontmatter, MemoryFrontmatter::default());
        assert_eq!(parsed.body, "just a body with no frontmatter");
    }

    #[test]
    fn parse_memory_file_handles_unterminated_frontmatter() {
        let parsed = parse_memory_file("---\nname: foo\ndescription: still going");
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
            normalize_git_remote("https://user:token@GitHub.com/serenorg/seren-desktop/"),
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
        assert!(!dir.join("MEMORY.md.tmp").exists());
    }
}

// ---------------------------------------------------------------------------
// SerenDB round-trip integration test (ignored by default)
//
// This is the ONLY test that talks to the network. It proves the spec:
// a file intercepted by our code ends up in SerenDB and comes back out via
// `MemoryClient::recall()`. Run with:
//
//   SEREN_CLAUDE_MEMORY_TEST_TOKEN=<token> \
//   SEREN_CLAUDE_MEMORY_TEST_PROJECT=<project-uuid> \
//   cargo test --lib claude_memory -- --ignored --nocapture \
//     serendb_roundtrip_persists_and_recalls
//
// Optional env vars:
//   SEREN_CLAUDE_MEMORY_TEST_BASE_URL (default: https://memory.serendb.com)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod integration {
    use super::*;
    use tempfile::TempDir;

    fn require_env(name: &str) -> String {
        match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => v,
            _ => panic!(
                "{name} is not set — SerenDB roundtrip test requires a live token and project UUID"
            ),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires live SerenDB credentials; see module docs"]
    async fn serendb_roundtrip_persists_and_recalls() {
        let token = require_env("SEREN_CLAUDE_MEMORY_TEST_TOKEN");
        let project_raw = require_env("SEREN_CLAUDE_MEMORY_TEST_PROJECT");
        let project_id = Uuid::parse_str(&project_raw).expect("project id must be a UUID");
        let base_url = std::env::var("SEREN_CLAUDE_MEMORY_TEST_BASE_URL")
            .unwrap_or_else(|_| "https://memory.serendb.com".to_string());

        // Build the SAME client the production code would build.
        let client = MemoryClient::new(base_url, token);

        // Write a memory file into a temp Claude-style memory directory so we
        // exercise the full parse + persist + delete path our production
        // watcher uses, not a shortcut that calls client.remember directly.
        let tmp = TempDir::new().expect("tempdir");
        let memory_dir = tmp.path().join("-test-proj").join("memory");
        fs::create_dir_all(&memory_dir).unwrap();

        // Unique marker so we can find this row on recall even if the project
        // has many other memories. Embedded in both the body and the frontmatter.
        let marker = format!("claude-memory-roundtrip-{}", Uuid::new_v4());
        let file_path = memory_dir.join("feedback_roundtrip.md");
        let contents = format!(
            "---\nname: roundtrip_{marker}\ndescription: integration test marker\ntype: feedback\n---\nMARKER={marker}\nclaude-memory-interceptor roundtrip test — safe to delete.\n"
        );
        fs::write(&file_path, &contents).unwrap();

        // Exercise OUR code under test.
        let outcome = process_memory_file(&file_path, &client, Some(project_id))
            .await
            .expect("process_memory_file must succeed against live SerenDB");

        match outcome {
            ProcessOutcome::Persisted { memory_type, .. } => {
                assert_eq!(memory_type, "feedback", "memory_type comes from frontmatter");
            }
            other => panic!("expected Persisted, got {other:?}"),
        }

        // The plaintext file must be gone once the cloud write succeeded.
        assert!(
            !file_path.exists(),
            "file must be deleted after successful SerenDB write"
        );

        // Round-trip: recall by unique marker and assert the content came back.
        let results = client
            .recall(&marker, Some(project_id), Some(10))
            .await
            .expect("recall against SerenDB must succeed");

        let hit = results.iter().find(|r| r.content.contains(&marker));
        assert!(
            hit.is_some(),
            "expected to recall a memory containing MARKER={marker}; got {} results: {:?}",
            results.len(),
            results.iter().map(|r| &r.content).collect::<Vec<_>>()
        );
    }
}
