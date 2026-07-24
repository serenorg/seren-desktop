// ABOUTME: Tauri commands for chat persistence and conversation management.
// ABOUTME: Handles CRUD operations for conversations and messages in SQLite.

use crate::commands::provider_runtime::DERIVED_KIND_CASE_SQL;
use crate::happy_bridge::HappyBridgeManager;
use crate::services::conversation_index::{self, IndexableMessage, open_index_db};
use crate::services::database::{
    DbPool, PersistedMessage, WalCheckpointMode, checkpoint_wal, enqueue_sync_tombstone, init_db,
    mark_sync_upsert, save_message_record, stamp_existing_privileged_messages,
};
use crate::commands::memory::MemoryState;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

fn load_indexable_message_meta(
    conn: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<
    Option<(String, Option<String>, Option<String>, Option<String>, bool, bool)>,
> {
    let sql = format!(
        "SELECT {case} AS derived_kind,
                c.title,
                CASE WHEN ({case}) = 'agent'
                     THEN COALESCE(c.agent_type, psr.provider)
                     ELSE c.agent_type END AS agent_type,
                COALESCE(c.project_root, c.agent_cwd, c.project_id) AS project_root,
                c.is_archived,
                c.privileged
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1",
        case = DERIVED_KIND_CASE_SQL,
    );
    conn.query_row(&sql, params![conversation_id], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get::<_, i32>(4)? != 0,
            row.get::<_, i32>(5)? != 0,
        ))
    })
    .optional()
}

fn index_message_best_effort(app: &AppHandle, message: &IndexableMessage) {
    match open_index_db(app).and_then(|conn| conversation_index::reindex_message(&conn, message)) {
        Ok(_) => {}
        Err(err) => log::warn!(
            "[ConversationIndex] Failed to index message {}: {}",
            message.message_id,
            err
        ),
    }
}

fn delete_conversation_index_best_effort(app: &AppHandle, conversation_id: &str) {
    match open_index_db(app)
        .and_then(|conn| conversation_index::delete_conversation_chunks(&conn, conversation_id))
    {
        Ok(_) => {}
        Err(err) => log::warn!(
            "[ConversationIndex] Failed to delete index for conversation {}: {}",
            conversation_id,
            err
        ),
    }
}

fn vacuum_database(conn: &Connection) -> rusqlite::Result<()> {
    // `delete_conversation_records` commits before its callers reach this helper;
    // VACUUM is intentionally outside that delete transaction.
    conn.execute_batch("VACUUM")?;
    checkpoint_wal(conn, WalCheckpointMode::Truncate)?;
    Ok(())
}

fn vacuum_conversation_index_best_effort(app: &AppHandle) {
    match open_index_db(app).and_then(|conn| vacuum_database(&conn)) {
        Ok(()) => {}
        Err(err) => log::warn!("[ConversationIndex] Failed to vacuum index after deletion: {err}"),
    }
}

fn clear_conversation_index_best_effort(app: &AppHandle) {
    match open_index_db(app).and_then(|conn| conversation_index::clear_all_chunks(&conn)) {
        Ok(_) => {}
        Err(err) => log::warn!(
            "[ConversationIndex] Failed to clear conversation index: {}",
            err
        ),
    }
}

/// A deleted conversation's agent identity, enough to locate its on-disk CLI
/// session transcript(s). Only agent conversations with a captured session id
/// have transcripts on disk.
struct AgentTranscriptTarget {
    agent_type: String,
    session_id: String,
    agent_cwd: Option<String>,
}

/// Read the transcript targets for the given conversations before their rows are
/// deleted. Skips rows with no captured `agent_session_id` (plain chats and
/// agent sessions that never wrote a transcript).
fn collect_agent_transcript_targets(
    conn: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<Vec<AgentTranscriptTarget>> {
    let mut stmt = conn.prepare(
        "SELECT agent_type, agent_session_id, agent_cwd
         FROM conversations
         WHERE id = ?1 AND agent_session_id IS NOT NULL AND agent_session_id <> ''",
    )?;
    let mut targets = Vec::new();
    for id in conversation_ids {
        let rows = stmt.query_map(params![id], |row| {
            Ok(AgentTranscriptTarget {
                agent_type: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                session_id: row.get::<_, String>(1)?,
                agent_cwd: row.get::<_, Option<String>>(2)?,
            })
        })?;
        for target in rows {
            targets.push(target?);
        }
    }
    Ok(targets)
}

/// Best-effort deletion of a deleted conversation's raw CLI session
/// transcript(s) — Claude Code (`~/.claude/projects/<cwd>/<id>.jsonl`) and Codex
/// (`~/.codex/sessions/**/rollout-*-<id>.jsonl`). Mirrors the index-cleanup
/// helpers: a missing, locked, or unresolvable file is logged, never fatal, so
/// the delete itself always succeeds.
fn delete_agent_transcripts_best_effort(targets: &[AgentTranscriptTarget]) {
    if targets.is_empty() {
        return;
    }
    let claude_root = crate::claude_memory::claude_projects_root().ok();
    let codex_root = crate::terminal::codex_sessions_root();
    remove_agent_transcripts(targets, claude_root.as_deref(), codex_root.as_deref());
}

/// Resolve the Claude and Codex session ids a conversation's stored
/// `agent_session_id` points at, returned as `(claude_id, codex_id)`.
///
/// A standalone `claude-code`/`codex` conversation stores that one agent's raw
/// session UUID. A paired `claude-codex` conversation stores a JSON composite
/// (`paired-runtime.mjs` → `compositeAgentSessionId`) with separate `planner`
/// (Claude) and `executor` (Codex) ids plus a ledger — treating that whole blob
/// as a single UUID left BOTH legs' transcripts on disk. Each leg is `None`
/// when it does not apply to the agent type, has no captured id, or the
/// composite is unparseable; downstream UUID validation still gates every path.
fn split_paired_session_ids(
    agent_type: &str,
    session_id: &str,
) -> (Option<String>, Option<String>) {
    let non_empty = |value: &str| (!value.is_empty()).then(|| value.to_string());
    match agent_type {
        "claude-code" => (non_empty(session_id), None),
        "codex" => (None, non_empty(session_id)),
        "claude-codex" => match serde_json::from_str::<PairedSessionIds>(session_id) {
            Ok(ids) => (
                ids.planner.filter(|id| !id.is_empty()),
                ids.executor.filter(|id| !id.is_empty()),
            ),
            Err(_) => (None, None),
        },
        _ => (None, None),
    }
}

/// The planner/executor session ids embedded in a paired `claude-codex`
/// conversation's composite `agent_session_id`. The trailing ledger is ignored.
#[derive(Deserialize)]
struct PairedSessionIds {
    planner: Option<String>,
    executor: Option<String>,
}

/// Core of [`delete_agent_transcripts_best_effort`], with the Claude/Codex roots
/// injected so it can be exercised against a real temporary filesystem. Session
/// ids must parse as UUIDs before a path is touched, which doubles as
/// path-injection defense.
fn remove_agent_transcripts(
    targets: &[AgentTranscriptTarget],
    claude_root: Option<&std::path::Path>,
    codex_root: Option<&std::path::Path>,
) {
    for target in targets {
        let (claude_id, codex_id) =
            split_paired_session_ids(&target.agent_type, &target.session_id);

        if let Some(claude_id) = claude_id {
            if let (Some(root), Some(cwd)) = (claude_root, target.agent_cwd.as_deref()) {
                if uuid::Uuid::parse_str(&claude_id).is_ok() {
                    let path = crate::claude_memory::session_jsonl_path(
                        root,
                        std::path::Path::new(cwd),
                        &claude_id,
                    );
                    remove_transcript_file(&path);
                }
            }
        }
        if let Some(codex_id) = codex_id {
            if let Some(root) = codex_root {
                for path in crate::terminal::codex_transcripts_for_session(root, &codex_id) {
                    remove_transcript_file(&path);
                }
            }
        }
    }
}

fn remove_transcript_file(path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("[Delete] Removed CLI session transcript {}", path.display()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!(
            "[Delete] Failed to remove CLI session transcript {}: {err}",
            path.display()
        ),
    }
}

async fn refresh_conversation_index_meta_best_effort(
    app: AppHandle,
    conversation_id: String,
    title: Option<String>,
    is_archived: Option<bool>,
) {
    match open_index_db(&app).and_then(|conn| {
        conversation_index::update_conversation_meta(
            &conn,
            &conversation_id,
            title.as_deref(),
            is_archived,
        )
    }) {
        Ok(_) => {}
        Err(err) => log::warn!(
            "[ConversationIndex] Failed to refresh index metadata for conversation {}: {}",
            conversation_id,
            err
        ),
    }
}

pub(crate) fn delete_conversation_records(
    conn: &Connection,
    conversation_ids: &[String],
) -> rusqlite::Result<usize> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let mut deleted = 0;
    for id in conversation_ids {
        let mut event_stmt =
            tx.prepare("SELECT id FROM message_events WHERE conversation_id = ?1")?;
        let event_ids = event_stmt
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(event_stmt);
        let mut message_stmt = tx.prepare("SELECT id FROM messages WHERE conversation_id = ?1")?;
        let message_ids = message_stmt
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(message_stmt);
        for event_id in &event_ids {
            enqueue_sync_tombstone(&tx, "message_events", event_id)?;
        }
        for message_id in &message_ids {
            enqueue_sync_tombstone(&tx, "messages", message_id)?;
        }
        enqueue_sync_tombstone(&tx, "thread_drafts", id)?;
        enqueue_sync_tombstone(&tx, "conversations", id)?;
        tx.execute(
            "DELETE FROM eval_signals
             WHERE message_id IN (
                 SELECT id FROM messages WHERE conversation_id = ?1
             )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM plan_subtasks
             WHERE plan_id IN (
                 SELECT id FROM orchestration_plans WHERE conversation_id = ?1
             )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM orchestration_plans WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM input_history WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM thread_skills WHERE thread_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM thread_skill_override_state WHERE thread_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM session_events
             WHERE session_id IN (
                 SELECT id FROM runtime_sessions WHERE thread_id = ?1
             )",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM runtime_sessions WHERE thread_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM message_events WHERE conversation_id = ?1",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        deleted += tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(deleted)
}

fn normalize_project_root(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let project_path = PathBuf::from(trimmed);
    let abs = if project_path.is_absolute() {
        project_path
    } else {
        std::env::current_dir().ok()?.join(project_path)
    };

    let normalized = abs.canonicalize().unwrap_or(abs);
    Some(normalized.to_string_lossy().to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub selected_model: Option<String>,
    pub selected_provider: Option<String>,
    pub project_root: Option<String>,
    pub is_archived: bool,
    pub employee_id: Option<String>,
    #[serde(default)]
    pub privileged: bool,
    pub counsel_direction: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AgentConversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub agent_type: String,
    pub agent_session_id: Option<String>,
    pub agent_cwd: Option<String>,
    pub agent_model_id: Option<String>,
    pub agent_permission_mode: Option<String>,
    pub agent_metadata: Option<String>,
    pub project_id: Option<String>,
    pub project_root: Option<String>,
    pub is_archived: bool,
    #[serde(default)]
    pub privileged: bool,
    pub counsel_direction: Option<String>,
}

/// Exact desktop record required to restore a provider process for a persisted
/// Happy relay binding. This deliberately carries both stored root columns so
/// the supervisor can canonicalize and compare them immediately before spawn
/// and again before the atomic ownership claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HappyRestorationCandidate {
    pub conversation_id: String,
    pub title: String,
    pub agent_type: String,
    pub agent_session_id: Option<String>,
    pub agent_cwd: String,
    pub agent_model_id: Option<String>,
    pub agent_permission_mode: Option<String>,
    pub project_root: String,
    pub is_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HappyRestorationLookup {
    NotHappyOrigin,
    InvalidHappyOrigin { is_archived: bool },
    Candidate(HappyRestorationCandidate),
}

/// Pre-key-store Happy conversation paired with the relay row recorded by the
/// released desktop build. Startup uses this only to migrate rows that have no
/// durable encrypted binding yet; exact lookup/claim still revalidates every
/// field after the replacement relay row exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyHappyRestorationCandidate {
    pub happy_session_id: String,
    pub conversation: HappyRestorationCandidate,
}

/// Wire-format row for the unified `list_conversations` command. Carries
/// every column either kind of thread needs so the chat and agent stores
/// can both project from a single read, and exposes a `kind` field that
/// is derived from `provider_session_runtime.provider` (falling back to
/// the stored `conversations.kind` only when no binding row exists).
/// Callers should treat `kind` here as authoritative for routing.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UnifiedConversationRow {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub kind: String,
    pub project_root: Option<String>,
    pub is_archived: bool,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub employee_id: Option<String>,
    pub agent_type: Option<String>,
    pub agent_session_id: Option<String>,
    pub agent_cwd: Option<String>,
    pub agent_model_id: Option<String>,
    pub agent_permission_mode: Option<String>,
    pub agent_metadata: Option<String>,
    pub project_id: Option<String>,
    // Older bridge/cache payloads predate Privileged Matter Mode. Treat an
    // omitted value as non-privileged so rolling updates keep deserializing;
    // the durable SQLite value is hydrated immediately after the read.
    #[serde(default)]
    pub privileged: bool,
    pub counsel_direction: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: Option<String>,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub timestamp: i64,
    pub metadata: Option<String>,
    pub provider: Option<String>,
}

// ============================================================================
// Conversation Commands
// ============================================================================

#[tauri::command]
pub async fn create_conversation(
    app: AppHandle,
    id: String,
    title: String,
    selected_model: Option<String>,
    selected_provider: Option<String>,
    project_root: Option<String>,
    employee_id: Option<String>,
) -> Result<Conversation, String> {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let normalized_project_root = project_root.as_deref().and_then(normalize_project_root);

    let conversation = Conversation {
        id: id.clone(),
        title: title.clone(),
        created_at,
        selected_model: selected_model.clone(),
        selected_provider: selected_provider.clone(),
        project_root: normalized_project_root.clone(),
        is_archived: false,
        employee_id: employee_id.clone(),
        privileged: false,
        counsel_direction: None,
    };

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, selected_model, selected_provider, project_root, is_archived, kind, employee_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'chat', ?7)",
            params![id, title, created_at, selected_model, selected_provider, normalized_project_root, employee_id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;

    Ok(conversation)
}

/// Unified list reader for both chat and agent conversations.
///
/// The `kind` column in the returned rows is derived from
/// `provider_session_runtime.provider` via the same native-agent set the
/// switch command uses; the stored `conversations.kind` is only the
/// fallback for threads that pre-date the runtime binding. Callers
/// should treat the returned `kind` as authoritative and stop reading
/// `conversations.kind` directly.
///
/// `kind` parameter filters the result; pass `None` to receive both
/// chat and agent rows in one call. `project_root` matches a thread if
/// any of its chat-side `project_root`, agent-side `project_id`, or
/// agent-side `agent_cwd` equals the raw or canonicalized form — that
/// preserves the prior asymmetric behavior of the two separate commands.
/// Chat-kind rows with a NULL `project_root` are always included so the
/// default sidebar bucket keeps surfacing them.
#[tauri::command]
pub async fn list_conversations(
    app: AppHandle,
    kind: Option<String>,
    project_root: Option<String>,
    limit: Option<i32>,
) -> Result<Vec<UnifiedConversationRow>, String> {
    if let Some(ref k) = kind {
        if k != "chat" && k != "agent" {
            return Err(format!("invalid kind filter: {k}"));
        }
    }

    // Treat a whitespace-only project_root the same as `None` so the
    // filter does not fall through to literal-equality on the empty
    // string. The prior chat-only read also routed empty input to its
    // "no filter" branch via `normalize_project_root` returning `None`;
    // preserve that behavior here for the raw form too.
    let raw = project_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let normalized = raw.as_deref().and_then(normalize_project_root);
    // SQLite treats `LIMIT -1` as no limit, matching the old behavior of
    // the unlimited chat read.
    let effective_limit = limit.unwrap_or(-1);

    run_db(app, move |conn| {
        let sql = format!(
            "WITH derived AS (
                SELECT c.id, c.title, c.created_at, c.is_archived,
                       c.project_root, c.selected_provider, c.selected_model,
                       c.employee_id, c.agent_type, c.agent_session_id,
                       c.agent_cwd, c.agent_model_id, c.agent_permission_mode,
                       c.agent_metadata, c.project_id, c.privileged,
                       c.counsel_direction, psr.provider AS runtime_provider,
                       {case} AS derived_kind
                FROM conversations c
                LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
            )
            SELECT id, title, created_at, derived_kind, project_root, is_archived,
                   CASE WHEN derived_kind = 'chat'
                        THEN COALESCE(selected_provider, runtime_provider)
                        ELSE selected_provider END AS selected_provider,
                   selected_model, employee_id,
                   CASE WHEN derived_kind = 'agent'
                        THEN COALESCE(agent_type, runtime_provider)
                        ELSE agent_type END AS agent_type,
                   agent_session_id, agent_cwd, agent_model_id,
                   agent_permission_mode, agent_metadata, project_id,
                   privileged, counsel_direction
            FROM derived
            WHERE is_archived = 0
              AND (?1 IS NULL OR derived_kind = ?1)
              AND (
                (?2 IS NULL AND ?3 IS NULL)
                OR project_root = ?2 OR project_id = ?2 OR agent_cwd = ?2
                OR project_root = ?3 OR project_id = ?3 OR agent_cwd = ?3
                OR (derived_kind = 'chat' AND project_root IS NULL)
              )
            ORDER BY created_at DESC
            LIMIT ?4",
            case = DERIVED_KIND_CASE_SQL,
        );
        let mut stmt = conn.prepare(&sql)?;

        let rows = stmt
            .query_map(params![kind, raw, normalized, effective_limit], |row| {
                Ok(UnifiedConversationRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    kind: row.get(3)?,
                    project_root: row.get(4)?,
                    is_archived: row.get::<_, i32>(5)? != 0,
                    selected_provider: row.get(6)?,
                    selected_model: row.get(7)?,
                    employee_id: row.get(8)?,
                    agent_type: row.get(9)?,
                    agent_session_id: row.get(10)?,
                    agent_cwd: row.get(11)?,
                    agent_model_id: row.get(12)?,
                    agent_permission_mode: row.get(13)?,
                    agent_metadata: row.get(14)?,
                    project_id: row.get(15)?,
                    privileged: row.get::<_, i32>(16)? != 0,
                    counsel_direction: row.get(17)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn get_conversation(app: AppHandle, id: String) -> Result<Option<Conversation>, String> {
    run_db(app, move |conn| {
        // Filter by the derived kind so the reader stays correct if the
        // stored `conversations.kind` ever drifts from the live provider
        // binding (e.g. a mirror update raced a switch).
        let sql = format!(
            "SELECT c.id, c.title, c.created_at, c.selected_model,
                    CASE WHEN ({case}) = 'chat'
                         THEN COALESCE(c.selected_provider, psr.provider)
                         ELSE c.selected_provider END AS selected_provider,
                    c.project_root, c.is_archived, c.employee_id,
                    c.privileged, c.counsel_direction
             FROM conversations c
             LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
             WHERE c.id = ?1
               AND ({case}) = 'chat'",
            case = DERIVED_KIND_CASE_SQL,
        );
        let mut stmt = conn.prepare(&sql)?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    selected_model: row.get(3)?,
                    selected_provider: row.get(4)?,
                    project_root: row.get(5)?,
                    is_archived: row.get::<_, i32>(6)? != 0,
                    employee_id: row.get(7)?,
                    privileged: row.get::<_, i32>(8)? != 0,
                    counsel_direction: row.get(9)?,
                })
            })
            .optional()?;

        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn update_conversation(
    app: AppHandle,
    id: String,
    title: Option<String>,
    selected_model: Option<String>,
    selected_provider: Option<String>,
) -> Result<(), String> {
    let index_id = id.clone();
    let index_title = title.clone();
    run_db(app.clone(), move |conn| {
        if let Some(t) = title {
            conn.execute(
                "UPDATE conversations SET title = ?1 WHERE id = ?2",
                params![t, id],
            )?;
            mark_sync_upsert(conn, "conversations", &id)?;
        }
        if let Some(m) = selected_model {
            conn.execute(
                "UPDATE conversations SET selected_model = ?1 WHERE id = ?2",
                params![m, id],
            )?;
            mark_sync_upsert(conn, "conversations", &id)?;
        }
        if let Some(p) = selected_provider {
            conn.execute(
                "UPDATE conversations SET selected_provider = ?1 WHERE id = ?2",
                params![p, id],
            )?;
            mark_sync_upsert(conn, "conversations", &id)?;
        }
        Ok(())
    })
    .await?;
    refresh_conversation_index_meta_best_effort(app, index_id, index_title, None).await;
    Ok(())
}

#[tauri::command]
pub async fn set_conversation_privileged(
    app: AppHandle,
    id: String,
    privileged: bool,
    counsel_direction: Option<String>,
) -> Result<(), String> {
    let index_id = id.clone();
    let normalized_direction = counsel_direction
        .as_deref()
        .map(str::trim)
        .filter(|direction| !direction.is_empty())
        .map(str::to_string);
    run_db(app.clone(), move |conn| {
        let changed = conn.execute(
            "UPDATE conversations
             SET privileged = ?1, counsel_direction = ?2
             WHERE id = ?3",
            params![i32::from(privileged), normalized_direction, id],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if privileged {
            stamp_existing_privileged_messages(conn, &id)?;
        }
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;

    // Remove chunks created before the flag was enabled. Subsequent message
    // writes are also blocked by `IndexableMessage::is_privileged`.
    if privileged {
        delete_conversation_index_best_effort(&app, &index_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn archive_conversation(app: AppHandle, id: String) -> Result<(), String> {
    let index_id = id.clone();
    run_db(app.clone(), move |conn| {
        conn.execute(
            "UPDATE conversations SET is_archived = 1 WHERE id = ?1",
            params![id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;
    refresh_conversation_index_meta_best_effort(app, index_id, None, Some(true)).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    let index_id = id.clone();
    let transcript_targets = run_db(app.clone(), move |conn| {
        let targets = collect_agent_transcript_targets(conn, std::slice::from_ref(&id))?;
        delete_conversation_records(conn, &[id])?;
        vacuum_database(conn)?;
        Ok(targets)
    })
    .await?;
    delete_conversation_index_best_effort(&app, &index_id);
    vacuum_conversation_index_best_effort(&app);
    delete_agent_transcripts_best_effort(&transcript_targets);
    Ok(())
}

#[tauri::command]
pub async fn delete_conversations_by_employee(
    app: AppHandle,
    employee_id: String,
) -> Result<i64, String> {
    let (deleted, conversation_ids, transcript_targets) = run_db(app.clone(), move |conn| {
        let mut stmt = conn.prepare("SELECT id FROM conversations WHERE employee_id = ?1")?;
        let conversation_ids = stmt
            .query_map(params![employee_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let targets = collect_agent_transcript_targets(conn, &conversation_ids)?;
        let deleted = delete_conversation_records(conn, &conversation_ids)?;
        vacuum_database(conn)?;
        Ok((deleted as i64, conversation_ids, targets))
    })
    .await?;
    for conversation_id in &conversation_ids {
        delete_conversation_index_best_effort(&app, conversation_id);
    }
    vacuum_conversation_index_best_effort(&app);
    delete_agent_transcripts_best_effort(&transcript_targets);
    Ok(deleted)
}

// ============================================================================
// Agent Conversation Commands
// ============================================================================

#[tauri::command]
pub async fn create_agent_conversation(
    app: AppHandle,
    id: String,
    title: String,
    agent_type: String,
    agent_cwd: Option<String>,
    project_root: Option<String>,
    agent_session_id: Option<String>,
    agent_metadata: Option<String>,
) -> Result<AgentConversation, String> {
    create_agent_conversation_record(
        app,
        id,
        title,
        agent_type,
        agent_cwd,
        project_root,
        agent_session_id,
        agent_metadata,
    )
    .await
}

pub(crate) async fn create_agent_conversation_record(
    app: AppHandle,
    id: String,
    title: String,
    agent_type: String,
    agent_cwd: Option<String>,
    project_root: Option<String>,
    agent_session_id: Option<String>,
    agent_metadata: Option<String>,
) -> Result<AgentConversation, String> {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let normalized_project_root = project_root
        .as_deref()
        .and_then(normalize_project_root)
        .or_else(|| agent_cwd.as_deref().and_then(normalize_project_root));
    let project_id = normalized_project_root.clone();

    let mut convo = AgentConversation {
        id: id.clone(),
        title: title.clone(),
        created_at,
        agent_type: agent_type.clone(),
        agent_session_id: agent_session_id.clone(),
        agent_cwd: agent_cwd.clone(),
        agent_model_id: None,
        agent_permission_mode: None,
        agent_metadata: agent_metadata.clone(),
        project_id: project_id.clone(),
        project_root: normalized_project_root.clone(),
        is_archived: false,
        privileged: false,
        counsel_direction: None,
    };

    let persisted_convo = convo.clone();
    let is_archived = run_db(app, move |conn| {
        upsert_agent_conversation_in_db(conn, &persisted_convo)
    })
    .await?;
    convo.is_archived = is_archived;

    Ok(convo)
}

fn upsert_agent_conversation_in_db(
    conn: &Connection,
    convo: &AgentConversation,
) -> rusqlite::Result<bool> {
    conn.execute(
        "INSERT INTO conversations (
                id,
                title,
                created_at,
                is_archived,
                kind,
                agent_type,
                agent_session_id,
                agent_cwd,
                agent_metadata,
                project_id,
                project_root
            ) VALUES (
                ?1,
                ?2,
                ?3,
                COALESCE((
                    SELECT is_archived
                    FROM happy_provider_session_lifecycle
                    WHERE provider_session_id = ?1
                ), 0),
                'agent',
                ?4,
                ?5,
                ?6,
                ?7,
                ?8,
                ?9
            )
             ON CONFLICT(id) DO UPDATE SET
                agent_type = excluded.agent_type,
                agent_session_id = COALESCE(excluded.agent_session_id, conversations.agent_session_id),
                agent_cwd = COALESCE(conversations.agent_cwd, excluded.agent_cwd),
                agent_metadata = COALESCE(excluded.agent_metadata, conversations.agent_metadata),
                project_id = COALESCE(conversations.project_id, excluded.project_id),
                project_root = COALESCE(conversations.project_root, excluded.project_root)",
        params![
            convo.id,
            convo.title,
            convo.created_at,
            convo.agent_type,
            convo.agent_session_id,
            convo.agent_cwd,
            convo.agent_metadata,
            convo.project_id,
            convo.project_root,
        ],
    )?;
    conn.execute(
        "UPDATE happy_provider_session_lifecycle
         SET conversation_id = COALESCE(conversation_id, ?1),
             updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
         WHERE provider_session_id = ?1",
        params![convo.id],
    )?;
    // Idempotent create/resume calls may arrive after another actor archives
    // the row. They can refresh agent metadata, but only an explicit restore
    // operation may make an archived conversation active again.
    mark_sync_upsert(conn, "conversations", &convo.id)?;
    conn.query_row(
        "SELECT is_archived FROM conversations WHERE id = ?1",
        params![convo.id],
        |row| row.get(0),
    )
}

pub(crate) async fn lookup_happy_restoration_candidate(
    app: AppHandle,
    provider_session_id: String,
    happy_session_id: String,
) -> Result<HappyRestorationLookup, String> {
    run_db(app, move |conn| {
        lookup_happy_restoration_candidate_in_db(conn, &provider_session_id, &happy_session_id)
    })
    .await
}

pub(crate) async fn list_legacy_happy_restoration_candidates(
    app: AppHandle,
) -> Result<Vec<LegacyHappyRestorationCandidate>, String> {
    run_db(app, list_legacy_happy_restoration_candidates_in_db).await
}

fn list_legacy_happy_restoration_candidates_in_db(
    conn: &Connection,
) -> rusqlite::Result<Vec<LegacyHappyRestorationCandidate>> {
    let sql = format!(
        "SELECT c.id,
                json_extract(c.agent_metadata, '$.happy_session_id')
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         LEFT JOIN happy_provider_session_lifecycle hpsl
           ON hpsl.provider_session_id = c.id
         WHERE c.is_archived = 0
           AND hpsl.provider_session_id IS NULL
           AND ({case}) = 'agent'
           AND json_valid(c.agent_metadata)
           AND json_type(c.agent_metadata, '$.happy_session_id') = 'text'
         ORDER BY c.created_at ASC, c.id ASC",
        case = DERIVED_KIND_CASE_SQL,
    );
    let rows = conn
        .prepare(&sql)?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut candidates = Vec::new();
    for (conversation_id, happy_session_id) in rows {
        if let HappyRestorationLookup::Candidate(conversation) =
            lookup_happy_restoration_candidate_in_db(conn, &conversation_id, &happy_session_id)?
            && !conversation.is_archived
        {
            candidates.push(LegacyHappyRestorationCandidate {
                happy_session_id,
                conversation,
            });
        }
    }
    Ok(candidates)
}

pub(crate) async fn migrate_happy_restoration_relay(
    app: AppHandle,
    conversation_id: String,
    expected_happy_session_id: String,
    replacement_happy_session_id: String,
) -> Result<bool, String> {
    run_db(app, move |conn| {
        migrate_happy_restoration_relay_in_db(
            conn,
            &conversation_id,
            &expected_happy_session_id,
            &replacement_happy_session_id,
        )
    })
    .await
}

fn migrate_happy_restoration_relay_in_db(
    conn: &Connection,
    conversation_id: &str,
    expected_happy_session_id: &str,
    replacement_happy_session_id: &str,
) -> rusqlite::Result<bool> {
    if replacement_happy_session_id.trim().is_empty() {
        return Ok(false);
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let lookup =
        lookup_happy_restoration_candidate_in_db(&tx, conversation_id, expected_happy_session_id)?;
    let HappyRestorationLookup::Candidate(candidate) = lookup else {
        return Ok(false);
    };
    if candidate.is_archived || candidate.conversation_id != conversation_id {
        return Ok(false);
    }

    // A successful current bridge claim leaves a durable lifecycle row. Its
    // presence distinguishes a genuinely retired current session (whose
    // encrypted key binding is intentionally deleted) from a pre-lifecycle
    // v3.72 row that still needs one-time migration. A matching ready binding
    // can acknowledge the old relay id without rotating it.
    let recorded_lifecycle = tx
        .query_row(
            "SELECT conversation_id, is_archived
             FROM happy_provider_session_lifecycle
             WHERE provider_session_id = ?1",
            params![conversation_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    if replacement_happy_session_id == expected_happy_session_id {
        if matches!(
            recorded_lifecycle.as_ref(),
            Some((Some(owner), _)) if owner != conversation_id
        ) || matches!(
            recorded_lifecycle.as_ref(),
            Some((_, archived)) if *archived
        ) {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO happy_provider_session_lifecycle
                (provider_session_id, conversation_id, is_archived, updated_at)
             VALUES (?1, ?1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
             ON CONFLICT(provider_session_id) DO UPDATE SET
                conversation_id = excluded.conversation_id,
                updated_at = excluded.updated_at",
            params![conversation_id],
        )?;
        tx.commit()?;
        return Ok(true);
    }
    // A lifecycle row appearing after candidate discovery means another
    // current bridge already claimed or retired this provider. Never rotate
    // its relay identity using a stale legacy-migration response.
    if recorded_lifecycle.is_some() {
        return Ok(false);
    }

    let replacement_owner_sql = format!(
        "SELECT c.id
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE ({case}) = 'agent'
           AND json_valid(c.agent_metadata)
           AND json_extract(c.agent_metadata, '$.happy_session_id') = ?1
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    if tx
        .query_row(
            &replacement_owner_sql,
            params![replacement_happy_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some()
    {
        return Ok(false);
    }

    let original_metadata = tx.query_row(
        "SELECT agent_metadata FROM conversations WHERE id = ?1 AND is_archived = 0",
        params![conversation_id],
        |row| row.get::<_, String>(0),
    )?;
    let mut metadata = match serde_json::from_str::<serde_json::Value>(&original_metadata) {
        Ok(serde_json::Value::Object(object)) => object,
        _ => return Ok(false),
    };
    if metadata
        .get("happy_session_id")
        .and_then(serde_json::Value::as_str)
        != Some(expected_happy_session_id)
    {
        return Ok(false);
    }
    metadata.insert(
        "happy_session_id".to_string(),
        serde_json::Value::String(replacement_happy_session_id.to_string()),
    );
    let replacement_metadata = serde_json::to_string(&metadata)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let updated = tx.execute(
        "UPDATE conversations
         SET agent_metadata = ?1
         WHERE id = ?2 AND is_archived = 0 AND agent_metadata = ?3",
        params![replacement_metadata, conversation_id, original_metadata],
    )?;
    if updated != 1 {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO happy_provider_session_lifecycle
            (provider_session_id, conversation_id, is_archived, updated_at)
         VALUES (?1, ?1, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000)",
        params![conversation_id],
    )?;
    mark_sync_upsert(&tx, "conversations", conversation_id)?;
    tx.commit()?;
    Ok(true)
}

fn lookup_happy_restoration_candidate_in_db(
    conn: &Connection,
    provider_session_id: &str,
    happy_session_id: &str,
) -> rusqlite::Result<HappyRestorationLookup> {
    let sql = format!(
        "SELECT c.id, c.title, c.agent_type, c.agent_session_id,
                c.agent_cwd, c.agent_model_id, c.agent_permission_mode,
                c.agent_metadata, c.project_root, c.is_archived,
                ({case}) AS derived_kind
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    let row = conn
        .query_row(&sql, params![provider_session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, i32>(9)? != 0,
                row.get::<_, String>(10)?,
            ))
        })
        .optional()?;
    let Some((
        conversation_id,
        title,
        agent_type,
        agent_session_id,
        agent_cwd,
        agent_model_id,
        agent_permission_mode,
        agent_metadata,
        project_root,
        is_archived,
        derived_kind,
    )) = row
    else {
        return Ok(HappyRestorationLookup::NotHappyOrigin);
    };

    // A local/provider id match is necessary but never sufficient. The
    // Happy-origin marker written by `conversation_create` must parse and map
    // to this exact relay row; otherwise a desktop-origin thread with the same
    // UUID could be revived remotely.
    let parsed_metadata = agent_metadata
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let Some(happy_session_marker) = parsed_metadata
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .and_then(|object| object.get("happy_session_id"))
    else {
        return Ok(HappyRestorationLookup::NotHappyOrigin);
    };
    let Some(recorded_happy_session_id) = happy_session_marker
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    };
    if recorded_happy_session_id != happy_session_id || derived_kind != "agent" {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    }

    // A relay id is a one-to-one provenance key. Duplicate metadata is
    // ambiguous even when one duplicate happens to share the requested local
    // id, so fail closed rather than selecting a row with LIMIT 1.
    let unique_sql = format!(
        "SELECT c.id
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE ({case}) = 'agent'
           AND json_valid(c.agent_metadata)
           AND json_extract(
                CASE WHEN json_valid(c.agent_metadata)
                     THEN c.agent_metadata
                     ELSE NULL END,
                '$.happy_session_id'
           ) = ?1
         LIMIT 2",
        case = DERIVED_KIND_CASE_SQL,
    );
    let mapped_ids = conn
        .prepare(&unique_sql)?
        .query_map(params![happy_session_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if mapped_ids.len() != 1 || mapped_ids[0] != provider_session_id {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    }

    let Some(agent_type) = agent_type.filter(|value| !value.trim().is_empty()) else {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    };
    let Some(agent_cwd) = agent_cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    };
    let Some(project_root) = project_root.filter(|value| !value.trim().is_empty()) else {
        return Ok(HappyRestorationLookup::InvalidHappyOrigin { is_archived });
    };

    Ok(HappyRestorationLookup::Candidate(
        HappyRestorationCandidate {
            conversation_id,
            title,
            agent_type,
            agent_session_id,
            agent_cwd,
            agent_model_id,
            agent_permission_mode,
            project_root,
            is_archived,
        },
    ))
}

pub(crate) async fn lookup_happy_session_id_by_conversation(
    app: AppHandle,
    conversation_id: String,
) -> Result<Option<String>, String> {
    run_db(app, move |conn| {
        lookup_happy_session_id_by_conversation_in_db(conn, &conversation_id)
    })
    .await
}

fn lookup_happy_session_id_by_conversation_in_db(
    conn: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<String>> {
    let sql = format!(
        "SELECT c.agent_metadata
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1 AND ({case}) = 'agent'
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    let metadata = conn
        .query_row(&sql, params![conversation_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten();
    Ok(metadata.and_then(|raw| {
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| {
                value
                    .get("happy_session_id")
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned)
            })
    }))
}

fn lookup_agent_conversation_owner_in_db(
    conn: &Connection,
    provider_session_id: &str,
    agent_session_id: Option<&str>,
) -> rusqlite::Result<(Option<String>, bool)> {
    let lifecycle_sql = format!(
        "SELECT c.id
         FROM happy_provider_session_lifecycle hpsl
         JOIN conversations c ON c.id = hpsl.conversation_id
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE hpsl.provider_session_id = ?1
           AND ({case}) = 'agent'
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    if let Some(owner) = conn
        .query_row(&lifecycle_sql, params![provider_session_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
    {
        return Ok((Some(owner), false));
    }

    let direct_sql = format!(
        "SELECT c.id
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1 AND ({case}) = 'agent'
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    if let Some(owner) = conn
        .query_row(&direct_sql, params![provider_session_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?
    {
        return Ok((Some(owner), false));
    }

    let Some(agent_session_id) = agent_session_id else {
        return Ok((None, false));
    };
    let fallback_sql = format!(
        "SELECT c.id
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.agent_session_id = ?1 AND ({case}) = 'agent'
         LIMIT 2",
        case = DERIVED_KIND_CASE_SQL,
    );
    let mut statement = conn.prepare(&fallback_sql)?;
    let owners = statement
        .query_map(params![agent_session_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok((owners.first().cloned(), owners.len() > 1))
}

fn claim_happy_provider_session_owner_in_db(
    conn: &Connection,
    conversation_id: &str,
    provider_session_id: &str,
    agent_session_id: Option<&str>,
) -> rusqlite::Result<bool> {
    claim_happy_provider_session_owner_with_provenance_in_db(
        conn,
        conversation_id,
        provider_session_id,
        agent_session_id,
        None,
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Identity captured by the pre-spawn lookup and echoed by the bridge. Because
/// this struct is itself optional, a `None` native session id is an exact
/// expected-absence assertion rather than a wildcard.
struct ExpectedHappyRestoration<'a> {
    happy_session_id: &'a str,
    agent_type: &'a str,
    agent_session_id: Option<&'a str>,
    agent_permission_mode: Option<&'a str>,
    agent_cwd: &'a str,
    project_root: &'a str,
}

fn claim_happy_provider_session_owner_with_provenance_in_db(
    conn: &Connection,
    conversation_id: &str,
    provider_session_id: &str,
    agent_session_id: Option<&str>,
    expected: Option<ExpectedHappyRestoration<'_>>,
) -> rusqlite::Result<Option<bool>> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if let Some(expected) = expected {
        if conversation_id != provider_session_id {
            return Ok(None);
        }
        let exact = lookup_happy_restoration_candidate_in_db(
            &tx,
            provider_session_id,
            expected.happy_session_id,
        )?;
        let HappyRestorationLookup::Candidate(candidate) = exact else {
            return Ok(None);
        };
        if candidate.agent_type != expected.agent_type
            || candidate.agent_session_id.as_deref() != expected.agent_session_id
            || candidate.agent_permission_mode.as_deref() != expected.agent_permission_mode
            || candidate.agent_cwd != expected.agent_cwd
            || candidate.project_root != expected.project_root
        {
            return Ok(None);
        }
    } else {
        let sql = format!(
            "SELECT 1
             FROM conversations c
             LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
             WHERE c.id = ?1 AND ({case}) = 'agent'
             LIMIT 1",
            case = DERIVED_KIND_CASE_SQL,
        );
        if tx
            .query_row(&sql, params![conversation_id], |_| Ok(()))
            .optional()?
            .is_none()
        {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
    }

    tx.execute(
        "INSERT INTO happy_provider_session_lifecycle
            (provider_session_id, conversation_id, is_archived, updated_at)
         VALUES (?1, ?2, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         ON CONFLICT(provider_session_id) DO UPDATE SET
            conversation_id = excluded.conversation_id,
            updated_at = excluded.updated_at",
        params![provider_session_id, conversation_id],
    )?;
    let archived = tx.query_row(
        "SELECT hpsl.is_archived OR c.is_archived
         FROM happy_provider_session_lifecycle hpsl
         JOIN conversations c ON c.id = hpsl.conversation_id
         WHERE hpsl.provider_session_id = ?1",
        params![provider_session_id],
        |row| row.get::<_, bool>(0),
    )?;
    if archived {
        tx.execute(
            "UPDATE happy_provider_session_lifecycle
             SET is_archived = 1
             WHERE provider_session_id = ?1",
            params![provider_session_id],
        )?;
        archive_agent_conversation_in_db(&tx, conversation_id)?;
    } else if let Some(agent_session_id) = agent_session_id {
        if !set_agent_conversation_session_id_in_db(&tx, conversation_id, agent_session_id)? {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
    }
    tx.commit()?;
    Ok(Some(archived))
}

/// Persist an exact provider-session archive fence without emitting another
/// frontend archive event. The Happy event listener uses this for sibling
/// sessions before attempting process teardown, so a transient provider RPC
/// failure cannot let the sibling reattach or promote later.
#[tauri::command]
pub async fn fence_happy_provider_session_archive(
    app: AppHandle,
    provider_session_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&provider_session_id)
        .map_err(|_| "providerSessionId must be a UUID".to_string())?;
    let persisted_provider_session_id = provider_session_id.clone();
    run_db(app.clone(), move |conn| {
        archive_happy_provider_session_in_db(conn, &persisted_provider_session_id).map(|_| ())
    })
    .await?;

    // The SQLite row is the crash-safe source of truth. Also notify the live
    // bridge so it can mark its encrypted relay binding retiring immediately;
    // startup reconciliation consults the SQLite fence if this write races a
    // bridge crash.
    if let Some(manager) = app.try_state::<HappyBridgeManager>()
        && manager.process_exists().await
        && let Err(error) = manager.retire_provider_session(&provider_session_id).await
    {
        log::warn!("[HappyBridge] Failed to notify live bridge of provider retirement: {error}");
    }
    Ok(())
}

fn archive_happy_provider_session_in_db(
    conn: &Connection,
    provider_session_id: &str,
) -> rusqlite::Result<Option<String>> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO happy_provider_session_lifecycle
            (provider_session_id, conversation_id, is_archived, updated_at)
         VALUES (?1, NULL, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
         ON CONFLICT(provider_session_id) DO UPDATE SET
            is_archived = 1,
            updated_at = excluded.updated_at",
        params![provider_session_id],
    )?;

    let (mut owner, _) = lookup_agent_conversation_owner_in_db(&tx, provider_session_id, None)?;
    if owner.is_none() {
        let direct_sql = format!(
            "SELECT c.id
             FROM conversations c
             LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
             WHERE c.id = ?1 AND ({case}) = 'agent'
             LIMIT 1",
            case = DERIVED_KIND_CASE_SQL,
        );
        owner = tx
            .query_row(&direct_sql, params![provider_session_id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
    }
    let Some(conversation_id) = owner else {
        tx.commit()?;
        return Ok(None);
    };
    tx.execute(
        "UPDATE happy_provider_session_lifecycle
         SET conversation_id = ?2
         WHERE provider_session_id = ?1",
        params![provider_session_id, conversation_id],
    )?;
    let archived = archive_agent_conversation_in_db(&tx, &conversation_id)?;
    tx.commit()?;
    if archived {
        Ok(Some(conversation_id))
    } else {
        Ok(None)
    }
}

fn is_happy_provider_session_archived_in_db(
    conn: &Connection,
    provider_session_id: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT is_archived
         FROM happy_provider_session_lifecycle
         WHERE provider_session_id = ?1",
        params![provider_session_id],
        |row| row.get::<_, bool>(0),
    )
    .optional()
    .map(|archived| archived.unwrap_or(false))
}

pub(crate) async fn is_happy_provider_session_archived(
    app: AppHandle,
    provider_session_id: String,
) -> Result<bool, String> {
    run_db(app, move |conn| {
        is_happy_provider_session_archived_in_db(conn, &provider_session_id)
    })
    .await
}

pub(crate) async fn lookup_agent_conversation_owner(
    app: AppHandle,
    provider_session_id: String,
    agent_session_id: Option<String>,
) -> Result<Option<String>, String> {
    let (owner, ambiguous) = run_db(app, move |conn| {
        lookup_agent_conversation_owner_in_db(
            conn,
            &provider_session_id,
            agent_session_id.as_deref(),
        )
    })
    .await?;
    if ambiguous {
        return Err("provider session maps to multiple agent conversations".to_string());
    }
    Ok(owner)
}

#[tauri::command]
pub async fn get_agent_conversation(
    app: AppHandle,
    id: String,
) -> Result<Option<AgentConversation>, String> {
    run_db(app, move |conn| {
        // Filter by the derived kind so the reader stays correct if the
        // stored `conversations.kind` ever drifts from the live provider
        // binding.
        let sql = format!(
            "SELECT c.id, c.title, c.created_at,
                    CASE WHEN ({case}) = 'agent'
                         THEN COALESCE(c.agent_type, psr.provider)
                         ELSE c.agent_type END AS agent_type,
                    c.agent_session_id,
                    c.agent_cwd, c.agent_model_id, c.agent_permission_mode,
                    c.agent_metadata, c.project_id, c.project_root, c.is_archived,
                    c.privileged, c.counsel_direction
             FROM conversations c
             LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
             WHERE c.id = ?1
               AND ({case}) = 'agent'",
            case = DERIVED_KIND_CASE_SQL,
        );
        let mut stmt = conn.prepare(&sql)?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(AgentConversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    agent_type: row.get(3)?,
                    agent_session_id: row.get(4)?,
                    agent_cwd: row.get(5)?,
                    agent_model_id: row.get(6)?,
                    agent_permission_mode: row.get(7)?,
                    agent_metadata: row.get(8)?,
                    project_id: row.get(9)?,
                    project_root: row.get(10)?,
                    is_archived: row.get::<_, i32>(11)? != 0,
                    privileged: row.get::<_, i32>(12)? != 0,
                    counsel_direction: row.get(13)?,
                })
            })
            .optional()?;

        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn set_agent_conversation_session_id(
    app: AppHandle,
    id: String,
    agent_session_id: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        if !set_agent_conversation_session_id_in_db(conn, &id, &agent_session_id)? {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        Ok(())
    })
    .await
}

fn set_agent_conversation_session_id_in_db(
    conn: &Connection,
    id: &str,
    agent_session_id: &str,
) -> rusqlite::Result<bool> {
    let sql = format!(
        "SELECT 1
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1
           AND ({case}) = 'agent'
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    let is_agent = conn
        .query_row(&sql, params![id], |_| Ok(()))
        .optional()?
        .is_some();
    if !is_agent {
        return Ok(false);
    }
    if conn.execute(
        "UPDATE conversations SET agent_session_id = ?1 WHERE id = ?2",
        params![agent_session_id, id],
    )? != 1
    {
        return Ok(false);
    }
    mark_sync_upsert(conn, "conversations", id)?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HappyProviderSessionOwnerClaim {
    pub(crate) archived: bool,
}

#[tauri::command]
pub async fn claim_happy_provider_session_owner(
    app: AppHandle,
    conversation_id: String,
    provider_session_id: String,
    agent_session_id: Option<String>,
) -> Result<HappyProviderSessionOwnerClaim, String> {
    uuid::Uuid::parse_str(&conversation_id)
        .map_err(|_| "conversation_id must be a UUID".to_string())?;
    uuid::Uuid::parse_str(&provider_session_id)
        .map_err(|_| "provider_session_id must be a UUID".to_string())?;
    let index_id = conversation_id.clone();
    let target_provider_session_id = provider_session_id.clone();
    let archived = run_db(app.clone(), move |conn| {
        claim_happy_provider_session_owner_in_db(
            conn,
            &conversation_id,
            &provider_session_id,
            agent_session_id.as_deref(),
        )
    })
    .await?;
    if archived {
        refresh_conversation_index_meta_best_effort(
            app.clone(),
            index_id.clone(),
            None,
            Some(true),
        )
        .await;
        emit_happy_provider_archive_event(&app, Some(&index_id), &target_provider_session_id);
    }
    Ok(HappyProviderSessionOwnerClaim { archived })
}

pub(crate) async fn claim_restored_happy_provider_session_owner(
    app: AppHandle,
    conversation_id: String,
    provider_session_id: String,
    happy_session_id: String,
    agent_session_id: Option<String>,
    expected_agent_type: String,
    expected_agent_session_id: Option<String>,
    expected_agent_permission_mode: Option<String>,
    expected_agent_cwd: String,
    expected_project_root: String,
) -> Result<HappyProviderSessionOwnerClaim, String> {
    uuid::Uuid::parse_str(&conversation_id)
        .map_err(|_| "conversationId must be a UUID".to_string())?;
    uuid::Uuid::parse_str(&provider_session_id)
        .map_err(|_| "providerSessionId must be a UUID".to_string())?;
    if conversation_id != provider_session_id || happy_session_id.trim().is_empty() {
        return Err("Happy restoration claim was rejected".to_string());
    }

    let index_id = conversation_id.clone();
    let target_provider_session_id = provider_session_id.clone();
    let claimed = run_db(app.clone(), move |conn| {
        claim_happy_provider_session_owner_with_provenance_in_db(
            conn,
            &conversation_id,
            &provider_session_id,
            agent_session_id.as_deref(),
            Some(ExpectedHappyRestoration {
                happy_session_id: &happy_session_id,
                agent_type: &expected_agent_type,
                agent_session_id: expected_agent_session_id.as_deref(),
                agent_permission_mode: expected_agent_permission_mode.as_deref(),
                agent_cwd: &expected_agent_cwd,
                project_root: &expected_project_root,
            }),
        )
    })
    .await?;
    let Some(archived) = claimed else {
        return Err("Happy restoration claim was rejected".to_string());
    };
    if archived {
        refresh_conversation_index_meta_best_effort(
            app.clone(),
            index_id.clone(),
            None,
            Some(true),
        )
        .await;
        emit_happy_provider_archive_event(&app, Some(&index_id), &target_provider_session_id);
    }
    Ok(HappyProviderSessionOwnerClaim { archived })
}

#[tauri::command]
pub async fn set_agent_conversation_title(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    let index_id = id.clone();
    let index_title = title.clone();
    run_db(app.clone(), move |conn| {
        conn.execute(
            "UPDATE conversations SET title = ?1 WHERE id = ?2 AND kind = 'agent'",
            params![title, id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;
    refresh_conversation_index_meta_best_effort(app, index_id, Some(index_title), None).await;
    Ok(())
}

#[tauri::command]
pub async fn set_agent_conversation_model_id(
    app: AppHandle,
    id: String,
    agent_model_id: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET agent_model_id = ?1 WHERE id = ?2 AND kind = 'agent'",
            params![agent_model_id, id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn set_agent_conversation_permission_mode(
    app: AppHandle,
    id: String,
    agent_permission_mode: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET agent_permission_mode = ?1 WHERE id = ?2 AND kind = 'agent'",
            params![agent_permission_mode, id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await
}

/// Fetch the persisted composer draft for a thread (#1631).
/// Survives force-quit so the user never loses unsent text.
#[tauri::command]
pub async fn get_thread_draft(app: AppHandle, thread_id: String) -> Result<String, String> {
    run_db(app, move |conn| {
        let draft: Option<String> = conn
            .query_row(
                "SELECT draft FROM conversations WHERE id = ?1",
                params![thread_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        Ok(draft.unwrap_or_default())
    })
    .await
}

/// Write the composer draft for a thread (#1631).
/// Called on 500ms input debounce; cleared after submit by the frontend.
#[tauri::command]
pub async fn set_thread_draft(
    app: AppHandle,
    thread_id: String,
    draft: String,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET draft = ?1 WHERE id = ?2",
            params![draft, thread_id],
        )?;
        mark_sync_upsert(conn, "thread_drafts", &thread_id)?;
        Ok(())
    })
    .await
}

const MAX_INPUT_HISTORY_PER_CONVERSATION: i64 = 200;

#[tauri::command]
pub async fn append_input_history(
    app: AppHandle,
    conversation_id: String,
    content: String,
) -> Result<(), String> {
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Ok(());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO input_history (conversation_id, timestamp, content) VALUES (?1, ?2, ?3)",
            params![conversation_id, timestamp, trimmed],
        )?;
        conn.execute(
            "DELETE FROM input_history
             WHERE conversation_id = ?1
               AND rowid NOT IN (
                 SELECT rowid FROM input_history
                 WHERE conversation_id = ?1
                 ORDER BY timestamp DESC
                 LIMIT ?2
               )",
            params![conversation_id, MAX_INPUT_HISTORY_PER_CONVERSATION],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_input_history(
    app: AppHandle,
    conversation_id: String,
) -> Result<Vec<String>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT content FROM input_history
             WHERE conversation_id = ?1
             ORDER BY timestamp ASC",
        )?;
        let rows = stmt
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn set_agent_conversation_metadata(
    app: AppHandle,
    id: String,
    agent_metadata: Option<String>,
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET agent_metadata = ?1 WHERE id = ?2 AND kind = 'agent'",
            params![agent_metadata, id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn archive_agent_conversation(app: AppHandle, id: String) -> Result<(), String> {
    archive_agent_conversation_with_origin(app, id, AgentArchiveOrigin::Desktop, None).await
}

pub(crate) async fn archive_agent_conversation_from_happy(
    app: AppHandle,
    id: String,
    provider_session_id: String,
) -> Result<(), String> {
    archive_agent_conversation_with_origin(
        app,
        id,
        AgentArchiveOrigin::Happy,
        Some(provider_session_id),
    )
    .await
}

pub(crate) async fn archive_happy_provider_session_from_happy(
    app: AppHandle,
    provider_session_id: String,
) -> Result<Option<String>, String> {
    let target_provider_session_id = provider_session_id.clone();
    let conversation_id = run_db(app.clone(), move |conn| {
        archive_happy_provider_session_in_db(conn, &provider_session_id)
    })
    .await?;
    if let Some(conversation_id) = conversation_id.as_deref() {
        refresh_conversation_index_meta_best_effort(
            app.clone(),
            conversation_id.to_string(),
            None,
            Some(true),
        )
        .await;
    }
    emit_happy_provider_archive_event(
        &app,
        conversation_id.as_deref(),
        &target_provider_session_id,
    );
    Ok(conversation_id)
}

#[derive(Clone, Copy)]
enum AgentArchiveOrigin {
    Desktop,
    Happy,
}

async fn archive_agent_conversation_with_origin(
    app: AppHandle,
    id: String,
    origin: AgentArchiveOrigin,
    provider_session_id: Option<String>,
) -> Result<(), String> {
    let index_id = id.clone();
    let archived = run_db(app.clone(), move |conn| {
        archive_agent_conversation_in_db(conn, &id)
    })
    .await?;
    if !archived {
        return Err("agent conversation was not found".to_string());
    }
    refresh_conversation_index_meta_best_effort(app.clone(), index_id.clone(), None, Some(true))
        .await;
    emit_happy_archive_event(&app, origin, &index_id, provider_session_id.as_deref());
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HappyConversationArchivedEvent<'a> {
    conversation_id: Option<&'a str>,
    target_provider_session_id: &'a str,
}

pub(crate) fn emit_happy_provider_archive_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    conversation_id: Option<&str>,
    target_provider_session_id: &str,
) {
    let _ = app.emit(
        "happy-bridge://conversation-archived",
        HappyConversationArchivedEvent {
            conversation_id,
            target_provider_session_id,
        },
    );
}

fn emit_happy_archive_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    origin: AgentArchiveOrigin,
    conversation_id: &str,
    provider_session_id: Option<&str>,
) {
    if let (AgentArchiveOrigin::Happy, Some(target_provider_session_id)) =
        (origin, provider_session_id)
    {
        emit_happy_provider_archive_event(app, Some(conversation_id), target_provider_session_id);
    }
}

fn archive_agent_conversation_in_db(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let sql = format!(
        "SELECT ({case}) = 'agent'
         FROM conversations c
         LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
         WHERE c.id = ?1
         LIMIT 1",
        case = DERIVED_KIND_CASE_SQL,
    );
    let is_agent = conn
        .query_row(&sql, params![id], |row| row.get::<_, bool>(0))
        .optional()?
        .unwrap_or(false);
    if !is_agent {
        return Ok(false);
    }
    let changed = conn.execute(
        "UPDATE conversations SET is_archived = 1 WHERE id = ?1",
        params![id],
    )?;
    if changed != 1 {
        return Ok(false);
    }
    mark_sync_upsert(conn, "conversations", id)?;
    Ok(true)
}

// ============================================================================
// Message Commands
// ============================================================================

#[tauri::command]
pub async fn save_message(
    app: AppHandle,
    id: String,
    conversation_id: String,
    role: String,
    content: String,
    model: Option<String>,
    timestamp: i64,
    metadata: Option<String>,
    provider: Option<String>,
) -> Result<(), String> {
    let indexable = run_db(app.clone(), move |conn| {
        let message = PersistedMessage {
            id,
            conversation_id,
            role,
            content,
            model,
            timestamp,
            metadata,
            provider,
        };
        save_message_record(conn, &message)?;
        let meta = load_indexable_message_meta(conn, &message.conversation_id)?;
        Ok(meta.map(
            |(kind, title, agent_type, project_root, is_archived, is_privileged)| IndexableMessage {
                message_id: message.id,
                conversation_id: message.conversation_id,
                kind,
                role: message.role,
                title,
                agent_type,
                project_root,
                is_archived,
                is_privileged,
                timestamp: message.timestamp,
                content: message.content,
            },
        ))
    })
    .await?;
    if let Some(message) = indexable {
        index_message_best_effort(&app, &message);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_messages(
    app: AppHandle,
    conversation_id: String,
    limit: i32,
) -> Result<Vec<StoredMessage>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, model, timestamp, metadata, provider
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let rows = stmt
            .query_map(params![conversation_id, limit], |row| {
                Ok(StoredMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    model: row.get(4)?,
                    timestamp: row.get(5)?,
                    metadata: row.get(6)?,
                    provider: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Reverse to get chronological order
        let mut ordered = rows;
        ordered.reverse();
        Ok(ordered)
    })
    .await
}

#[tauri::command]
pub async fn clear_conversation_history(
    app: AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    let index_id = conversation_id.clone();
    run_db(app.clone(), move |conn| {
        let mut event_stmt =
            conn.prepare("SELECT id FROM message_events WHERE conversation_id = ?1")?;
        let event_ids = event_stmt
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(event_stmt);
        let mut message_stmt =
            conn.prepare("SELECT id FROM messages WHERE conversation_id = ?1")?;
        let message_ids = message_stmt
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(message_stmt);
        for event_id in &event_ids {
            enqueue_sync_tombstone(conn, "message_events", event_id)?;
        }
        for message_id in &message_ids {
            enqueue_sync_tombstone(conn, "messages", message_id)?;
        }
        conn.execute(
            "DELETE FROM message_events WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        Ok(())
    })
    .await?;
    delete_conversation_index_best_effort(&app, &index_id);
    Ok(())
}

#[tauri::command]
pub async fn clear_all_history(app: AppHandle) -> Result<(), String> {
    run_db(app.clone(), move |conn| {
        let conversation_ids = conn
            .prepare("SELECT id FROM conversations")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in &conversation_ids {
            enqueue_sync_tombstone(conn, "thread_drafts", id)?;
            enqueue_sync_tombstone(conn, "conversations", id)?;
        }
        let event_ids = conn
            .prepare("SELECT id FROM message_events")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in &event_ids {
            enqueue_sync_tombstone(conn, "message_events", id)?;
        }
        let message_ids = conn
            .prepare("SELECT id FROM messages")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in &message_ids {
            enqueue_sync_tombstone(conn, "messages", id)?;
        }
        conn.execute("DELETE FROM message_events", [])?;
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM conversations", [])?;
        Ok(())
    })
    .await?;
    clear_conversation_index_best_effort(&app);
    Ok(())
}

/// Outcome of erasing one conversation-data target in the erase-all flow.
/// `status` is one of `ok`, `failed`, `delegated`, or `unsupported`.
#[derive(Serialize)]
pub struct EraseTargetReport {
    pub target: String,
    pub status: String,
    pub detail: Option<String>,
}

impl EraseTargetReport {
    fn new(target: &str, status: &str, detail: Option<String>) -> Self {
        Self {
            target: target.to_string(),
            status: status.to_string(),
            detail,
        }
    }
}

/// Erase every local conversation-data target in one flow and return a
/// per-target success/failure report. Each target is best-effort and isolated:
/// a failure in one is recorded and the remaining targets still run.
///
/// Remote targets this flow does not perform are reported honestly rather than
/// omitted — `remote_history_schema` and `claude_agent_preferences` are
/// delegated to their own controls, and `cloud_memories` is unsupported because
/// the memory service exposes no source/bulk delete (tracked in #3198).
#[tauri::command]
pub async fn erase_all_conversation_data(
    app: AppHandle,
    memory_state: State<'_, MemoryState>,
) -> Result<Vec<EraseTargetReport>, String> {
    let mut reports = Vec::new();

    // Local chat.db: capture each agent conversation's transcript identity
    // before the rows are deleted, then run the thorough per-conversation
    // delete for every conversation, followed by VACUUM + WAL truncate.
    let chat_result = run_db(app.clone(), move |conn| {
        let conversation_ids = conn
            .prepare("SELECT id FROM conversations")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        let targets = collect_agent_transcript_targets(conn, &conversation_ids)?;
        delete_conversation_records(conn, &conversation_ids)?;
        vacuum_database(conn)?;
        Ok((conversation_ids.len(), targets))
    })
    .await;

    let transcript_targets = match chat_result {
        Ok((count, targets)) => {
            reports.push(EraseTargetReport::new(
                "local_chat_db",
                "ok",
                Some(format!("{count} conversation(s) removed; VACUUM + WAL truncate")),
            ));
            targets
        }
        Err(err) => {
            reports.push(EraseTargetReport::new("local_chat_db", "failed", Some(err)));
            Vec::new()
        }
    };

    // Conversation index: clear all chunks and reclaim the freed pages.
    let index_result = open_index_db(&app).and_then(|conn| {
        conversation_index::clear_all_chunks(&conn)?;
        vacuum_database(&conn)?;
        Ok(())
    });
    match index_result {
        Ok(()) => reports.push(EraseTargetReport::new("conversation_index", "ok", None)),
        Err(err) => reports.push(EraseTargetReport::new(
            "conversation_index",
            "failed",
            Some(err.to_string()),
        )),
    }

    // CLI transcripts: best-effort file removal (failures are logged per file).
    let transcript_count = transcript_targets.len();
    delete_agent_transcripts_best_effort(&transcript_targets);
    reports.push(EraseTargetReport::new(
        "cli_transcripts",
        "ok",
        Some(format!(
            "{transcript_count} agent session transcript(s) targeted"
        )),
    ));

    // Local cloud-memory cache: drop the connection and remove the files.
    match memory_state.wipe_local_cache() {
        Ok(()) => reports.push(EraseTargetReport::new("memory_cache_db", "ok", None)),
        Err(err) => reports.push(EraseTargetReport::new(
            "memory_cache_db",
            "failed",
            Some(err),
        )),
    }

    // Remote / blocked targets — reported so "erase all" is not misleading.
    reports.push(EraseTargetReport::new(
        "remote_history_schema",
        "delegated",
        Some(
            "Use \"Wipe Remote Copy\" — needs the SerenDB project/branch and a typed database-name confirmation.".to_string(),
        ),
    ));
    reports.push(EraseTargetReport::new(
        "cloud_memories",
        "unsupported",
        Some("The memory service exposes no source or bulk delete (tracked in #3198).".to_string()),
    ));
    reports.push(EraseTargetReport::new(
        "claude_agent_preferences",
        "delegated",
        Some("Remote SerenDB memory preferences are cleared through the Claude memory tools.".to_string()),
    ));

    Ok(reports)
}

// ============================================================================
// Helper
// ============================================================================

pub(crate) async fn run_db<T>(
    app: AppHandle,
    task: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        // Use the shared connection pool if available (normal runtime),
        // fall back to opening a fresh connection (tests / early startup).
        if let Some(pool) = app.try_state::<DbPool>() {
            pool.with_connection(|conn| task(conn))
        } else {
            let conn = init_db(&app).map_err(|err| err.to_string())?;
            task(&conn).map_err(|err| err.to_string())
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        AgentArchiveOrigin, AgentConversation, AgentTranscriptTarget, DERIVED_KIND_CASE_SQL,
        ExpectedHappyRestoration, HappyRestorationCandidate, HappyRestorationLookup,
        archive_agent_conversation_in_db, archive_happy_provider_session_in_db,
        claim_happy_provider_session_owner_in_db,
        claim_happy_provider_session_owner_with_provenance_in_db, collect_agent_transcript_targets,
        delete_conversation_records, emit_happy_archive_event, emit_happy_provider_archive_event,
        is_happy_provider_session_archived_in_db, list_legacy_happy_restoration_candidates_in_db,
        lookup_agent_conversation_owner_in_db, lookup_happy_restoration_candidate_in_db,
        lookup_happy_session_id_by_conversation_in_db, migrate_happy_restoration_relay_in_db,
        remove_agent_transcripts, set_agent_conversation_session_id_in_db,
        upsert_agent_conversation_in_db, vacuum_database,
    };
    use crate::services::database::{configure_connection, setup_schema};
    use rusqlite::{Connection, params};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::Listener;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn deleting_agent_conversation_removes_its_cli_transcripts() {
        let conn = open();
        let claude_id = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";
        let codex_id = "11111111-2222-4333-8444-555555555555";
        let cwd = "/work/project";

        // Two agent conversations (Claude Code + Codex) and one plain chat that
        // must be left untouched because it has no captured session id.
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, agent_session_id, agent_cwd)
             VALUES
               ('claude-convo', 't', 0, 'agent', 'claude-code', ?1, ?3),
               ('codex-convo',  't', 0, 'agent', 'codex',       ?2, ?3)",
            params![claude_id, codex_id, cwd],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind) VALUES ('plain-chat', 't', 0, 'chat')",
            [],
        )
        .unwrap();

        let targets = collect_agent_transcript_targets(
            &conn,
            &[
                "claude-convo".to_string(),
                "codex-convo".to_string(),
                "plain-chat".to_string(),
            ],
        )
        .unwrap();
        // The plain chat has no session id, so only the two agent rows surface.
        assert_eq!(targets.len(), 2);

        // Lay down real transcript files where production would have written them.
        let claude_root = tempfile::TempDir::new().unwrap();
        let codex_root = tempfile::TempDir::new().unwrap();
        let claude_path = crate::claude_memory::session_jsonl_path(
            claude_root.path(),
            std::path::Path::new(cwd),
            claude_id,
        );
        std::fs::create_dir_all(claude_path.parent().unwrap()).unwrap();
        std::fs::write(&claude_path, b"{}").unwrap();

        let codex_day = codex_root.path().join("2026").join("06").join("16");
        std::fs::create_dir_all(&codex_day).unwrap();
        let codex_path = codex_day.join(format!("rollout-2026-06-16T07-24-21-{codex_id}.jsonl"));
        std::fs::write(&codex_path, b"{}").unwrap();

        remove_agent_transcripts(&targets, Some(claude_root.path()), Some(codex_root.path()));

        assert!(!claude_path.exists(), "claude transcript should be deleted");
        assert!(!codex_path.exists(), "codex transcript should be deleted");

        // Idempotent: a second pass over now-missing files must not panic.
        remove_agent_transcripts(&targets, Some(claude_root.path()), Some(codex_root.path()));
    }

    #[test]
    fn transcript_targets_reject_non_uuid_session_ids() {
        // A non-UUID session id must be skipped, so the file that its naive path
        // would resolve to is left untouched (path-injection defense).
        let claude_root = tempfile::TempDir::new().unwrap();
        let codex_root = tempfile::TempDir::new().unwrap();
        let naive_path = crate::claude_memory::session_jsonl_path(
            claude_root.path(),
            std::path::Path::new("/work"),
            "not-a-uuid",
        );
        std::fs::create_dir_all(naive_path.parent().unwrap()).unwrap();
        std::fs::write(&naive_path, b"keep").unwrap();

        let targets = vec![AgentTranscriptTarget {
            agent_type: "claude-code".to_string(),
            session_id: "not-a-uuid".to_string(),
            agent_cwd: Some("/work".to_string()),
        }];
        remove_agent_transcripts(&targets, Some(claude_root.path()), Some(codex_root.path()));
        assert!(naive_path.exists(), "non-UUID session id must be skipped");
    }

    #[test]
    fn deleting_paired_conversation_removes_both_legs() {
        let conn = open();
        let planner_id = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";
        let executor_id = "11111111-2222-4333-8444-555555555555";
        let cwd = "/work/project";

        // A paired claude-codex conversation stores a JSON composite in
        // agent_session_id (planner + executor ids + ledger), exactly as
        // paired-runtime.mjs → compositeAgentSessionId writes it. The nested
        // ledger even carries its own `planner`/`executor` spend objects, which
        // must NOT be mistaken for the top-level session-id strings.
        let composite = serde_json::json!({
            "planner": planner_id,
            "executor": executor_id,
            "ledger": {
                "version": 1,
                "totalSpend": {
                    "planner": { "input_tokens": 10, "output_tokens": 20 },
                    "executor": { "input_tokens": 30, "output_tokens": 40 }
                }
            }
        })
        .to_string();

        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, agent_session_id, agent_cwd)
             VALUES ('paired-convo', 't', 0, 'agent', 'claude-codex', ?1, ?2)",
            params![composite, cwd],
        )
        .unwrap();

        let targets =
            collect_agent_transcript_targets(&conn, &["paired-convo".to_string()]).unwrap();
        assert_eq!(targets.len(), 1);

        // Lay down both legs where production would have written them: the Claude
        // planner transcript keyed by the planner UUID, and the Codex executor
        // rollout keyed by the executor UUID.
        let claude_root = tempfile::TempDir::new().unwrap();
        let codex_root = tempfile::TempDir::new().unwrap();
        let claude_path = crate::claude_memory::session_jsonl_path(
            claude_root.path(),
            std::path::Path::new(cwd),
            planner_id,
        );
        std::fs::create_dir_all(claude_path.parent().unwrap()).unwrap();
        std::fs::write(&claude_path, b"{}").unwrap();

        let codex_day = codex_root.path().join("2026").join("06").join("16");
        std::fs::create_dir_all(&codex_day).unwrap();
        let codex_path = codex_day.join(format!("rollout-2026-06-16T07-24-21-{executor_id}.jsonl"));
        std::fs::write(&codex_path, b"{}").unwrap();

        remove_agent_transcripts(&targets, Some(claude_root.path()), Some(codex_root.path()));

        assert!(
            !claude_path.exists(),
            "paired planner transcript should be deleted"
        );
        assert!(
            !codex_path.exists(),
            "paired executor rollout should be deleted"
        );

        // A malformed / legacy composite must touch no path and never panic.
        let bad = vec![AgentTranscriptTarget {
            agent_type: "claude-codex".to_string(),
            session_id: "not-json".to_string(),
            agent_cwd: Some(cwd.to_string()),
        }];
        std::fs::write(&claude_path, b"{}").unwrap();
        std::fs::write(&codex_path, b"{}").unwrap();
        remove_agent_transcripts(&bad, Some(claude_root.path()), Some(codex_root.path()));
        assert!(
            claude_path.exists(),
            "unparseable composite must not delete anything"
        );
        assert!(
            codex_path.exists(),
            "unparseable composite must not delete anything"
        );
    }

    #[test]
    fn true_deletion_delete_and_vacuum_erases_deleted_message_canary_from_chat_db() {
        const CANARY: &str = "true-deletion-canary-1a6b4ec5-83d7-44e4-a044-81c1fe94b24d";
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("chat.db");
        let wal_path = temp_dir.path().join("chat.db-wal");

        {
            let conn = Connection::open(&db_path).unwrap();
            configure_connection(&conn).unwrap();
            setup_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Chat', 1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, timestamp)
                 VALUES ('m1', 'c1', 'user', ?1, 2)",
                params![CANARY],
            )
            .unwrap();

            delete_conversation_records(&conn, &["c1".to_string()]).unwrap();
            vacuum_database(&conn).unwrap();
        }

        for path in [&db_path, &wal_path] {
            if path.exists() {
                let bytes = std::fs::read(path).unwrap();
                assert!(
                    !bytes
                        .windows(CANARY.len())
                        .any(|window| window == CANARY.as_bytes()),
                    "deleted canary remained in {}",
                    path.display()
                );
            }
        }
    }

    fn insert_happy_restoration_candidate(conn: &Connection, id: &str, happy_session_id: &str) {
        conn.execute(
            "INSERT INTO conversations (
                id, title, created_at, kind, agent_type, agent_session_id,
                agent_cwd, agent_model_id, agent_permission_mode,
                agent_metadata, project_root
             ) VALUES (
                ?1, 'Remote thread', 1000, 'agent', 'codex', 'native-before',
                '/synthetic/consented', 'saved-model', 'saved-permission',
                ?2, '/synthetic/consented'
             )",
            params![
                id,
                serde_json::json!({ "happy_session_id": happy_session_id }).to_string(),
            ],
        )
        .unwrap();
    }

    #[test]
    fn happy_restoration_lookup_returns_exact_saved_resume_fields() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "provider-local-id", "relay-id");

        assert_eq!(
            lookup_happy_restoration_candidate_in_db(&conn, "provider-local-id", "relay-id",)
                .unwrap(),
            HappyRestorationLookup::Candidate(HappyRestorationCandidate {
                conversation_id: "provider-local-id".to_string(),
                title: "Remote thread".to_string(),
                agent_type: "codex".to_string(),
                agent_session_id: Some("native-before".to_string()),
                agent_cwd: "/synthetic/consented".to_string(),
                agent_model_id: Some("saved-model".to_string()),
                agent_permission_mode: Some("saved-permission".to_string()),
                project_root: "/synthetic/consented".to_string(),
                is_archived: false,
            }),
        );
    }

    #[test]
    fn legacy_happy_candidates_are_exact_unarchived_rows_and_rebind_atomically() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "provider-local-id", "legacy-relay-id");

        let candidates = list_legacy_happy_restoration_candidates_in_db(&conn).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].happy_session_id, "legacy-relay-id");
        assert_eq!(
            candidates[0].conversation.conversation_id,
            "provider-local-id"
        );

        assert!(
            migrate_happy_restoration_relay_in_db(
                &conn,
                "provider-local-id",
                "legacy-relay-id",
                "replacement-relay-id",
            )
            .unwrap()
        );
        assert!(matches!(
            lookup_happy_restoration_candidate_in_db(
                &conn,
                "provider-local-id",
                "replacement-relay-id",
            )
            .unwrap(),
            HappyRestorationLookup::Candidate(_)
        ));
        assert!(
            list_legacy_happy_restoration_candidates_in_db(&conn)
                .unwrap()
                .is_empty(),
            "the committed migration lifecycle must exclude this current row",
        );
        assert!(
            !migrate_happy_restoration_relay_in_db(
                &conn,
                "provider-local-id",
                "legacy-relay-id",
                "stale-replacement",
            )
            .unwrap(),
            "a stale migration must not overwrite the committed relay marker",
        );

        conn.execute(
            "UPDATE conversations SET is_archived = 1 WHERE id = 'provider-local-id'",
            [],
        )
        .unwrap();
        assert!(
            list_legacy_happy_restoration_candidates_in_db(&conn)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn matching_ready_binding_marks_legacy_row_as_current_without_rotating_it() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "provider-local-id", "relay-id");

        assert!(
            migrate_happy_restoration_relay_in_db(
                &conn,
                "provider-local-id",
                "relay-id",
                "relay-id",
            )
            .unwrap()
        );
        assert!(
            list_legacy_happy_restoration_candidates_in_db(&conn)
                .unwrap()
                .is_empty(),
            "a current row must not become a migration candidate after its key is retired",
        );
        assert!(matches!(
            lookup_happy_restoration_candidate_in_db(&conn, "provider-local-id", "relay-id",)
                .unwrap(),
            HappyRestorationLookup::Candidate(_)
        ));
        assert!(
            !migrate_happy_restoration_relay_in_db(
                &conn,
                "provider-local-id",
                "relay-id",
                "stale-rotation",
            )
            .unwrap(),
            "a lifecycle claim appearing after discovery must reject stale rotation",
        );
    }

    #[test]
    fn happy_restoration_lookup_never_falls_back_and_rejects_ambiguous_provenance() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "provider-local-id", "relay-id");
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('desktop-origin', 'Desktop thread', 1001, 'agent', 'codex')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO conversations (
                id, title, created_at, kind, agent_type, agent_cwd,
                agent_metadata, project_root
             ) VALUES (
                'invalid-marker', 'Invalid marker', 1002, 'agent', 'codex',
                '/synthetic/consented', '{\"happy_session_id\":42}',
                '/synthetic/consented'
             )",
            [],
        )
        .unwrap();

        assert_eq!(
            lookup_happy_restoration_candidate_in_db(&conn, "missing-local-id", "relay-id")
                .unwrap(),
            HappyRestorationLookup::NotHappyOrigin,
            "a matching relay id must never substitute for the exact local/provider id",
        );
        assert_eq!(
            lookup_happy_restoration_candidate_in_db(&conn, "desktop-origin", "relay-id").unwrap(),
            HappyRestorationLookup::NotHappyOrigin,
            "a desktop-origin row is not remotely restorable without the Happy marker",
        );
        assert_eq!(
            lookup_happy_restoration_candidate_in_db(&conn, "invalid-marker", "relay-id").unwrap(),
            HappyRestorationLookup::InvalidHappyOrigin { is_archived: false },
            "a present but invalid Happy marker is not a desktop-origin row",
        );
        assert_eq!(
            lookup_happy_restoration_candidate_in_db(
                &conn,
                "provider-local-id",
                "different-relay-id",
            )
            .unwrap(),
            HappyRestorationLookup::InvalidHappyOrigin { is_archived: false },
        );

        insert_happy_restoration_candidate(&conn, "duplicate-local-id", "relay-id");
        assert_eq!(
            lookup_happy_restoration_candidate_in_db(&conn, "provider-local-id", "relay-id",)
                .unwrap(),
            HappyRestorationLookup::InvalidHappyOrigin { is_archived: false },
            "duplicate relay metadata is ambiguous and must fail closed",
        );
    }

    #[test]
    fn restored_happy_claim_revalidates_provenance_and_preserves_archive_wins() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "provider-local-id", "relay-id");

        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "provider-local-id",
                "provider-local-id",
                Some("native-rejected"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "different-relay-id",
                    agent_type: "codex",
                    agent_session_id: Some("native-before"),
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            None,
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM happy_provider_session_lifecycle",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0,
            "a rejected restoration cannot claim lifecycle ownership",
        );

        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "provider-local-id",
                "provider-local-id",
                Some("native-restored"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "relay-id",
                    agent_type: "codex",
                    agent_session_id: Some("native-before"),
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            Some(false),
        );
        assert_eq!(
            archive_happy_provider_session_in_db(&conn, "provider-local-id").unwrap(),
            Some("provider-local-id".to_string()),
        );
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "provider-local-id",
                "provider-local-id",
                Some("native-too-late"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "relay-id",
                    agent_type: "codex",
                    agent_session_id: Some("native-restored"),
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            Some(true),
        );
        assert_eq!(
            conn.query_row(
                "SELECT is_archived, agent_session_id
                 FROM conversations
                 WHERE id = 'provider-local-id'",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap(),
            (1, Some("native-restored".to_string())),
            "the archive fence wins and a late claim cannot install its native session id",
        );
    }

    #[test]
    fn restored_happy_claim_rejects_concurrent_agent_identity_changes() {
        let conn = open();
        insert_happy_restoration_candidate(&conn, "type-changed", "type-relay");
        conn.execute(
            "UPDATE conversations SET agent_type = 'claude' WHERE id = 'type-changed'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "type-changed",
                "type-changed",
                Some("native-after-spawn"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "type-relay",
                    agent_type: "codex",
                    agent_session_id: Some("native-before"),
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            None,
            "a provider-kind mutation after lookup must reject the claim",
        );

        insert_happy_restoration_candidate(&conn, "native-changed", "native-relay");
        conn.execute(
            "UPDATE conversations
             SET agent_session_id = 'native-concurrent'
             WHERE id = 'native-changed'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "native-changed",
                "native-changed",
                Some("native-after-spawn"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "native-relay",
                    agent_type: "codex",
                    agent_session_id: Some("native-before"),
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            None,
            "a native resume-id mutation after lookup must reject the claim",
        );

        insert_happy_restoration_candidate(&conn, "permission-changed", "permission-relay");
        conn.execute(
            "UPDATE conversations
             SET agent_permission_mode = 'ask'
             WHERE id = 'permission-changed'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "permission-changed",
                "permission-changed",
                Some("native-after-spawn"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "permission-relay",
                    agent_type: "codex",
                    agent_session_id: Some("native-before"),
                    agent_permission_mode: Some("bypassPermissions"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            None,
            "a permission-mode mutation after lookup must reject the claim",
        );

        insert_happy_restoration_candidate(&conn, "absence-changed", "absence-relay");
        conn.execute(
            "UPDATE conversations
             SET agent_session_id = 'native-concurrent'
             WHERE id = 'absence-changed'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "absence-changed",
                "absence-changed",
                Some("native-after-spawn"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "absence-relay",
                    agent_type: "codex",
                    agent_session_id: None,
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            None,
            "an expected-absent native id must not act as a wildcard",
        );

        insert_happy_restoration_candidate(&conn, "absence-stable", "stable-relay");
        conn.execute(
            "UPDATE conversations SET agent_session_id = NULL WHERE id = 'absence-stable'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_happy_provider_session_owner_with_provenance_in_db(
                &conn,
                "absence-stable",
                "absence-stable",
                Some("native-after-spawn"),
                Some(ExpectedHappyRestoration {
                    happy_session_id: "stable-relay",
                    agent_type: "codex",
                    agent_session_id: None,
                    agent_permission_mode: Some("saved-permission"),
                    agent_cwd: "/synthetic/consented",
                    project_root: "/synthetic/consented",
                }),
            )
            .unwrap(),
            Some(false),
            "a stable expected absence may install the spawned native id",
        );

        assert_eq!(
            conn.query_row(
                "SELECT agent_session_id FROM conversations WHERE id = 'native-changed'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            Some("native-concurrent".to_string()),
            "a rejected claim must not overwrite the concurrent native id",
        );
        assert_eq!(
            conn.query_row(
                "SELECT agent_session_id FROM conversations WHERE id = 'absence-stable'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap(),
            Some("native-after-spawn".to_string()),
        );
    }

    #[test]
    fn happy_archive_resolves_promoted_owner_and_derived_agent_rows() {
        let conn = open();
        conn.execute(
            "INSERT INTO conversations
                (id, title, created_at, kind, agent_session_id, agent_metadata)
             VALUES (?1, 'Promoted agent', 1000, 'chat', ?2, ?3)",
            params![
                "owning-conversation",
                "native-agent-session",
                r#"{"happy_session_id":"relay-session"}"#,
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, status, updated_at)
             VALUES (?1, 'codex', 'active', 2000)",
            params!["owning-conversation"],
        )
        .unwrap();

        let (owner, ambiguous) = lookup_agent_conversation_owner_in_db(
            &conn,
            "different-runtime-session",
            Some("native-agent-session"),
        )
        .unwrap();
        assert_eq!(owner.as_deref(), Some("owning-conversation"));
        assert!(!ambiguous);
        assert_eq!(
            lookup_happy_session_id_by_conversation_in_db(&conn, "owning-conversation")
                .unwrap()
                .as_deref(),
            Some("relay-session"),
        );
        assert!(archive_agent_conversation_in_db(&conn, "owning-conversation").unwrap());
        assert_eq!(
            conn.query_row(
                "SELECT is_archived FROM conversations WHERE id = ?1",
                params!["owning-conversation"],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1,
        );
        assert!(!archive_agent_conversation_in_db(&conn, "missing-conversation").unwrap());
    }

    #[test]
    fn native_session_id_updates_a_derived_agent_row() {
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind)
             VALUES ('derived-agent', 'Derived agent', 1000, 'chat')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, status, updated_at)
             VALUES ('derived-agent', 'codex', 'active', 2000)",
            [],
        )
        .unwrap();

        assert!(
            set_agent_conversation_session_id_in_db(&conn, "derived-agent", "native-session",)
                .unwrap(),
        );
        assert_eq!(
            conn.query_row(
                "SELECT agent_session_id FROM conversations WHERE id = 'derived-agent'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap()
            .as_deref(),
            Some("native-session"),
        );
    }

    #[test]
    fn provider_archive_fence_survives_late_create_and_promotion_claims() {
        let conn = open();

        assert_eq!(
            archive_happy_provider_session_in_db(&conn, "late-create").unwrap(),
            None,
        );
        assert!(is_happy_provider_session_archived_in_db(&conn, "late-create").unwrap());
        assert!(!is_happy_provider_session_archived_in_db(&conn, "not-archived").unwrap());
        let late = AgentConversation {
            id: "late-create".to_string(),
            title: "Late create".to_string(),
            created_at: 1000,
            agent_type: "codex".to_string(),
            agent_session_id: None,
            agent_cwd: None,
            agent_model_id: None,
            agent_permission_mode: None,
            agent_metadata: None,
            project_id: None,
            project_root: None,
            is_archived: false,
            privileged: false,
            counsel_direction: None,
        };
        assert!(upsert_agent_conversation_in_db(&conn, &late).unwrap());

        let promoted = AgentConversation {
            id: "promoted-owner".to_string(),
            title: "Promoted owner".to_string(),
            ..late.clone()
        };
        assert!(!upsert_agent_conversation_in_db(&conn, &promoted).unwrap());
        assert_eq!(
            archive_happy_provider_session_in_db(&conn, "promoted-provider").unwrap(),
            None,
        );
        assert!(
            claim_happy_provider_session_owner_in_db(
                &conn,
                "promoted-owner",
                "promoted-provider",
                Some("native-promoted"),
            )
            .unwrap(),
        );
        assert_eq!(
            lookup_agent_conversation_owner_in_db(&conn, "promoted-provider", None,).unwrap(),
            (Some("promoted-owner".to_string()), false),
        );
        assert_eq!(
            conn.query_row(
                "SELECT is_archived FROM conversations WHERE id = 'promoted-owner'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1,
        );

        let mapped = AgentConversation {
            id: "mapped-owner".to_string(),
            title: "Mapped owner".to_string(),
            ..late.clone()
        };
        assert!(!upsert_agent_conversation_in_db(&conn, &mapped).unwrap());
        assert!(
            !claim_happy_provider_session_owner_in_db(
                &conn,
                "mapped-owner",
                "mapped-provider",
                None,
            )
            .unwrap(),
        );
        assert_eq!(
            archive_happy_provider_session_in_db(&conn, "mapped-provider").unwrap(),
            Some("mapped-owner".to_string()),
        );

        let already_archived = AgentConversation {
            id: "already-archived-owner".to_string(),
            title: "Already archived owner".to_string(),
            ..late
        };
        assert!(!upsert_agent_conversation_in_db(&conn, &already_archived).unwrap());
        assert!(archive_agent_conversation_in_db(&conn, "already-archived-owner").unwrap());
        assert!(
            claim_happy_provider_session_owner_in_db(
                &conn,
                "already-archived-owner",
                "late-provider-claim",
                None,
            )
            .unwrap(),
        );
    }

    #[test]
    fn only_happy_origin_emits_frontend_archive_invalidation() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let received = Arc::new(AtomicUsize::new(0));
        let received_by_listener = Arc::clone(&received);
        let received_payload = Arc::new(Mutex::new(None));
        let received_payload_by_listener = Arc::clone(&received_payload);
        app.handle()
            .listen("happy-bridge://conversation-archived", move |event| {
                received_by_listener.fetch_add(1, Ordering::SeqCst);
                *received_payload_by_listener.lock().unwrap() =
                    serde_json::from_str::<serde_json::Value>(event.payload()).ok();
            });

        emit_happy_archive_event(
            app.handle(),
            AgentArchiveOrigin::Desktop,
            "desktop-conversation",
            None,
        );
        assert_eq!(received.load(Ordering::SeqCst), 0);
        emit_happy_archive_event(
            app.handle(),
            AgentArchiveOrigin::Happy,
            "happy-conversation",
            Some("happy-provider-session"),
        );
        assert_eq!(received.load(Ordering::SeqCst), 1);
        assert_eq!(
            *received_payload.lock().unwrap(),
            Some(serde_json::json!({
                "conversationId": "happy-conversation",
                "targetProviderSessionId": "happy-provider-session",
            })),
        );

        emit_happy_provider_archive_event(app.handle(), None, "unowned-provider-session");
        assert_eq!(received.load(Ordering::SeqCst), 2);
        assert_eq!(
            *received_payload.lock().unwrap(),
            Some(serde_json::json!({
                "conversationId": null,
                "targetProviderSessionId": "unowned-provider-session",
            })),
        );
    }

    #[test]
    fn late_agent_upsert_preserves_an_archived_row() {
        let conn = open();
        let mut conversation = AgentConversation {
            id: "late-resume".to_string(),
            title: "Synthetic agent".to_string(),
            created_at: 1000,
            agent_type: "codex".to_string(),
            agent_session_id: None,
            agent_cwd: Some("/synthetic/project".to_string()),
            agent_model_id: None,
            agent_permission_mode: None,
            agent_metadata: None,
            project_id: Some("/synthetic/project".to_string()),
            project_root: Some("/synthetic/project".to_string()),
            is_archived: false,
            privileged: false,
            counsel_direction: None,
        };

        assert!(!upsert_agent_conversation_in_db(&conn, &conversation).unwrap());
        assert!(archive_agent_conversation_in_db(&conn, &conversation.id).unwrap());

        conversation.agent_session_id = Some("late-provider-session".to_string());
        assert!(upsert_agent_conversation_in_db(&conn, &conversation).unwrap());
        assert_eq!(
            conn.query_row(
                "SELECT is_archived, agent_session_id FROM conversations WHERE id = ?1",
                params![conversation.id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap(),
            (1, Some("late-provider-session".to_string())),
        );
    }

    /// Mirror of the production `list_conversations` SQL so tests can
    /// drive every filter (derived kind, project_root, limit) without an
    /// AppHandle. Returns the (id, kind, agent_type) triplet for each
    /// row in created_at DESC.
    ///
    /// `project_root` here stands in for both the raw and normalized
    /// bindings - tests that care about raw-vs-normalized matching can
    /// drive the corresponding params directly via `list_for_test_full`.
    fn list_for_test(
        conn: &Connection,
        kind: Option<&str>,
    ) -> Vec<(String, String, Option<String>, Option<String>)> {
        list_for_test_full(conn, kind, None, None, None)
    }

    fn list_for_test_full(
        conn: &Connection,
        kind: Option<&str>,
        raw_project_root: Option<&str>,
        normalized_project_root: Option<&str>,
        limit: Option<i32>,
    ) -> Vec<(String, String, Option<String>, Option<String>)> {
        // Keep this SQL in lock-step with the production
        // `list_conversations` query so the test exercises the same
        // filter shape (kind + project_root + limit), not a relaxed
        // subset.
        let sql = format!(
            "WITH derived AS (
                SELECT c.id, c.created_at, c.kind, c.agent_type,
                       c.selected_provider, c.is_archived,
                       c.project_root, c.project_id, c.agent_cwd,
                       psr.provider AS runtime_provider,
                       {case} AS derived_kind
                FROM conversations c
                LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
            )
            SELECT id, derived_kind,
                   CASE WHEN derived_kind = 'agent'
                        THEN COALESCE(agent_type, runtime_provider)
                        ELSE agent_type END AS agent_type,
                   CASE WHEN derived_kind = 'chat'
                        THEN COALESCE(selected_provider, runtime_provider)
                        ELSE selected_provider END AS selected_provider
            FROM derived
            WHERE is_archived = 0
              AND (?1 IS NULL OR derived_kind = ?1)
              AND (
                (?2 IS NULL AND ?3 IS NULL)
                OR project_root = ?2 OR project_id = ?2 OR agent_cwd = ?2
                OR project_root = ?3 OR project_id = ?3 OR agent_cwd = ?3
                OR (derived_kind = 'chat' AND project_root IS NULL)
              )
            ORDER BY created_at DESC
            LIMIT ?4",
            case = DERIVED_KIND_CASE_SQL,
        );
        let effective_limit = limit.unwrap_or(-1);
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(
            params![
                kind,
                raw_project_root,
                normalized_project_root,
                effective_limit
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    #[test]
    fn derived_kind_follows_provider_binding_over_stored_kind() {
        // A row whose stored kind disagrees with the binding (e.g. a
        // mid-flight mirror write that hasn't landed yet) must report
        // the binding's kind, not the stored one.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('t1', 'Thread', 1000, 'chat', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, status, updated_at)
             VALUES ('t1', 'claude-code', 'active', 2000)",
            [],
        )
        .unwrap();

        let rows = list_for_test(&conn, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "agent");
        assert_eq!(rows[0].2.as_deref(), Some("claude-code"));
    }

    #[test]
    fn derived_kind_falls_back_to_stored_kind_without_a_binding() {
        // Legacy rows with no runtime binding row still need a kind for
        // routing - fall back to the stored column.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('legacy', 'Legacy', 1000, 'agent', 'claude-code')",
            [],
        )
        .unwrap();

        let rows = list_for_test(&conn, None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "agent");
    }

    #[test]
    fn kind_filter_drops_other_partition() {
        // The reader is the canonical list endpoint for both stores;
        // filtering by kind must give each store only its own rows.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('c1', 'Chat', 1000, 'chat', NULL),
                    ('a1', 'Agent', 2000, 'agent', 'codex')",
            [],
        )
        .unwrap();

        let chat_only = list_for_test(&conn, Some("chat"));
        assert_eq!(chat_only.len(), 1);
        assert_eq!(chat_only[0].0, "c1");

        let agent_only = list_for_test(&conn, Some("agent"));
        assert_eq!(agent_only.len(), 1);
        assert_eq!(agent_only[0].0, "a1");
    }

    #[test]
    fn project_root_matches_chat_project_root_and_agent_cwd_and_project_id() {
        // The unified reader is supposed to union the prior chat behavior
        // (match on `project_root`) with the prior agent behavior (match
        // on `project_id` OR `agent_cwd`). All three columns should pull
        // a row into the result for the same target project.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type,
                                        project_root, project_id, agent_cwd)
             VALUES ('chat-pr', 'Chat by project_root', 1000, 'chat', NULL,
                     '/tmp/proj', NULL, NULL),
                    ('agent-pid', 'Agent by project_id', 2000, 'agent', 'codex',
                     NULL, '/tmp/proj', NULL),
                    ('agent-cwd', 'Agent by agent_cwd', 3000, 'agent', 'codex',
                     NULL, NULL, '/tmp/proj'),
                    ('chat-null', 'Chat with NULL project', 4000, 'chat', NULL,
                     NULL, NULL, NULL),
                    ('chat-other', 'Chat in other project', 5000, 'chat', NULL,
                     '/tmp/other', NULL, NULL)",
            [],
        )
        .unwrap();

        let rows = list_for_test_full(&conn, None, Some("/tmp/proj"), None, None);
        let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        // chat-pr, agent-pid, agent-cwd match by the requested project.
        assert!(
            ids.contains(&"chat-pr"),
            "chat-pr should match by project_root"
        );
        assert!(
            ids.contains(&"agent-pid"),
            "agent-pid should match by project_id"
        );
        assert!(
            ids.contains(&"agent-cwd"),
            "agent-cwd should match by agent_cwd"
        );
        // chat-null is included because the chat bucket always surfaces
        // unscoped chat rows.
        assert!(
            ids.contains(&"chat-null"),
            "chat with NULL project_root should surface"
        );
        // chat-other is in a different project and must be excluded.
        assert!(
            !ids.contains(&"chat-other"),
            "chat in other project must be filtered out"
        );
    }

    #[test]
    fn project_root_filter_unions_raw_and_normalized_forms() {
        // The reader gets both the raw caller-supplied project_root and
        // a canonicalized form. A row that stored only the canonical
        // path must still match a caller that passed the raw form, and
        // vice versa.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, project_root)
             VALUES ('raw-row', 'Stored raw', 1000, 'chat', '~/projects/app'),
                    ('canon-row', 'Stored canon', 2000, 'chat', '/Users/me/projects/app')",
            [],
        )
        .unwrap();

        let rows = list_for_test_full(
            &conn,
            Some("chat"),
            Some("~/projects/app"),
            Some("/Users/me/projects/app"),
            None,
        );
        let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        // Both rows must surface: one matches via the raw param, the other
        // via the normalized param.
        assert!(ids.contains(&"raw-row"));
        assert!(ids.contains(&"canon-row"));
    }

    #[test]
    fn limit_negative_one_returns_all_rows() {
        // SQLite documents that a negative LIMIT means no upper bound.
        // The Rust command relies on that to map `Option::None` to "no
        // limit"; if the SQLite behavior ever changes, this test fails
        // loudly.
        let conn = open();
        for i in 0..5 {
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, kind)
                 VALUES (?1, 'Thread', ?2, 'chat')",
                params![format!("t{i}"), 1000 + i],
            )
            .unwrap();
        }

        let rows = list_for_test_full(&conn, None, None, None, Some(-1));
        assert_eq!(rows.len(), 5);
    }

    #[test]
    fn limit_caps_returned_rows_in_created_at_desc_order() {
        // Pin the order-then-limit behavior: with `limit = 2`, we want
        // the two most recent rows, not an arbitrary pair.
        let conn = open();
        for i in 0..5 {
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, kind)
                 VALUES (?1, 'Thread', ?2, 'chat')",
                params![format!("t{i}"), 1000 + i],
            )
            .unwrap();
        }

        let rows = list_for_test_full(&conn, None, None, None, Some(2));
        assert_eq!(rows.len(), 2);
        // t4 (created_at = 1004) and t3 (1003) - newest first.
        assert_eq!(rows[0].0, "t4");
        assert_eq!(rows[1].0, "t3");
    }

    #[test]
    fn binding_to_chat_provider_yields_chat_kind() {
        // A native-agent thread that was switched to a chat provider:
        // stored kind may have already been mirrored, but even if it
        // hasn't, the binding wins.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type)
             VALUES ('t1', 'Thread', 1000, 'agent', 'claude-code')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, status, updated_at)
             VALUES ('t1', 'seren', 'active', 2000)",
            [],
        )
        .unwrap();

        let rows = list_for_test(&conn, Some("chat"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "t1");
        assert_eq!(rows[0].3.as_deref(), Some("seren"));
    }

    #[test]
    fn archived_rows_are_excluded_regardless_of_derived_kind() {
        // The reader is the canonical sidebar source; archived rows must
        // never reach the sidebar even when their derived kind matches the
        // requested filter, and that applies to BOTH the binding-derived
        // path and the stored-kind fallback.
        let conn = open();
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, kind, agent_type, is_archived)
             VALUES ('chat-arch', 'Old Chat', 1000, 'chat', NULL, 1),
                    ('agent-arch-legacy', 'Old Agent', 1100, 'agent', 'codex', 1),
                    ('agent-arch-bound', 'Bound Agent', 1200, 'chat', NULL, 1),
                    ('chat-live', 'Live Chat', 1300, 'chat', NULL, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO provider_session_runtime
                (thread_id, provider, status, updated_at)
             VALUES ('agent-arch-bound', 'claude-code', 'active', 2000)",
            [],
        )
        .unwrap();

        let all_rows = list_for_test(&conn, None);
        let ids: Vec<&str> = all_rows.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(ids, vec!["chat-live"]);

        // Filtered reads honor is_archived = 0 too, so neither store sees
        // archived rows in its kind-scoped read.
        let agent_only = list_for_test(&conn, Some("agent"));
        assert!(agent_only.is_empty());
        let chat_only = list_for_test(&conn, Some("chat"));
        let chat_ids: Vec<&str> = chat_only.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(chat_ids, vec!["chat-live"]);
    }
}
