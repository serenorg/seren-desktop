// ABOUTME: File discovery and indexing orchestration service.
// ABOUTME: Walks project directories and coordinates chunking for semantic indexing.

use crate::services::chunker;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// Maximum file size to index (10MB)
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Files to ignore during discovery
const IGNORE_PATTERNS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "venv",
    ".venv",
    "env",
    ".env",
    ".idea",
    ".vscode",
    ".DS_Store",
    "Thumbs.db",
    "*.min.js",
    "*.min.css",
    "*.map",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
];

/// A discovered file ready for indexing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredFile {
    pub path: String,
    pub relative_path: String,
    pub language: String,
    pub size: u64,
    pub hash: String,
}

/// A file with its chunks ready for embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkedFile {
    pub file: DiscoveredFile,
    pub chunks: Vec<FileChunk>,
}

/// A chunk with file context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChunk {
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    pub chunk_type: String,
    pub symbol_name: Option<String>,
}

/// Discover all indexable files in a project directory.
pub fn discover_files(project_path: &Path) -> Vec<DiscoveredFile> {
    let mut files = Vec::new();
    discover_files_recursive(project_path, project_path, &mut files);
    files
}

fn discover_files_recursive(root: &Path, current: &Path, files: &mut Vec<DiscoveredFile>) {
    let entries = match fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Check ignore patterns
        if should_ignore(file_name) {
            continue;
        }

        if path.is_dir() {
            discover_files_recursive(root, &path, files);
        } else if path.is_file() {
            // Check if file is indexable
            if !chunker::is_indexable_file(&path) {
                continue;
            }

            // Check file size
            let metadata = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.len() > MAX_FILE_SIZE {
                continue;
            }

            // Get language
            let language = match chunker::detect_language(&path) {
                Some(l) => l,
                None => continue,
            };

            // Calculate content hash
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue, // Skip binary or unreadable files
            };
            let hash = compute_hash(&content);

            // Get relative path
            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            files.push(DiscoveredFile {
                path: path.to_string_lossy().to_string(),
                relative_path,
                language,
                size: metadata.len(),
                hash,
            });
        }
    }
}

fn should_ignore(name: &str) -> bool {
    for pattern in IGNORE_PATTERNS {
        if pattern.starts_with('*') {
            // Wildcard pattern like "*.min.js"
            let suffix = &pattern[1..];
            if name.ends_with(suffix) {
                return true;
            }
        } else if name == *pattern {
            return true;
        }
    }
    false
}

/// Compute a hash of file content for change detection.
pub fn compute_hash(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Chunk a file and prepare it for indexing.
pub fn chunk_file(file: &DiscoveredFile) -> Result<ChunkedFile, String> {
    let content = fs::read_to_string(&file.path)
        .map_err(|e| format!("Failed to read file {}: {}", file.path, e))?;

    let chunks = chunker::chunk_file(&content, &file.language);

    let file_chunks: Vec<FileChunk> = chunks
        .into_iter()
        .map(|c| FileChunk {
            start_line: c.start_line,
            end_line: c.end_line,
            content: c.content,
            chunk_type: c.chunk_type.to_string(),
            symbol_name: c.symbol_name,
        })
        .collect();

    Ok(ChunkedFile {
        file: file.clone(),
        chunks: file_chunks,
    })
}

/// Get total chunk count and estimated tokens for discovered files.
pub fn estimate_indexing_work(files: &[DiscoveredFile]) -> (usize, usize) {
    let mut total_chunks = 0;
    let mut total_tokens = 0;

    for file in files {
        if let Ok(chunked) = chunk_file(file) {
            total_chunks += chunked.chunks.len();
            for chunk in &chunked.chunks {
                // Rough estimate: 4 chars per token
                total_tokens += chunk.content.len() / 4;
            }
        }
    }

    (total_chunks, total_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_ignore() {
        assert!(should_ignore("node_modules"));
        assert!(should_ignore(".git"));
        assert!(should_ignore("foo.min.js"));
        assert!(!should_ignore("main.rs"));
        assert!(!should_ignore("index.ts"));
    }

    #[test]
    fn test_compute_hash() {
        let hash1 = compute_hash("hello world");
        let hash2 = compute_hash("hello world");
        let hash3 = compute_hash("different content");
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }
}
