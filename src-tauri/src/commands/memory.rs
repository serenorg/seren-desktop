// ABOUTME: Tauri commands for memory operations via seren-memory-sdk.
// ABOUTME: Bootstrap, remember, recall, and sync with cloud and local cache.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use seren_memory_sdk::bootstrap::BootstrapOrchestrator;
use seren_memory_sdk::cache::LocalCache;
use seren_memory_sdk::client::MemoryClient;
use seren_memory_sdk::models::CachedMemory;
use seren_memory_sdk::sync::SyncEngine;

/// Managed state for memory operations.
pub struct MemoryState {
    client: MemoryClient,
    cache_path: PathBuf,
    cache: Mutex<Option<LocalCache>>,
}

impl MemoryState {
    pub fn new(base_url: String, api_key: String, cache_path: PathBuf) -> Self {
        Self {
            client: MemoryClient::new(base_url, api_key),
            cache_path,
            cache: Mutex::new(None),
        }
    }

    /// Get or initialize the local cache (lazy init).
    fn ensure_cache(&self) -> Result<(), String> {
        let mut guard = self.cache.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            if let Some(parent) = self.cache_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let cache = LocalCache::open(&self.cache_path).map_err(|e| e.to_string())?;
            *guard = Some(cache);
        }
        Ok(())
    }
}

/// Output type for bootstrap (serializable to frontend).
#[derive(Serialize)]
pub struct BootstrapResult {
    pub prompt: String,
    pub total_memories: usize,
    pub source: String,
}

/// Output type for recall results (serializable to frontend).
#[derive(Serialize, Deserialize)]
pub struct RecallOutput {
    pub content: String,
    pub memory_type: String,
    pub relevance_score: f64,
}

/// Output type for sync results (serializable to frontend).
#[derive(Serialize)]
pub struct SyncOutput {
    pub pushed: usize,
    pub pulled: usize,
    pub errors: Vec<String>,
}

/// Assemble project memory context for system prompt injection.
#[tauri::command]
pub async fn memory_bootstrap(
    state: State<'_, MemoryState>,
    project_id: Option<String>,
) -> Result<Option<String>, String> {
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    state.ensure_cache()?;

    // LocalCache (rusqlite::Connection) is not Send, so run on a blocking thread
    // and use Handle::block_on() for async operations within it.
    let cache_path = state.cache_path.clone();
    let base_url = state.client.base_url().to_string();
    let api_key = state.client.api_key().to_string();

    let handle = tokio::runtime::Handle::current();
    let ctx = tokio::task::spawn_blocking(move || {
        let cache = LocalCache::open(&cache_path).map_err(|e| e.to_string())?;
        let client = MemoryClient::new(base_url, api_key);
        let orchestrator = BootstrapOrchestrator::new(cache, client);
        handle
            .block_on(orchestrator.bootstrap(project_uuid, None, None))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    if ctx.assembled_prompt.is_empty() {
        Ok(None)
    } else {
        Ok(Some(ctx.assembled_prompt))
    }
}

/// Store a memory via the cloud MCP remember tool.
#[tauri::command]
pub async fn memory_remember(
    state: State<'_, MemoryState>,
    content: String,
    memory_type: String,
    project_id: Option<String>,
) -> Result<String, String> {
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    let result = state
        .client
        .remember(&content, &memory_type, project_uuid, None)
        .await
        .map_err(|e| e.to_string())?;

    // Also cache locally (with zero embedding — cloud has the real one).
    state.ensure_cache()?;
    let cached = CachedMemory {
        id: uuid::Uuid::new_v4(),
        content,
        memory_type,
        metadata: serde_json::json!({}),
        embedding: vec![0.0; 1536],
        relevance_score: 1.0,
        created_at: seren_memory_sdk::chrono::Utc::now(),
        synced: true,
        cloud_id: None,
    };

    let guard = state.cache.lock().map_err(|e| e.to_string())?;
    if let Some(cache) = guard.as_ref() {
        cache.insert_memory(&cached).ok();
    }

    Ok(result)
}

/// Search memories via the cloud MCP recall tool.
#[tauri::command]
pub async fn memory_recall(
    state: State<'_, MemoryState>,
    query: String,
    project_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<RecallOutput>, String> {
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    match state
        .client
        .recall(&query, project_uuid, limit)
        .await
    {
        Ok(results) => Ok(results
            .into_iter()
            .map(|r| RecallOutput {
                content: r.content,
                memory_type: r.memory_type,
                relevance_score: r.relevance_score,
            })
            .collect()),
        Err(e) => {
            // Offline fallback: search local cache.
            log::warn!("Cloud recall failed, trying local cache: {e}");
            state.ensure_cache()?;
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            if let Some(cache) = guard.as_ref() {
                // Use a zero query embedding for local fallback (returns by insertion order).
                let local = cache
                    .list_recent(limit.unwrap_or(10))
                    .map_err(|e| e.to_string())?;
                Ok(local
                    .into_iter()
                    .map(|m| RecallOutput {
                        content: m.content,
                        memory_type: m.memory_type,
                        relevance_score: m.relevance_score,
                    })
                    .collect())
            } else {
                Err(e.to_string())
            }
        }
    }
}

/// Sync local cache with cloud (push pending, pull new).
#[tauri::command]
pub async fn memory_sync(
    state: State<'_, MemoryState>,
    user_id: Option<String>,
    project_id: Option<String>,
) -> Result<SyncOutput, String> {
    let user_uuid = user_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .unwrap_or_else(uuid::Uuid::new_v4);
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    // LocalCache (rusqlite::Connection) is not Send, so run on a blocking thread.
    let cache_path = state.cache_path.clone();
    let base_url = state.client.base_url().to_string();
    let api_key = state.client.api_key().to_string();

    let handle = tokio::runtime::Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        let cache = LocalCache::open(&cache_path).map_err(|e| e.to_string())?;
        let client = MemoryClient::new(base_url, api_key);
        let engine = SyncEngine::new(cache, client);
        handle
            .block_on(engine.sync(user_uuid, project_uuid))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(SyncOutput {
        pushed: result.pushed,
        pulled: result.pulled,
        errors: result.errors,
    })
}
