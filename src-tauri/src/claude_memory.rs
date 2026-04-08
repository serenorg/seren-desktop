// ABOUTME: Intercepts Claude Code auto-memory writes and persists them to SerenDB SQL.
// ABOUTME: Watches ~/.claude/projects/*/memory/ and INSERTs each file as a row in
// ABOUTME: claude_agent_preferences. Storage is a separate SerenDB project from user memory.

use std::collections::HashMap;
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
const AUTH_TOKEN_KEY: &str = "token";
const RENDERED_INDEX_FILENAME: &str = "MEMORY.md";
const PROJECT_ID_FILENAME: &str = "project_id";
const DEFAULT_PREF_TYPE: &str = "claude_preference";

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

/// Build a SELECT to read all preferences for a project, ordered by pref_type
/// and pref_key for stable rendering. Used by `MEMORY.md` rendering.
pub fn build_select_preferences_sql(project_path: &str) -> String {
    format!(
        "SELECT pref_key, pref_type, description, content, source_file \
         FROM claude_agent_preferences \
         WHERE project_path = {project_path} \
         ORDER BY pref_type, pref_key;",
        project_path = quote_sql_string(project_path),
    )
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

/// Render rows from `claude_agent_preferences` as a Markdown document Claude
/// Code can read at session start.
pub fn render_preferences_as_markdown(rows: &[Vec<serde_json::Value>]) -> String {
    if rows.is_empty() {
        return "# Claude Memory\n\n_No preferences stored yet._\n".to_string();
    }
    let mut out = String::from("# Claude Memory\n\n");
    for row in rows {
        // Schema: pref_key, pref_type, description, content, source_file
        let pref_key = row.first().and_then(|v| v.as_str()).unwrap_or("");
        let pref_type = row.get(1).and_then(|v| v.as_str()).unwrap_or("");
        let description = row.get(2).and_then(|v| v.as_str()).unwrap_or("");
        let content = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
        let source_file = row.get(4).and_then(|v| v.as_str()).unwrap_or("");

        out.push_str("---\n");
        out.push_str(&format!("name: {pref_key}\n"));
        out.push_str(&format!("type: {pref_type}\n"));
        if !description.is_empty() {
            out.push_str(&format!("description: {description}\n"));
        }
        if !source_file.is_empty() {
            out.push_str(&format!("source_file: {source_file}\n"));
        }
        out.push_str("---\n");
        out.push_str(content);
        if !content.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// SerenDB SQL HTTP client
// ---------------------------------------------------------------------------

/// Minimal SerenDB SQL client. Holds a `reqwest::Client` plus the OAuth
/// bearer token used to authenticate `/query` calls. We do NOT depend on
/// `seren-memory-sdk` — that's the user-memory store, a different SerenDB
/// surface entirely.
#[derive(Debug, Clone)]
pub struct SerenDbSqlClient {
    http: reqwest::Client,
    token: String,
}

impl SerenDbSqlClient {
    pub fn new(token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
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
            .bearer_auth(&self.token)
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
/// generated TypeScript SDK.
#[derive(Debug, Deserialize, Clone)]
pub struct QueryResult {
    #[allow(dead_code)]
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

/// Render `MEMORY.md` for a given Claude project directory by SELECTing all
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
    log::info!(
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

fn read_auth_token(app: &AppHandle) -> Result<String, String> {
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

fn build_sql_client(app: &AppHandle) -> Result<SerenDbSqlClient, String> {
    let token = read_auth_token(app)?;
    Ok(SerenDbSqlClient::new(token))
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
            log::info!(
                "[ClaudeMemory] persisted {} to claude_agent_preferences and removed plaintext file",
                path.display()
            );
            let _ = app.emit(
                "claude-memory-intercepted",
                InterceptSuccessEvent {
                    path: path.to_string_lossy().to_string(),
                    name,
                    memory_type,
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

/// Walk every `~/.claude/projects/*/memory/` directory and INSERT any
/// pre-existing `.md` files into SerenDB. Returns the number successfully
/// persisted. Files whose cloud write fails are left on disk and counted in
/// `failures`.
pub async fn migrate_existing_files(
    app: &AppHandle,
    config: &SerenDbConfig,
) -> Result<MigrationReport, String> {
    let client = build_sql_client(app)?;
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
            match process_memory_file(&path, &client, config).await {
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
    fn derive_pref_key_strips_md_extension() {
        let path = Path::new("/some/dir/feedback_smoke_test.md");
        assert_eq!(derive_pref_key(path), Some("feedback_smoke_test".to_string()));
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
        let sql = build_upsert_preference_sql(
            "-proj",
            "no_desc",
            "feedback",
            None,
            "body",
            "no_desc.md",
        );
        // None description must serialize as the literal NULL keyword,
        // not as a quoted empty string.
        assert!(sql.contains(", NULL,"));
    }

    #[test]
    fn build_select_preferences_sql_escapes_project_path() {
        let sql = build_select_preferences_sql("-Users-x-evil'project");
        assert!(sql.contains("'-Users-x-evil''project'"));
        assert!(sql.contains("FROM claude_agent_preferences"));
        assert!(sql.contains("ORDER BY pref_type, pref_key"));
    }

    #[test]
    fn render_preferences_as_markdown_empty_returns_placeholder() {
        let rendered = render_preferences_as_markdown(&[]);
        assert!(rendered.contains("# Claude Memory"));
        assert!(rendered.contains("No preferences stored yet"));
    }

    #[test]
    fn render_preferences_as_markdown_includes_each_row() {
        let rows = vec![
            vec![
                serde_json::json!("feedback_one"),
                serde_json::json!("feedback"),
                serde_json::json!("first description"),
                serde_json::json!("first body"),
                serde_json::json!("feedback_one.md"),
            ],
            vec![
                serde_json::json!("project_two"),
                serde_json::json!("project"),
                serde_json::json!(null),
                serde_json::json!("second body"),
                serde_json::json!("project_two.md"),
            ],
        ];
        let rendered = render_preferences_as_markdown(&rows);
        assert!(rendered.contains("name: feedback_one"));
        assert!(rendered.contains("type: feedback"));
        assert!(rendered.contains("description: first description"));
        assert!(rendered.contains("first body"));
        assert!(rendered.contains("name: project_two"));
        assert!(rendered.contains("type: project"));
        assert!(rendered.contains("second body"));
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
            _ => panic!(
                "{name} is not set — SerenDB SQL roundtrip test requires live credentials"
            ),
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
