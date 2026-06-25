// ABOUTME: Intercepts Claude Code auto-memory writes and persists them to SerenDB SQL.
// ABOUTME: Watches ~/.claude/projects/*/memory/ and INSERTs each file as a row in
// ABOUTME: claude_agent_preferences. Storage is a separate SerenDB project from user memory.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use uuid::Uuid;

const AUTH_STORE: &str = "auth.json";
/// Sentinel comments wrapping the auto-rendered index inside `MEMORY.md`.
/// Only content between these markers is replaced when SerenDB intercepts
/// refresh the file; everything outside is hand-curated and must survive.
const AUTO_INDEX_BEGIN: &str = "<!-- BEGIN AUTO-INDEX -->";
const AUTO_INDEX_END: &str = "<!-- END AUTO-INDEX -->";
/// The user's SerenDB API key. This is the credential for the SerenDB SQL
/// data plane at `api.serendb.com/publishers/seren-db/query` — NOT the
/// OAuth bearer token in `auth.json.token`, which is the Seren Desktop
/// session credential for Gateway API calls. They are different keys and
/// are not interchangeable on the SQL endpoint.
const SEREN_API_KEY_KEY: &str = "seren_api_key";
const RENDERED_INDEX_FILENAME: &str = "MEMORY.md";
const PROJECT_ID_FILENAME: &str = "project_id";
const DEFAULT_PREF_TYPE: &str = "claude_preference";

/// Maximum number of entries listed in the MEMORY.md auto-index. Rows beyond
/// this are summarized in an overflow footer instead of being listed — their
/// bodies always remain in SerenDB and stay reachable via the seren MCP.
/// Without a cap the index grows one line per row and can blow past the
/// harness's MEMORY.md load budget (a 56-row project already approaches it).
const MAX_AUTO_INDEX_ENTRIES: usize = 50;

/// Soft byte budget for the whole rendered MEMORY.md. Over this we log a
/// warning so an oversized index is noticed. We never truncate: the bulk of an
/// over-budget file is hand-curated prose outside the markers, which the
/// renderer is contractually forbidden to touch.
const MEMORY_MD_SIZE_BUDGET_BYTES: u64 = 20_000;

/// Consecutive cloud-write failures tolerated for a single intercepted file
/// before it is quarantined out of the live `memory/` dir. Bounds how long a
/// persistently-failing plaintext file lingers and stops the watcher from
/// retrying it forever on every fs event.
const MAX_INTERCEPT_RETRIES: u32 = 3;

/// Subdirectory (under a project's `memory/`) where files that exhausted their
/// retries are parked. Its parent is `.quarantine`, not `memory`, so
/// `should_intercept_path` never re-picks these up.
const QUARANTINE_DIR_NAME: &str = ".quarantine";

/// Hardcoded SerenDB SQL endpoint for the seren-db publisher. The frontend uses
/// the same path through the generated SDK; we hit it directly from Rust so the
/// watcher can persist files without round-tripping through JS.
const SERENDB_QUERY_URL: &str = "https://api.serendb.com/publishers/seren-db/query";

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

/// SerenDB destination for the interceptor — a project + branch + database
/// triple resolved by the frontend `ensureClaudeMemoryProvisioned()` helper
/// before the watcher starts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerenDbConfig {
    pub project_id: String,
    pub branch_id: String,
    pub database_name: String,
}

/// Event emitted to the frontend after a successful SerenDB SQL INSERT.
#[derive(Debug, Clone, Serialize)]
pub struct InterceptSuccessEvent {
    pub path: String,
    pub name: Option<String>,
    pub memory_type: String,
    pub rendered_memory_md: Option<String>,
    pub render_error: Option<String>,
}

/// Event emitted when the cloud write fails; the file is left on disk so the
/// watcher can retry on the next event (or after an app restart).
#[derive(Debug, Clone, Serialize)]
pub struct InterceptFailureEvent {
    pub path: String,
    pub memory_type: String,
    pub error: String,
}

/// Event emitted when a file exhausts its retries and is moved out of the live
/// `memory/` dir into `.quarantine/`. The original plaintext no longer lingers
/// where it can be re-intercepted; `quarantine_path` points at where it landed.
#[derive(Debug, Clone, Serialize)]
pub struct InterceptQuarantineEvent {
    pub path: String,
    pub quarantine_path: String,
    pub error: String,
}

/// Global watcher handle so we can start / stop / inspect from Tauri commands.
struct WatcherSlot {
    watcher: Option<RecommendedWatcher>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
    running: bool,
    config: Option<SerenDbConfig>,
}

impl Default for WatcherSlot {
    fn default() -> Self {
        Self {
            watcher: None,
            stop_tx: None,
            task: None,
            running: false,
            config: None,
        }
    }
}

lazy_static::lazy_static! {
    static ref WATCHER_SLOT: Arc<Mutex<WatcherSlot>> =
        Arc::new(Mutex::new(WatcherSlot::default()));
    /// Consecutive cloud-write failure count per intercepted file path. Drives
    /// the quarantine threshold so a persistently-failing file is parked
    /// instead of retried forever. Cleared on success or after quarantine.
    static ref FAILURE_COUNTS: Mutex<HashMap<PathBuf, u32>> =
        Mutex::new(HashMap::new());
}

// ---------------------------------------------------------------------------
// Path / filesystem helpers
// ---------------------------------------------------------------------------

/// Return `~/.claude/projects`, creating it on demand.
pub fn claude_projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

/// Build the path Claude CLI uses for a session transcript:
/// `<root>/<encoded(cwd)>/<session_id>.jsonl`. The pre-#1825 implementation
/// added a `sessions/` subdir that Claude Code never creates, so
/// `claude_session_exists` always returned false and the resume-side gate
/// from #1657 silently skipped --resume on every reload. Pure path
/// construction — caller decides whether to stat or read.
pub fn session_jsonl_path(root: &Path, project_cwd: &Path, session_id: &str) -> PathBuf {
    let encoded = encode_project_dir(project_cwd);
    root.join(&encoded).join(format!("{session_id}.jsonl"))
}

/// Encode an absolute project directory the same way Claude Code does:
/// `/Users/a/b` → `-Users-a-b`. Every non-`[a-zA-Z0-9-]` char (including `_`
/// and `.`) collapses to `-`, matching the CLI's on-disk convention. (#1836)
pub fn encode_project_dir(cwd: &Path) -> String {
    let resolved = cwd
        .canonicalize()
        .unwrap_or_else(|_| cwd.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/");
    let sanitized = resolved.trim_start_matches('/').replace(':', "");
    let normalized: String = sanitized
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("-{normalized}")
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

/// Extract the encoded Claude project directory name from a memory file path.
/// `/.../.claude/projects/-Users-x-foo/memory/bar.md` → `-Users-x-foo`.
/// Returns `None` if the path does not match the expected layout.
pub fn extract_claude_project_dir_name(path: &Path) -> Option<String> {
    let memory_dir = path.parent()?;
    let project_dir = memory_dir.parent()?;
    project_dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
}

/// Derive a `pref_key` from a memory file path: the filename without the
/// `.md` extension. The combination `(project_path, pref_key)` is the
/// `UNIQUE` constraint on `claude_agent_preferences`, so re-intercepting an
/// updated file overwrites the row instead of duplicating it.
pub fn derive_pref_key(path: &Path) -> Option<String> {
    let file_name = path.file_name().and_then(|n| n.to_str())?;
    Some(
        file_name
            .strip_suffix(".md")
            .unwrap_or(file_name)
            .to_string(),
    )
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
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
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
// SQL escaping + query builders
//
// We do not have parameterized queries on the SerenDB `/query` endpoint
// (the `QueryRequest` schema only takes a single `query` string). To prevent
// SQL injection from arbitrary file content, we escape every value into a
// Postgres standard string literal: `'value'` with single quotes doubled.
// This is safe for Postgres when `standard_conforming_strings = on` (the
// default since 9.1) — backslashes are NOT escape characters in standard
// strings.
// ---------------------------------------------------------------------------

/// Escape a string for embedding in a Postgres standard SQL string literal.
/// Returns the value wrapped in single quotes with internal `'` doubled.
///
/// Example: `O'Brien` → `'O''Brien'`.
pub fn quote_sql_string(value: &str) -> String {
    let escaped = value.replace('\'', "''");
    format!("'{escaped}'")
}

/// `NULL` if the option is `None`, otherwise a quoted SQL string.
fn quote_optional(value: Option<&str>) -> String {
    match value {
        Some(v) => quote_sql_string(v),
        None => "NULL".to_string(),
    }
}

/// Build the `INSERT ... ON CONFLICT DO UPDATE` statement that upserts a
/// `claude_agent_preferences` row. The `(project_path, pref_key)` UNIQUE
/// constraint means re-intercepting an updated file overwrites instead of
/// duplicating, which preserves the spec's idempotent-write semantics.
pub fn build_upsert_preference_sql(
    project_path: &str,
    pref_key: &str,
    pref_type: &str,
    description: Option<&str>,
    content: &str,
    source_file: &str,
) -> String {
    format!(
        "INSERT INTO claude_agent_preferences \
         (project_path, pref_key, pref_type, description, content, source_file, updated_at) \
         VALUES ({project_path}, {pref_key}, {pref_type}, {description}, {content}, {source_file}, now()) \
         ON CONFLICT (project_path, pref_key) DO UPDATE SET \
         pref_type = EXCLUDED.pref_type, \
         description = EXCLUDED.description, \
         content = EXCLUDED.content, \
         source_file = EXCLUDED.source_file, \
         updated_at = now();",
        project_path = quote_sql_string(project_path),
        pref_key = quote_sql_string(pref_key),
        pref_type = quote_sql_string(pref_type),
        description = quote_optional(description),
        content = quote_sql_string(content),
        source_file = quote_sql_string(source_file),
    )
}

/// Build a SELECT to read all preferences for a project. Rows come back
/// most-recently-updated first so the renderer's entry cap keeps the freshest
/// memories; `pref_key` is the stable tie-breaker. `updated_at` is the trailing
/// column so the positional row indexing in `render_preferences_as_markdown`
/// (pref_key, pref_type, description, content, source_file) is unaffected.
pub fn build_select_preferences_sql(project_path: &str) -> String {
    format!(
        "SELECT pref_key, pref_type, description, content, source_file, updated_at \
         FROM claude_agent_preferences \
         WHERE project_path = {project_path} \
         ORDER BY updated_at DESC NULLS LAST, pref_key;",
        project_path = quote_sql_string(project_path),
    )
}

// ---------------------------------------------------------------------------
// MEMORY.md rendering
// ---------------------------------------------------------------------------

/// Atomically refresh `memory/MEMORY.md` so its auto-index reflects the latest
/// SerenDB rows while preserving any hand-curated content the user wrote
/// outside the marker block.
///
/// Behavior:
/// - If `MEMORY.md` already contains `AUTO_INDEX_BEGIN`/`AUTO_INDEX_END`,
///   only the bytes between them are replaced.
/// - If the file exists without markers, a fresh auto-index block is
///   appended (the existing content is preserved verbatim) — this keeps
///   pre-existing curated indexes intact on first refresh.
/// - If the file does not exist, a minimal MEMORY.md scaffold is written.
///
/// `auto_index_body` is the section-grouped bullet list produced by
/// `render_preferences_as_markdown` — the markers and surrounding prose
/// are added here, not by the renderer.
pub fn write_rendered_memory_md(
    claude_project_dir: &Path,
    auto_index_body: &str,
) -> Result<PathBuf, String> {
    let memory_dir = claude_project_dir.join("memory");
    fs::create_dir_all(&memory_dir)
        .map_err(|e| format!("failed to create claude memory dir: {e}"))?;
    // Memory files are plaintext until ingested; keep the dir owner-only.
    restrict_permissions(&memory_dir, 0o700);

    let final_path = memory_dir.join(RENDERED_INDEX_FILENAME);
    let block = format!(
        "{AUTO_INDEX_BEGIN}\n{}\n{AUTO_INDEX_END}",
        auto_index_body.trim_matches('\n')
    );

    let merged = match fs::read_to_string(&final_path) {
        Ok(existing) => merge_auto_index_block(&existing, &block),
        Err(_) => format!("# Claude Memory\n\n{block}\n"),
    };

    let tmp_path = memory_dir.join(format!("{RENDERED_INDEX_FILENAME}.tmp"));
    fs::write(&tmp_path, &merged).map_err(|e| format!("failed to write temp MEMORY.md: {e}"))?;
    restrict_permissions(&tmp_path, 0o600);
    fs::rename(&tmp_path, &final_path).map_err(|e| format!("failed to finalize MEMORY.md: {e}"))?;
    restrict_permissions(&final_path, 0o600);

    // Surface an oversized index rather than silently letting it grow past the
    // harness's load budget. We only warn — hand-curated prose outside the
    // markers is never truncated.
    if let Ok(meta) = fs::metadata(&final_path) {
        if memory_md_over_budget(meta.len()) {
            log::warn!(
                "[ClaudeMemory] {} is {} bytes, over the {}-byte budget — consider consolidating memories (bodies stay in SerenDB)",
                final_path.display(),
                meta.len(),
                MEMORY_MD_SIZE_BUDGET_BYTES
            );
        }
    }
    Ok(final_path)
}

/// Restrict a path's permissions to owner-only on Unix. No-op elsewhere, where
/// the parent dir's ACL inheritance governs access. Best-effort: a failure is
/// logged at debug and does not abort the write.
#[cfg(unix)]
fn restrict_permissions(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(mode)) {
        log::debug!(
            "[ClaudeMemory] could not set mode {mode:o} on {}: {e}",
            path.display()
        );
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path, _mode: u32) {}

/// Whether a file with `failure_count` consecutive cloud-write failures should
/// be quarantined out of the live memory dir.
fn should_quarantine(failure_count: u32) -> bool {
    failure_count >= MAX_INTERCEPT_RETRIES
}

/// Record a failed cloud write for `path` and return the new consecutive count.
fn record_failure(path: &Path) -> u32 {
    let mut counts = match FAILURE_COUNTS.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    let entry = counts.entry(path.to_path_buf()).or_insert(0);
    *entry += 1;
    *entry
}

/// Clear any recorded failures for `path` (on success or after quarantine).
fn clear_failure(path: &Path) {
    if let Ok(mut counts) = FAILURE_COUNTS.lock() {
        counts.remove(path);
    }
}

/// Move a file that exhausted its retries into `memory/.quarantine/`, writing a
/// sibling `<name>.error` with the last error. The file leaves the live
/// `memory/` dir (so it is no longer re-intercepted, since `.quarantine` is not
/// `memory`) but is preserved for inspection rather than deleted. Returns the
/// quarantine path.
fn quarantine_failed_file(path: &Path, error: &str) -> Result<PathBuf, String> {
    let memory_dir = path
        .parent()
        .ok_or_else(|| format!("cannot quarantine {}: no parent dir", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("cannot quarantine {}: no file name", path.display()))?;

    let quarantine_dir = memory_dir.join(QUARANTINE_DIR_NAME);
    fs::create_dir_all(&quarantine_dir)
        .map_err(|e| format!("failed to create quarantine dir: {e}"))?;
    restrict_permissions(&quarantine_dir, 0o700);

    let dest = quarantine_dir.join(file_name);
    fs::rename(path, &dest)
        .map_err(|e| format!("failed to move {} to quarantine: {e}", path.display()))?;
    restrict_permissions(&dest, 0o600);

    let err_path = quarantine_dir.join(format!("{file_name}.error"));
    if let Err(e) = fs::write(&err_path, error) {
        log::debug!("[ClaudeMemory] could not write quarantine error sidecar: {e}");
    } else {
        restrict_permissions(&err_path, 0o600);
    }

    Ok(dest)
}

/// Splice `new_block` into `existing` at the auto-index markers, or append it
/// if the markers are absent. Malformed marker pairs (only one present, or
/// `END` before `BEGIN`) are treated as absent so the existing content is
/// never silently truncated.
fn merge_auto_index_block(existing: &str, new_block: &str) -> String {
    if let Some(begin_idx) = existing.find(AUTO_INDEX_BEGIN) {
        if let Some(end_rel) = existing[begin_idx..].find(AUTO_INDEX_END) {
            let end_idx = begin_idx + end_rel + AUTO_INDEX_END.len();
            let before = &existing[..begin_idx];
            let after = &existing[end_idx..];
            return format!("{before}{new_block}{after}");
        }
    }
    let trimmed = existing.trim_end_matches('\n');
    if trimmed.is_empty() {
        format!("# Claude Memory\n\n{new_block}\n")
    } else {
        format!("{trimmed}\n\n{new_block}\n")
    }
}

/// Render rows from `claude_agent_preferences` as the auto-index body that
/// goes between MEMORY.md's marker block. Output is grouped by `pref_type`
/// into `## <Title>` sections, with one `- [file.md](file.md) — description`
/// bullet per row. Bodies stay in SerenDB.
pub fn render_preferences_as_markdown(rows: &[Vec<serde_json::Value>]) -> String {
    if rows.is_empty() {
        return String::new();
    }

    // Rows arrive most-recent-first (see build_select_preferences_sql). Cap the
    // listed set so the index can't grow past the harness's load budget; the
    // remainder is summarized in an overflow footer and stays in SerenDB.
    let total = rows.len();
    let capped = &rows[..total.min(MAX_AUTO_INDEX_ENTRIES)];

    // Schema: pref_key, pref_type, description, content, source_file
    let mut sections: BTreeMap<String, Vec<(String, String, String)>> = BTreeMap::new();
    for row in capped {
        let pref_key = row.first().and_then(|v| v.as_str()).unwrap_or("");
        let pref_type = row
            .get(1)
            .and_then(|v| v.as_str())
            .unwrap_or("uncategorized");
        let description = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
        let source_file = row
            .get(4)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("{pref_key}.md"));
        sections.entry(pref_type.to_string()).or_default().push((
            pref_key.to_string(),
            source_file,
            description.to_string(),
        ));
    }

    let mut out = String::new();
    let mut first = true;
    for (pref_type, entries) in &sections {
        if !first {
            out.push('\n');
        }
        first = false;
        out.push_str(&format!("## {}\n", titleize(pref_type)));
        for (_pref_key, source_file, description) in entries {
            if description.is_empty() {
                out.push_str(&format!("- [{source_file}]({source_file})\n"));
            } else {
                out.push_str(&format!(
                    "- [{source_file}]({source_file}) — {description}\n"
                ));
            }
        }
    }

    let overflow = total.saturating_sub(capped.len());
    if overflow > 0 {
        out.push_str(&format!(
            "\n_+{overflow} more {} in SerenDB — recall via the seren MCP._\n",
            if overflow == 1 { "memory" } else { "memories" }
        ));
    }
    out
}

/// True when a rendered MEMORY.md exceeds the soft size budget. Pulled out so
/// the threshold is unit-testable without capturing log output.
pub fn memory_md_over_budget(byte_len: u64) -> bool {
    byte_len > MEMORY_MD_SIZE_BUDGET_BYTES
}

/// `feedback` → `Feedback`, `active_engagement` → `Active Engagement`.
fn titleize(s: &str) -> String {
    s.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Derive the encoded Claude project directory for a memory file. The
/// intercepted file lives at `<claude_project_dir>/memory/<name>.md`, so the
/// project dir is always the file's grandparent. Returns `None` for paths
/// that do not match that shape.
pub fn claude_project_dir_for_memory_file(path: &Path) -> Option<PathBuf> {
    Some(path.parent()?.parent()?.to_path_buf())
}

// ---------------------------------------------------------------------------
// SerenDB SQL HTTP client
// ---------------------------------------------------------------------------

/// Minimal SerenDB SQL client. Holds a `reqwest::Client` plus the user's
/// **SerenDB API key** used to authenticate `/query` calls. This is the
/// data plane credential — it is NOT the OAuth bearer token used for
/// Gateway API calls. Mixing these up produces "Failed to connect to
/// target database" errors because the SQL endpoint authenticates via API
/// key and the OAuth token has insufficient scope for it.
///
/// We do NOT depend on `seren-memory-sdk` — that's the user-memory store,
/// a different SerenDB surface entirely.
#[derive(Debug, Clone)]
pub struct SerenDbSqlClient {
    http: reqwest::Client,
    api_key: String,
}

impl SerenDbSqlClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key,
        }
    }

    /// Execute a SQL statement against `(project_id, branch_id, database_name)`.
    /// Returns the parsed `QueryResult` rows on success. Network or HTTP-level
    /// errors are surfaced as `Err(String)`.
    pub async fn run_sql(
        &self,
        config: &SerenDbConfig,
        sql: &str,
        read_only: bool,
    ) -> Result<QueryResult, String> {
        let body = serde_json::json!({
            "project_id": config.project_id,
            "branch_id": config.branch_id,
            "database": config.database_name,
            "query": sql,
            "read_only": read_only,
        });

        let resp = self
            .http
            .post(SERENDB_QUERY_URL)
            .bearer_auth(&self.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("SerenDB query request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let truncated = if text.len() > 500 {
                format!("{}…", &text[..500])
            } else {
                text
            };
            return Err(format!(
                "SerenDB query returned HTTP {}: {truncated}",
                status.as_u16()
            ));
        }

        let envelope: QueryEnvelope = resp
            .json()
            .await
            .map_err(|e| format!("SerenDB response parse error: {e}"))?;
        Ok(envelope.data)
    }
}

#[derive(Debug, Deserialize)]
struct QueryEnvelope {
    data: QueryResult,
}

/// Result rows from a SerenDB SQL `/query` call. Mirrors the OpenAPI
/// `QueryResult` type so deserialization works without depending on the
/// generated TypeScript SDK. `Serialize` is derived so `claude_memory_run_sql`
/// can return it directly to the frontend via Tauri IPC.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub row_count: usize,
    pub rows: Vec<Vec<serde_json::Value>>,
}

// ---------------------------------------------------------------------------
// Core interception logic
// ---------------------------------------------------------------------------

/// Outcome of a single [`process_memory_file`] call.
#[derive(Debug, Clone)]
pub enum ProcessOutcome {
    Skipped,
    Persisted {
        name: Option<String>,
        memory_type: String,
    },
}

/// Read a single memory file, INSERT it into `claude_agent_preferences` via
/// the supplied `SerenDbSqlClient`, and delete the file **only** on cloud
/// success. On failure the file is left on disk so the watcher can retry.
///
/// This is the single unit of work for the interceptor — the tokio event
/// loop calls it, the startup migration calls it, and the integration test
/// calls it. It does NOT touch the user-memory store (`memory_remember` /
/// `seren-memory-sdk`) — Claude memory is a separate SerenDB project.
pub async fn process_memory_file(
    path: &Path,
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
) -> Result<ProcessOutcome, String> {
    if !path.exists() {
        return Ok(ProcessOutcome::Skipped);
    }

    let contents =
        fs::read_to_string(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    if contents.trim().is_empty() {
        return Ok(ProcessOutcome::Skipped);
    }

    let parsed = parse_memory_file(&contents);
    let memory_type = parsed
        .frontmatter
        .memory_type
        .clone()
        .unwrap_or_else(|| DEFAULT_PREF_TYPE.to_string());

    let project_path = extract_claude_project_dir_name(path)
        .ok_or_else(|| format!("could not derive project path from {}", path.display()))?;
    let pref_key = derive_pref_key(path)
        .ok_or_else(|| format!("could not derive pref_key from {}", path.display()))?;
    let source_file = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_default();

    let sql = build_upsert_preference_sql(
        &project_path,
        &pref_key,
        &memory_type,
        parsed.frontmatter.description.as_deref(),
        &parsed.body,
        &source_file,
    );

    // Await the REAL SerenDB SQL INSERT. On Err we return without deleting
    // the file so the watcher can retry on the next event.
    client
        .run_sql(config, &sql, /* read_only */ false)
        .await
        .map_err(|e| format!("serendb INSERT failed: {e}"))?;

    fs::remove_file(path).map_err(|e| format!("failed to delete {}: {e}", path.display()))?;

    Ok(ProcessOutcome::Persisted {
        name: parsed.frontmatter.name,
        memory_type,
    })
}

/// Render `memory/MEMORY.md` for a given Claude project directory by SELECTing all
/// preference rows from SerenDB and formatting them as Markdown.
pub async fn render_memory_md_from_db(
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
    claude_project_dir: &Path,
) -> Result<PathBuf, String> {
    let project_path = claude_project_dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid claude project dir name".to_string())?;

    let sql = build_select_preferences_sql(project_path);
    let result = client
        .run_sql(config, &sql, /* read_only */ true)
        .await
        .map_err(|e| format!("serendb SELECT failed: {e}"))?;
    // Routine per-refresh bookkeeping; only useful while debugging memory
    // provisioning. Keep it out of the INFO console to reduce noise. #2500.
    log::debug!(
        "[ClaudeMemory] SELECT returned {} preference rows for project {}",
        result.row_count,
        project_path
    );
    let rendered = render_preferences_as_markdown(&result.rows);
    write_rendered_memory_md(claude_project_dir, &rendered)
}

// ---------------------------------------------------------------------------
// Tauri-facing auth + client bootstrap
// ---------------------------------------------------------------------------

/// Read the user's SerenDB API key from the Tauri store. This is the data
/// plane credential for `api.serendb.com/publishers/seren-db/query` and is
/// different from the OAuth bearer token used elsewhere in the app. If the
/// API key is missing the user needs to log in to Seren Desktop (the login
/// flow stores the key via `storeSerenApiKey()`).
fn read_seren_api_key(app: &AppHandle) -> Result<String, String> {
    let key = app
        .store(AUTH_STORE)
        .map_err(|e| e.to_string())?
        .get(SEREN_API_KEY_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    if key.is_empty() {
        return Err(
            "SerenDB API key not available — log in to Seren Desktop so the key is provisioned"
                .to_string(),
        );
    }
    Ok(key)
}

pub(crate) fn build_sql_client(app: &AppHandle) -> Result<SerenDbSqlClient, String> {
    let api_key = read_seren_api_key(app)?;
    Ok(SerenDbSqlClient::new(api_key))
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

/// Start watching `~/.claude/projects` recursively. Any `.md` write inside a
/// `memory/` subdirectory is intercepted, INSERTed into the
/// `claude_agent_preferences` table in the supplied SerenDB destination, and
/// deleted from disk on success.
pub fn start_watcher(app: AppHandle, config: SerenDbConfig) -> Result<PathBuf, String> {
    // Validate credentials up-front so the user sees the error in the UI
    // instead of discovering it via a silent watcher failure later.
    let _ = build_sql_client(&app)?;

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

    let app_for_task = app.clone();
    let config_for_task = config.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                maybe_path = event_rx.recv() => {
                    match maybe_path {
                        Some(path) => {
                            handle_event(&app_for_task, path, &config_for_task).await;
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
    slot.config = Some(config.clone());
    drop(slot);

    log::info!(
        "[ClaudeMemory] watcher started on {} (project_id={}, database={})",
        root.display(),
        config.project_id,
        config.database_name
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
    slot.config = None;
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

async fn handle_event(app: &AppHandle, path: PathBuf, config: &SerenDbConfig) {
    let memory_type_fallback = DEFAULT_PREF_TYPE.to_string();

    let client = match build_sql_client(app) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[ClaudeMemory] skipping {}: cannot build SerenDB SQL client: {e}",
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

    match process_memory_file(&path, &client, config).await {
        Ok(ProcessOutcome::Persisted { name, memory_type }) => {
            // A clean write clears any prior failure streak for this path.
            clear_failure(&path);
            log::info!(
                "[ClaudeMemory] persisted {} to claude_agent_preferences and removed plaintext file",
                path.display()
            );

            let mut rendered_memory_md = None;
            let mut render_error = None;

            // Refresh MEMORY.md so the agent that wrote this file can see
            // its entry appear in the index — closing the feedback gap that
            // caused the "memory write vanished" loop. Failures here MUST
            // NOT mask the successful intercept (the row is already in
            // SerenDB); we only log them.
            if let Some(claude_project_dir) = claude_project_dir_for_memory_file(&path) {
                match render_memory_md_from_db(&client, config, &claude_project_dir).await {
                    Ok(rendered_path) => {
                        rendered_memory_md = Some(rendered_path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        log::warn!(
                            "[ClaudeMemory] persisted {} but MEMORY.md refresh failed: {e}",
                            path.display()
                        );
                        render_error = Some(e);
                    }
                }
            } else {
                let message = format!(
                    "[ClaudeMemory] persisted {} but could not derive claude project dir for MEMORY.md refresh",
                    path.display()
                );
                log::warn!("{message}");
                render_error = Some(message);
            }

            let _ = app.emit(
                "claude-memory-intercepted",
                InterceptSuccessEvent {
                    path: path.to_string_lossy().to_string(),
                    name,
                    memory_type,
                    rendered_memory_md,
                    render_error,
                },
            );
        }
        Ok(ProcessOutcome::Skipped) => {}
        Err(e) => {
            let failures = record_failure(&path);
            if should_quarantine(failures) {
                match quarantine_failed_file(&path, &e) {
                    Ok(dest) => {
                        clear_failure(&path);
                        log::warn!(
                            "[ClaudeMemory] {} failed {failures}x — quarantined to {}: {e}",
                            path.display(),
                            dest.display()
                        );
                        let _ = app.emit(
                            "claude-memory-intercept-quarantined",
                            InterceptQuarantineEvent {
                                path: path.to_string_lossy().to_string(),
                                quarantine_path: dest.to_string_lossy().to_string(),
                                error: e,
                            },
                        );
                    }
                    Err(qe) => {
                        // Could not move it; leave it for another retry and
                        // surface both errors.
                        log::warn!(
                            "[ClaudeMemory] {} failed {failures}x and could not be quarantined ({qe}): {e}",
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
            } else {
                log::warn!(
                    "[ClaudeMemory] {} left on disk (failure {failures}/{MAX_INTERCEPT_RETRIES}) — cloud write failed: {e}",
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
}

// ---------------------------------------------------------------------------
// Startup migration
// ---------------------------------------------------------------------------

/// Walk every `~/.claude/projects/*/memory/` directory and INSERT any
/// pre-existing `.md` files into SerenDB. Returns the number successfully
/// persisted. Files whose cloud write fails are left on disk and counted in
/// `failures`.
pub async fn migrate_existing_files(
    app: &AppHandle,
    config: &SerenDbConfig,
) -> Result<MigrationReport, String> {
    let client = build_sql_client(app)?;
    sync_all_projects(&client, config).await
}

/// Flush every pending memory file under `~/.claude/projects` into SerenDB and
/// re-render each affected `MEMORY.md`. This is the AppHandle-free core shared
/// by the in-app startup migration and the headless `claude_memory_sync`
/// entrypoint — it depends only on a `SerenDbSqlClient` + `SerenDbConfig`, so
/// the index can be kept consistent without launching the desktop app.
pub async fn sync_all_projects(
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
) -> Result<MigrationReport, String> {
    let root = claude_projects_root()?;
    sync_projects_under_root(&root, client, config).await
}

/// Root-parametrized worker behind [`sync_all_projects`] so the walk can be
/// exercised against a temp tree in tests without touching `$HOME`.
async fn sync_projects_under_root(
    root: &Path,
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
) -> Result<MigrationReport, String> {
    if !root.exists() {
        return Ok(MigrationReport::default());
    }

    let mut report = MigrationReport::default();
    let mut projects_to_render = BTreeSet::new();
    let project_dirs =
        fs::read_dir(root).map_err(|e| format!("failed to read claude projects root: {e}"))?;

    for entry in project_dirs.flatten() {
        flush_memory_dir(
            &entry.path(),
            client,
            config,
            &mut report,
            &mut projects_to_render,
        )
        .await;
    }

    render_projects(projects_to_render, client, config, &mut report).await;

    log::info!(
        "[ClaudeMemory] sync finished: persisted={} failures={} rendered={} render_failures={}",
        report.persisted,
        report.failures,
        report.rendered,
        report.render_failures
    );
    Ok(report)
}

/// Flush + render a single project addressed by its working directory. Lets the
/// headless entrypoint target one repo instead of walking everything.
pub async fn sync_project(
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
    project_cwd: &Path,
) -> Result<MigrationReport, String> {
    let root = claude_projects_root()?;
    let claude_project_dir = root.join(encode_project_dir(project_cwd));
    let mut report = MigrationReport::default();
    let mut projects_to_render = BTreeSet::new();
    flush_memory_dir(
        &claude_project_dir,
        client,
        config,
        &mut report,
        &mut projects_to_render,
    )
    .await;
    render_projects(projects_to_render, client, config, &mut report).await;
    Ok(report)
}

/// Persist every interceptable file in `<claude_project_dir>/memory/` and queue
/// the project for an index refresh if anything was written.
async fn flush_memory_dir(
    claude_project_dir: &Path,
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
    report: &mut MigrationReport,
    projects_to_render: &mut BTreeSet<PathBuf>,
) {
    let memory_dir = claude_project_dir.join("memory");
    if !memory_dir.is_dir() {
        return;
    }
    let files = match fs::read_dir(&memory_dir) {
        Ok(f) => f,
        Err(_) => return,
    };
    for file in files.flatten() {
        let path = file.path();
        if !should_intercept_path(&path) {
            continue;
        }
        match process_memory_file(&path, client, config).await {
            Ok(ProcessOutcome::Persisted { .. }) => {
                report.persisted += 1;
                projects_to_render.insert(claude_project_dir.to_path_buf());
            }
            Ok(ProcessOutcome::Skipped) => {}
            Err(e) => {
                log::warn!("[ClaudeMemory] sync failed for {}: {e}", path.display());
                report.failures += 1;
            }
        }
    }
}

/// Re-render `MEMORY.md` for each project that had a successful flush.
async fn render_projects(
    projects: BTreeSet<PathBuf>,
    client: &SerenDbSqlClient,
    config: &SerenDbConfig,
    report: &mut MigrationReport,
) {
    for claude_project_dir in projects {
        match render_memory_md_from_db(client, config, &claude_project_dir).await {
            Ok(path) => {
                report.rendered += 1;
                log::info!("[ClaudeMemory] sync refreshed {}", path.display());
            }
            Err(e) => {
                report.render_failures += 1;
                log::warn!(
                    "[ClaudeMemory] sync could not refresh MEMORY.md for {}: {e}",
                    claude_project_dir.display()
                );
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MigrationReport {
    pub persisted: usize,
    pub failures: usize,
    pub rendered: usize,
    pub render_failures: usize,
}

// ---------------------------------------------------------------------------
// Pure-function tests
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
    fn session_jsonl_path_constructs_expected_layout_and_detects_presence() {
        // Mirrors Claude CLI's real on-disk layout:
        //   <root>/<encoded(cwd)>/<session_id>.jsonl
        // The pre-#1825 implementation pointed at a `sessions/` subdir that
        // Claude Code does not create — `claude_session_exists` therefore
        // always returned false and the resume-side gate from #1657 silently
        // skipped --resume on every reload. The test now codifies the real
        // layout (a flat `<id>.jsonl` directly under the encoded project
        // dir) so any future drift back to the bogus `sessions/` segment
        // fails fast.
        let tmp = TempDir::new().expect("tempdir");
        let root = tmp.path();
        let cwd = tmp.path().join("Projects").join("seren-desktop");
        fs::create_dir_all(&cwd).expect("create fake cwd");
        let session_id = "6b43ee5e-5699-486b-98c5-bbf42f703a19";

        let path_before = session_jsonl_path(root, &cwd, session_id);
        assert!(
            !path_before.is_file(),
            "missing session must NOT be reported as present (this is the stale-session case the fix addresses)",
        );

        // Layout assertion: <id>.jsonl lives directly inside the encoded
        // project dir — there is NO `sessions/` segment in the real CLI
        // layout. The parent dir must equal the encoded project dir.
        let session_dir = path_before
            .parent()
            .expect("session jsonl must have a parent dir");
        assert!(
            !session_dir.ends_with("sessions"),
            "real Claude Code layout has no `sessions/` subdir — the pre-#1825 path was wrong",
        );
        assert_eq!(
            session_dir.file_name().and_then(|n| n.to_str()),
            Some(encode_project_dir(&cwd).as_str()),
            "session jsonl must live directly under <root>/<encoded(cwd)>",
        );

        fs::create_dir_all(session_dir).expect("create encoded project dir");
        fs::write(&path_before, b"{\"stub\":true}\n").expect("write stub session");
        assert!(
            path_before.is_file(),
            "present session file MUST be reported as present so --resume is allowed",
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
    fn extract_claude_project_dir_name_from_memory_path() {
        let path = Path::new("/home/a/.claude/projects/-Users-x-foo/memory/feedback_test.md");
        assert_eq!(
            extract_claude_project_dir_name(path),
            Some("-Users-x-foo".to_string())
        );
    }

    #[test]
    fn encode_project_dir_collapses_underscore_dot_and_other_specials() {
        // #1836: every non-`[a-zA-Z0-9-]` char in the absolute cwd collapses
        // to `-`, matching the Claude Code CLI's on-disk naming. Restricting
        // to just `/` produced encoded names that didn't exist on disk for
        // any cwd containing `_` (e.g. `Foo_Bar`) or `.` (e.g. `.app`),
        // breaking fork, MEMORY.md render, and `claude_session_exists`.
        let cwd = Path::new("/Users/x/Projects/Seren_Projects/seren-bounty");
        assert_eq!(
            encode_project_dir(cwd),
            "-Users-x-Projects-Seren-Projects-seren-bounty"
        );

        let dotted = Path::new("/Users/x/.claude/plugins");
        assert_eq!(encode_project_dir(dotted), "-Users-x--claude-plugins");

        let plain = Path::new("/Users/x/Projects/seren-desktop");
        assert_eq!(encode_project_dir(plain), "-Users-x-Projects-seren-desktop");
    }

    #[test]
    fn derive_pref_key_strips_md_extension() {
        let path = Path::new("/some/dir/feedback_smoke_test.md");
        assert_eq!(
            derive_pref_key(path),
            Some("feedback_smoke_test".to_string())
        );
    }

    #[test]
    fn write_rendered_memory_md_preserves_content_outside_markers() {
        // Re-rendering MEMORY.md after a SerenDB intercept MUST NOT clobber
        // hand-curated content the user wrote outside the auto-index block.
        // Only the content between AUTO_INDEX_BEGIN and AUTO_INDEX_END is
        // refreshed; everything else (headings, notes, prose) survives.
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("-proj");
        fs::create_dir_all(dir.join("memory")).unwrap();
        let path = dir.join("memory").join("MEMORY.md");
        let existing = "# Seren Desktop Memory\n\n## Critical Lessons\n\
            - hand-written note that must survive a re-render\n\n\
            <!-- BEGIN AUTO-INDEX -->\nstale auto content\n<!-- END AUTO-INDEX -->\n\n\
            ## Trailing hand-written section\n- also must survive\n";
        fs::write(&path, existing).unwrap();

        let result =
            write_rendered_memory_md(&dir, "## Feedback\n- [foo.md](foo.md) — hook\n").unwrap();
        let merged = fs::read_to_string(&result).unwrap();

        assert!(merged.contains("hand-written note that must survive a re-render"));
        assert!(merged.contains("Trailing hand-written section"));
        assert!(merged.contains("- also must survive"));
        assert!(merged.contains("## Feedback"));
        assert!(merged.contains("- [foo.md](foo.md) — hook"));
        assert!(
            !merged.contains("stale auto content"),
            "stale content inside markers MUST be replaced"
        );
        assert!(!dir.join("memory").join("MEMORY.md.tmp").exists());
    }

    #[test]
    fn write_rendered_memory_md_appends_block_when_markers_missing() {
        // A user with a hand-curated MEMORY.md that predates the marker
        // convention must not lose their content on first re-render. We
        // append a fresh auto-index block to the existing file rather than
        // overwriting it.
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("-proj");
        fs::create_dir_all(dir.join("memory")).unwrap();
        let path = dir.join("memory").join("MEMORY.md");
        let existing = "# Seren Desktop Memory\n\n## Critical Lessons\n- must survive\n";
        fs::write(&path, existing).unwrap();

        let result =
            write_rendered_memory_md(&dir, "## Feedback\n- [foo.md](foo.md) — hook\n").unwrap();
        let merged = fs::read_to_string(&result).unwrap();

        assert!(merged.contains("## Critical Lessons"));
        assert!(merged.contains("- must survive"));
        assert!(merged.contains("<!-- BEGIN AUTO-INDEX -->"));
        assert!(merged.contains("<!-- END AUTO-INDEX -->"));
        assert!(merged.contains("- [foo.md](foo.md) — hook"));
    }

    #[test]
    fn claude_project_dir_for_memory_file_returns_grandparent() {
        // The intercept handler derives the claude project dir from the
        // intercepted file path so it can call render_memory_md_from_db
        // without depending on outside state. The dir is always the file's
        // grandparent (parent is the `memory/` subdir).
        let path = Path::new("/home/a/.claude/projects/-Users-x-foo/memory/feedback_test.md");
        assert_eq!(
            claude_project_dir_for_memory_file(path),
            Some(PathBuf::from("/home/a/.claude/projects/-Users-x-foo"))
        );
        assert_eq!(claude_project_dir_for_memory_file(Path::new("/")), None);
    }

    #[test]
    fn write_rendered_memory_md_targets_memory_subdir_and_replaces_stale_index() {
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("-proj");

        let first = write_rendered_memory_md(
            &dir,
            "## Feedback\n- [stale.md](stale.md) — stale description\n",
        )
        .unwrap();
        assert_eq!(first, dir.join("memory").join("MEMORY.md"));
        let first_modified = fs::metadata(&first).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(20));

        let second = write_rendered_memory_md(
            &dir,
            "## Feedback\n- [current.md](current.md) — current description\n",
        )
        .unwrap();
        let second_modified = fs::metadata(&second).unwrap().modified().unwrap();
        let rendered = fs::read_to_string(&second).unwrap();

        assert!(rendered.contains("current description"));
        assert!(!rendered.contains("stale description"));
        assert!(
            second_modified >= first_modified,
            "MEMORY.md mtime must not go backwards after a refresh"
        );
        assert!(!dir.join("MEMORY.md").exists());
    }

    // ---- SQL builder tests (the heart of the #1509 storage rebuild) ------

    #[test]
    fn quote_sql_string_doubles_single_quotes() {
        assert_eq!(quote_sql_string("plain"), "'plain'");
        assert_eq!(quote_sql_string("O'Brien"), "'O''Brien'");
        assert_eq!(
            quote_sql_string("multiple ' single ' quotes"),
            "'multiple '' single '' quotes'"
        );
        assert_eq!(quote_sql_string(""), "''");
    }

    #[test]
    fn quote_sql_string_does_not_treat_backslash_as_escape() {
        // Postgres standard strings (standard_conforming_strings = on, the
        // default) treat backslashes literally. We must not transform them.
        assert_eq!(quote_sql_string("a\\b"), "'a\\b'");
        assert_eq!(quote_sql_string("a\\nb"), "'a\\nb'");
    }

    #[test]
    fn build_upsert_preference_sql_escapes_all_user_input() {
        // The most important test: a project_path or content with embedded
        // single quotes must NOT break out of the SQL string. This is the
        // injection-prevention guarantee for the #1509 storage layer.
        let sql = build_upsert_preference_sql(
            "-Users-x-evil'project",       // injection attempt in project_path
            "feedback_'; DROP TABLE foo;", // injection attempt in pref_key
            "feedback",
            Some("description with ' quote"),
            "content with multiple ' embedded ' quotes",
            "feedback_evil.md",
        );

        // The injection vectors must all be doubled, not opened.
        assert!(sql.contains("'-Users-x-evil''project'"));
        assert!(sql.contains("'feedback_''; DROP TABLE foo;'"));
        assert!(sql.contains("'description with '' quote'"));
        assert!(sql.contains("'content with multiple '' embedded '' quotes'"));
        // Sanity: the statement is well-formed (correct table, ON CONFLICT clause).
        assert!(sql.contains("INSERT INTO claude_agent_preferences"));
        assert!(sql.contains("ON CONFLICT (project_path, pref_key) DO UPDATE"));
    }

    #[test]
    fn build_upsert_preference_sql_handles_null_description() {
        let sql =
            build_upsert_preference_sql("-proj", "no_desc", "feedback", None, "body", "no_desc.md");
        // None description must serialize as the literal NULL keyword,
        // not as a quoted empty string.
        assert!(sql.contains(", NULL,"));
    }

    #[test]
    fn build_select_preferences_sql_escapes_project_path() {
        let sql = build_select_preferences_sql("-Users-x-evil'project");
        assert!(sql.contains("'-Users-x-evil''project'"));
        assert!(sql.contains("FROM claude_agent_preferences"));
        // Recency ordering so the renderer's entry cap keeps the freshest rows.
        assert!(sql.contains("ORDER BY updated_at DESC NULLS LAST, pref_key"));
        // updated_at must be projected for the ordering to be selectable.
        assert!(sql.contains("source_file, updated_at"));
    }

    #[test]
    fn render_preferences_as_markdown_groups_rows_into_section_bullets() {
        // The auto-index body is the only thing that goes between the
        // MEMORY.md marker block. It MUST be a section-grouped bullet
        // index — `## <Type>` headings with `- [file.md](file.md) — desc`
        // bullets — to match the curated MEMORY.md format. Bodies and
        // frontmatter are NOT emitted (those live in SerenDB and would
        // bloat the index).
        let rows = vec![
            vec![
                serde_json::json!("feedback_one"),
                serde_json::json!("feedback"),
                serde_json::json!("first description"),
                serde_json::json!("first body — must NOT appear"),
                serde_json::json!("feedback_one.md"),
            ],
            vec![
                serde_json::json!("project_two"),
                serde_json::json!("project"),
                serde_json::json!(null),
                serde_json::json!("second body — must NOT appear"),
                serde_json::json!("project_two.md"),
            ],
        ];
        let rendered = render_preferences_as_markdown(&rows);

        assert!(rendered.contains("## Feedback"));
        assert!(rendered.contains("- [feedback_one.md](feedback_one.md) — first description"));
        assert!(rendered.contains("## Project"));
        assert!(rendered.contains("- [project_two.md](project_two.md)"));
        assert!(
            !rendered.contains("must NOT appear"),
            "bodies must not bleed into the auto-index"
        );
        assert!(
            !rendered.contains("name: feedback_one"),
            "frontmatter blocks must not appear in the auto-index"
        );
    }

    // ---- #2637: bounded auto-index + size budget --------------------------

    #[test]
    fn render_preferences_caps_entries_and_emits_overflow_footer() {
        // More rows than the cap → exactly MAX_AUTO_INDEX_ENTRIES are listed
        // and the remainder is summarized so nothing is silently dropped.
        let n = MAX_AUTO_INDEX_ENTRIES + 7;
        let rows: Vec<Vec<serde_json::Value>> = (0..n)
            .map(|i| {
                vec![
                    serde_json::json!(format!("pref_{i}")),
                    serde_json::json!("project"),
                    serde_json::json!(format!("desc {i}")),
                    serde_json::json!("body"),
                    serde_json::json!(format!("pref_{i}.md")),
                ]
            })
            .collect();
        let rendered = render_preferences_as_markdown(&rows);
        let listed = rendered.matches("](").count();
        assert_eq!(
            listed, MAX_AUTO_INDEX_ENTRIES,
            "must list exactly the cap, not every row"
        );
        assert!(
            rendered.contains("_+7 more memories in SerenDB"),
            "overflow remainder must be surfaced; got:\n{rendered}"
        );
    }

    #[test]
    fn render_preferences_no_footer_when_within_cap() {
        let rows = vec![vec![
            serde_json::json!("pref_one"),
            serde_json::json!("project"),
            serde_json::json!("desc"),
            serde_json::json!("body"),
            serde_json::json!("pref_one.md"),
        ]];
        let rendered = render_preferences_as_markdown(&rows);
        assert!(!rendered.contains("more memor"));
    }

    #[test]
    fn memory_md_over_budget_is_strict_threshold() {
        assert!(!memory_md_over_budget(0));
        assert!(!memory_md_over_budget(MEMORY_MD_SIZE_BUDGET_BYTES));
        assert!(memory_md_over_budget(MEMORY_MD_SIZE_BUDGET_BYTES + 1));
    }

    // ---- #2638: secure perms + quarantine ---------------------------------

    #[test]
    fn should_quarantine_only_at_retry_ceiling() {
        assert!(!should_quarantine(0));
        assert!(!should_quarantine(MAX_INTERCEPT_RETRIES - 1));
        assert!(should_quarantine(MAX_INTERCEPT_RETRIES));
        assert!(should_quarantine(MAX_INTERCEPT_RETRIES + 1));
    }

    #[test]
    fn quarantine_failed_file_moves_file_with_error_sidecar() {
        let tmp = TempDir::new().expect("tempdir");
        let memory_dir = tmp.path().join("-proj").join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        let file = memory_dir.join("feedback_bad.md");
        fs::write(&file, "---\ntype: feedback\n---\nbody").unwrap();

        let dest = quarantine_failed_file(&file, "serendb INSERT failed: boom").unwrap();

        assert!(!file.exists(), "original must leave the live memory dir");
        assert!(dest.exists(), "file must land in quarantine");
        assert_eq!(
            dest.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str()),
            Some(QUARANTINE_DIR_NAME)
        );
        let sidecar = memory_dir
            .join(QUARANTINE_DIR_NAME)
            .join("feedback_bad.md.error");
        assert!(sidecar.exists(), "error sidecar must be written");
        assert!(fs::read_to_string(&sidecar).unwrap().contains("boom"));
        assert!(
            !should_intercept_path(&dest),
            "a quarantined file must never be re-intercepted"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_rendered_memory_md_sets_owner_only_perms() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().expect("tempdir");
        let dir = tmp.path().join("-proj");
        let path = write_rendered_memory_md(&dir, "## Feedback\n- [a.md](a.md) — x\n").unwrap();
        let file_mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600, "rendered MEMORY.md must be owner-only");
        let dir_mode = fs::metadata(dir.join("memory"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "memory dir must be owner-only");
    }

    // ---- #2639: AppHandle-free headless sync ------------------------------

    #[tokio::test]
    async fn sync_projects_under_empty_root_is_noop_without_network() {
        // An empty projects root returns a default report and makes NO network
        // call — proving the sync core is AppHandle-free and safe to run
        // headless. The client holds a key that would fail any real request.
        let tmp = TempDir::new().expect("tempdir");
        let client = SerenDbSqlClient::new("unused-test-key".to_string());
        let config = SerenDbConfig {
            project_id: "p".into(),
            branch_id: "b".into(),
            database_name: "d".into(),
        };
        let report = sync_projects_under_root(tmp.path(), &client, &config)
            .await
            .expect("empty tree must not error");
        assert_eq!(report.persisted, 0);
        assert_eq!(report.rendered, 0);
        assert_eq!(report.failures, 0);
        assert_eq!(report.render_failures, 0);
    }
}

// ---------------------------------------------------------------------------
// SerenDB SQL round-trip integration test (ignored by default)
//
// This is the ONLY test that talks to the network. It proves the spec:
// a file intercepted by our code ends up as a row in the
// `claude_agent_preferences` table and comes back out via SELECT.
//
//   SEREN_CLAUDE_MEMORY_TEST_TOKEN=<oauth-bearer-token> \
//   SEREN_CLAUDE_MEMORY_TEST_PROJECT_ID=<serendb-project-uuid> \
//   SEREN_CLAUDE_MEMORY_TEST_BRANCH_ID=<serendb-branch-uuid> \
//   SEREN_CLAUDE_MEMORY_TEST_DATABASE=<serendb-database-name> \
//   cargo test --lib claude_memory -- --ignored --nocapture \
//     serendb_sql_roundtrip_persists_and_selects
// ---------------------------------------------------------------------------

#[cfg(test)]
mod integration {
    use super::*;
    use tempfile::TempDir;

    fn require_env(name: &str) -> String {
        match std::env::var(name) {
            Ok(v) if !v.trim().is_empty() => v,
            _ => panic!("{name} is not set — SerenDB SQL roundtrip test requires live credentials"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires live SerenDB credentials; see module docs"]
    async fn serendb_sql_roundtrip_persists_and_selects() {
        let token = require_env("SEREN_CLAUDE_MEMORY_TEST_TOKEN");
        let project_id = require_env("SEREN_CLAUDE_MEMORY_TEST_PROJECT_ID");
        let branch_id = require_env("SEREN_CLAUDE_MEMORY_TEST_BRANCH_ID");
        let database_name = require_env("SEREN_CLAUDE_MEMORY_TEST_DATABASE");

        let client = SerenDbSqlClient::new(token);
        let config = SerenDbConfig {
            project_id,
            branch_id,
            database_name,
        };

        // Spin up a temp Claude-style memory directory and write a marker file.
        let tmp = TempDir::new().expect("tempdir");
        let project_dir_name = format!("-test-roundtrip-{}", Uuid::new_v4());
        let memory_dir = tmp.path().join(&project_dir_name).join("memory");
        fs::create_dir_all(&memory_dir).unwrap();

        let marker = format!("MARKER-{}", Uuid::new_v4());
        let file_path = memory_dir.join("feedback_roundtrip.md");
        let contents = format!(
            "---\nname: roundtrip\ndescription: integration test marker\ntype: feedback\n---\n{marker} — claude-memory SQL roundtrip test, safe to delete.\n"
        );
        fs::write(&file_path, &contents).unwrap();

        // Exercise the production code path.
        let outcome = process_memory_file(&file_path, &client, &config)
            .await
            .expect("process_memory_file must succeed against live SerenDB");
        match outcome {
            ProcessOutcome::Persisted { memory_type, .. } => {
                assert_eq!(memory_type, "feedback");
            }
            other => panic!("expected Persisted, got {other:?}"),
        }
        assert!(
            !file_path.exists(),
            "file must be deleted after successful SerenDB SQL INSERT"
        );

        // Round-trip: SELECT the row back via the SAME client and assert
        // the marker comes back from SerenDB.
        let select = build_select_preferences_sql(&project_dir_name);
        let result = client
            .run_sql(&config, &select, true)
            .await
            .expect("SELECT against live SerenDB must succeed");
        assert!(
            result.row_count >= 1,
            "expected at least one row, got {}",
            result.row_count
        );
        let any_marker = result.rows.iter().any(|row| {
            row.iter()
                .any(|v| v.as_str().is_some_and(|s| s.contains(&marker)))
        });
        assert!(
            any_marker,
            "expected SELECT to return a row containing {marker}; rows: {:?}",
            result.rows
        );

        // Cleanup: delete the test row so the table doesn't accumulate
        // marker rows across runs.
        let cleanup = format!(
            "DELETE FROM claude_agent_preferences WHERE project_path = {};",
            quote_sql_string(&project_dir_name)
        );
        let _ = client.run_sql(&config, &cleanup, false).await;
    }
}
