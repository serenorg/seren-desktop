// ABOUTME: Tauri commands for Seren Memory operations.
// ABOUTME: Exposes the full seren-memory MCP surface with local cache fallback for core recall/bootstrap paths.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use seren_memory_sdk::bootstrap::BootstrapOrchestrator;
use seren_memory_sdk::cache::LocalCache;
use seren_memory_sdk::client::MemoryClient;
use seren_memory_sdk::models::{CachedMemory, ContextSource, SessionContext};
use seren_memory_sdk::sync::SyncEngine;

const AUTH_STORE: &str = "auth.json";
// The memory service at memory.serendb.com authenticates via SerenDB API key,
// NOT the OAuth bearer token. Using "token" (the OAuth token) caused every
// cloud call to return HTTP 401, silently falling back to local-only cache.
// Same credential used by claude_memory.rs (fixed in #1511). Resolves #1540.
const TOKEN_KEY: &str = "seren_api_key";

pub const MEMORY_MCP_TOOLS: &[&str] = &[
    "session_bootstrap",
    "remember",
    "create_memory",
    "recall",
    "process_conversation",
    "learn_from_error",
    "list_memories",
    "get_memory",
    "update_memory",
    "forget",
    "delete_memory",
    "get_memory_graph",
    "consolidate",
    "configure_publishers",
];

/// Managed state for memory operations.
pub struct MemoryState {
    base_url: String,
    cache_path: PathBuf,
    cache: Mutex<Option<LocalCache>>,
}

impl MemoryState {
    pub fn new(base_url: String, cache_path: PathBuf) -> Self {
        Self {
            base_url,
            cache_path,
            cache: Mutex::new(None),
        }
    }

    /// Create a MemoryClient using the current token from the Tauri store.
    fn client(&self, app: &tauri::AppHandle) -> Result<MemoryClient, String> {
        use tauri_plugin_store::StoreExt;
        let token = app
            .store(AUTH_STORE)
            .map_err(|e| e.to_string())?
            .get(TOKEN_KEY)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();

        if token.is_empty() {
            return Err("unauthorized".to_string());
        }

        Ok(MemoryClient::new(self.base_url.clone(), token))
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

    async fn call_memory_tool(
        &self,
        app: &tauri::AppHandle,
        tool_name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        validate_memory_tool(tool_name)?;
        let client = self.client(app)?;
        let url = format!("{}/mcp", self.base_url);
        let rpc_request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments,
            }
        });

        let response = reqwest::Client::new()
            .post(&url)
            .bearer_auth(client.api_key())
            .header("Accept", "application/json, text/event-stream")
            .json(&rpc_request)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("unauthorized".to_string());
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("memory MCP call failed ({status}): {body}"));
        }

        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/event-stream"))
            .unwrap_or(false);
        let body = response.text().await.map_err(|e| e.to_string())?;
        let json_body = if is_sse {
            extract_sse_json(&body)?
        } else {
            body
        };
        let rpc_response: Value = serde_json::from_str(&json_body).map_err(|e| e.to_string())?;
        let parsed = parse_mcp_tool_result(rpc_response);
        if let Err(error) = &parsed {
            log::warn!("memory tool {tool_name} failed: {error}");
        }
        parsed
    }
}

fn validate_memory_tool(tool_name: &str) -> Result<(), String> {
    if MEMORY_MCP_TOOLS.contains(&tool_name) {
        Ok(())
    } else {
        Err(format!("unsupported memory operation: {tool_name}"))
    }
}

fn ensure_delete_confirmed(confirm: bool) -> Result<(), String> {
    if confirm {
        Ok(())
    } else {
        Err("Permanent memory delete requires confirmation".to_string())
    }
}

fn extract_sse_json(body: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for line in body.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            if data == "[DONE]" {
                break;
            }
            parts.push(data);
        } else if let Some(data) = line.strip_prefix("data:") {
            let trimmed = data.trim();
            if trimmed == "[DONE]" {
                break;
            }
            parts.push(trimmed);
        }
    }
    if parts.is_empty() {
        return Err("SSE response contained no data lines".to_string());
    }
    Ok(parts.join(""))
}

fn parse_mcp_tool_result(rpc_response: Value) -> Result<Value, String> {
    if let Some(error) = rpc_response.get("error") {
        return Err(error.to_string());
    }
    let result = rpc_response
        .get("result")
        .ok_or_else(|| "unexpected MCP response format".to_string())?;
    let text = result
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str);

    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(text
            .map(ToString::to_string)
            .unwrap_or_else(|| result.to_string()));
    }

    let text = text.ok_or_else(|| "unexpected MCP response format".to_string())?;

    match serde_json::from_str(text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(json!({ "message": text })),
    }
}

fn value_to_string(value: &Value) -> String {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| value.to_string())
}

fn insert_optional<T: Serialize>(args: &mut Value, key: &str, value: Option<T>) {
    if let Some(value) = value {
        args[key] = json!(value);
    }
}

/// Output type for bootstrap (serializable to frontend).
#[derive(Serialize)]
pub struct BootstrapResult {
    pub prompt: String,
    pub total_memories: usize,
    pub source: String,
}

#[derive(Serialize)]
pub struct MemoryRefOutput {
    pub id: String,
    pub content: String,
}

/// Full typed output for session_bootstrap with provenance-carrying memory refs.
#[derive(Serialize)]
pub struct SessionBootstrapOutput {
    pub prompt: String,
    pub total_memories: usize,
    pub source: String,
    pub memories_by_type: HashMap<String, Vec<MemoryRefOutput>>,
}

/// Output type for recall results (serializable to frontend).
#[derive(Serialize, Deserialize)]
pub struct RecallOutput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub memory_type: String,
    pub relevance_score: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bm25_score: Option<f64>,
}

/// Output type for sync results (serializable to frontend).
#[derive(Serialize)]
pub struct SyncOutput {
    pub pushed: usize,
    pub pulled: usize,
    pub errors: Vec<String>,
}

fn source_label(source: &ContextSource) -> &'static str {
    match source {
        ContextSource::Cloud => "cloud",
        ContextSource::LocalCache => "local_cache",
    }
}

fn session_output(ctx: SessionContext) -> SessionBootstrapOutput {
    SessionBootstrapOutput {
        prompt: ctx.assembled_prompt,
        total_memories: ctx.total_memories,
        source: source_label(&ctx.source).to_string(),
        memories_by_type: ctx
            .memories_by_type
            .into_iter()
            .map(|(memory_type, refs)| {
                (
                    memory_type,
                    refs.into_iter()
                        .map(|r| MemoryRefOutput {
                            id: r.id.to_string(),
                            content: r.content,
                        })
                        .collect(),
                )
            })
            .collect(),
    }
}

async fn build_session_context(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    project_id: Option<String>,
    org_id: Option<String>,
    token_budget: Option<usize>,
) -> Result<SessionContext, String> {
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());
    let org_uuid = org_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    state.ensure_cache()?;

    // LocalCache (rusqlite::Connection) is not Send, so run on a blocking thread
    // and use Handle::block_on() for async operations within it.
    let cache_path = state.cache_path.clone();
    let base_url = state.base_url.clone();
    let client = state.client(&app)?;
    let api_key = client.api_key().to_string();

    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let cache = LocalCache::open(&cache_path).map_err(|e| e.to_string())?;
        let client = MemoryClient::new(base_url, api_key);
        let orchestrator = BootstrapOrchestrator::new(cache, client);
        handle
            .block_on(orchestrator.bootstrap(project_uuid, org_uuid, token_budget))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Assemble project memory context for system prompt injection.
#[tauri::command]
pub async fn memory_bootstrap(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    project_id: Option<String>,
) -> Result<Option<String>, String> {
    let ctx = build_session_context(app, state, project_id, None, None).await?;

    if ctx.assembled_prompt.is_empty() {
        Ok(None)
    } else {
        Ok(Some(ctx.assembled_prompt))
    }
}

/// Assemble full typed session_bootstrap output for UI provenance.
#[tauri::command]
pub async fn memory_session_bootstrap(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    project_id: Option<String>,
    org_id: Option<String>,
    token_budget: Option<usize>,
) -> Result<SessionBootstrapOutput, String> {
    let ctx = build_session_context(app, state, project_id, org_id, token_budget).await?;
    Ok(session_output(ctx))
}

/// Store a memory via the cloud MCP remember tool.
#[tauri::command]
pub async fn memory_remember(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    content: String,
    memory_type: String,
    metadata: Option<Value>,
    pin: Option<bool>,
    project_id: Option<String>,
    session_id: Option<String>,
    org_id: Option<String>,
    skip_conflict_check: Option<bool>,
    skip_enrichment: Option<bool>,
) -> Result<String, String> {
    // Validate auth before writing anything.
    state.client(&app)?;

    // Write to local cache first (synced=false) so memory survives cloud failures
    // such as scale-to-zero cold starts. The sync engine will push pending entries later.
    let local_id = uuid::Uuid::new_v4();
    state.ensure_cache()?;
    let cached = CachedMemory {
        id: local_id,
        content: content.clone(),
        memory_type: memory_type.clone(),
        metadata: metadata.clone().unwrap_or_else(|| json!({})),
        embedding: vec![0.0; 1536],
        relevance_score: 1.0,
        created_at: seren_memory_sdk::chrono::Utc::now(),
        synced: false,
        cloud_id: None,
        feedback_signal: None,
        pinned: false,
    };
    {
        let guard = state.cache.lock().map_err(|e| e.to_string())?;
        if let Some(cache) = guard.as_ref() {
            cache.insert_memory(&cached).ok();
        }
    }

    // Attempt cloud sync (best-effort; service may be warming up from scale-to-zero).
    let mut args = json!({
        "content": content,
        "memory_type": memory_type,
    });
    insert_optional(&mut args, "metadata", metadata);
    insert_optional(&mut args, "pin", pin);
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "session_id", session_id);
    insert_optional(&mut args, "org_id", org_id);
    insert_optional(&mut args, "skip_conflict_check", skip_conflict_check);
    insert_optional(&mut args, "skip_enrichment", skip_enrichment);

    match state.call_memory_tool(&app, "remember", args).await {
        Ok(result) => Ok(value_to_string(&result)),
        Err(e) => {
            log::warn!("Cloud remember failed (local cache saved, will sync later): {e}");
            Ok(local_id.to_string())
        }
    }
}

/// Search memories via the cloud MCP recall tool.
#[tauri::command]
pub async fn memory_recall(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    query: String,
    project_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<RecallOutput>, String> {
    let project_uuid = project_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok());

    let client = state.client(&app)?;
    match client.recall(&query, project_uuid, limit).await {
        Ok(results) => Ok(results
            .into_iter()
            .map(|r| RecallOutput {
                id: (!r.id.is_nil()).then(|| r.id.to_string()),
                content: r.content,
                memory_type: r.memory_type,
                relevance_score: r.relevance_score,
                vector_score: r.vector_score,
                bm25_score: r.bm25_score,
            })
            .collect()),
        Err(e) => {
            log::warn!("Cloud recall failed, trying local cache: {e}");
            state.ensure_cache()?;
            let guard = state.cache.lock().map_err(|e| e.to_string())?;
            if let Some(cache) = guard.as_ref() {
                // No offline embedding source on the desktop, so hybrid_search
                // degrades to BM25-only — content-aware, unlike list_recent.
                let local = cache
                    .hybrid_search(&query, None, limit.unwrap_or(10))
                    .map_err(|e| e.to_string())?;
                Ok(local
                    .into_iter()
                    .map(|r| RecallOutput {
                        id: Some(r.memory.cloud_id.unwrap_or(r.memory.id).to_string()),
                        content: r.memory.content,
                        memory_type: r.memory.memory_type,
                        relevance_score: r.rrf_score,
                        vector_score: r.vector_score,
                        bm25_score: r.bm25_score,
                    })
                    .collect())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[tauri::command]
pub async fn memory_create_memory(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    content: String,
    memory_type: String,
    metadata: Option<Value>,
    project_id: Option<String>,
    session_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let mut args = json!({
        "content": content,
        "memory_type": memory_type,
    });
    insert_optional(&mut args, "metadata", metadata);
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "session_id", session_id);
    insert_optional(&mut args, "org_id", org_id);
    state.call_memory_tool(&app, "create_memory", args).await
}

#[tauri::command]
pub async fn memory_process_conversation(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    transcript: String,
    project_context: Option<String>,
    project_id: Option<String>,
    session_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let mut args = json!({ "transcript": transcript });
    insert_optional(&mut args, "project_context", project_context);
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "session_id", session_id);
    insert_optional(&mut args, "org_id", org_id);
    state
        .call_memory_tool(&app, "process_conversation", args)
        .await
}

#[tauri::command]
pub async fn memory_learn_from_error(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    error_content: String,
    fix_content: String,
    metadata: Option<Value>,
    project_id: Option<String>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let mut args = json!({
        "error_content": error_content,
        "fix_content": fix_content,
    });
    insert_optional(&mut args, "metadata", metadata);
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "org_id", org_id);
    state.call_memory_tool(&app, "learn_from_error", args).await
}

#[tauri::command]
pub async fn memory_list_memories(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_type: Option<String>,
    is_pinned: Option<bool>,
    is_consolidated: Option<bool>,
    project_id: Option<String>,
    session_id: Option<String>,
    org_id: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Value, String> {
    let mut args = json!({});
    insert_optional(&mut args, "memory_type", memory_type);
    insert_optional(&mut args, "is_pinned", is_pinned);
    insert_optional(&mut args, "is_consolidated", is_consolidated);
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "session_id", session_id);
    insert_optional(&mut args, "org_id", org_id);
    insert_optional(&mut args, "limit", limit);
    insert_optional(&mut args, "offset", offset);
    state.call_memory_tool(&app, "list_memories", args).await
}

#[tauri::command]
pub async fn memory_get_memory(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_id: String,
) -> Result<Value, String> {
    state
        .call_memory_tool(&app, "get_memory", json!({ "memory_id": memory_id }))
        .await
}

#[tauri::command]
pub async fn memory_update_memory(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_id: String,
    content: Option<String>,
    summary: Option<String>,
    metadata: Option<Value>,
    is_pinned: Option<bool>,
) -> Result<Value, String> {
    let mut args = json!({ "memory_id": memory_id });
    insert_optional(&mut args, "content", content);
    insert_optional(&mut args, "summary", summary);
    insert_optional(&mut args, "metadata", metadata);
    insert_optional(&mut args, "is_pinned", is_pinned);
    state.call_memory_tool(&app, "update_memory", args).await
}

#[tauri::command]
pub async fn memory_forget(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_id: String,
) -> Result<Value, String> {
    state
        .call_memory_tool(&app, "forget", json!({ "memory_id": memory_id }))
        .await
}

#[tauri::command]
pub async fn memory_delete_memory(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_id: String,
    confirm: bool,
) -> Result<Value, String> {
    ensure_delete_confirmed(confirm)?;
    state
        .call_memory_tool(&app, "delete_memory", json!({ "memory_id": memory_id }))
        .await
}

#[tauri::command]
pub async fn memory_get_memory_graph(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    memory_id: String,
    depth: Option<usize>,
) -> Result<Value, String> {
    let mut args = json!({ "memory_id": memory_id });
    insert_optional(&mut args, "depth", depth);
    state.call_memory_tool(&app, "get_memory_graph", args).await
}

#[tauri::command]
pub async fn memory_consolidate(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    project_id: Option<String>,
    older_than_days: Option<usize>,
    stale_age_days: Option<usize>,
    stale_max_relevance: Option<f64>,
    min_cluster_size: Option<usize>,
) -> Result<Value, String> {
    let mut args = json!({});
    insert_optional(&mut args, "project_id", project_id);
    insert_optional(&mut args, "older_than_days", older_than_days);
    insert_optional(&mut args, "stale_age_days", stale_age_days);
    insert_optional(&mut args, "stale_max_relevance", stale_max_relevance);
    insert_optional(&mut args, "min_cluster_size", min_cluster_size);
    state.call_memory_tool(&app, "consolidate", args).await
}

#[tauri::command]
pub async fn memory_configure_publishers(
    app: tauri::AppHandle,
    state: State<'_, MemoryState>,
    publishers: Vec<Value>,
    org_id: Option<String>,
) -> Result<Value, String> {
    let mut args = json!({ "publishers": publishers });
    insert_optional(&mut args, "org_id", org_id);
    state
        .call_memory_tool(&app, "configure_publishers", args)
        .await
}

/// Sync local cache with cloud (push pending, pull new).
#[tauri::command]
pub async fn memory_sync(
    app: tauri::AppHandle,
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
    let client = state.client(&app)?;
    let base_url = client.base_url().to_string();
    let api_key = client.api_key().to_string();

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_all_live_memory_mcp_tools() {
        assert_eq!(
            MEMORY_MCP_TOOLS,
            &[
                "session_bootstrap",
                "remember",
                "create_memory",
                "recall",
                "process_conversation",
                "learn_from_error",
                "list_memories",
                "get_memory",
                "update_memory",
                "forget",
                "delete_memory",
                "get_memory_graph",
                "consolidate",
                "configure_publishers",
            ]
        );
    }

    #[test]
    fn rejects_unsupported_memory_operation() {
        let err = validate_memory_tool("mark_feedback").unwrap_err();
        assert!(err.contains("unsupported memory operation"));
    }

    #[test]
    fn hard_delete_requires_confirmation() {
        assert!(ensure_delete_confirmed(true).is_ok());
        let err = ensure_delete_confirmed(false).unwrap_err();
        assert!(err.contains("requires confirmation"));
    }

    #[test]
    fn parses_json_tool_result_text() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "content": [{ "type": "text", "text": "{\"created_count\":2}" }]
            }
        });
        let parsed = parse_mcp_tool_result(response).unwrap();
        assert_eq!(parsed["created_count"], 2);
    }

    #[test]
    fn tool_error_result_is_err() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "isError": true,
                "content": [{ "type": "text", "text": "internal error" }]
            }
        });
        let error = parse_mcp_tool_result(response).unwrap_err();
        assert!(error.contains("internal error"));
    }

    #[test]
    fn extracts_sse_tool_response_json() {
        let body = "event: message\ndata: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\n";
        let extracted = extract_sse_json(body).unwrap();
        assert!(extracted.contains("\"result\""));
    }
}
