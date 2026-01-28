// ABOUTME: Local vector storage for semantic code search using sqlite-vec.
// ABOUTME: Stores code embeddings locally for instant retrieval without network latency.

use rusqlite::{ffi::sqlite3_auto_extension, params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Once;
use tauri::{AppHandle, Manager};

/// Embedding dimension for text-embedding-3-small model.
pub const EMBEDDING_DIM: usize = 1536;

/// Ensure sqlite-vec is loaded only once.
static INIT_VEC: Once = Once::new();

/// Initialize sqlite-vec extension globally (call once at app startup).
pub fn init_sqlite_vec() {
    INIT_VEC.call_once(|| {
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
}

/// A code chunk with its embedding vector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeChunk {
    pub id: i64,
    pub file_path: String,
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    pub chunk_type: String,
    pub symbol_name: Option<String>,
    pub language: String,
    pub file_hash: String,
    pub indexed_at: i64,
}

/// A search result with similarity score.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub chunk: CodeChunk,
    pub distance: f32,
}

/// Get the path to the vector database for a project.
pub fn get_vector_db_path(app: &AppHandle, project_path: &str) -> PathBuf {
    // Create a unique db per project based on path hash
    let project_hash = format!("{:x}", md5_hash(project_path));
    app.path()
        .app_data_dir()
        .expect("app data dir")
        .join("indexes")
        .join(format!("{}.db", project_hash))
}

/// Simple hash function for project path.
fn md5_hash(input: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}

/// Initialize the vector database with required tables.
pub fn init_vector_db(app: &AppHandle, project_path: &str) -> Result<Connection> {
    // Ensure sqlite-vec extension is registered
    init_sqlite_vec();

    let path = get_vector_db_path(app, project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(&path)?;

    // Verify sqlite-vec is loaded
    let _version: String = conn.query_row("SELECT vec_version()", [], |row| row.get(0))?;

    // Create metadata table for code chunks
    conn.execute(
        "CREATE TABLE IF NOT EXISTS code_chunks (
            id INTEGER PRIMARY KEY,
            file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            content TEXT NOT NULL,
            chunk_type TEXT NOT NULL,
            symbol_name TEXT,
            language TEXT NOT NULL,
            file_hash TEXT NOT NULL,
            indexed_at INTEGER NOT NULL
        )",
        [],
    )?;

    // Create indexes
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_chunks_hash ON code_chunks(file_hash)",
        [],
    )?;

    // Create virtual table for vector embeddings
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS code_embeddings USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding float[{}]
            )",
            EMBEDDING_DIM
        ),
        [],
    )?;

    // Store project path for reference
    conn.execute(
        "CREATE TABLE IF NOT EXISTS index_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('project_path', ?1)",
        params![project_path],
    )?;

    Ok(conn)
}

/// Open an existing vector database connection.
pub fn open_vector_db(app: &AppHandle, project_path: &str) -> Result<Connection> {
    // Ensure sqlite-vec extension is registered
    init_sqlite_vec();

    let path = get_vector_db_path(app, project_path);
    if !path.exists() {
        return Err(rusqlite::Error::InvalidPath(path));
    }

    let conn = Connection::open(&path)?;

    Ok(conn)
}

/// Insert a code chunk with its embedding.
pub fn insert_chunk(
    conn: &Connection,
    file_path: &str,
    start_line: i32,
    end_line: i32,
    content: &str,
    chunk_type: &str,
    symbol_name: Option<&str>,
    language: &str,
    file_hash: &str,
    embedding: &[f32],
) -> Result<i64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Insert chunk metadata
    conn.execute(
        "INSERT INTO code_chunks (file_path, start_line, end_line, content, chunk_type, symbol_name, language, file_hash, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![file_path, start_line, end_line, content, chunk_type, symbol_name, language, file_hash, now],
    )?;

    let chunk_id = conn.last_insert_rowid();

    // Insert embedding vector
    let embedding_blob = embedding_to_blob(embedding);
    conn.execute(
        "INSERT INTO code_embeddings (chunk_id, embedding) VALUES (?1, ?2)",
        params![chunk_id, embedding_blob],
    )?;

    Ok(chunk_id)
}

/// Delete all chunks for a file (used before re-indexing).
pub fn delete_file_chunks(conn: &Connection, file_path: &str) -> Result<usize> {
    // Get chunk IDs first
    let mut stmt = conn.prepare("SELECT id FROM code_chunks WHERE file_path = ?1")?;
    let chunk_ids: Vec<i64> = stmt
        .query_map(params![file_path], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    // Delete embeddings
    for chunk_id in &chunk_ids {
        conn.execute(
            "DELETE FROM code_embeddings WHERE chunk_id = ?1",
            params![chunk_id],
        )?;
    }

    // Delete chunks
    let deleted = conn.execute("DELETE FROM code_chunks WHERE file_path = ?1", params![file_path])?;

    Ok(deleted)
}

/// Search for similar code chunks by embedding.
pub fn search_similar(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<SearchResult>> {
    let embedding_blob = embedding_to_blob(query_embedding);

    let mut stmt = conn.prepare(
        "SELECT
            c.id, c.file_path, c.start_line, c.end_line, c.content,
            c.chunk_type, c.symbol_name, c.language, c.file_hash, c.indexed_at,
            e.distance
         FROM code_embeddings e
         JOIN code_chunks c ON c.id = e.chunk_id
         WHERE e.embedding MATCH ?1
         ORDER BY e.distance
         LIMIT ?2",
    )?;

    let results = stmt
        .query_map(params![embedding_blob, limit as i64], |row| {
            Ok(SearchResult {
                chunk: CodeChunk {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    start_line: row.get(2)?,
                    end_line: row.get(3)?,
                    content: row.get(4)?,
                    chunk_type: row.get(5)?,
                    symbol_name: row.get(6)?,
                    language: row.get(7)?,
                    file_hash: row.get(8)?,
                    indexed_at: row.get(9)?,
                },
                distance: row.get(10)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Check if a file needs re-indexing by comparing hashes.
pub fn file_needs_reindex(conn: &Connection, file_path: &str, current_hash: &str) -> Result<bool> {
    let stored_hash: Option<String> = conn
        .query_row(
            "SELECT file_hash FROM code_chunks WHERE file_path = ?1 LIMIT 1",
            params![file_path],
            |row| row.get(0),
        )
        .ok();

    Ok(stored_hash.as_deref() != Some(current_hash))
}

/// Get index statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStats {
    pub total_chunks: i64,
    pub total_files: i64,
    pub last_indexed: Option<i64>,
}

pub fn get_index_stats(conn: &Connection) -> Result<IndexStats> {
    let total_chunks: i64 =
        conn.query_row("SELECT COUNT(*) FROM code_chunks", [], |row| row.get(0))?;

    let total_files: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT file_path) FROM code_chunks",
        [],
        |row| row.get(0),
    )?;

    let last_indexed: Option<i64> = conn
        .query_row(
            "SELECT MAX(indexed_at) FROM code_chunks",
            [],
            |row| row.get(0),
        )
        .ok();

    Ok(IndexStats {
        total_chunks,
        total_files,
        last_indexed,
    })
}

/// Convert f32 embedding to blob for storage.
fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_to_blob() {
        let embedding = vec![1.0, 2.0, 3.0];
        let blob = embedding_to_blob(&embedding);
        assert_eq!(blob.len(), 12); // 3 floats * 4 bytes each
    }

    #[test]
    fn test_md5_hash() {
        let hash1 = md5_hash("/path/to/project");
        let hash2 = md5_hash("/path/to/project");
        let hash3 = md5_hash("/different/path");
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }
}
