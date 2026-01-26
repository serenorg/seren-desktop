// ABOUTME: Tauri commands for chat persistence and conversation management.
// ABOUTME: Handles CRUD operations for conversations and messages in SQLite.

use crate::services::database::init_db;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MAX_MESSAGES_PER_CONVERSATION: i32 = 100;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub selected_model: Option<String>,
    pub selected_provider: Option<String>,
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
) -> Result<Conversation, String> {
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let conversation = Conversation {
        id: id.clone(),
        title: title.clone(),
        created_at,
        selected_model: selected_model.clone(),
        selected_provider: selected_provider.clone(),
        is_archived: false,
    };

    run_db(app, move |conn| {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at, selected_model, selected_provider, is_archived)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![id, title, created_at, selected_model, selected_provider],
        )?;
        Ok(())
    })
    .await?;

    Ok(conversation)
}

#[tauri::command]
pub async fn get_conversations(app: AppHandle) -> Result<Vec<Conversation>, String> {
    run_db(app, move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, selected_model, selected_provider, is_archived
             FROM conversations
             WHERE is_archived = 0
             ORDER BY created_at DESC",
        )?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    selected_model: row.get(3)?,
                    selected_provider: row.get(4)?,
                    is_archived: row.get::<_, i32>(5)? != 0,
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
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, selected_model, selected_provider, is_archived
             FROM conversations
             WHERE id = ?1",
        )?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    selected_model: row.get(3)?,
                    selected_provider: row.get(4)?,
                    is_archived: row.get::<_, i32>(5)? != 0,
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
) -> Result<(), String> {
    run_db(app, move |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO messages (id, conversation_id, role, content, model, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, conversation_id, role, content, model, timestamp],
        )?;

        // Prune old messages for this conversation
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND id NOT IN (
                SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY timestamp DESC LIMIT ?2
            )",
            params![conversation_id, MAX_MESSAGES_PER_CONVERSATION],
        )?;
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
            "SELECT id, conversation_id, role, content, model, timestamp
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let rows = stmt
            .query_map(
                params![conversation_id, limit.min(MAX_MESSAGES_PER_CONVERSATION)],
                |row| {
                    Ok(StoredMessage {
                        id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        role: row.get(2)?,
                        content: row.get(3)?,
                        model: row.get(4)?,
                        timestamp: row.get(5)?,
                    })
                },
            )?
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
