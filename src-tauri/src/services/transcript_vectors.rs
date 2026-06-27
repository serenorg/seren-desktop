// ABOUTME: Local vector storage for semantic transcript search using sqlite-vec.
// ABOUTME: Stores meeting transcript chunk embeddings in a dedicated index DB.

use crate::services::vector_store::{EMBEDDING_DIM, init_sqlite_vec};
use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A transcript search hit: a matched chunk's location, text, and distance.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub meeting_id: String,
    pub seq_start: i64,
    pub seq_end: i64,
    pub text: String,
    pub distance: f32,
}

fn transcript_db_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("indexes")
        .join("transcripts.db")
}

/// Create the transcript chunk + embedding tables on a connection that already
/// has the sqlite-vec extension loaded.
fn create_transcript_tables(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS transcript_chunks (
            id INTEGER PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            seq_start INTEGER NOT NULL,
            seq_end INTEGER NOT NULL,
            text TEXT NOT NULL,
            indexed_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_transcript_chunks_meeting
         ON transcript_chunks (meeting_id)",
        [],
    )?;
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS transcript_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding float[{EMBEDDING_DIM}]
            )"
        ),
        [],
    )?;
    Ok(())
}

/// Open (creating if needed) the transcript vector DB with sqlite-vec loaded.
pub fn open_transcript_db(app: &AppHandle) -> Result<Connection> {
    init_sqlite_vec();
    let path = transcript_db_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    // Match the managed DB's connection config (busy_timeout + WAL +
    // synchronous=NORMAL). Every index/search/delete command opens its own
    // connection, so without this, concurrent backfill vs. search vs. delete
    // hit "database is locked" — silently surfacing as "No matches".
    crate::services::database::configure_connection(&conn)?;
    create_transcript_tables(&conn)?;
    Ok(conn)
}

fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// Remove all indexed chunks for a meeting (before re-indexing or on delete).
pub fn delete_meeting_chunks(conn: &Connection, meeting_id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt =
            tx.prepare("SELECT id FROM transcript_chunks WHERE meeting_id = ?1")?;
        let ids: Vec<i64> = stmt
            .query_map(params![meeting_id], |row| row.get(0))?
            .filter_map(|row| row.ok())
            .collect();
        for id in ids {
            tx.execute(
                "DELETE FROM transcript_embeddings WHERE chunk_id = ?1",
                params![id],
            )?;
        }
    }
    tx.execute(
        "DELETE FROM transcript_chunks WHERE meeting_id = ?1",
        params![meeting_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Insert one transcript chunk and its embedding, returning the chunk id.
pub fn insert_transcript_chunk(
    conn: &Connection,
    meeting_id: &str,
    seq_start: i64,
    seq_end: i64,
    text: &str,
    embedding: &[f32],
    now: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO transcript_chunks (meeting_id, seq_start, seq_end, text, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![meeting_id, seq_start, seq_end, text, now],
    )?;
    let chunk_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO transcript_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
        params![chunk_id, embedding_to_blob(embedding)],
    )?;
    Ok(chunk_id)
}

/// K-nearest-neighbor search over indexed transcript chunks.
pub fn search_transcript_chunks(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<TranscriptHit>> {
    let mut stmt = conn.prepare(
        "SELECT c.meeting_id, c.seq_start, c.seq_end, c.text, e.distance
         FROM transcript_embeddings e
         JOIN transcript_chunks c ON c.id = e.chunk_id
         WHERE e.embedding MATCH ?1 AND k = ?2
         ORDER BY e.distance",
    )?;
    let hits = stmt
        .query_map(
            params![embedding_to_blob(query_embedding), limit as i64],
            |row| {
                Ok(TranscriptHit {
                    meeting_id: row.get(0)?,
                    seq_start: row.get(1)?,
                    seq_end: row.get(2)?,
                    text: row.get(3)?,
                    distance: row.get(4)?,
                })
            },
        )?
        .filter_map(|row| row.ok())
        .collect();
    Ok(hits)
}

/// Escape the LIKE metacharacters so a user query is matched literally.
fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Literal substring search over indexed transcript text. This works offline /
/// unauthenticated / when seren-embed is down, and surfaces exact names, emails,
/// and phrases that vector search ranks poorly. Returned hits carry distance 0.
pub fn search_transcript_chunks_like(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<TranscriptHit>> {
    let pattern = format!("%{}%", escape_like(query));
    let mut stmt = conn.prepare(
        "SELECT meeting_id, seq_start, seq_end, text
         FROM transcript_chunks
         WHERE text LIKE ?1 ESCAPE '\\'
         ORDER BY indexed_at DESC
         LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(params![pattern, limit as i64], |row| {
            Ok(TranscriptHit {
                meeting_id: row.get(0)?,
                seq_start: row.get(1)?,
                seq_end: row.get(2)?,
                text: row.get(3)?,
                distance: 0.0,
            })
        })?
        .filter_map(|row| row.ok())
        .collect();
    Ok(hits)
}

/// Meeting ids that already have indexed chunks (used to skip backfill work).
pub fn indexed_meeting_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT meeting_id FROM transcript_chunks")?;
    let ids = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|row| row.ok())
        .collect();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_vec(index: usize) -> Vec<f32> {
        let mut embedding = vec![0.0f32; EMBEDDING_DIM];
        embedding[index] = 1.0;
        embedding
    }

    #[test]
    fn search_ranks_nearest_chunk_first_and_delete_clears() {
        init_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        create_transcript_tables(&conn).unwrap();

        insert_transcript_chunk(&conn, "m1", 0, 2, "budget decision", &unit_vec(0), 1)
            .unwrap();
        insert_transcript_chunk(&conn, "m1", 3, 5, "weather chatter", &unit_vec(1), 1)
            .unwrap();

        // Query closest to the first chunk's direction.
        let mut query = vec![0.0f32; EMBEDDING_DIM];
        query[0] = 0.9;
        query[1] = 0.1;
        let hits = search_transcript_chunks(&conn, &query, 5).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].seq_start, 0);
        assert_eq!(hits[0].text, "budget decision");

        delete_meeting_chunks(&conn, "m1").unwrap();
        assert!(search_transcript_chunks(&conn, &query, 5).unwrap().is_empty());
        assert!(indexed_meeting_ids(&conn).unwrap().is_empty());
    }

    #[test]
    fn like_search_matches_literal_substrings_and_escapes_wildcards() {
        init_sqlite_vec();
        let conn = Connection::open_in_memory().unwrap();
        create_transcript_tables(&conn).unwrap();

        insert_transcript_chunk(&conn, "m1", 0, 2, "Me: email is bob@acme.io", &unit_vec(0), 1)
            .unwrap();
        insert_transcript_chunk(&conn, "m1", 3, 5, "Them: 50% off the budget", &unit_vec(1), 2)
            .unwrap();

        // Literal substring (case-insensitive via SQLite LIKE) hits one chunk.
        let hits = search_transcript_chunks_like(&conn, "bob@acme.io", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].seq_start, 0);
        assert_eq!(hits[0].distance, 0.0);

        // `%` is matched literally, not as a wildcard: "50%" matches, "xx" does not.
        assert_eq!(search_transcript_chunks_like(&conn, "50%", 10).unwrap().len(), 1);
        assert!(search_transcript_chunks_like(&conn, "%", 10)
            .unwrap()
            .iter()
            .all(|hit| hit.text.contains('%')));
        assert!(search_transcript_chunks_like(&conn, "nope", 10).unwrap().is_empty());
    }
}
