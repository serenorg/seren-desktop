// ABOUTME: Tauri commands for chat persistence and conversation management.
// ABOUTME: Handles CRUD operations for conversations and messages in SQLite.

use crate::services::database::init_db;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

const MAX_MESSAGES_PER_CONVERSATION: i32 = 1000;

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
    pub project_id: Option<String>,
    pub project_root: Option<String>,
    pub is_archived: bool,
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
    };

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, selected_model, selected_provider, project_root, is_archived, kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'chat')",
            params![id, title, created_at, selected_model, selected_provider, normalized_project_root],
        )?;
        Ok(())
    })
    .await?;

    Ok(conversation)
}

#[tauri::command]
pub async fn get_conversations(
    app: AppHandle,
    project_root: Option<String>,
) -> Result<Vec<Conversation>, String> {
    let normalized = project_root.as_deref().and_then(normalize_project_root);

    run_db(app, move |conn| {
        let rows = if let Some(ref root) = normalized {
            let mut stmt = conn.prepare(
                "SELECT id, title, created_at, selected_model, selected_provider, project_root, is_archived
                 FROM conversations
                 WHERE kind = 'chat' AND is_archived = 0
                   AND (project_root = ?1 OR project_root IS NULL)
                 ORDER BY created_at DESC",
            )?;
            stmt.query_map(params![root], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    selected_model: row.get(3)?,
                    selected_provider: row.get(4)?,
                    project_root: row.get(5)?,
                    is_archived: row.get::<_, i32>(6)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, title, created_at, selected_model, selected_provider, project_root, is_archived
                 FROM conversations
                 WHERE kind = 'chat' AND is_archived = 0
                 ORDER BY created_at DESC",
            )?;
            stmt.query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    selected_model: row.get(3)?,
                    selected_provider: row.get(4)?,
                    project_root: row.get(5)?,
                    is_archived: row.get::<_, i32>(6)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
        };

        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn get_conversation(app: AppHandle, id: String) -> Result<Option<Conversation>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, selected_model, selected_provider, project_root, is_archived
             FROM conversations
             WHERE id = ?1 AND kind = 'chat'",
        )?;

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
    run_db(app, move |conn| {
        if let Some(t) = title {
            conn.execute(
                "UPDATE conversations SET title = ?1 WHERE id = ?2",
                params![t, id],
            )?;
        }
        if let Some(m) = selected_model {
            conn.execute(
                "UPDATE conversations SET selected_model = ?1 WHERE id = ?2",
                params![m, id],
            )?;
        }
        if let Some(p) = selected_provider {
            conn.execute(
                "UPDATE conversations SET selected_provider = ?1 WHERE id = ?2",
                params![p, id],
            )?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn archive_conversation(app: AppHandle, id: String) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET is_archived = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    run_db(app, move |conn| {
        // Delete messages first (foreign key constraint)
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![id],
        )?;
        // Then delete the conversation
        conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    })
    .await
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
                project_id,
                project_root
            ) VALUES (?1, ?2, ?3, 0, 'agent', ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                is_archived = 0,
                agent_type = excluded.agent_type,
                agent_session_id = COALESCE(excluded.agent_session_id, conversations.agent_session_id),
                agent_cwd = COALESCE(conversations.agent_cwd, excluded.agent_cwd),
                project_id = COALESCE(conversations.project_id, excluded.project_id),
                project_root = COALESCE(conversations.project_root, excluded.project_root)",
            params![
                id,
                title,
                created_at,
                agent_type,
                agent_session_id,
                agent_cwd,
                project_id,
                normalized_project_root
            ],
        )?;
        Ok(())
    })
    .await?;

    Ok(convo)
}

#[tauri::command]
pub async fn get_agent_conversations(
    app: AppHandle,
    limit: i32,
    project_root: Option<String>,
) -> Result<Vec<AgentConversation>, String> {
    let normalized_project_root = project_root.as_deref().and_then(normalize_project_root);
    let raw_project_root = project_root;

    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, agent_type, agent_session_id, agent_cwd, agent_model_id, project_id, project_root, is_archived
             FROM conversations
             WHERE kind = 'agent' AND is_archived = 0
               AND ((?1 IS NULL AND ?2 IS NULL)
                    OR project_id = ?1
                    OR project_root = ?1
                    OR agent_cwd = ?1
                    OR project_id = ?2
                    OR project_root = ?2
                    OR agent_cwd = ?2)
             ORDER BY created_at DESC
             LIMIT ?3",
        )?;

        let rows = stmt
            .query_map(params![normalized_project_root, raw_project_root, limit], |row| {
                Ok(AgentConversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    agent_type: row.get(3)?,
                    agent_session_id: row.get(4)?,
                    agent_cwd: row.get(5)?,
                    agent_model_id: row.get(6)?,
                    project_id: row.get(7)?,
                    project_root: row.get(8)?,
                    is_archived: row.get::<_, i32>(9)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    })
    .await
}

#[tauri::command]
pub async fn get_agent_conversation(
    app: AppHandle,
    id: String,
) -> Result<Option<AgentConversation>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, agent_type, agent_session_id, agent_cwd, agent_model_id, project_id, project_root, is_archived
             FROM conversations
             WHERE id = ?1 AND kind = 'agent'",
        )?;

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
                    project_id: row.get(7)?,
                    project_root: row.get(8)?,
                    is_archived: row.get::<_, i32>(9)? != 0,
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
        Ok(())
    })
    .await
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
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn archive_agent_conversation(app: AppHandle, id: String) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "UPDATE conversations SET is_archived = 1 WHERE id = ?1 AND kind = 'agent'",
            params![id],
        )?;
        Ok(())
    })
    .await
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
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, conversation_id, role, content, model, timestamp, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, conversation_id, role, content, model, timestamp, metadata],
        )?;

        // Prune old messages only when count exceeds limit
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
            |row| row.get(0),
        )?;
        if count > MAX_MESSAGES_PER_CONVERSATION {
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                    SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
                )",
                params![conversation_id, MAX_MESSAGES_PER_CONVERSATION],
            )?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_messages(
    app: AppHandle,
    conversation_id: String,
    limit: i32,
) -> Result<Vec<StoredMessage>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, model, timestamp, metadata
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
    run_db(app, move |conn| {
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            params![conversation_id],
        )?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn clear_all_history(app: AppHandle) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute("DELETE FROM messages", [])?;
        conn.execute("DELETE FROM conversations", [])?;
        Ok(())
    })
    .await
}

// ============================================================================
// Helper
// ============================================================================

async fn run_db<T>(
    app: AppHandle,
    task: impl FnOnce(Connection) -> rusqlite::Result<T> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let conn = init_db(&app).map_err(|err| err.to_string())?;
        task(conn).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}
