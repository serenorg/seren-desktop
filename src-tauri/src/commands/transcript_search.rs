// ABOUTME: Tauri commands for semantic transcript search over meeting embeddings.
// ABOUTME: Indexes pre-embedded chunks and runs KNN queries via the transcript vector DB.

use crate::services::transcript_vectors::{self, TranscriptHit, open_transcript_db};
use serde::Deserialize;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptChunkInput {
    pub seq_start: i64,
    pub seq_end: i64,
    pub text: String,
    pub embedding: Vec<f32>,
}

/// Re-index a meeting's transcript: replace its chunks with the supplied
/// pre-embedded chunks. Embeddings are generated on the frontend via seren-embed.
#[tauri::command]
pub fn index_meeting_transcript(
    app: AppHandle,
    meeting_id: String,
    chunks: Vec<TranscriptChunkInput>,
) -> Result<usize, String> {
    let conn = open_transcript_db(&app).map_err(|err| err.to_string())?;
    transcript_vectors::delete_meeting_chunks(&conn, &meeting_id)
        .map_err(|err| err.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    for chunk in &chunks {
        transcript_vectors::insert_transcript_chunk(
            &conn,
            &meeting_id,
            chunk.seq_start,
            chunk.seq_end,
            &chunk.text,
            &chunk.embedding,
            now,
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(chunks.len())
}

/// Semantic KNN search over indexed transcripts using a query embedding.
#[tauri::command]
pub fn search_transcripts(
    app: AppHandle,
    query_embedding: Vec<f32>,
    limit: Option<usize>,
) -> Result<Vec<TranscriptHit>, String> {
    let conn = open_transcript_db(&app).map_err(|err| err.to_string())?;
    transcript_vectors::search_transcript_chunks(&conn, &query_embedding, limit.unwrap_or(20))
        .map_err(|err| err.to_string())
}

/// Meeting ids that already have indexed transcript chunks (for backfill).
#[tauri::command]
pub fn indexed_transcript_meeting_ids(app: AppHandle) -> Result<Vec<String>, String> {
    let conn = open_transcript_db(&app).map_err(|err| err.to_string())?;
    transcript_vectors::indexed_meeting_ids(&conn).map_err(|err| err.to_string())
}

/// Drop a meeting's transcript index (called when a meeting is deleted).
#[tauri::command]
pub fn delete_meeting_transcript_index(
    app: AppHandle,
    meeting_id: String,
) -> Result<(), String> {
    let conn = open_transcript_db(&app).map_err(|err| err.to_string())?;
    transcript_vectors::delete_meeting_chunks(&conn, &meeting_id).map_err(|err| err.to_string())
}
