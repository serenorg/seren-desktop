// ABOUTME: Tauri commands for chat persistence and conversation management.
// ABOUTME: Handles CRUD operations for conversations and messages in SQLite.

use crate::commands::provider_runtime::DERIVED_KIND_CASE_SQL;
use crate::services::database::{
    DbPool, PersistedMessage, enqueue_sync_tombstone, init_db, mark_sync_upsert,
    save_message_record,
};
use crate::services::conversation_index::{self, IndexableMessage, open_index_db};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn load_indexable_message_meta(
    conn: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<(String, Option<String>, Option<String>, Option<String>, bool)>> {
    let sql = format!(
        "SELECT {case} AS derived_kind,
                c.title,
                CASE WHEN ({case}) = 'agent'
                     THEN COALESCE(c.agent_type, psr.provider)
                     ELSE c.agent_type END AS agent_type,
                COALESCE(c.project_root, c.agent_cwd, c.project_id) AS project_root,
                c.is_archived
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

fn clear_conversation_index_best_effort(app: &AppHandle) {
    match open_index_db(app).and_then(|conn| conversation_index::clear_all_chunks(&conn)) {
        Ok(_) => {}
        Err(err) => log::warn!(
            "[ConversationIndex] Failed to clear conversation index: {}",
            err
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
    let tx = conn.unchecked_transaction()?;
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
                       c.agent_metadata, c.project_id, psr.provider AS runtime_provider,
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
                   agent_permission_mode, agent_metadata, project_id
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
                    c.project_root, c.is_archived, c.employee_id
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
    run_db(app.clone(), move |conn| {
        delete_conversation_records(conn, &[id])?;
        Ok(())
    })
    .await?;
    delete_conversation_index_best_effort(&app, &index_id);
    Ok(())
}

#[tauri::command]
pub async fn delete_conversations_by_employee(
    app: AppHandle,
    employee_id: String,
) -> Result<i64, String> {
    let (deleted, conversation_ids) = run_db(app.clone(), move |conn| {
        let mut stmt = conn.prepare("SELECT id FROM conversations WHERE employee_id = ?1")?;
        let conversation_ids = stmt
            .query_map(params![employee_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let deleted = delete_conversation_records(conn, &conversation_ids)?;
        Ok((deleted as i64, conversation_ids))
    })
    .await?;
    for conversation_id in &conversation_ids {
        delete_conversation_index_best_effort(&app, conversation_id);
    }
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
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let normalized_project_root = project_root
        .as_deref()
        .and_then(normalize_project_root)
        .or_else(|| agent_cwd.as_deref().and_then(normalize_project_root));
    let project_id = normalized_project_root.clone();

    let convo = AgentConversation {
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
    };

    run_db(app, move |conn| {
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
            ) VALUES (?1, ?2, ?3, 0, 'agent', ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                is_archived = 0,
                agent_type = excluded.agent_type,
                agent_session_id = COALESCE(excluded.agent_session_id, conversations.agent_session_id),
                agent_cwd = COALESCE(conversations.agent_cwd, excluded.agent_cwd),
                agent_metadata = COALESCE(excluded.agent_metadata, conversations.agent_metadata),
                project_id = COALESCE(conversations.project_id, excluded.project_id),
                project_root = COALESCE(conversations.project_root, excluded.project_root)",
            params![
                id,
                title,
                created_at,
                agent_type,
                agent_session_id,
                agent_cwd,
                agent_metadata,
                project_id,
                normalized_project_root
            ],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;

    Ok(convo)
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
                    c.agent_metadata, c.project_id, c.project_root, c.is_archived
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
        conn.execute(
            "UPDATE conversations SET agent_session_id = ?1 WHERE id = ?2 AND kind = 'agent'",
            params![agent_session_id, id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await
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
    let index_id = id.clone();
    run_db(app.clone(), move |conn| {
        conn.execute(
            "UPDATE conversations SET is_archived = 1 WHERE id = ?1 AND kind = 'agent'",
            params![id],
        )?;
        mark_sync_upsert(conn, "conversations", &id)?;
        Ok(())
    })
    .await?;
    refresh_conversation_index_meta_best_effort(app, index_id, None, Some(true)).await;
    Ok(())
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
        Ok(meta.map(|(kind, title, agent_type, project_root, is_archived)| {
            IndexableMessage {
                message_id: message.id,
                conversation_id: message.conversation_id,
                kind,
                role: message.role,
                title,
                agent_type,
                project_root,
                is_archived,
                timestamp: message.timestamp,
                content: message.content,
            }
        }))
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
    use super::DERIVED_KIND_CASE_SQL;
    use crate::services::database::setup_schema;
    use rusqlite::{Connection, params};

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
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
