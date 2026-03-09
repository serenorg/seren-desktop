// ABOUTME: Recursive Language Model processor for inputs exceeding the context window.
// ABOUTME: Implements the RLM inference paradigm from Zhang et al. (arXiv 2512.24601).

use log;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::types::{ImageAttachment, WorkerEvent};

// =============================================================================
// Constants
// =============================================================================

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const PUBLISHER_SLUG: &str = "seren-models";

/// Activate RLM when input exceeds this fraction of the model's context window.
const RLM_THRESHOLD: f64 = 0.85;

/// Each chunk targets this fraction of the context window (leaves room for
/// history, system prompt, user question, and model response).
const CHUNK_TARGET_FRACTION: f64 = 0.45;

/// Overlap in characters between adjacent chunks to prevent context loss at seams.
/// ~200 tokens × 4 chars/token.
const CHUNK_OVERLAP_CHARS: usize = 800;

/// HTTP connect timeout for RLM sub-calls.
const CONNECT_TIMEOUT_SECS: u64 = 30;

/// Request timeout for RLM sub-calls (10 minutes).
const REQUEST_TIMEOUT_SECS: u64 = 600;

// =============================================================================
// Model context limits (characters, not tokens; 1 token ≈ 4 chars)
// =============================================================================

fn model_context_limit_chars(model: &str) -> usize {
    let tokens: usize = if model.contains("gemini-1.5")
        || model.contains("gemini-2")
        || model.contains("gemini-3")
    {
        1_000_000
    } else if model.contains("claude") {
        200_000
    } else if model.contains("gpt-4") {
        128_000
    } else {
        100_000
    };
    tokens * 4
}

// =============================================================================
// Public API
// =============================================================================

/// Returns true if the combined input (prompt + history + images decoded) exceeds
/// the RLM threshold for the given model.
pub fn needs_rlm(
    prompt: &str,
    history: &[serde_json::Value],
    images: &[ImageAttachment],
    model: &str,
) -> bool {
    let limit = model_context_limit_chars(model);
    let threshold = (limit as f64 * RLM_THRESHOLD) as usize;

    let prompt_chars = prompt.len();
    let history_chars: usize = history
        .iter()
        .map(|msg| {
            msg.get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.len())
                .unwrap_or(0)
        })
        .sum();
    // Text-based image attachments decoded from base64: rough estimate
    let image_chars: usize = images
        .iter()
        .filter(|img| {
            img.mime_type.starts_with("text/")
                || img.mime_type == "application/pdf"
                || img.mime_type.contains("javascript")
                || img.mime_type.contains("json")
        })
        .map(|img| {
            // base64 → raw bytes ≈ 3/4 of base64 length; treat as chars
            img.base64.len() * 3 / 4
        })
        .sum();

    let total = prompt_chars + history_chars + image_chars;
    log::debug!(
        "[RLM] Token estimate: {total} chars vs threshold {threshold} chars (model={model})"
    );
    total > threshold
}

/// Process a prompt that exceeds the context window using the RLM approach.
///
/// Emits `RlmStart`, one `RlmChunkComplete` per chunk, then the normal
/// `Content` + `Complete` events so the existing frontend pipeline needs no
/// special handling of the final answer.
pub async fn process(
    app: &AppHandle,
    _conversation_id: &str,
    prompt: &str,
    history: &[serde_json::Value],
    model: &str,
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<(), String> {
    log::info!("[RLM] Starting RLM processing for model={model}");

    let limit = model_context_limit_chars(model);
    let chunk_budget = (limit as f64 * CHUNK_TARGET_FRACTION) as usize;

    // 1. Extract the long content and the user question.
    // The question is the last paragraph / sentence of the prompt;
    // the content is everything else. If the prompt has no clear separator,
    // treat the whole prompt as content and repeat it as the question.
    let (content, question) = split_content_and_question(prompt);

    // 2. Classify the task
    let strategy = classify_task(app, &question, model).await.unwrap_or_else(|e| {
        log::warn!("[RLM] Classification failed ({e}), defaulting to sequential");
        RlmStrategy::Sequential
    });
    log::info!("[RLM] Strategy: {strategy:?}");

    // 3. Chunk the content
    let chunks = chunk_content(&content, chunk_budget);
    let chunk_count = chunks.len();
    log::info!("[RLM] Split into {chunk_count} chunks");

    // Emit RlmStart so the frontend can show the status indicator
    let _ = event_tx
        .send(WorkerEvent::RlmStart { chunk_count })
        .await;

    // 4. Process chunks
    let (final_answer, chunk_results) = match strategy {
        RlmStrategy::Synthesis => {
            process_map_reduce(app, &question, &chunks, model, history, event_tx).await?
        }
        RlmStrategy::Sequential => {
            process_sequential(app, &question, &chunks, model, history, event_tx).await?
        }
    };

    // 5. Emit the final answer as normal Content + Complete events so the
    //    existing frontend message pipeline handles it without changes.
    //    Attach chunk results in the Complete payload via the rlm_steps field.
    let _ = event_tx
        .send(WorkerEvent::Content {
            text: final_answer.clone(),
        })
        .await;

    // Serialize chunk results as JSON for the Complete metadata
    let steps_json = serde_json::to_string(&chunk_results).unwrap_or_default();

    let _ = event_tx
        .send(WorkerEvent::Complete {
            final_content: final_answer,
            thinking: None,
            cost: None,
            rlm_steps: Some(steps_json),
        })
        .await;

    // Also emit the OrchestratorEvent wrapper directly so the frontend receives it.
    // (event_tx is consumed by service.rs which wraps and emits; no double-emit needed.)

    Ok(())
}

// =============================================================================
// Task classification
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
enum RlmStrategy {
    /// Answer requires reasoning across the whole document. Use map-reduce.
    Synthesis,
    /// Answer can be built chunk-by-chunk. Use rolling context.
    Sequential,
}

/// Ask the model to classify the task with a single, cheap, non-streaming call.
async fn classify_task(
    app: &AppHandle,
    question: &str,
    model: &str,
) -> Result<RlmStrategy, String> {
    let client = build_client();
    let url = format!(
        "{}/publishers/{}/chat/completions",
        GATEWAY_BASE_URL, PUBLISHER_SLUG
    );

    let system = "You are a task classifier. Respond with exactly one word.";
    let user = format!(
        "Classify this task as either \"synthesis\" (requires reasoning across a whole document: \
         summarize, analyze, compare, find themes) or \"sequential\" (can be done chunk by chunk: \
         translate, reformat, extract).\n\nTask: {question}\n\nRespond with exactly one word: \
         synthesis or sequential"
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user}
        ],
        "stream": false,
        "max_tokens": 10
    });

    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let response = crate::auth::authenticated_request(app, &client, |c, token| {
        c.post(&url)
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .body(body_str.clone())
    })
    .await?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Read classify response: {e}"))?;

    if !status.is_success() {
        return Err(format!("Classify HTTP {status}: {text}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Parse classify response: {e}"))?;

    let answer = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    Ok(if answer.contains("sequential") {
        RlmStrategy::Sequential
    } else {
        RlmStrategy::Synthesis
    })
}

// =============================================================================
// Chunking
// =============================================================================

#[derive(Debug, Clone)]
struct Chunk {
    index: usize,
    total: usize,
    text: String,
}

/// Split `content` into chunks that each fit within `budget` characters.
///
/// Priority order for split points:
/// 1. Markdown/numbered headings
/// 2. Double newlines (paragraphs)
/// 3. Single newlines
/// 4. Sentence-ending punctuation
/// 5. Fixed character count (fallback)
///
/// Adjacent chunks share `CHUNK_OVERLAP_CHARS` chars at their boundary.
fn chunk_content(content: &str, budget: usize) -> Vec<Chunk> {
    let raw = split_at_budget(content, budget);
    let total = raw.len();
    raw.into_iter()
        .enumerate()
        .map(|(i, text)| Chunk {
            index: i,
            total,
            text,
        })
        .collect()
}

fn split_at_budget(text: &str, budget: usize) -> Vec<String> {
    if text.len() <= budget {
        return vec![text.to_string()];
    }

    // Try to find the best split point within [budget/2 .. budget]
    let window_start = budget / 2;
    let search_region = &text[..budget.min(text.len())];

    // Priority 1: heading boundary (line starting with #, or "N. ", "N) ")
    if let Some(pos) = find_heading_boundary(search_region, window_start) {
        let (head, _tail) = text.split_at(pos);
        let overlap_start = head.len().saturating_sub(CHUNK_OVERLAP_CHARS);
        let tail_with_overlap = &text[overlap_start..];
        let mut result = vec![head.to_string()];
        result.extend(split_at_budget(tail_with_overlap, budget));
        return result;
    }

    // Priority 2: double newline (paragraph)
    if let Some(pos) = rfind_in_range(search_region, "\n\n", window_start) {
        let (head, _tail) = text.split_at(pos + 2);
        let overlap_start = head.len().saturating_sub(CHUNK_OVERLAP_CHARS);
        let tail_with_overlap = &text[overlap_start..];
        let mut result = vec![head.to_string()];
        result.extend(split_at_budget(tail_with_overlap, budget));
        return result;
    }

    // Priority 3: single newline
    if let Some(pos) = rfind_in_range(search_region, "\n", window_start) {
        let (head, _tail) = text.split_at(pos + 1);
        let overlap_start = head.len().saturating_sub(CHUNK_OVERLAP_CHARS);
        let tail_with_overlap = &text[overlap_start..];
        let mut result = vec![head.to_string()];
        result.extend(split_at_budget(tail_with_overlap, budget));
        return result;
    }

    // Priority 4: sentence boundary (". ", "! ", "? ")
    for sep in &[". ", "! ", "? "] {
        if let Some(pos) = rfind_in_range(search_region, sep, window_start) {
            let (head, _tail) = text.split_at(pos + sep.len());
            let overlap_start = head.len().saturating_sub(CHUNK_OVERLAP_CHARS);
            let tail_with_overlap = &text[overlap_start..];
            let mut result = vec![head.to_string()];
            result.extend(split_at_budget(tail_with_overlap, budget));
            return result;
        }
    }

    // Priority 5: hard cut at budget (ensure valid UTF-8 boundary)
    let cut = floor_char_boundary(text, budget);
    let (head, _tail) = text.split_at(cut);
    let overlap_start = head.len().saturating_sub(CHUNK_OVERLAP_CHARS);
    let tail_with_overlap = &text[overlap_start..];
    let mut result = vec![head.to_string()];
    result.extend(split_at_budget(tail_with_overlap, budget));
    result
}

/// Find the last occurrence of `needle` in `haystack` at or after `min_pos`.
fn rfind_in_range(haystack: &str, needle: &str, min_pos: usize) -> Option<usize> {
    haystack[..haystack.len()]
        .rmatch_indices(needle)
        .find(|(pos, _)| *pos >= min_pos)
        .map(|(pos, _)| pos)
}

/// Find a heading-style line boundary after `min_pos`.
fn find_heading_boundary(text: &str, min_pos: usize) -> Option<usize> {
    for (i, _) in text.match_indices('\n') {
        if i < min_pos {
            continue;
        }
        let rest = &text[i + 1..];
        if rest.starts_with('#')
            || rest
                .chars()
                .next()
                .map(|c| c.is_ascii_digit())
                .unwrap_or(false)
        {
            return Some(i + 1);
        }
    }
    None
}

/// Round down to the largest valid UTF-8 char boundary ≤ `index`.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

// =============================================================================
// Map-reduce strategy
// =============================================================================

/// Process all chunks in parallel, then merge results in a final call.
async fn process_map_reduce(
    app: &AppHandle,
    question: &str,
    chunks: &[Chunk],
    model: &str,
    history: &[serde_json::Value],
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<(String, Vec<ChunkResult>), String> {
    // Process all chunks concurrently
    let tasks: Vec<_> = chunks
        .iter()
        .map(|chunk| {
            let app = app.clone();
            let question = question.to_string();
            let chunk_text = chunk.text.clone();
            let model = model.to_string();
            let idx = chunk.index;
            let total = chunk.total;
            tokio::spawn(async move {
                let result =
                    call_chunk(&app, &question, &chunk_text, &model, &[], idx, total).await;
                (idx, total, result)
            })
        })
        .collect();

    let mut chunk_results: Vec<ChunkResult> = Vec::with_capacity(chunks.len());
    let mut summaries: Vec<String> = vec![String::new(); chunks.len()];

    for task in tasks {
        let (idx, total, result) = task
            .await
            .map_err(|e| format!("RLM chunk task panicked: {e}"))?;
        let summary = result?;

        let _ = event_tx
            .send(WorkerEvent::RlmChunkComplete {
                index: idx,
                total,
                summary: summary.clone(),
            })
            .await;

        summaries[idx] = summary.clone();
        chunk_results.push(ChunkResult {
            index: idx,
            total,
            summary,
        });
    }

    // Sort by index for the merge prompt
    chunk_results.sort_by_key(|r| r.index);

    // Merge all chunk summaries into a final answer
    let merge_prompt = build_merge_prompt(question, &summaries);
    let final_answer = call_simple(app, &merge_prompt, model, history).await?;

    Ok((final_answer, chunk_results))
}

// =============================================================================
// Sequential (rolling context) strategy
// =============================================================================

/// Process chunks in order, each building on the previous summary.
async fn process_sequential(
    app: &AppHandle,
    question: &str,
    chunks: &[Chunk],
    model: &str,
    history: &[serde_json::Value],
    event_tx: &mpsc::Sender<WorkerEvent>,
) -> Result<(String, Vec<ChunkResult>), String> {
    let mut chunk_results: Vec<ChunkResult> = Vec::with_capacity(chunks.len());
    let mut running_summary = String::new();
    let mut last_answer = String::new();

    for chunk in chunks {
        let prompt = if running_summary.is_empty() {
            format!(
                "Question: {question}\n\nDocument section {}/{} :\n\n{}",
                chunk.index + 1,
                chunk.total,
                chunk.text
            )
        } else {
            format!(
                "Question: {question}\n\nProgress so far:\n{running_summary}\n\n\
                 Document section {}/{} :\n\n{}",
                chunk.index + 1,
                chunk.total,
                chunk.text
            )
        };

        let answer = call_simple(app, &prompt, model, history).await?;

        let _ = event_tx
            .send(WorkerEvent::RlmChunkComplete {
                index: chunk.index,
                total: chunk.total,
                summary: answer.clone(),
            })
            .await;

        running_summary = answer.clone();
        last_answer = answer.clone();
        chunk_results.push(ChunkResult {
            index: chunk.index,
            total: chunk.total,
            summary: answer,
        });
    }

    Ok((last_answer, chunk_results))
}

// =============================================================================
// HTTP helpers
// =============================================================================

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// Call the model on a single chunk, returning a text summary.
async fn call_chunk(
    app: &AppHandle,
    question: &str,
    chunk_text: &str,
    model: &str,
    history: &[serde_json::Value],
    index: usize,
    total: usize,
) -> Result<String, String> {
    let prompt = format!(
        "Question: {question}\n\nDocument section {}/{} :\n\n{chunk_text}\n\n\
         Answer the question based only on the content in this section. \
         If the section does not contain relevant information, say so briefly.",
        index + 1,
        total
    );
    call_simple(app, &prompt, model, history).await
}

/// Make a simple non-streaming completion call and return the text response.
async fn call_simple(
    app: &AppHandle,
    prompt: &str,
    model: &str,
    history: &[serde_json::Value],
) -> Result<String, String> {
    let client = build_client();
    let url = format!(
        "{}/publishers/{}/chat/completions",
        GATEWAY_BASE_URL, PUBLISHER_SLUG
    );

    let mut messages: Vec<serde_json::Value> = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": "You are a helpful AI assistant."
    }));
    for msg in history {
        messages.push(msg.clone());
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": prompt
    }));

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false
    });
    let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    let response = crate::auth::authenticated_request(app, &client, |c, token| {
        c.post(&url)
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .body(body_str.clone())
    })
    .await?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Read RLM response body: {e}"))?;

    if !status.is_success() {
        return Err(format!("RLM sub-call HTTP {status}: {text}"));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("Parse RLM response: {e}"))?;

    json.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("No content in RLM response: {text}"))
}

// =============================================================================
// Prompts and result types
// =============================================================================

/// Chunk processing result stored as metadata on the final message.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChunkResult {
    pub index: usize,
    pub total: usize,
    pub summary: String,
}

/// Build the merge prompt for map-reduce aggregation.
fn build_merge_prompt(question: &str, summaries: &[String]) -> String {
    let parts: Vec<String> = summaries
        .iter()
        .enumerate()
        .map(|(i, s)| format!("Section {} answer:\n{s}", i + 1))
        .collect();
    format!(
        "Question: {question}\n\nI processed a large document in {} sections. \
         Here are the answers from each section:\n\n{}\n\n\
         Synthesize these section answers into a single, coherent final answer to the question.",
        summaries.len(),
        parts.join("\n\n")
    )
}

/// Split the prompt into (content, question).
///
/// If the prompt contains two or more paragraphs, treats everything except the
/// last paragraph as content and the last paragraph as the question.
/// Otherwise treats the entire prompt as both content and question.
fn split_content_and_question(prompt: &str) -> (String, String) {
    let trimmed = prompt.trim();
    if let Some(pos) = trimmed.rfind("\n\n") {
        let content = trimmed[..pos].trim().to_string();
        let question = trimmed[pos + 2..].trim().to_string();
        if !content.is_empty() && !question.is_empty() {
            return (content, question);
        }
    }
    // Fallback: whole prompt is both content and question
    (trimmed.to_string(), trimmed.to_string())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_rlm_returns_false_for_short_input() {
        let prompt = "What is the capital of France?";
        let history: Vec<serde_json::Value> = vec![];
        let images: Vec<ImageAttachment> = vec![];
        assert!(!needs_rlm(prompt, &history, &images, "anthropic/claude-sonnet-4"));
    }

    #[test]
    fn needs_rlm_returns_true_for_oversized_input() {
        // Generate a prompt larger than 85% of 200k tokens × 4 chars = 680k chars
        let prompt = "a".repeat(700_000);
        let history: Vec<serde_json::Value> = vec![];
        let images: Vec<ImageAttachment> = vec![];
        assert!(needs_rlm(&prompt, &history, &images, "anthropic/claude-sonnet-4"));
    }

    #[test]
    fn chunk_content_single_chunk_when_small() {
        let text = "Short text.";
        let chunks = chunk_content(text, 1000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, text);
        assert_eq!(chunks[0].total, 1);
    }

    #[test]
    fn chunk_content_splits_at_paragraph() {
        let para1 = "a".repeat(600);
        let para2 = "b".repeat(600);
        let text = format!("{}\n\n{}", para1, para2);
        let chunks = chunk_content(&text, 800);
        // Should split into at least 2 chunks
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn split_content_and_question_splits_on_double_newline() {
        let prompt = "This is the long document content.\n\nWhat is the main theme?";
        let (content, question) = split_content_and_question(prompt);
        assert_eq!(content, "This is the long document content.");
        assert_eq!(question, "What is the main theme?");
    }

    #[test]
    fn split_content_and_question_falls_back_for_single_paragraph() {
        let prompt = "A single paragraph prompt with no double newline.";
        let (content, question) = split_content_and_question(prompt);
        assert_eq!(content, prompt);
        assert_eq!(question, prompt);
    }

    #[test]
    fn build_merge_prompt_includes_all_summaries() {
        let question = "What is the theme?";
        let summaries = vec!["Theme A".to_string(), "Theme B".to_string()];
        let prompt = build_merge_prompt(question, &summaries);
        assert!(prompt.contains(question));
        assert!(prompt.contains("Theme A"));
        assert!(prompt.contains("Theme B"));
        assert!(prompt.contains("2 sections"));
    }
}
