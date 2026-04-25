// ABOUTME: Tauri commands for the Claude Code auto-memory interceptor.
// ABOUTME: Exposes start/stop/status, startup migration, render, and identity lookup.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::claude_memory::{self, QueryResult, SerenDbConfig};

/// Hard upper bound on how long `claude_memory_start` is allowed to take
/// before returning a timeout error to the caller. The watcher does an
/// `fs::create_dir_all`, an FSEvents recursive watch on `~/.claude/projects`,
/// and a `tokio::spawn` — none of which should take more than a fraction of
/// a second on a healthy system, but we cap it so a slow filesystem cannot
/// freeze the UI through the IPC dispatch.
const CLAUDE_MEMORY_START_TIMEOUT: Duration = Duration::from_secs(10);

/// Public status snapshot for the frontend.
#[derive(Debug, Serialize)]
pub struct ClaudeMemoryStatus {
    pub running: bool,
    pub watching_root: Option<String>,
}

/// Public project identity payload for the frontend.
#[derive(Debug, Serialize)]
pub struct ClaudeMemoryProjectIdentity {
    pub identifier: String,
    pub source: String,
}

fn build_config(
    project_id: String,
    branch_id: String,
    database_name: String,
) -> Result<SerenDbConfig, String> {
    if project_id.is_empty() || branch_id.is_empty() || database_name.is_empty() {
        return Err(
            "claude_memory_start requires non-empty projectId, branchId, and databaseName \
             (the frontend's ensureClaudeMemoryProvisioned helper should have populated these)"
                .to_string(),
        );
    }
    Ok(SerenDbConfig {
        project_id,
        branch_id,
        database_name,
    })
}

/// Start watching `~/.claude/projects/*/memory/` for Claude Code memory writes.
///
/// `claude_memory::start_watcher` does synchronous filesystem and notify-watcher
/// setup work that previously ran on the main Tauri thread. Under load (deep
/// `~/.claude/projects` tree, slow disk, contention with the auth store) that
/// could freeze the UI. We dispatch the entire body onto the blocking pool and
/// cap it with a timeout so the IPC caller is never parked indefinitely.
///
/// The frontend's `ensureClaudeMemoryProvisioned()` helper auto-creates the
/// `claude-agent-prefs` SerenDB project, the `claude_agent_prefs` database,
/// and the `claude_agent_preferences` table on first run, then passes the
/// resolved identifiers down to this command. Per #1509, Claude memory is
/// stored in a separate SerenDB project from the user's conversational
/// memory — these are two distinct stores and must not share storage.
#[tauri::command]
pub async fn claude_memory_start(
    app: AppHandle,
    project_id: String,
    branch_id: String,
    database_name: String,
) -> Result<ClaudeMemoryStatus, String> {
    let config = build_config(project_id, branch_id, database_name)?;

    let join =
        tokio::task::spawn_blocking(move || claude_memory::start_watcher(app, config));
    let root = match tokio::time::timeout(CLAUDE_MEMORY_START_TIMEOUT, join).await {
        Ok(Ok(Ok(path))) => path,
        Ok(Ok(Err(e))) => return Err(e),
        Ok(Err(join_err)) => {
            return Err(format!(
                "Claude memory interceptor start task panicked: {join_err}"
            ));
        }
        Err(_elapsed) => {
            return Err(format!(
                "Claude memory interceptor start timed out after {}s — check that ~/.claude/projects is reachable and that you are logged in to SerenDB",
                CLAUDE_MEMORY_START_TIMEOUT.as_secs()
            ));
        }
    };

    Ok(ClaudeMemoryStatus {
        running: true,
        watching_root: Some(root.to_string_lossy().to_string()),
    })
}

/// Stop the watcher if running.
///
/// Dispatched onto the blocking pool for the same reason as `claude_memory_start`:
/// the underlying `stop_watcher` acquires a global `Mutex` and calls
/// `task.abort()` — both fast in the happy path, but we never want either to
/// park the main Tauri thread.
#[tauri::command]
pub async fn claude_memory_stop() -> Result<ClaudeMemoryStatus, String> {
    let join = tokio::task::spawn_blocking(claude_memory::stop_watcher);
    match join.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(join_err) => {
            return Err(format!(
                "Claude memory interceptor stop task panicked: {join_err}"
            ));
        }
    }
    Ok(ClaudeMemoryStatus {
        running: false,
        watching_root: None,
    })
}

/// Return the current watcher status without mutating it.
#[tauri::command]
pub fn claude_memory_status() -> Result<ClaudeMemoryStatus, String> {
    let running = claude_memory::is_watcher_running();
    let watching_root = if running {
        claude_memory::claude_projects_root()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(ClaudeMemoryStatus {
        running,
        watching_root,
    })
}

/// Walk every existing Claude memory directory and INSERT any pre-existing
/// `.md` files into `claude_agent_preferences`. Returns persisted + failures.
#[tauri::command]
pub async fn claude_memory_migrate_existing(
    app: AppHandle,
    project_id: String,
    branch_id: String,
    database_name: String,
) -> Result<claude_memory::MigrationReport, String> {
    let config = build_config(project_id, branch_id, database_name)?;
    claude_memory::migrate_existing_files(&app, &config).await
}

/// Resolve a stable project identifier for `project_cwd` (git remote or UUID).
/// Check whether Claude CLI's session JSONL file exists on disk for the given
/// project cwd + session id. Used by the frontend to skip `--resume` when the
/// stored session ID points at a missing file (CLI cleaned up its sessions
/// dir, app reinstall, cross-machine sync). Without this pre-flight, the
/// resume attempt fails with `code=1: No conversation found with session ID:
/// <id>` and surfaces a "Claude Code request failed" error event before the
/// recovery fallback kicks in (#1657).
#[tauri::command]
pub fn claude_session_exists(
    project_cwd: String,
    session_id: String,
) -> Result<bool, String> {
    let root = claude_memory::claude_projects_root()?;
    Ok(claude_memory::session_jsonl_path(&root, Path::new(&project_cwd), &session_id).is_file())
}

#[tauri::command]
pub fn claude_memory_get_project_identity(
    project_cwd: String,
) -> Result<ClaudeMemoryProjectIdentity, String> {
    let identity = claude_memory::resolve_project_identity(Path::new(&project_cwd))?;
    let source = match identity.source {
        claude_memory::ProjectIdentitySource::GitRemote => "git_remote",
        claude_memory::ProjectIdentitySource::PersistedUuid => "persisted_uuid",
        claude_memory::ProjectIdentitySource::GeneratedUuid => "generated_uuid",
    }
    .to_string();
    Ok(ClaudeMemoryProjectIdentity {
        identifier: identity.identifier,
        source,
    })
}

/// Render `~/.claude/projects/<encoded(project_cwd)>/MEMORY.md` from the
/// `claude_agent_preferences` table in SerenDB. The frontend calls this when
/// a project is opened so Claude Code reads fresh content next session.
#[tauri::command]
pub async fn claude_memory_render_memory_md(
    app: AppHandle,
    project_cwd: String,
    project_id: String,
    branch_id: String,
    database_name: String,
) -> Result<String, String> {
    let config = build_config(project_id, branch_id, database_name)?;
    let root = claude_memory::claude_projects_root()?;
    let encoded = claude_memory::encode_project_dir(Path::new(&project_cwd));
    let claude_project_dir: PathBuf = root.join(&encoded);

    let api_key = {
        use tauri_plugin_store::StoreExt;
        app.store("auth.json")
            .map_err(|e| e.to_string())?
            .get("seren_api_key")
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default()
    };
    if api_key.is_empty() {
        return Err(
            "SerenDB API key not available — log in to Seren Desktop so the key is provisioned"
                .to_string(),
        );
    }

    let client = claude_memory::SerenDbSqlClient::new(api_key);
    let final_path =
        claude_memory::render_memory_md_from_db(&client, &config, &claude_project_dir).await?;
    Ok(final_path.to_string_lossy().to_string())
}

/// Execute a SQL statement against a SerenDB database from the frontend via
/// the Rust-side `SerenDbSqlClient` (reqwest + SerenDB API key).
///
/// This command exists because the TypeScript `databases.runSql` path has
/// failed through every other routing we tried:
///
///   1. The hey-api generated client went through the `customFetch` →
///      Rust gateway bridge, which injects the **OAuth bearer token**. The
///      SerenDB `/publishers/seren-db/query` endpoint authenticates with the
///      **SerenDB API key**, so this path returned HTTP 500 "Failed to
///      connect to target database" (#1511 diagnosis).
///
///   2. A direct cross-origin `fetch()` from the Tauri webview to
///      `api.serendb.com` was blocked by webview CORS with
///      `TypeError: Load failed` (#1512 diagnosis).
///
///   3. Routing through `callSerenTool("run_sql", ...)` via the Seren MCP
///      gateway at `mcp.serendb.com` worked architecturally (Rust-side
///      `rmcp` client has no CORS, handles its own auth) but the MCP
///      gateway fails to connect in the user's dev environment — the
///      `waitForGatewayReady` guard (#1513) just makes the failure
///      explicit after 30 seconds instead of immediately.
///
/// So we do what the Rust watcher already does successfully: call
/// `reqwest::Client` from Rust, which has no CORS, with the SerenDB API
/// key read from the Tauri secure store. This bypasses both the browser
/// origin policy AND the broken MCP gateway, and reuses the same client
/// code path that `process_memory_file` runs on every intercepted write.
///
/// The only caller is `databases.runSql` in the frontend, which is itself
/// used by the Claude memory auto-provisioning flow (`ensureClaudeMemoryProvisioned`,
/// `waitForDatabaseReady`) — i.e. the setup that runs BEFORE the watcher
/// starts. Once the watcher is running, SQL writes happen entirely in Rust
/// and never touch this command.
#[tauri::command]
pub async fn claude_memory_run_sql(
    app: AppHandle,
    project_id: String,
    branch_id: Option<String>,
    database_name: Option<String>,
    query: String,
    read_only: bool,
) -> Result<QueryResult, String> {
    if project_id.is_empty() {
        return Err("claude_memory_run_sql requires a non-empty projectId".to_string());
    }
    if query.is_empty() {
        return Err("claude_memory_run_sql requires a non-empty query".to_string());
    }

    let client = claude_memory::build_sql_client(&app)?;
    let config = SerenDbConfig {
        project_id,
        branch_id: branch_id.unwrap_or_default(),
        database_name: database_name.unwrap_or_default(),
    };
    client.run_sql(&config, &query, read_only).await
}

// ============================================================================
// Tests for #1507 (claude_memory_start must not block the main Tauri thread).
// The pattern itself is verified here; the SQL builder + injection-prevention
// tests live in `claude_memory::tests` since that's where the SQL helpers live.
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test(flavor = "multi_thread")]
    async fn start_pattern_returns_within_bound_when_inner_blocks() {
        // The inner closure simulates a `start_watcher` call that has parked
        // on a slow filesystem, an FSEvents init, or a contended Mutex —
        // exactly the failure mode #1507 reported. The wrapping
        // spawn_blocking + timeout MUST return control to the caller within
        // the timeout bound, otherwise the production fix is not actually
        // protecting the main Tauri thread.
        let inner_blocking_duration = Duration::from_millis(1500);
        let outer_timeout = Duration::from_millis(500);
        let started = Instant::now();

        let join = tokio::task::spawn_blocking(move || {
            std::thread::sleep(inner_blocking_duration);
        });
        let result = tokio::time::timeout(outer_timeout, join).await;
        let elapsed_to_timeout = started.elapsed();

        assert!(
            result.is_err(),
            "spawn_blocking + timeout MUST return a timeout error when the inner work blocks; got {result:?}"
        );
        assert!(
            elapsed_to_timeout < Duration::from_secs(2),
            "expected timeout to fire within 2s (the main Tauri thread is not parked); took {elapsed_to_timeout:?}"
        );
    }

    #[test]
    fn claude_memory_start_timeout_constant_is_bounded() {
        assert!(
            CLAUDE_MEMORY_START_TIMEOUT <= Duration::from_secs(60),
            "CLAUDE_MEMORY_START_TIMEOUT must stay bounded; got {:?}",
            CLAUDE_MEMORY_START_TIMEOUT
        );
        assert!(
            CLAUDE_MEMORY_START_TIMEOUT >= Duration::from_secs(5),
            "CLAUDE_MEMORY_START_TIMEOUT too aggressive; got {:?}",
            CLAUDE_MEMORY_START_TIMEOUT
        );
    }

    #[test]
    fn build_config_rejects_empty_strings() {
        assert!(build_config("".into(), "b".into(), "d".into()).is_err());
        assert!(build_config("p".into(), "".into(), "d".into()).is_err());
        assert!(build_config("p".into(), "b".into(), "".into()).is_err());
        assert!(build_config("p".into(), "b".into(), "d".into()).is_ok());
    }
}
