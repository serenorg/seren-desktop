// ABOUTME: Tauri commands for indexed chat/agent conversation history search.
// ABOUTME: Opens the local conversation index DB and maps search/backfill errors to strings.

use crate::commands::chat::run_db;
use crate::commands::provider_runtime::DERIVED_KIND_CASE_SQL;
use crate::services::conversation_index::{
    self, ConversationHit, IndexableMessage, SearchFilters, open_index_db,
};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::HashSet;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnembeddedConversationChunk {
    pub chunk_id: i64,
    pub text: String,
}

fn load_conversation_meta(
    conn: &rusqlite::Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<(Option<String>, bool)>> {
    conn.query_row(
        "SELECT title, is_archived FROM conversations WHERE id = ?1",
        params![conversation_id],
        |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
    )
    .optional()
}

#[tauri::command]
pub fn search_conversations_fts(
    app: AppHandle,
    query: String,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
) -> Result<Vec<ConversationHit>, String> {
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    conversation_index::search_fts(
        &conn,
        &query,
        &filters.unwrap_or_default(),
        limit.unwrap_or(20),
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn search_conversations(
    app: AppHandle,
    query_embedding: Vec<f32>,
    filters: Option<SearchFilters>,
    limit: Option<usize>,
) -> Result<Vec<ConversationHit>, String> {
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    conversation_index::search_semantic(
        &conn,
        &query_embedding,
        &filters.unwrap_or_default(),
        limit.unwrap_or(20),
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn index_conversation_embeddings(
    app: AppHandle,
    chunk_id: i64,
    embedding: Vec<f32>,
) -> Result<(), String> {
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    conversation_index::insert_embedding(&conn, chunk_id, &embedding)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn unembedded_conversation_chunks(
    app: AppHandle,
    limit: Option<usize>,
) -> Result<Vec<UnembeddedConversationChunk>, String> {
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    let rows = conversation_index::unembedded_chunk_batch(&conn, limit.unwrap_or(20))
        .map_err(|err| err.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(chunk_id, text)| UnembeddedConversationChunk { chunk_id, text })
        .collect())
}

#[tauri::command]
pub fn delete_conversation_index(app: AppHandle, conversation_id: String) -> Result<(), String> {
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    conversation_index::delete_conversation_chunks(&conn, &conversation_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn update_conversation_index_meta(
    app: AppHandle,
    conversation_id: String,
) -> Result<(), String> {
    let meta = run_db(app.clone(), {
        let id = conversation_id.clone();
        move |conn| load_conversation_meta(conn, &id)
    })
    .await?
    .ok_or_else(|| "conversation not found".to_string())?;
    let conn = open_index_db(&app).map_err(|err| err.to_string())?;
    conversation_index::update_conversation_meta(
        &conn,
        &conversation_id,
        meta.0.as_deref(),
        Some(meta.1),
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn backfill_conversation_fts(app: AppHandle) -> Result<usize, String> {
    let index_conn = open_index_db(&app).map_err(|err| err.to_string())?;
    let indexed = conversation_index::indexed_message_ids(&index_conn)
        .map_err(|err| err.to_string())?
        .into_iter()
        .collect::<HashSet<_>>();

    let messages = run_db(app.clone(), move |conn| {
        let sql = format!(
            "SELECT m.id, m.conversation_id, {case} AS derived_kind, m.role,
                    c.title,
                    CASE WHEN ({case}) = 'agent'
                         THEN COALESCE(c.agent_type, psr.provider)
                         ELSE c.agent_type END AS agent_type,
                    COALESCE(c.project_root, c.agent_cwd, c.project_id) AS project_root,
                    c.is_archived, m.timestamp, m.content
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             LEFT JOIN provider_session_runtime psr ON psr.thread_id = c.id
             ORDER BY m.timestamp ASC",
            case = DERIVED_KIND_CASE_SQL,
        );
        let mut stmt = conn.prepare(&sql)?;
        stmt.query_map([], |row| {
            Ok(IndexableMessage {
                message_id: row.get(0)?,
                conversation_id: row.get(1)?,
                kind: row.get(2)?,
                role: row.get(3)?,
                title: row.get(4)?,
                agent_type: row.get(5)?,
                project_root: row.get(6)?,
                is_archived: row.get::<_, i32>(7)? != 0,
                timestamp: row.get(8)?,
                content: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })
    .await?;

    let mut count = 0;
    for message in messages {
        if indexed.contains(&message.message_id) {
            continue;
        }
        conversation_index::reindex_message(&index_conn, &message)
            .map_err(|err| err.to_string())?;
        count += 1;
    }
    Ok(count)
}
