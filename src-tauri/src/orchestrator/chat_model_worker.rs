// ABOUTME: Chat model worker adapter that calls the Seren Gateway API.
// ABOUTME: Streams SSE responses with tool execution loop for function calling.

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::StreamExt;
use log;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, mpsc};

use super::tool_bridge::ToolResultBridge;
use super::tool_relevance;
use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};
use super::worker::Worker;

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const DEFAULT_PUBLISHER_SLUG: &str = "seren-models";

/// Maximum number of tool execution rounds before forcing completion.
/// Context window limits and cost naturally cap long sessions.
const MAX_TOOL_ROUNDS: usize = 100;

/// Connect timeout for the HTTP client (seconds).
const CONNECT_TIMEOUT_SECS: u64 = 30;

/// Overall request timeout for Gateway API calls (10 minutes).
/// Allows for long-running agent requests with multiple tool execution rounds.
const REQUEST_TIMEOUT_SECS: u64 = 600;

/// Maximum size (in bytes) of a single tool result when appended to the LLM
/// conversation context.  Results larger than this are truncated to prevent the
/// accumulated messages payload from growing large enough to cause upstream
/// Gateway / provider timeouts (HTTP 408).
///
/// This does NOT affect the user-facing display — full results are still emitted
/// via `WorkerEvent::ToolResult`.
const MAX_TOOL_RESULT_CONTEXT_BYTES: usize = 30_000;

/// Tone and behavior rules injected into every chat system prompt.
///
/// Kept here as a single source of truth for the Rust orchestrator path.
/// The JS direct-provider path (src/services/chat.ts TONE_INSTRUCTIONS)
/// carries a matching copy — update both when changing this block.
pub(crate) const TONE_INSTRUCTIONS: &str = "Tone and behavior:\n\
    - Be concise. Lead with the answer, not preamble.\n\
    - Never open with \"Great question,\" \"Excellent,\" \"Perfect,\" or \"You're absolutely right.\"\n\
    - Do not use emojis unless the user uses them first.\n\
    - Push back honestly on bad ideas. The user wants candor, not validation.\n\
    - Never claim a tool or capability is unavailable without first checking your actual tool list. \
    If the tool list is empty or still loading, say so — do not assert the capability does not exist.";

// =============================================================================
// Live Repo Context
// =============================================================================

/// Gather lightweight git/project context for a directory.
/// Returns a short string for system prompt injection, or empty if not a git repo.
fn gather_repo_context(project_root: &str) -> String {
    let root = std::path::Path::new(project_root);
    if !root.join(".git").exists() {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    // Current branch
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
    {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() {
            parts.push(format!("Branch: {}", branch));
        }
    }

    // Dirty file count
    if let Ok(output) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .output()
    {
        let status = String::from_utf8_lossy(&output.stdout);
        let dirty_count = status.lines().filter(|l| !l.is_empty()).count();
        if dirty_count > 0 {
            parts.push(format!("Uncommitted changes: {} files", dirty_count));
        } else {
            parts.push("Working tree: clean".to_string());
        }
    }

    // Recent commits (last 5)
    if let Ok(output) = std::process::Command::new("git")
        .args(["log", "--oneline", "-5"])
        .current_dir(root)
        .output()
    {
        let log = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !log.is_empty() {
            parts.push(format!("Recent commits:\n{}", log));
        }
    }

    if parts.is_empty() {
        return String::new();
    }

    format!("Project: {}\n{}", project_root, parts.join("\n"))
}

// =============================================================================
// Types for SSE Parsing and Tool Execution
// =============================================================================

/// A tool call accumulated across SSE streaming chunks.
#[derive(Debug, Clone)]
struct AccumulatedToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Raw tool call chunk from a single SSE event.
#[derive(Debug, Clone)]
struct ToolCallChunk {
    index: usize,
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// Result of parsing a single SSE data line.
struct ParseResult {
    events: Vec<WorkerEvent>,
    cost: Option<f64>,
    tool_call_chunks: Vec<ToolCallChunk>,
    finish_reason: Option<String>,
}

/// Outcome of streaming an API response.
#[derive(Debug)]
#[allow(dead_code)]
enum StreamOutcome {
    /// Model finished naturally (finish_reason: "stop" or stream ended).
    Complete {
        final_content: String,
        thinking: Option<String>,
        cost: f64,
    },
    /// Model wants tool results before continuing (finish_reason: "tool_calls").
    ToolCallsPending {
        tool_calls: Vec<AccumulatedToolCall>,
        accumulated_content: String,
        accumulated_thinking: String,
        accumulated_cost: f64,
    },
    /// Stream terminated with an upstream error (HTTP 4xx/5xx wrapped by the
    /// gateway). The error event has already been forwarded to the UI; this
    /// variant lets the orchestrator distinguish failure from empty completion
    /// so it does not lie about the conversation being completed successfully.
    Failed {
        error: String,
        cost: f64,
        retryable: bool,
    },
}

/// Decide whether a gateway HTTP status indicates a transient failure that
/// the orchestrator could safely retry. Treats all 5xx as retryable plus the
/// canonical retryable 4xx codes (408 Request Timeout, 429 Too Many Requests).
/// Permanent client errors (400, 401, 403, 404, 422, etc.) are not retryable.
fn gateway_status_is_retryable(status: u64) -> bool {
    matches!(status, 408 | 429) || (500..600).contains(&status)
}

/// Extract unique publisher names from tool calls in recent conversation messages.
/// Scans assistant messages for `tool_calls[].function.name` and extracts publisher
/// names using the `mcp__<publisher>__` / `gateway__<publisher>__` convention.
fn extract_recent_publishers(conversation_context: &[serde_json::Value]) -> Vec<String> {
    let mut publishers = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for msg in conversation_context.iter().rev() {
        if msg.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            for tc in tool_calls {
                if let Some(name) = tc.pointer("/function/name").and_then(|v| v.as_str()) {
                    if let Some(publisher) = tool_relevance::extract_mcp_publisher(name) {
                        if seen.insert(publisher.to_string()) {
                            publishers.push(publisher.to_string());
                        }
                    }
                }
            }
        }
    }
    publishers
}

fn summarize_gateway_error(status: reqwest::StatusCode, body_text: &str) -> String {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return format!("Gateway returned HTTP {}", status);
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("message").and_then(|v| v.as_str()))
            .or_else(|| value.get("error").and_then(|v| v.as_str()))
        {
            return format!("Gateway returned HTTP {}: {}", status, message);
        }
    }

    format!(
        "Gateway returned HTTP {}: {}",
        status,
        &trimmed[..trimmed.floor_char_boundary(200)]
    )
}

// =============================================================================
// ChatModelWorker
// =============================================================================

/// Chat model worker that routes through the Seren Gateway API.
pub struct ChatModelWorker {
    client: reqwest::Client,
    /// Cancellation flag shared with the streaming loop.
    cancelled: Arc<Mutex<bool>>,
    publisher_slug: String,
    /// OpenAI-format tool definitions passed to the LLM for function calling.
    tool_definitions: Vec<serde_json::Value>,
}

impl ChatModelWorker {
    #[cfg(test)]
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .unwrap_or_default(),
            cancelled: Arc::new(Mutex::new(false)),
            publisher_slug: DEFAULT_PUBLISHER_SLUG.to_string(),
            tool_definitions: Vec::new(),
        }
    }

    /// Create a worker with tool definitions for function calling.
    pub fn with_tools(tools: Vec<serde_json::Value>, publisher_slug: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            cancelled: Arc::new(Mutex::new(false)),
            publisher_slug: publisher_slug
                .unwrap_or_else(|| DEFAULT_PUBLISHER_SLUG.to_string()),
            tool_definitions: Self::inject_local_tool_definitions(tools),
        }
    }

    /// Prepend tool definitions for local builtins that the frontend catalog
    /// does not ship. Today that's just `write_pdf_from_html` (GH #1585) —
    /// a native atomic HTML→PDF renderer that replaces the previous
    /// "write HTML intermediate, then shell-out to convert" pattern and its
    /// orphan-file failure mode.
    ///
    /// Definitions are pushed to the front so they are visible to tool-
    /// relevance ranking even when the gateway catalog is full.
    fn inject_local_tool_definitions(
        existing: Vec<serde_json::Value>,
    ) -> Vec<serde_json::Value> {
        let write_pdf = serde_json::json!({
            "type": "function",
            "function": {
                "name": "write_pdf_from_html",
                "description": "Render the given HTML as a PDF and write it atomically to `path`. \
Prefer this tool over `write_file` + a separate conversion step whenever the \
user asks for PDF output — it uses one tool round, leaves no HTML intermediate \
on disk, and fails cleanly if conversion is not possible. `path` may start \
with `~/` to refer to the user's home directory. Parent directories are \
created if missing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or ~/-relative output path ending in .pdf, e.g. '~/Downloads/invoice.pdf'."
                        },
                        "html": {
                            "type": "string",
                            "description": "Complete, self-contained HTML document (should begin with <!DOCTYPE html>). Inline all CSS; external assets are not fetched."
                        }
                    },
                    "required": ["path", "html"]
                }
            }
        });
        let mut out = Vec::with_capacity(existing.len() + 1);
        // Only inject if the catalog doesn't already define it (avoid dup).
        let already_present = existing.iter().any(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                == Some("write_pdf_from_html")
        });
        if !already_present {
            out.push(write_pdf);
        }
        out.extend(existing);
        out
    }

    /// Build a tool publisher inventory from the actual tools being sent.
    ///
    /// Extracts publisher names from gateway/MCP tool naming conventions and
    /// produces a system prompt section that tells the model exactly which
    /// services it has access to. This prevents the model from denying access
    /// to tools that are in its function definitions but not mentioned in the
    /// Active Skills section.
    fn build_tool_inventory(tools: &[serde_json::Value]) -> String {
        let mut publisher_tools: HashMap<String, Vec<String>> = HashMap::new();
        let mut local_tools: Vec<String> = Vec::new();

        for tool in tools {
            let name = match tool.pointer("/function/name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => continue,
            };
            if let Some(publisher) = tool_relevance::extract_mcp_publisher(name) {
                publisher_tools
                    .entry(publisher.to_string())
                    .or_default()
                    .push(name.to_string());
            } else {
                local_tools.push(name.to_string());
            }
        }

        if publisher_tools.is_empty() && local_tools.is_empty() {
            return String::new();
        }

        let mut lines = vec![
            "# Available Tools".to_string(),
            String::new(),
            "You have access to ALL tools listed in your function definitions. \
             Always check your available tools before saying you cannot perform an action."
                .to_string(),
            String::new(),
        ];

        if !publisher_tools.is_empty() {
            lines.push("## Connected Services".to_string());
            lines.push(String::new());

            // Sort for deterministic output.
            let mut publishers: Vec<_> = publisher_tools.iter().collect();
            publishers.sort_by_key(|(name, _)| (*name).clone());

            for (publisher, tools) in &publishers {
                lines.push(format!("- **{}** ({} tools)", publisher, tools.len()));
            }
            lines.push(String::new());
        }

        if !local_tools.is_empty() {
            lines.push(format!(
                "## Local Tools\n\n{} core tools: {}",
                local_tools.len(),
                local_tools.join(", ")
            ));
            lines.push(String::new());
        }

        lines.join("\n")
    }

    /// Build the request body for the Gateway API.
    fn build_request_body(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        tools: &[serde_json::Value],
        images: &[ImageAttachment],
        project_root: Option<&str>,
    ) -> serde_json::Value {
        let mut messages: Vec<serde_json::Value> = Vec::new();

        // System prompt: base + repo context + tool inventory + skill content.
        // The tool inventory ensures the model knows about ALL connected services,
        // not just the skills matched by the classifier.
        let tool_inventory = Self::build_tool_inventory(tools);
        // Pin the current UTC date as the very first line of the system prompt
        // so document-generation tasks (invoices, reports) stamp a correct date
        // even when history has been trimmed by RLM. The system prompt itself
        // is never trimmed, so this context cannot be dropped.
        let today_utc = seren_memory_sdk::chrono::Utc::now()
            .format("%Y-%m-%d")
            .to_string();
        let mut system_parts = vec![
            format!(
                "Current date (UTC): {}. Use this date for any timestamp, \
                 invoice date, report date, or other dated artifact unless \
                 the user explicitly supplies a different date.",
                today_utc
            ),
            "You are a helpful AI assistant running inside Seren Desktop. \
             The user is already authenticated and all tool calls are pre-authenticated \
             through the Seren Gateway — you do not need API keys, tokens, or environment \
             variables to use any of your tools. Never ask the user to configure credentials \
             or look for keys like SEREN_API_KEY. Just call the tools directly."
                .to_string(),
            // File output rules (GH #1583, #1585) — tell the model how to
            // hit the user's requested path and format in one tool round.
            "File output rules:\n\
             • Paths starting with '~/' are expanded to the user's home directory. \
             Pass them through as-is — do not rewrite to an absolute path.\n\
             • When the user asks for a PDF, use the `write_pdf_from_html` tool \
             to produce the file in one step. Do NOT write an HTML file first \
             and then convert it — that leaves an orphan intermediate on disk \
             and costs extra rounds. Build a complete self-contained HTML \
             document (with inline CSS) and pass it to `write_pdf_from_html` \
             with the exact path the user asked for.\n\
             • Respect the exact filename and extension the user asked for. \
             If they asked for '~/Downloads/X/Y.pdf', write to that path — not \
             to 'invoice.pdf' or a similar auto-named file."
                .to_string(),
            // Publisher-routing rules (GH #1592, follows from #1591) — steer the model
            // toward specific connected publishers over generic browser automation
            // whenever the request maps cleanly onto one. Additive and reversible:
            // the model retains full agency; only the priority is nudged.
            "Publisher-routing rules:\n\
             • When the user's request maps cleanly to a connected publisher \
             (e.g. `gateway__gmail__*` for email, inbox, drafts, threads; \
             `gateway__github__*` for issues, PRs, repos; `gateway__slack__*` \
             for messages; `gateway__jira__*` for tickets), prefer those \
             publisher tools over generic `playwright_*` browser automation \
             or `seren_web_fetch`.\n\
             • A registered publisher is pre-authenticated and deterministic. \
             Browser automation against the same service's web UI is typically \
             NOT authenticated in this session and will fail with a login \
             screen. Do not start with Playwright for Gmail, GitHub, Slack, \
             Jira, or similar when a matching `gateway__*` publisher is in \
             your tool list.\n\
             • Only fall back to browser automation or `seren_web_fetch` when \
             the user explicitly asks for it, when no dedicated publisher is \
             available for the target service, or when the publisher's tools \
             genuinely cannot do what is being asked."
                .to_string(),
        ];
        // Inject live repo context (git branch, status, recent commits)
        if let Some(root) = project_root {
            let repo_context = gather_repo_context(root);
            if !repo_context.is_empty() {
                system_parts.push(repo_context);
            }
        }
        if !tool_inventory.is_empty() {
            system_parts.push(tool_inventory);
        }
        if !skill_content.is_empty() {
            system_parts.push(skill_content.to_string());
        }
        // Tone and behavior rules — must match JS path TONE_INSTRUCTIONS in
        // src/services/chat.ts. Appended last so the model reads them after
        // the tool inventory it is allowed to use.
        system_parts.push(TONE_INSTRUCTIONS.to_string());
        let system_content = system_parts.join("\n\n");

        messages.push(serde_json::json!({
            "role": "system",
            "content": system_content
        }));

        // Conversation history
        for msg in conversation_context {
            messages.push(msg.clone());
        }

        // Current user prompt — multimodal when images are present
        if images.is_empty() {
            messages.push(serde_json::json!({
                "role": "user",
                "content": prompt
            }));
        } else {
            let mut content_parts: Vec<serde_json::Value> = Vec::new();
            content_parts.push(serde_json::json!({
                "type": "text",
                "text": prompt
            }));
            for image in images {
                if image.mime_type.starts_with("image/") {
                    // Vision-compatible image — send as image_url
                    content_parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:{};base64,{}", image.mime_type, image.base64)
                        }
                    }));
                } else if image.mime_type.starts_with("text/")
                    || image.mime_type == "application/json"
                    || image.mime_type == "application/xml"
                {
                    // Text/code file — decode base64 and inline as text
                    let decoded = STANDARD
                        .decode(&image.base64)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok());
                    if let Some(text_content) = decoded {
                        let ext = image.name.rsplit('.').next().unwrap_or("");
                        content_parts.push(serde_json::json!({
                            "type": "text",
                            "text": format!("```{} ({})\n{}\n```", ext, image.name, text_content)
                        }));
                    } else {
                        content_parts.push(serde_json::json!({
                            "type": "text",
                            "text": format!("[Could not decode attachment: {}]", image.name)
                        }));
                    }
                } else {
                    // Unsupported binary format — note it for the model
                    content_parts.push(serde_json::json!({
                        "type": "text",
                        "text": format!("[Unsupported attachment format: {} ({})]", image.name, image.mime_type)
                    }));
                }
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": content_parts
            }));
        }

        let mut body = serde_json::json!({
            "model": routing.model_id,
            "messages": messages,
            "stream": true
        });

        if !tools.is_empty() {
            body["tools"] = serde_json::json!(tools);
            body["tool_choice"] = serde_json::json!("auto");
        }

        // OpenRouter reasoning effort parameter (for models that support extended thinking)
        if let Some(ref effort) = routing.reasoning_effort {
            body["reasoning"] = serde_json::json!({ "effort": effort });
        }

        body
    }

    /// Extract text from a content value that may be a string, an array of parts,
    /// or an object with a "text" field (Gemini returns array-of-parts format).
    fn normalize_content(value: &serde_json::Value) -> Option<String> {
        if let Some(s) = value.as_str() {
            return if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            };
        }

        if let Some(arr) = value.as_array() {
            let combined: String = arr
                .iter()
                .filter_map(|piece| {
                    piece.as_str().map(|s| s.to_string()).or_else(|| {
                        piece
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    })
                })
                .collect::<Vec<_>>()
                .join("");
            return if combined.is_empty() {
                None
            } else {
                Some(combined)
            };
        }

        if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
            return if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            };
        }

        None
    }

    /// Parse a single SSE data line into events, cost, tool call chunks, and finish reason.
    fn parse_sse_data(data: &str) -> ParseResult {
        let mut result = ParseResult {
            events: Vec::new(),
            cost: None,
            tool_call_chunks: Vec::new(),
            finish_reason: None,
        };

        let parsed: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => {
                log::debug!(
                    "[ChatModelWorker] Non-JSON SSE data: {}",
                    &data[..data.floor_char_boundary(200)]
                );
                return result;
            }
        };

        log::debug!(
            "[ChatModelWorker] SSE chunk: {}",
            &data[..data.floor_char_boundary(300)]
        );

        // Extract cost from Gateway wrapper (present at top level)
        result.cost = parsed.get("cost").and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
        });

        // Check for wrapped error status from Gateway
        if let Some(status) = parsed.get("status").and_then(|s| s.as_u64()) {
            if status >= 400 {
                let error_msg = parsed
                    .pointer("/body/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Gateway API error");
                result.events.push(WorkerEvent::Error {
                    message: format!("HTTP {}: {}", status, error_msg),
                });
                return result;
            }
        }

        // If Gateway wraps the SSE event in {status, body, cost}, unwrap body
        let effective = if parsed.get("body").is_some() && parsed.get("status").is_some() {
            parsed.pointer("/body").unwrap_or(&parsed)
        } else {
            &parsed
        };

        // Extract content delta (handles string, array-of-parts, or object with "text")
        let content_value = effective
            .pointer("/delta/content")
            .or_else(|| effective.pointer("/choices/0/delta/content"));

        let content_text = content_value.and_then(Self::normalize_content);

        if let Some(ref text) = content_text {
            result
                .events
                .push(WorkerEvent::Content { text: text.clone() });
        }

        // Extract thinking delta (Anthropic extended thinking)
        let thinking = effective
            .pointer("/delta/thinking")
            .or_else(|| effective.pointer("/choices/0/delta/thinking"))
            .and_then(|v| v.as_str());

        if let Some(text) = thinking {
            if !text.is_empty() {
                result.events.push(WorkerEvent::Thinking {
                    text: text.to_string(),
                });
            }
        }

        // Extract tool call chunks from delta (streaming format)
        if let Some(tool_calls) = effective
            .pointer("/delta/tool_calls")
            .or_else(|| effective.pointer("/choices/0/delta/tool_calls"))
            .and_then(|v| v.as_array())
        {
            for tc in tool_calls {
                let index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let id = tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
                let name = tc
                    .pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let arguments = tc
                    .pointer("/function/arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Store raw chunk for accumulation in stream_response
                result.tool_call_chunks.push(ToolCallChunk {
                    index,
                    id: id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                });

                // Emit ToolCall event for frontend display (first chunk with id+name)
                let id_str = id.unwrap_or_default();
                let name_str = name.unwrap_or_default();
                if !id_str.is_empty() && !name_str.is_empty() {
                    result.events.push(WorkerEvent::ToolCall {
                        tool_call_id: id_str,
                        name: name_str.clone(),
                        arguments,
                        title: name_str,
                    });
                }
            }
        }

        // Extract finish_reason (any value: "stop", "tool_calls", "length", etc.)
        result.finish_reason = effective
            .pointer("/choices/0/finish_reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Log when no events were extracted (helps debug format issues)
        if result.events.is_empty()
            && result.tool_call_chunks.is_empty()
            && result.finish_reason.is_none()
        {
            log::debug!(
                "[ChatModelWorker] No events extracted from SSE data: {}",
                &data[..data.floor_char_boundary(300)]
            );
        }

        result
    }

    /// Build a StreamOutcome from accumulated state.
    fn build_stream_outcome(
        finish_reason: &Option<String>,
        pending_tool_calls: HashMap<usize, AccumulatedToolCall>,
        content: String,
        thinking: String,
        cost: f64,
    ) -> StreamOutcome {
        if finish_reason.as_deref() == Some("tool_calls") && !pending_tool_calls.is_empty() {
            let mut indexed: Vec<(usize, AccumulatedToolCall)> =
                pending_tool_calls.into_iter().collect();
            indexed.sort_by_key(|(idx, _)| *idx);
            let tool_calls = indexed.into_iter().map(|(_, tc)| tc).collect();

            StreamOutcome::ToolCallsPending {
                tool_calls,
                accumulated_content: content,
                accumulated_thinking: thinking,
                accumulated_cost: cost,
            }
        } else {
            StreamOutcome::Complete {
                final_content: content,
                thinking: if thinking.is_empty() {
                    None
                } else {
                    Some(thinking)
                },
                cost,
            }
        }
    }

    /// Process a ParseResult: accumulate tool call chunks and forward events.
    async fn process_parse_result(
        result: &ParseResult,
        pending_tool_calls: &mut HashMap<usize, AccumulatedToolCall>,
        accumulated_content: &mut String,
        accumulated_thinking: &mut String,
        accumulated_cost: &mut f64,
        last_finish_reason: &mut Option<String>,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        if let Some(c) = result.cost {
            *accumulated_cost += c;
        }

        // Accumulate tool call chunks by index
        for chunk in &result.tool_call_chunks {
            let entry =
                pending_tool_calls
                    .entry(chunk.index)
                    .or_insert_with(|| AccumulatedToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: String::new(),
                    });
            if let Some(ref id) = chunk.id {
                if !id.is_empty() {
                    entry.id = id.clone();
                }
            }
            if let Some(ref name) = chunk.name {
                if !name.is_empty() {
                    entry.name = name.clone();
                }
            }
            entry.arguments.push_str(&chunk.arguments);
        }

        // Track finish reason
        if let Some(ref reason) = result.finish_reason {
            log::info!(
                "[ChatModelWorker] Stream finish_reason detected: {}",
                reason
            );
            *last_finish_reason = Some(reason.clone());
        }

        // Forward events (Content, Thinking, ToolCall) to frontend
        for event in &result.events {
            match event {
                WorkerEvent::Content { text } => {
                    accumulated_content.push_str(text);
                }
                WorkerEvent::Thinking { text } => {
                    accumulated_thinking.push_str(text);
                }
                _ => {}
            }
            event_tx
                .send(event.clone())
                .await
                .map_err(|e| format!("Failed to send event: {}", e))?;
        }

        Ok(())
    }

    /// Stream SSE response and return the outcome (complete or tool calls pending).
    async fn stream_response(
        &self,
        response: reqwest::Response,
        event_tx: &mpsc::Sender<WorkerEvent>,
    ) -> Result<StreamOutcome, String> {
        log::debug!("[ChatModelWorker] Starting SSE stream");
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut accumulated_content = String::new();
        let mut accumulated_thinking = String::new();
        let mut accumulated_cost: f64 = 0.0;
        let mut pending_tool_calls: HashMap<usize, AccumulatedToolCall> = HashMap::new();
        let mut last_finish_reason: Option<String> = None;

        let mut chunk_count = 0u32;

        while let Some(chunk_result) = stream.next().await {
            // Check cancellation
            if *self.cancelled.lock().await {
                return Ok(Self::build_stream_outcome(
                    &last_finish_reason,
                    pending_tool_calls,
                    accumulated_content,
                    accumulated_thinking,
                    accumulated_cost,
                ));
            }

            let chunk = chunk_result.map_err(|e| format!("Stream read error: {}", e))?;
            let text = String::from_utf8_lossy(&chunk);
            chunk_count += 1;

            // Log first few chunks to diagnose format issues
            if chunk_count <= 3 {
                log::info!(
                    "[ChatModelWorker] Chunk #{} ({} bytes): {}",
                    chunk_count,
                    chunk.len(),
                    &text[..text.floor_char_boundary(500)]
                );
            }

            buffer.push_str(&text);

            // Process complete lines
            while let Some(newline_pos) = buffer.find('\n') {
                let line = buffer[..newline_pos].trim().to_string();
                buffer = buffer[newline_pos + 1..].to_string();

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                // Handle both "data: " (with space) and "data:" (without space)
                let data_opt = line
                    .strip_prefix("data: ")
                    .or_else(|| line.strip_prefix("data:"));

                // Extract SSE data payload, or try raw JSON as fallback
                let data_str = if let Some(data) = data_opt {
                    data.to_string()
                } else if line.starts_with('{') {
                    // Fallback: raw JSON line without SSE data: prefix (NDJSON)
                    log::debug!(
                        "[ChatModelWorker] Raw JSON line (no data: prefix): {}",
                        &line[..line.floor_char_boundary(200)]
                    );
                    line.clone()
                } else {
                    log::debug!(
                        "[ChatModelWorker] Skipping unrecognized SSE line: {}",
                        &line[..line.floor_char_boundary(200)]
                    );
                    continue;
                };

                if data_str.trim() == "[DONE]" {
                    log::info!(
                        "[ChatModelWorker] Stream [DONE] marker received — finish_reason: {:?}, pending_tools: {}",
                        last_finish_reason,
                        pending_tool_calls.len()
                    );
                    return Ok(Self::build_stream_outcome(
                        &last_finish_reason,
                        pending_tool_calls,
                        accumulated_content,
                        accumulated_thinking,
                        accumulated_cost,
                    ));
                }

                let result = Self::parse_sse_data(&data_str);
                Self::process_parse_result(
                    &result,
                    &mut pending_tool_calls,
                    &mut accumulated_content,
                    &mut accumulated_thinking,
                    &mut accumulated_cost,
                    &mut last_finish_reason,
                    event_tx,
                )
                .await?;
            }
        }

        // Log stream summary for debugging
        log::info!(
            "[ChatModelWorker] Stream ended: {} chunks received, {} bytes remaining in buffer, accumulated {} content bytes",
            chunk_count,
            buffer.len(),
            accumulated_content.len()
        );

        // Handle Gateway non-streaming wrapper format:
        // The Gateway may return the entire response as a single JSON blob where
        // the body field is a string containing embedded SSE data:
        //   {"status":200,"body":"data: {...}\n\ndata: {...}\n\n...[DONE]","cost":"..."}
        // In this case the buffer has no real newlines (SSE newlines are JSON escapes).
        if !buffer.is_empty() && accumulated_content.is_empty() && last_finish_reason.is_none() {
            if let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(&buffer) {
                // Extract cost from the non-streaming wrapper
                if let Some(wrapper_cost) = wrapper.get("cost").and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| v.as_f64())
                }) {
                    log::info!("[ChatModelWorker] Gateway reported cost: {}", wrapper_cost);
                    accumulated_cost += wrapper_cost;
                }

                // Check wrapper status for errors before processing body
                if let Some(status) = wrapper.get("status").and_then(|s| s.as_u64()) {
                    if status >= 400 {
                        let error_msg = wrapper
                            .pointer("/body/error/message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Gateway API error");
                        // Include raw provider error when available so the
                        // orchestrator can detect context-overflow and reroute
                        // to a large-context model.
                        let raw_detail = wrapper
                            .pointer("/body/error/metadata/raw")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let full_error = if raw_detail.is_empty() {
                            format!("HTTP {}: {}", status, error_msg)
                        } else {
                            format!("HTTP {}: {} — {}", status, error_msg, raw_detail)
                        };
                        let retryable = gateway_status_is_retryable(status);
                        log::error!(
                            "[ChatModelWorker] Non-streaming wrapper error: {} (retryable={})",
                            full_error,
                            retryable,
                        );
                        event_tx
                            .send(WorkerEvent::Error {
                                message: full_error.clone(),
                            })
                            .await
                            .map_err(|e| format!("Failed to send error event: {}", e))?;
                        return Ok(StreamOutcome::Failed {
                            error: full_error,
                            cost: accumulated_cost,
                            retryable,
                        });
                    }
                }

                if let Some(body_str) = wrapper.get("body").and_then(|b| b.as_str()) {
                    log::info!(
                        "[ChatModelWorker] Gateway returned non-streaming wrapper, extracting embedded SSE ({} bytes)",
                        body_str.len()
                    );
                    // Process the embedded SSE content
                    for raw_line in body_str.split('\n') {
                        let line = raw_line.trim();
                        if line.is_empty() || line.starts_with(':') {
                            continue;
                        }
                        let data = line
                            .strip_prefix("data: ")
                            .or_else(|| line.strip_prefix("data:"));
                        let data_str = if let Some(d) = data {
                            d
                        } else if line.starts_with('{') {
                            line
                        } else {
                            continue;
                        };
                        if data_str.trim() == "[DONE]" {
                            break;
                        }
                        let result = Self::parse_sse_data(data_str);
                        Self::process_parse_result(
                            &result,
                            &mut pending_tool_calls,
                            &mut accumulated_content,
                            &mut accumulated_thinking,
                            &mut accumulated_cost,
                            &mut last_finish_reason,
                            event_tx,
                        )
                        .await?;
                    }
                } else if let Some(body_obj) = wrapper.get("body") {
                    // body is a JSON object (non-streaming response), extract content directly
                    if body_obj.is_object() {
                        log::info!("[ChatModelWorker] Gateway returned non-streaming JSON body");
                        let result = Self::parse_sse_data(&body_obj.to_string());
                        Self::process_parse_result(
                            &result,
                            &mut pending_tool_calls,
                            &mut accumulated_content,
                            &mut accumulated_thinking,
                            &mut accumulated_cost,
                            &mut last_finish_reason,
                            event_tx,
                        )
                        .await?;
                    }
                }
            }
        }

        Ok(Self::build_stream_outcome(
            &last_finish_reason,
            pending_tool_calls,
            accumulated_content,
            accumulated_thinking,
            accumulated_cost,
        ))
    }

    // =========================================================================
    // Tool Execution
    // =========================================================================

    /// Truncate a tool result for the LLM conversation context.
    ///
    /// Large tool results (e.g. web page fetches) accumulate across tool rounds,
    /// bloating the messages payload and causing upstream 408 timeouts.  This
    /// preserves a UTF-8-safe prefix and appends a truncation notice.
    fn truncate_for_context(content: &str, tool_name: &str) -> String {
        if content.len() <= MAX_TOOL_RESULT_CONTEXT_BYTES {
            return content.to_string();
        }

        // Find a valid UTF-8 boundary near the limit
        let mut end = MAX_TOOL_RESULT_CONTEXT_BYTES;
        while end > 0 && !content.is_char_boundary(end) {
            end -= 1;
        }

        log::info!(
            "[ChatModelWorker] Truncating {} result from {} to {} bytes for LLM context",
            tool_name,
            content.len(),
            end,
        );

        let mut truncated = content[..end].to_string();
        truncated.push_str(&format!(
            "\n\n[Content truncated from {} to {} bytes. The full result was shown to the user.]",
            content.len(),
            end,
        ));
        truncated
    }

    /// Check if a tool name refers to a locally-executable tool.
    /// Non-local tools (gateway__, mcp__) are routed to the frontend.
    fn is_local_tool(name: &str) -> bool {
        matches!(
            name,
            "read_file"
                | "read_file_base64"
                | "write_file"
                | "write_pdf_from_html"
                | "list_directory"
                | "path_exists"
                | "create_directory"
                | "seren_web_fetch"
                | "execute_command"
        )
    }

    /// Check if a tool is a file-read operation (for deduplication).
    fn is_file_read_tool(name: &str) -> bool {
        name == "read_file"
    }

    /// Extract the file path from a tool's arguments JSON.
    fn extract_file_path(arguments: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(arguments)
            .ok()
            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(String::from))
    }

    /// Execute a local tool by name with the given arguments.
    /// Returns (result_content, is_error).
    async fn execute_tool(name: &str, arguments: &str) -> (String, bool) {
        let args: serde_json::Value = match serde_json::from_str(arguments) {
            Ok(v) => v,
            Err(e) => {
                return (format!("Failed to parse tool arguments: {}", e), true);
            }
        };

        match name {
            "read_file" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                match crate::files::read_file(path) {
                    Ok(content) => (content, false),
                    Err(e) => (e, true),
                }
            }
            "read_file_base64" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                match crate::files::read_file_base64(path) {
                    Ok(content) => (content, false),
                    Err(e) => (e, true),
                }
            }
            "write_file" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                let content = args["content"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                match crate::files::write_file(path.clone(), content) {
                    Ok(()) => (format!("Successfully wrote file: {}", path), false),
                    Err(e) => (e, true),
                }
            }
            "write_pdf_from_html" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                let html = args["html"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                if html.is_empty() {
                    return ("Missing required parameter: html".to_string(), true);
                }
                match crate::pdf::write_pdf_from_html(&path, &html).await {
                    Ok(msg) => (msg, false),
                    Err(e) => (e, true),
                }
            }
            "list_directory" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                match crate::files::list_directory(path) {
                    Ok(entries) => match serde_json::to_string_pretty(&entries) {
                        Ok(s) => (s, false),
                        Err(e) => (format!("Failed to serialize listing: {}", e), true),
                    },
                    Err(e) => (e, true),
                }
            }
            "path_exists" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                let exists = crate::files::path_exists(path);
                (format!("{}", exists), false)
            }
            "create_directory" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                if path.is_empty() {
                    return ("Missing required parameter: path".to_string(), true);
                }
                match crate::files::create_directory(path.clone()) {
                    Ok(()) => (format!("Successfully created directory: {}", path), false),
                    Err(e) => (e, true),
                }
            }
            "seren_web_fetch" => {
                let url = args["url"].as_str().unwrap_or("").to_string();
                if url.is_empty() {
                    return ("Missing required parameter: url".to_string(), true);
                }
                let timeout_ms = args["timeout_ms"].as_u64();
                match crate::commands::web::web_fetch(url, timeout_ms).await {
                    Ok(fetch_result) => (fetch_result.content, false),
                    Err(e) => (e, true),
                }
            }
            "execute_command" => {
                let command = args["command"].as_str().unwrap_or("").to_string();
                if command.is_empty() {
                    return ("Missing required parameter: command".to_string(), true);
                }
                let timeout_secs = args["timeout_secs"].as_u64();
                match crate::shell::execute_shell_command(command, timeout_secs).await {
                    Ok(cmd_result) => {
                        let mut output = String::new();
                        if !cmd_result.stdout.is_empty() {
                            output.push_str(&cmd_result.stdout);
                        }
                        if !cmd_result.stderr.is_empty() {
                            if !output.is_empty() {
                                output.push('\n');
                            }
                            output.push_str("stderr: ");
                            output.push_str(&cmd_result.stderr);
                        }
                        if cmd_result.timed_out {
                            output = format!("Command timed out.\n{}", output);
                        }
                        if output.is_empty() {
                            output = "(no output)".to_string();
                        }
                        let is_error =
                            cmd_result.timed_out || cmd_result.exit_code.map_or(true, |c| c != 0);
                        (output, is_error)
                    }
                    Err(e) => (e, true),
                }
            }
            _ => (
                format!("Tool '{}' is not available in chat mode", name),
                true,
            ),
        }
    }

    /// Route a non-local tool call to the frontend for execution via the tool bridge.
    ///
    /// Emits an `orchestrator://tool-request` event, then waits for the frontend to
    /// call `submit_tool_result` with the result.
    async fn execute_frontend_tool(
        app: &tauri::AppHandle,
        tool_call_id: &str,
        name: &str,
        arguments: &str,
    ) -> (String, bool) {
        log::info!(
            "[ChatModelWorker] Frontend tool execution starting: {} (id: {}, args: {})",
            name,
            tool_call_id,
            &arguments[..arguments.floor_char_boundary(200)]
        );

        let bridge = app.state::<ToolResultBridge>();
        let rx = bridge.register(tool_call_id).await;
        log::debug!(
            "[ChatModelWorker] Tool bridge registered for {}",
            tool_call_id
        );

        // Emit a tool execution request to the frontend
        let payload = serde_json::json!({
            "tool_call_id": tool_call_id,
            "name": name,
            "arguments": arguments,
        });
        if let Err(e) = app.emit("orchestrator://tool-request", &payload) {
            log::error!(
                "[ChatModelWorker] Failed to emit tool-request for {}: {}",
                name,
                e
            );
            return (format!("Failed to request tool execution: {}", e), true);
        }
        log::debug!(
            "[ChatModelWorker] Tool request emitted, waiting for frontend result (no timeout)"
        );

        // Wait for the frontend to submit the result (no timeout — user may need time to review)
        match rx.await {
            Ok(result) => {
                log::info!(
                    "[ChatModelWorker] Frontend tool completed: {} (is_error={}, result_len={})",
                    name,
                    result.is_error,
                    result.content.len()
                );
                (result.content, result.is_error)
            }
            Err(_) => {
                // Sender was dropped (bridge cleaned up or cancelled)
                log::warn!(
                    "[ChatModelWorker] Tool result channel closed for {} — bridge cleaned up or cancelled",
                    name
                );
                ("Tool execution was cancelled".to_string(), true)
            }
        }
    }
}

#[async_trait]
impl Worker for ChatModelWorker {
    fn id(&self) -> &str {
        "chat_model"
    }

    async fn execute(
        &self,
        _conversation_id: &str,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        app: &tauri::AppHandle,
        images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String> {
        // Reset cancellation flag
        *self.cancelled.lock().await = false;

        // Extract publishers whose tools were called in recent conversation turns.
        // This feeds Phase 3 (conversation-aware boosting) of tool relevance.
        let recent_publishers = extract_recent_publishers(conversation_context);

        // Select tools relevant to this query via BM25 scoring.
        // Model-aware budgets (Phase 1), publisher-set scoping (Phase 2),
        // and conversation-aware boosting (Phase 3).
        let budgeted_tools = tool_relevance::select_relevant_tools(
            prompt,
            &self.tool_definitions,
            &routing.model_id,
            &recent_publishers,
        );

        log::info!(
            "[ChatModelWorker] Executing with model: {}, tools: {}",
            routing.model_id,
            budgeted_tools.len()
        );
        log::debug!(
            "[ChatModelWorker] Prompt preview: {}",
            &prompt[..prompt.floor_char_boundary(50)]
        );

        let url = format!(
            "{}/publishers/{}/chat/completions",
            GATEWAY_BASE_URL, self.publisher_slug
        );
        let tools = &budgeted_tools;

        // Build initial request body (includes system prompt, repo context, history, user message, images)
        let initial_body = self.build_request_body(
            prompt,
            conversation_context,
            routing,
            skill_content,
            tools,
            images,
            routing.project_root.as_deref(),
        );

        // Extract messages for the tool execution loop
        let mut messages: Vec<serde_json::Value> = initial_body["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        // Track file paths already read in this execution to avoid re-inlining
        // the same content. On duplicate reads, return a short reference instead.
        let mut read_file_paths: HashSet<String> = HashSet::new();

        let mut total_cost: f64 = 0.0;

        // Track where the current prompt's messages start (after system + history).
        // On tool-call rounds (1+), we trim old conversation history and keep only
        // the system prompt + the current prompt's message chain. This cuts prompt
        // tokens by ~60% on multi-round tool calls without affecting tool selection.
        let current_prompt_start = messages.len().saturating_sub(1); // user message index

        for round in 0..=MAX_TOOL_ROUNDS {
            // Check cancellation
            if *self.cancelled.lock().await {
                return Ok(());
            }

            // On tool-call follow-up rounds, trim old conversation history.
            // Keep: system prompt (index 0) + messages from the current prompt onward.
            // The model already has the tool calls and results in the message chain —
            // it doesn't need 30K tokens of old history to process tool results.
            let round_messages = if round > 0 && messages.len() > current_prompt_start + 1 {
                let mut trimmed = Vec::with_capacity(1 + messages.len() - current_prompt_start);
                trimmed.push(messages[0].clone()); // system prompt
                trimmed.extend_from_slice(&messages[current_prompt_start..]);
                trimmed
            } else {
                messages.clone()
            };

            // Build request body
            let mut body = serde_json::json!({
                "model": routing.model_id,
                "messages": round_messages,
                "stream": true
            });
            if !tools.is_empty() {
                body["tools"] = serde_json::json!(tools);
                body["tool_choice"] = serde_json::json!("auto");
            }
            // Cap output tokens on tool-call rounds — tool selections are small.
            if round > 0 {
                body["max_tokens"] = serde_json::json!(4096);
            }

            let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

            // Use authenticated_request for automatic 401 refresh and retry
            let response =
                crate::auth::authenticated_request(app, &self.client, |client, token| {
                    client
                        .post(&url)
                        .header("Content-Type", "application/json")
                        .bearer_auth(token)
                        .body(body_str.clone())
                })
                .await?;

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                // Check cancellation before logging — a 504 after cancel is expected
                if *self.cancelled.lock().await {
                    log::debug!(
                        "[ChatModelWorker] HTTP {} after cancellation (expected)",
                        status
                    );
                    return Ok(());
                }
                log::error!("[ChatModelWorker] HTTP {} from Gateway", status);
                let display_message = summarize_gateway_error(status, &body_text);
                if let Err(e) = event_tx
                    .send(WorkerEvent::Error {
                        message: display_message.clone(),
                    })
                    .await
                {
                    // Channel closed — likely cancelled while sending
                    log::debug!("[ChatModelWorker] Channel closed, cannot send error: {}", e);
                    return Ok(());
                }
                return Err(display_message);
            }

            // Stream the response
            log::info!(
                "[ChatModelWorker] Tool round {} starting — awaiting stream outcome",
                round
            );
            let outcome = self.stream_response(response, &event_tx).await?;

            match outcome {
                StreamOutcome::Complete {
                    final_content,
                    thinking,
                    cost,
                } => {
                    total_cost += cost;
                    let total = if total_cost > 0.0 {
                        Some(total_cost)
                    } else {
                        None
                    };
                    log::info!(
                        "[ChatModelWorker] StreamOutcome::Complete received — round={}, content_len={}, cost={:?}",
                        round,
                        final_content.len(),
                        total
                    );
                    if let Err(e) = event_tx
                        .send(WorkerEvent::Complete {
                            final_content,
                            thinking,
                            cost: total,
                            rlm_steps: None,
                        })
                        .await
                    {
                        log::debug!(
                            "[ChatModelWorker] Channel closed, cannot send Complete: {}",
                            e
                        );
                        return Ok(());
                    }
                    log::info!("[ChatModelWorker] Execution complete, breaking from tool loop");
                    break;
                }
                StreamOutcome::ToolCallsPending {
                    tool_calls,
                    accumulated_content,
                    accumulated_thinking: _,
                    accumulated_cost,
                } => {
                    log::info!(
                        "[ChatModelWorker] StreamOutcome::ToolCallsPending received — round={}, {} tool(s) to execute",
                        round,
                        tool_calls.len()
                    );
                    total_cost += accumulated_cost;

                    if round == MAX_TOOL_ROUNDS {
                        log::warn!(
                            "[ChatModelWorker] Max tool rounds ({}) reached, forcing completion",
                            MAX_TOOL_ROUNDS
                        );
                        event_tx
                            .send(WorkerEvent::Complete {
                                final_content: accumulated_content,
                                thinking: None,
                                cost: if total_cost > 0.0 {
                                    Some(total_cost)
                                } else {
                                    None
                                },
                                rlm_steps: None,
                            })
                            .await
                            .map_err(|e| format!("Failed to send Complete event: {}", e))?;
                        break;
                    }

                    log::info!(
                        "[ChatModelWorker] Tool round {} — {} tool call(s) pending",
                        round,
                        tool_calls.len()
                    );

                    // Build assistant message with tool_calls for the API
                    let tool_calls_json: Vec<serde_json::Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            serde_json::json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments,
                                }
                            })
                        })
                        .collect();

                    let mut assistant_msg = serde_json::json!({
                        "role": "assistant",
                        "tool_calls": tool_calls_json
                    });
                    if !accumulated_content.is_empty() {
                        assistant_msg["content"] = serde_json::json!(accumulated_content);
                    }
                    messages.push(assistant_msg);

                    // Execute each tool and build result messages
                    for tc in &tool_calls {
                        // Check cancellation between tool executions
                        if *self.cancelled.lock().await {
                            log::info!(
                                "[ChatModelWorker] Cancelled during tool execution, stopping"
                            );
                            return Ok(());
                        }

                        log::info!(
                            "[ChatModelWorker] Executing tool: {} (id: {})",
                            tc.name,
                            tc.id
                        );

                        let (result_content, is_error) = if Self::is_local_tool(&tc.name) {
                            Self::execute_tool(&tc.name, &tc.arguments).await
                        } else {
                            // Route non-local tools (gateway__, mcp__)
                            // to the frontend for execution via the tool bridge.
                            Self::execute_frontend_tool(app, &tc.id, &tc.name, &tc.arguments).await
                        };

                        // Emit ToolResult event to frontend
                        let _ = event_tx
                            .send(WorkerEvent::ToolResult {
                                tool_call_id: tc.id.clone(),
                                content: result_content.clone(),
                                is_error,
                            })
                            .await;

                        // Deduplicate file reads: if the same path was already
                        // read in this execution, return a short reference instead
                        // of re-inlining the full content.
                        let deduped_content = if Self::is_file_read_tool(&tc.name) {
                            if let Some(path) = Self::extract_file_path(&tc.arguments) {
                                if read_file_paths.contains(&path) {
                                    log::info!(
                                        "[ChatModelWorker] Dedup: file already read: {}",
                                        path
                                    );
                                    format!("[File already in context: {}]", path)
                                } else {
                                    read_file_paths.insert(path);
                                    result_content.clone()
                                }
                            } else {
                                result_content.clone()
                            }
                        } else {
                            result_content.clone()
                        };

                        // Truncate tool result for LLM context to prevent
                        // unbounded payload growth that causes upstream 408s.
                        let context_content = Self::truncate_for_context(&deduped_content, &tc.name);

                        // Add tool result message for the next API call
                        messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": context_content
                        }));
                    }

                    log::info!(
                        "[ChatModelWorker] All tools executed for round {}, continuing to next round with {} messages",
                        round,
                        messages.len()
                    );
                }
                StreamOutcome::Failed {
                    error,
                    cost,
                    retryable,
                } => {
                    total_cost += cost;
                    let total = if total_cost > 0.0 {
                        Some(total_cost)
                    } else {
                        None
                    };
                    log::error!(
                        "[ChatModelWorker] StreamOutcome::Failed received — round={}, error={}, retryable={}, cost={:?}",
                        round,
                        error,
                        retryable,
                        total
                    );
                    // The error event was already forwarded by stream_response,
                    // so the destructive UI is already showing. Send a final
                    // Complete event with empty content to clear the loading
                    // spinner — but mark this conversation as failed in logs so
                    // metrics and downstream consumers don't count it as a
                    // successful completion.
                    if let Err(e) = event_tx
                        .send(WorkerEvent::Complete {
                            final_content: String::new(),
                            thinking: None,
                            cost: total,
                            rlm_steps: None,
                        })
                        .await
                    {
                        log::debug!(
                            "[ChatModelWorker] Channel closed, cannot send Complete after Failed: {}",
                            e
                        );
                        return Ok(());
                    }
                    log::info!(
                        "[ChatModelWorker] Execution failed, breaking from tool loop (retryable={})",
                        retryable
                    );
                    break;
                }
            }
        }

        Ok(())
    }

    async fn cancel(&self) -> Result<(), String> {
        *self.cancelled.lock().await = true;
        Ok(())
    }
}

/// Request body for the Gateway chat completions endpoint.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<serde_json::Value>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_correct_request_body() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body = worker.build_request_body(
            "Hello world",
            &[serde_json::json!({"role": "user", "content": "previous message"})],
            &routing,
            "",
            &[],
            &[],
            None,
        );

        assert_eq!(body["model"], "anthropic/claude-sonnet-4");
        assert_eq!(body["stream"], true);
        let messages = body["messages"].as_array().unwrap();
        // system + 1 history + current user = 3
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["content"], "previous message");
        assert_eq!(messages[2]["content"], "Hello world");
    }

    #[test]
    fn injects_tone_instructions_into_system_prompt() {
        // Critical: every chat system prompt must carry the tone block so the
        // model is bound by the same anti-sycophancy / verify-before-denying
        // rules regardless of skills, tools, or repo context. Regression
        // guard for serenorg/seren-desktop#1464.
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body =
            worker.build_request_body("hi", &[], &routing, "", &[], &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        assert!(
            system_msg.contains("Tone and behavior:"),
            "system prompt must contain the tone header"
        );
        assert!(
            system_msg.contains("Be concise. Lead with the answer"),
            "tone block must enforce concise/lead-with-answer rule"
        );
        assert!(
            system_msg.contains("Never open with"),
            "tone block must forbid sycophantic openers"
        );
        assert!(
            system_msg.contains(
                "Never claim a tool or capability is unavailable without first checking"
            ),
            "tone block must require verification before denying capabilities"
        );
    }

    #[test]
    fn builds_request_with_skill_content() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body = worker.build_request_body(
            "Hello",
            &[],
            &routing,
            "# Active Skills\n\n## Skill: Prose",
            &[],
            &[],
            None,
        );

        let system_msg = body["messages"][0]["content"].as_str().unwrap();
        assert!(system_msg.contains("Active Skills"));
        assert!(system_msg.contains("Prose"));
    }

    #[test]
    fn builds_request_with_tools() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Research".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {}}
            }
        })];

        let body = worker.build_request_body("Search for news", &[], &routing, "", &tools, &[], None);

        assert!(body.get("tools").is_some());
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn parses_content_sse_data() {
        let data = r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_content_from_delta_shorthand() {
        let data = r#"{"delta":{"content":"World"}}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "World"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_tool_call_sse_data() {
        let data = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"news\"}"}}]},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::ToolCall {
                tool_call_id,
                name,
                arguments,
                title,
            } => {
                assert_eq!(tool_call_id, "tc_1");
                assert_eq!(name, "web_search");
                assert!(arguments.contains("news"));
                assert_eq!(title, "web_search");
            }
            _ => panic!("Expected ToolCall event"),
        }
        // Also check tool_call_chunks
        assert_eq!(result.tool_call_chunks.len(), 1);
        assert_eq!(result.tool_call_chunks[0].index, 0);
        assert_eq!(result.tool_call_chunks[0].id, Some("tc_1".to_string()));
        assert_eq!(
            result.tool_call_chunks[0].name,
            Some("web_search".to_string())
        );
    }

    #[test]
    fn accumulates_tool_call_argument_chunks() {
        // First chunk: has id and name, partial arguments
        let data1 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"write_file","arguments":"{\"path"}}]},"finish_reason":null}]}"#;
        let result1 = ChatModelWorker::parse_sse_data(data1);
        assert_eq!(result1.tool_call_chunks.len(), 1);
        assert_eq!(result1.tool_call_chunks[0].arguments, "{\"path");
        // First chunk emits a ToolCall event (has id+name)
        assert_eq!(result1.events.len(), 1);

        // Continuation chunk: only arguments, no id/name
        let data2 = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\":\"/tmp/test.txt\""}}]},"finish_reason":null}]}"#;
        let result2 = ChatModelWorker::parse_sse_data(data2);
        assert_eq!(result2.tool_call_chunks.len(), 1);
        assert_eq!(
            result2.tool_call_chunks[0].arguments,
            "\":\"/tmp/test.txt\""
        );
        assert_eq!(result2.tool_call_chunks[0].id, None);
        assert_eq!(result2.tool_call_chunks[0].name, None);
        // Continuation chunk should NOT emit a ToolCall event
        assert!(result2.events.is_empty());
    }

    #[test]
    fn detects_tool_calls_finish_reason() {
        let data = r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.finish_reason, Some("tool_calls".to_string()));
    }

    #[test]
    fn detects_stop_finish_reason() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn parses_gateway_error_response() {
        let data =
            r#"{"status":402,"body":{"error":{"message":"Insufficient credits"}},"cost":"0"}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Error { message } => {
                assert!(message.contains("402"));
                assert!(message.contains("Insufficient credits"));
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[test]
    fn ignores_invalid_json() {
        let result = ChatModelWorker::parse_sse_data("not json at all");
        assert!(result.events.is_empty());
        assert!(result.cost.is_none());
    }

    #[test]
    fn ignores_empty_content() {
        let data = r#"{"choices":[{"delta":{"content":""},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        // Should not produce a Content event for empty string
        assert!(
            result
                .events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Content { .. }))
        );
    }

    #[test]
    fn parses_thinking_sse_data() {
        let data = r#"{"delta":{"thinking":"Let me consider..."}}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Let me consider..."),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn parses_thinking_from_choices_path() {
        let data = r#"{"choices":[{"delta":{"thinking":"Reasoning step"},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Thinking { text } => assert_eq!(text, "Reasoning step"),
            _ => panic!("Expected Thinking event"),
        }
    }

    #[test]
    fn ignores_empty_thinking() {
        let data = r#"{"choices":[{"delta":{"thinking":""},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert!(
            result
                .events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Thinking { .. }))
        );
    }

    #[test]
    fn builds_request_with_images() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let images = vec![ImageAttachment {
            name: "screenshot.png".to_string(),
            mime_type: "image/png".to_string(),
            base64: "iVBORw0KGgo=".to_string(),
        }];

        let body =
            worker.build_request_body("What is in this image?", &[], &routing, "", &[], &images, None);

        let messages = body["messages"].as_array().unwrap();
        let user_msg = &messages[messages.len() - 1];
        assert_eq!(user_msg["role"], "user");
        // Should be multimodal content array
        let content = user_msg["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "What is in this image?");
        assert_eq!(content[1]["type"], "image_url");
        assert!(
            content[1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }

    #[test]
    fn parses_gemini_array_of_parts_content() {
        // Gemini returns content as an array of objects with "text" fields
        let data = r#"{"choices":[{"delta":{"content":[{"text":"Hello from Gemini"}]},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello from Gemini"),
            _ => panic!("Expected Content event, got {:?}", result.events[0]),
        }
    }

    #[test]
    fn parses_gemini_multi_part_content() {
        // Multiple parts concatenated
        let data = r#"{"choices":[{"delta":{"content":[{"text":"Hello "},{"text":"world"}]},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Hello world"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn parses_gemini_object_with_text_content() {
        // Content as a single object with "text" field
        let data =
            r#"{"choices":[{"delta":{"content":{"text":"Object content"}},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Object content"),
            _ => panic!("Expected Content event"),
        }
    }

    #[test]
    fn ignores_empty_gemini_array_content() {
        let data = r#"{"choices":[{"delta":{"content":[]},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert!(
            result
                .events
                .iter()
                .all(|e| !matches!(e, WorkerEvent::Content { .. }))
        );
    }

    #[test]
    fn parses_gemini_finish_with_array_content() {
        // Finish with array-of-parts content should include the content and set finish_reason
        let data =
            r#"{"choices":[{"delta":{"content":[{"text":"Done"}]},"finish_reason":"stop"}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert!(
            result
                .events
                .iter()
                .any(|e| matches!(e, WorkerEvent::Content { text } if text == "Done"))
        );
        assert_eq!(result.finish_reason, Some("stop".to_string()));
    }

    #[test]
    fn parses_gateway_wrapped_content() {
        // Gateway wraps SSE events in {status, body, cost}
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":"Wrapped hello"},"finish_reason":null}]},"cost":"0.001"}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Wrapped hello"),
            _ => panic!("Expected Content event, got {:?}", result.events[0]),
        }
        assert_eq!(result.cost, Some(0.001));
    }

    #[test]
    fn parses_gateway_wrapped_finish() {
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]},"cost":"0.002"}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.finish_reason, Some("stop".to_string()));
        assert_eq!(result.cost, Some(0.002));
    }

    #[test]
    fn extracts_zero_cost_from_gateway() {
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":"test"},"finish_reason":null}]},"cost":"0"}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.cost, Some(0.0));
    }

    #[test]
    fn no_cost_when_absent_from_response() {
        let data = r#"{"choices":[{"delta":{"content":"no wrapper"},"finish_reason":null}]}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert!(result.cost.is_none());
    }

    #[test]
    fn parses_gateway_wrapped_gemini_array_content() {
        // Gateway-wrapped Gemini array-of-parts format
        let data = r#"{"status":200,"body":{"choices":[{"delta":{"content":[{"text":"Wrapped Gemini"}]},"finish_reason":null}]},"cost":"0"}"#;
        let result = ChatModelWorker::parse_sse_data(data);
        assert_eq!(result.events.len(), 1);
        match &result.events[0] {
            WorkerEvent::Content { text } => assert_eq!(text, "Wrapped Gemini"),
            _ => panic!("Expected Content event, got {:?}", result.events[0]),
        }
    }

    #[test]
    fn build_stream_outcome_returns_complete_for_stop() {
        let outcome = ChatModelWorker::build_stream_outcome(
            &Some("stop".to_string()),
            HashMap::new(),
            "Hello".to_string(),
            String::new(),
            0.005,
        );
        match outcome {
            StreamOutcome::Complete {
                final_content,
                thinking,
                cost,
            } => {
                assert_eq!(final_content, "Hello");
                assert!(thinking.is_none());
                assert_eq!(cost, 0.005);
            }
            _ => panic!("Expected Complete outcome"),
        }
    }

    #[test]
    fn build_stream_outcome_returns_tool_calls_pending() {
        let mut pending = HashMap::new();
        pending.insert(
            0,
            AccumulatedToolCall {
                id: "tc_1".to_string(),
                name: "write_file".to_string(),
                arguments: r#"{"path":"/tmp/test.txt","content":"hello"}"#.to_string(),
            },
        );

        let outcome = ChatModelWorker::build_stream_outcome(
            &Some("tool_calls".to_string()),
            pending,
            String::new(),
            String::new(),
            0.003,
        );
        match outcome {
            StreamOutcome::ToolCallsPending {
                tool_calls,
                accumulated_cost,
                ..
            } => {
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].name, "write_file");
                assert_eq!(accumulated_cost, 0.003);
            }
            _ => panic!("Expected ToolCallsPending outcome"),
        }
    }

    #[test]
    fn build_stream_outcome_complete_when_no_pending_tool_calls() {
        // Even if finish_reason is "tool_calls", if no pending tool calls, return Complete
        let outcome = ChatModelWorker::build_stream_outcome(
            &Some("tool_calls".to_string()),
            HashMap::new(),
            "content".to_string(),
            String::new(),
            0.0,
        );
        match outcome {
            StreamOutcome::Complete { .. } => {}
            _ => panic!("Expected Complete outcome when no pending tool calls"),
        }
    }

    #[test]
    fn gateway_status_retryable_classification() {
        // 5xx — all retryable (transient upstream/server failure)
        assert!(gateway_status_is_retryable(500));
        assert!(gateway_status_is_retryable(502));
        assert!(gateway_status_is_retryable(503));
        assert!(gateway_status_is_retryable(504));

        // Retryable 4xx — only 408 Request Timeout and 429 Too Many Requests
        assert!(gateway_status_is_retryable(408));
        assert!(gateway_status_is_retryable(429));

        // Permanent client errors — never retryable.
        // 400 specifically guards against the regression where the gateway
        // mislabels upstream timeouts as 400 (serenorg/seren-core#125): even
        // though that case _should_ be retryable, the desktop must trust the
        // status code it sees and not auto-retry on a real client error.
        assert!(!gateway_status_is_retryable(400));
        assert!(!gateway_status_is_retryable(401));
        assert!(!gateway_status_is_retryable(403));
        assert!(!gateway_status_is_retryable(404));
        assert!(!gateway_status_is_retryable(422));

        // 2xx and 3xx are not error states and should not be classified as retryable.
        assert!(!gateway_status_is_retryable(200));
        assert!(!gateway_status_is_retryable(301));
    }

    #[tokio::test]
    async fn execute_tool_read_file_missing_path() {
        let (content, is_error) = ChatModelWorker::execute_tool("read_file", "{}").await;
        assert!(is_error);
        assert!(content.contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn execute_tool_read_file_base64_round_trips_bytes() {
        // Critical regression guard: the read_file_base64 dispatcher arm must
        // hand off to crate::files::read_file_base64 and return real base64.
        // Without this wiring, agents have no typed path to upload binary
        // files (PDF, images) to API publishers like seren-docreader.
        use base64::{Engine, engine::general_purpose::STANDARD};
        use std::io::Write;

        // Use a binary payload that includes a NUL byte so a string-based
        // read_file would either fail or corrupt the content — proves the
        // base64 path is reading raw bytes, not UTF-8.
        let payload: &[u8] = &[0x25, 0x50, 0x44, 0x46, 0x00, 0xFF, 0xC0, 0xA9];
        let mut tmp = tempfile::NamedTempFile::new().expect("create tempfile");
        tmp.write_all(payload).expect("write payload");
        let path = tmp.path().to_string_lossy().to_string();

        let args = serde_json::json!({ "path": path }).to_string();
        let (content, is_error) =
            ChatModelWorker::execute_tool("read_file_base64", &args).await;

        assert!(!is_error, "read_file_base64 returned error: {}", content);
        let decoded = STANDARD
            .decode(content.as_bytes())
            .expect("dispatcher must return valid base64");
        assert_eq!(decoded, payload, "round-tripped bytes must match input");

        // Empty path is a user error, not a panic.
        let (err_content, err_flag) =
            ChatModelWorker::execute_tool("read_file_base64", "{}").await;
        assert!(err_flag);
        assert!(err_content.contains("Missing required parameter"));
    }

    #[tokio::test]
    async fn execute_tool_unknown_tool() {
        let (content, is_error) = ChatModelWorker::execute_tool("nonexistent_tool", "{}").await;
        assert!(is_error);
        assert!(content.contains("not available in chat mode"));
    }

    #[tokio::test]
    async fn execute_tool_invalid_arguments() {
        let (content, is_error) = ChatModelWorker::execute_tool("read_file", "not json").await;
        assert!(is_error);
        assert!(content.contains("Failed to parse tool arguments"));
    }

    #[tokio::test]
    async fn execute_tool_path_exists() {
        // Check a path that definitely exists
        let args = serde_json::json!({"path": "/"}).to_string();
        let (content, is_error) = ChatModelWorker::execute_tool("path_exists", &args).await;
        assert!(!is_error);
        assert_eq!(content, "true");
    }

    #[tokio::test]
    async fn execute_tool_path_not_exists() {
        let args = serde_json::json!({"path": "/definitely/not/a/real/path/12345"}).to_string();
        let (content, is_error) = ChatModelWorker::execute_tool("path_exists", &args).await;
        assert!(!is_error);
        assert_eq!(content, "false");
    }

    #[test]
    fn with_tools_stores_definitions() {
        let tools = vec![serde_json::json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {}}
            }
        })];
        let worker = ChatModelWorker::with_tools(tools.clone(), None);
        // `with_tools` injects `write_pdf_from_html` (GH #1585) at the front
        // of the list, so the caller's tools follow. Assert both are present
        // and read_file is preserved.
        assert_eq!(worker.tool_definitions.len(), 2);
        let names: Vec<&str> = worker
            .tool_definitions
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap_or(""))
            .collect();
        assert!(names.contains(&"write_pdf_from_html"));
        assert!(names.contains(&"read_file"));
    }

    #[test]
    fn inject_local_tool_definitions_is_idempotent() {
        // If the frontend catalog ever ships `write_pdf_from_html`, we must
        // not duplicate it. (GH #1585)
        let existing = vec![serde_json::json!({
            "type": "function",
            "function": {"name": "write_pdf_from_html"}
        })];
        let result = ChatModelWorker::inject_local_tool_definitions(existing);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["function"]["name"], "write_pdf_from_html");
    }

    fn make_tool(name: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": name,
                "description": "A tool",
                "parameters": {"type": "object", "properties": {}}
            }
        })
    }

    #[test]
    fn tool_inventory_lists_all_publishers() {
        let tools = vec![
            make_tool("gateway__gmail__get_messages"),
            make_tool("gateway__gmail__send_message"),
            make_tool("gateway__google-calendar__list_events"),
            make_tool("gateway__google-contacts__search"),
            make_tool("gateway__firecrawl-serenai__scrape"),
            make_tool("read_file"),
            make_tool("write_file"),
        ];
        let inventory = ChatModelWorker::build_tool_inventory(&tools);

        // All publishers must appear
        assert!(inventory.contains("gmail"), "gmail missing from inventory");
        assert!(inventory.contains("google-calendar"), "google-calendar missing");
        assert!(inventory.contains("google-contacts"), "google-contacts missing");
        assert!(inventory.contains("firecrawl-serenai"), "firecrawl missing");

        // Tool counts must be correct
        assert!(inventory.contains("gmail** (2 tools)"), "gmail should have 2 tools");
        assert!(inventory.contains("google-calendar** (1 tools)"), "calendar should have 1 tool");

        // Local tools listed
        assert!(inventory.contains("read_file"));
        assert!(inventory.contains("write_file"));

        // Must contain the instruction
        assert!(inventory.contains("Always check your available tools"));
    }

    #[test]
    fn tool_inventory_injected_into_system_prompt() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };
        let tools = vec![
            make_tool("gateway__gmail__get_messages"),
            make_tool("gateway__google-calendar__list_events"),
            make_tool("read_file"),
        ];

        let body = worker.build_request_body("Hello", &[], &routing, "", &tools, &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        assert!(system_msg.contains("gmail"), "system prompt must list gmail publisher");
        assert!(
            system_msg.contains("google-calendar"),
            "system prompt must list google-calendar publisher"
        );
        assert!(
            system_msg.contains("Always check your available tools"),
            "system prompt must instruct model to check tools"
        );
    }

    #[test]
    fn tool_inventory_coexists_with_skill_content() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };
        let tools = vec![make_tool("gateway__gmail__send_message")];
        let skill_content = "# Active Skills\n\n## Skill: Google Docs\n\nCreate documents.";

        let body = worker.build_request_body("Hello", &[], &routing, skill_content, &tools, &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        // Both sections present
        assert!(system_msg.contains("gmail"), "tool inventory must be present");
        assert!(system_msg.contains("Active Skills"), "skill content must be present");
        assert!(system_msg.contains("Google Docs"), "skill details must be present");
    }

    /// GH #1592 (follows from #1591): the system prompt must tell the model
    /// to prefer a specific `gateway__*` publisher over generic Playwright
    /// browser automation when the request maps onto a connected publisher.
    ///
    /// One critical invariant — the string is present — because this change
    /// only adds static text. Behaviour changes (if any) are observed in
    /// live agent runs, not unit-testable without a mocked LLM.
    #[test]
    fn system_prompt_carries_publisher_routing_rules() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "Chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body = worker.build_request_body("Hi", &[], &routing, "", &[], &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        assert!(
            system_msg.contains("Publisher-routing rules"),
            "system prompt must carry the Publisher-routing rules header"
        );
        // At least one canonical example is surfaced — guards against the
        // block being silently gutted to a no-op string.
        assert!(
            system_msg.contains("gateway__gmail__*"),
            "system prompt must name gateway__gmail__* as the preferred route for email asks"
        );
        // The guard against starting with Playwright for connected
        // publishers (the exact #1591 failure mode) must be present.
        assert!(
            system_msg.contains("Do not start with Playwright"),
            "system prompt must explicitly tell the model not to start with Playwright for publisher-backed services"
        );
    }

    #[test]
    fn system_prompt_includes_auth_context() {
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body = worker.build_request_body("Hi", &[], &routing, "", &[], &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        assert!(
            system_msg.contains("pre-authenticated"),
            "system prompt must tell model that tools are pre-authenticated"
        );
        assert!(
            system_msg.contains("SEREN_API_KEY"),
            "system prompt must explicitly mention SEREN_API_KEY so model never asks for it"
        );
    }

    #[test]
    fn system_prompt_pins_current_utc_date() {
        // Regression for #1579: document-generation tasks (invoices, reports)
        // must stamp the real current date even when RLM has trimmed history.
        // The system prompt is never trimmed, so we pin a formatted UTC date
        // at the top. We assert the format and today's year are present —
        // enough to catch accidental removal without being flaky at day rollover.
        let worker = ChatModelWorker::new();
        let routing = RoutingDecision {
            worker_type: super::super::types::WorkerType::ChatModel,
            model_id: "anthropic/claude-sonnet-4".to_string(),
            delegation: super::super::types::DelegationType::InLoop,
            reason: "General chat".to_string(),
            selected_skills: vec![],
            publisher_slug: None,
            reasoning_effort: None,
            project_root: None,
        };

        let body = worker.build_request_body("Hi", &[], &routing, "", &[], &[], None);
        let system_msg = body["messages"][0]["content"].as_str().unwrap();

        let current_year = seren_memory_sdk::chrono::Utc::now()
            .format("%Y")
            .to_string();
        assert!(
            system_msg.contains("Current date (UTC):"),
            "system prompt must pin a current-date line"
        );
        assert!(
            system_msg.contains(&current_year),
            "system prompt must include the current year so stamped dates are fresh"
        );
    }
}
