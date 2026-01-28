// ABOUTME: Tauri commands for semantic codebase indexing.
// ABOUTME: Exposes vector store operations to the frontend for code search.

use crate::services::indexer::{self, ChunkedFile, DiscoveredFile};
use crate::services::vector_store::{self, IndexStats, SearchResult, EMBEDDING_DIM};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

/// Initialize or get index for a project.
#[tauri::command]
pub fn init_project_index(app: AppHandle, project_path: String) -> Result<IndexStats, String> {
    let conn = vector_store::init_vector_db(&app, &project_path).map_err(|e| e.to_string())?;
    vector_store::get_index_stats(&conn).map_err(|e| e.to_string())
}

/// Get index statistics for a project.
#[tauri::command]
pub fn get_index_status(app: AppHandle, project_path: String) -> Result<IndexStats, String> {
    let conn = vector_store::open_vector_db(&app, &project_path).map_err(|e| e.to_string())?;
    vector_store::get_index_stats(&conn).map_err(|e| e.to_string())
}

/// Check if index exists for a project.
#[tauri::command]
pub fn has_project_index(app: AppHandle, project_path: String) -> bool {
    let path = vector_store::get_vector_db_path(&app, &project_path);
    path.exists()
}

/// Chunk metadata for indexing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkInput {
    pub file_path: String,
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    pub chunk_type: String,
    pub symbol_name: Option<String>,
    pub language: String,
    pub file_hash: String,
    pub embedding: Vec<f32>,
}

/// Insert a code chunk with its embedding.
#[tauri::command]
pub fn index_chunk(app: AppHandle, project_path: String, chunk: ChunkInput) -> Result<i64, String> {
    if chunk.embedding.len() != EMBEDDING_DIM {
        return Err(format!(
            "Embedding dimension mismatch: expected {}, got {}",
            EMBEDDING_DIM,
            chunk.embedding.len()
        ));
    }

    let conn = vector_store::open_vector_db(&app, &project_path).map_err(|e| e.to_string())?;

    vector_store::insert_chunk(
        &conn,
        &chunk.file_path,
        chunk.start_line,
        chunk.end_line,
        &chunk.content,
        &chunk.chunk_type,
        chunk.symbol_name.as_deref(),
        &chunk.language,
        &chunk.file_hash,
        &chunk.embedding,
    )
    .map_err(|e| e.to_string())
}

/// Batch insert multiple chunks.
#[tauri::command]
pub fn index_chunks(
    app: AppHandle,
    project_path: String,
    chunks: Vec<ChunkInput>,
) -> Result<Vec<i64>, String> {
    let conn = vector_store::open_vector_db(&app, &project_path).map_err(|e| e.to_string())?;

    let mut ids = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if chunk.embedding.len() != EMBEDDING_DIM {
            return Err(format!(
                "Embedding dimension mismatch for {}: expected {}, got {}",
                chunk.file_path,
                EMBEDDING_DIM,
                chunk.embedding.len()
            ));
        }

        let id = vector_store::insert_chunk(
            &conn,
            &chunk.file_path,
            chunk.start_line,
            chunk.end_line,
            &chunk.content,
            &chunk.chunk_type,
            chunk.symbol_name.as_deref(),
            &chunk.language,
            &chunk.file_hash,
            &chunk.embedding,
        )
        .map_err(|e| e.to_string())?;

        ids.push(id);
    }

    Ok(ids)
}

/// Delete all chunks for a file (before re-indexing).
#[tauri::command]
pub fn delete_file_index(
    app: AppHandle,
    project_path: String,
    file_path: String,
) -> Result<usize, String> {
    let conn = vector_store::open_vector_db(&app, &project_path).map_err(|e| e.to_string())?;
    vector_store::delete_file_chunks(&conn, &file_path).map_err(|e| e.to_string())
}

/// Check if a file needs re-indexing.
#[tauri::command]
pub fn file_needs_reindex(
    app: AppHandle,
    project_path: String,
    file_path: String,
    file_hash: String,
) -> Result<bool, String> {
    let conn = match vector_store::open_vector_db(&app, &project_path) {
        Ok(c) => c,
        Err(_) => return Ok(true), // No index = needs indexing
    };
    vector_store::file_needs_reindex(&conn, &file_path, &file_hash).map_err(|e| e.to_string())
}

/// Search for similar code chunks.
#[tauri::command]
pub fn search_codebase(
    app: AppHandle,
    project_path: String,
    query_embedding: Vec<f32>,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    if query_embedding.len() != EMBEDDING_DIM {
        return Err(format!(
            "Query embedding dimension mismatch: expected {}, got {}",
            EMBEDDING_DIM,
            query_embedding.len()
        ));
    }

    let conn = vector_store::open_vector_db(&app, &project_path).map_err(|e| e.to_string())?;
    vector_store::search_similar(&conn, &query_embedding, limit).map_err(|e| e.to_string())
}

/// Get the embedding dimension constant.
#[tauri::command]
pub fn get_embedding_dimension() -> usize {
    EMBEDDING_DIM
}

/// Discover all indexable files in a project directory.
#[tauri::command]
pub fn discover_project_files(project_path: String) -> Vec<DiscoveredFile> {
    indexer::discover_files(Path::new(&project_path))
}

/// Chunk a single file for indexing.
#[tauri::command]
pub fn chunk_file(file: DiscoveredFile) -> Result<ChunkedFile, String> {
    indexer::chunk_file(&file)
}

/// Estimate indexing work (chunk count and tokens) for discovered files.
#[tauri::command]
pub fn estimate_indexing(files: Vec<DiscoveredFile>) -> (usize, usize) {
    indexer::estimate_indexing_work(&files)
}

/// Compute content hash for change detection.
#[tauri::command]
pub fn compute_file_hash(content: String) -> String {
    indexer::compute_hash(&content)
}
