// ABOUTME: BM25-based tool relevance scoring for per-request tool selection.
// ABOUTME: Replaces naive byte-budget truncation with query-aware tool ranking.

use std::collections::HashMap;

/// BM25 tuning constants (Robertson et al., standard values).
const K1: f32 = 1.5;
const B: f32 = 0.75;
/// Estimated average tool document length in words (name + description + props).
const AVG_TOOL_WORDS: f32 = 60.0;

/// Approximate token count: 4 characters ≈ 1 token for typical JSON schema text.
const CHARS_PER_TOKEN: usize = 4;

/// Token budget for selected tools sent to the model per request.
/// At ~49 tokens/tool average, 12,000 supports ~245 tools.
/// The frontend already caps at model-specific limits (Gemini 256, GPT 128).
const TOOL_TOKEN_BUDGET: usize = 12_000;

/// Minimum tools always included regardless of BM25 score.
const MIN_TOOLS: usize = 5;

/// Soft cap: never send more than this many tools even if budget allows.
/// Set high because the frontend already enforces per-model limits;
/// the backend should not aggressively re-filter.
const MAX_TOOLS: usize = 200;

/// Hard byte budget as a final safety net against HTTP 413 responses from the
/// Gateway. BM25 selection is the primary mechanism; this catches edge cases.
const HARD_BYTE_BUDGET: usize = 400 * 1024;

/// Local tools that are always included regardless of BM25 score.
/// These are fundamental capabilities the model needs constant access to —
/// without them it cannot read/write files or execute commands.
const PINNED_TOOL_NAMES: &[&str] = &[
    "read_file",
    "write_file",
    "list_directory",
    "path_exists",
    "create_directory",
    "seren_web_fetch",
    "execute_command",
];

/// Check if a tool definition matches a pinned tool name.
fn is_pinned_tool(tool: &serde_json::Value) -> bool {
    tool.pointer("/function/name")
        .and_then(|v| v.as_str())
        .map(|name| PINNED_TOOL_NAMES.contains(&name))
        .unwrap_or(false)
}

/// Select the most relevant tools for the given query within the token budget.
///
/// Tools are in OpenAI function-calling format:
/// `{ "type": "function", "function": { "name": ..., "description": ..., "parameters": ... } }`
///
/// # Algorithm
/// 1. Fast-path: if the tool list already fits the budget, return it as-is.
/// 2. Separate pinned tools (local tools) from the pool — they are always included.
/// 3. Score remaining tools with BM25 against name + description + parameter names/descriptions.
/// 4. Sort by score descending; greedily select within the remaining token budget,
///    guaranteeing at least `MIN_TOOLS` total (including pinned).
/// 5. Restore original frontend priority ordering in the final selection.
/// 6. Apply the hard byte budget as a final safety net.
pub fn select_relevant_tools(query: &str, tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    // Fast path: no scoring needed when the set is small enough.
    let total_bytes = serde_json::to_string(tools)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if total_bytes <= HARD_BYTE_BUDGET && tools.len() <= MAX_TOOLS {
        return tools.to_vec();
    }

    if tools.is_empty() {
        return Vec::new();
    }

    // Partition into pinned (always-included) and non-pinned (BM25-scored) tools,
    // preserving original indices for ordering restoration.
    let mut pinned_indices: Vec<usize> = Vec::new();
    let mut pool_indices: Vec<usize> = Vec::new();
    for (i, tool) in tools.iter().enumerate() {
        if is_pinned_tool(tool) {
            pinned_indices.push(i);
        } else {
            pool_indices.push(i);
        }
    }

    // Account for pinned tools in the budget.
    let pinned_tokens: usize = pinned_indices
        .iter()
        .map(|&i| approximate_tokens(&tool_text(&tools[i])))
        .sum();

    let query_terms = tokenize(query);
    if query_terms.is_empty() {
        return apply_hard_budget(tools);
    }

    // Score only the non-pinned pool.
    let pool_docs: Vec<String> = pool_indices.iter().map(|&i| tool_text(&tools[i])).collect();
    let pool_scores = bm25_scores(&query_terms, &pool_docs);

    // Rank pool tools by score descending.
    let mut ranked: Vec<(usize, f32)> = pool_scores.into_iter().enumerate().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Greedily pick pool tools into the remaining budget.
    let mut selected_indices: Vec<usize> = pinned_indices.clone();
    let mut token_count: usize = pinned_tokens;
    let remaining_slots = MAX_TOOLS.saturating_sub(pinned_indices.len());
    let total_min = MIN_TOOLS.saturating_sub(pinned_indices.len());

    let mut pool_picked: usize = 0;
    for (pool_idx, _score) in &ranked {
        if pool_picked >= remaining_slots {
            break;
        }
        let original_idx = pool_indices[*pool_idx];
        let tool_tokens = approximate_tokens(&pool_docs[*pool_idx]);
        let budget_exceeded =
            token_count + tool_tokens > TOOL_TOKEN_BUDGET && pool_picked >= total_min;
        if budget_exceeded {
            break;
        }
        selected_indices.push(original_idx);
        token_count += tool_tokens;
        pool_picked += 1;
    }

    // Restore original ordering so the frontend's priority ranking is preserved.
    selected_indices.sort_unstable();

    let result: Vec<serde_json::Value> =
        selected_indices.iter().map(|&i| tools[i].clone()).collect();

    log::info!(
        "[ToolRelevance] Selected {} of {} tools ({} pinned + {} scored, ~{} tokens)",
        result.len(),
        tools.len(),
        pinned_indices.len(),
        pool_picked,
        token_count,
    );

    apply_hard_budget(&result)
}

// =============================================================================
// Internal helpers
// =============================================================================

/// Extract indexable text from an OpenAI-format tool definition.
///
/// Concatenates: function name + description + parameter names + parameter descriptions.
/// For MCP tools with the `mcp__<publisher>__<action>` naming convention, the publisher
/// name is extracted and repeated to boost its BM25 term frequency — so queries
/// mentioning "google" or "slack" naturally rank that publisher's tools higher.
fn tool_text(tool: &serde_json::Value) -> String {
    let mut parts: Vec<&str> = Vec::new();

    let publisher_boost: String;
    if let Some(name) = tool.pointer("/function/name").and_then(|v| v.as_str()) {
        parts.push(name);

        // Boost publisher name for MCP tools: mcp__<publisher>__<action>
        if let Some(publisher) = extract_mcp_publisher(name) {
            // Repeat publisher 3x to give it strong BM25 weight without
            // overwhelming the description/param signals.
            publisher_boost = format!("{publisher} {publisher} {publisher}");
            parts.push(&publisher_boost);
        }
    }
    if let Some(desc) = tool
        .pointer("/function/description")
        .and_then(|v| v.as_str())
    {
        parts.push(desc);
    }

    // Include parameter names and descriptions for keyword matching.
    let prop_strings: Vec<String>;
    if let Some(props) = tool
        .pointer("/function/parameters/properties")
        .and_then(|v| v.as_object())
    {
        prop_strings = props
            .iter()
            .flat_map(|(key, val)| {
                let mut items = vec![key.clone()];
                if let Some(pdesc) = val.get("description").and_then(|v| v.as_str()) {
                    items.push(pdesc.to_string());
                }
                items
            })
            .collect();
        for s in &prop_strings {
            parts.push(s.as_str());
        }
    }

    parts.join(" ").to_lowercase()
}

/// Extract the publisher name from a tool name following the
/// `mcp__<publisher>__<action>` or `gateway__<publisher>__<action>` convention.
/// Returns None for tools that don't use either prefix.
pub fn extract_mcp_publisher(tool_name: &str) -> Option<&str> {
    let rest = tool_name
        .strip_prefix("mcp__")
        .or_else(|| tool_name.strip_prefix("gateway__"))?;
    let publisher = rest.split("__").next()?;
    if publisher.is_empty() {
        return None;
    }
    Some(publisher)
}

/// Tokenize text into lowercase alphanumeric tokens, filtering single chars.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(|t| t.to_lowercase())
        .collect()
}

/// Compute BM25 scores for each document given the query terms.
///
/// Uses BM25 with k1=1.5, b=0.75, Okapi IDF smoothing, and a fixed average
/// document length estimate. IDF is precomputed per query term to avoid O(n²).
fn bm25_scores(query_terms: &[String], docs: &[String]) -> Vec<f32> {
    let n = docs.len() as f32;
    let tokenized_docs: Vec<Vec<String>> = docs.iter().map(|d| tokenize(d)).collect();

    // Precompute document frequency per query term (O(n·q) not O(n²·q)).
    let df_map: HashMap<&str, f32> = query_terms
        .iter()
        .map(|term| {
            let df = tokenized_docs
                .iter()
                .filter(|doc| doc.iter().any(|t| t == term))
                .count() as f32;
            (term.as_str(), df)
        })
        .collect();

    tokenized_docs
        .iter()
        .map(|doc_terms| {
            let dl = doc_terms.len() as f32;
            let length_norm = K1 * (1.0 - B + B * dl / AVG_TOOL_WORDS);

            query_terms
                .iter()
                .map(|term| {
                    let tf = doc_terms.iter().filter(|t| *t == term).count() as f32;
                    if tf == 0.0 {
                        return 0.0;
                    }
                    let df_t = df_map.get(term.as_str()).copied().unwrap_or(0.0);
                    // Okapi IDF with smoothing (prevents log(0)).
                    let idf = ((n - df_t + 0.5) / (df_t + 0.5) + 1.0).ln();
                    let tf_norm = tf * (K1 + 1.0) / (tf + length_norm);
                    idf * tf_norm
                })
                .sum::<f32>()
        })
        .collect()
}

/// Approximate token count for a document string (4 chars ≈ 1 token).
fn approximate_tokens(text: &str) -> usize {
    (text.len() / CHARS_PER_TOKEN).max(1)
}

/// Apply the hard 400 KB byte budget as a final safety net.
fn apply_hard_budget(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let total = serde_json::to_string(tools)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if total <= HARD_BYTE_BUDGET {
        return tools.to_vec();
    }

    let mut result: Vec<serde_json::Value> = Vec::with_capacity(tools.len());
    let mut running: usize = 2; // outer `[` and `]`

    for tool in tools {
        let bytes = serde_json::to_string(tool).unwrap_or_default().len() + 1;
        if running + bytes > HARD_BYTE_BUDGET {
            break;
        }
        running += bytes;
        result.push(tool.clone());
    }

    log::warn!(
        "[ToolRelevance] Hard byte budget applied: keeping {} of {} tools ({} bytes)",
        result.len(),
        tools.len(),
        running,
    );

    result
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_tool(name: &str, description: &str) -> serde_json::Value {
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }

    fn make_tool_with_params(
        name: &str,
        description: &str,
        params: &[(&str, &str)],
    ) -> serde_json::Value {
        let props: serde_json::Map<String, serde_json::Value> = params
            .iter()
            .map(|(k, desc)| {
                (
                    k.to_string(),
                    json!({ "type": "string", "description": desc }),
                )
            })
            .collect();
        json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": { "type": "object", "properties": props }
            }
        })
    }

    #[test]
    fn fast_path_when_small_set() {
        let tools: Vec<serde_json::Value> = (0..5)
            .map(|i| make_tool(&format!("tool_{i}"), "short desc"))
            .collect();
        let result = select_relevant_tools("any query", &tools);
        assert_eq!(
            result.len(),
            tools.len(),
            "small set should pass through unchanged"
        );
    }

    #[test]
    fn empty_tools_returns_empty() {
        let result = select_relevant_tools("some query", &[]);
        assert!(result.is_empty());
    }

    #[test]
    fn empty_query_falls_back_gracefully() {
        let tools: Vec<serde_json::Value> = (0..5)
            .map(|i| make_tool(&format!("tool_{i}"), "some description"))
            .collect();
        let result = select_relevant_tools("", &tools);
        assert!(
            !result.is_empty(),
            "should still return tools on empty query"
        );
    }

    #[test]
    fn relevant_tool_scores_higher_than_unrelated() {
        let tools = vec![
            make_tool("file_read", "Read file contents from the filesystem"),
            make_tool("database_query", "Execute SQL queries against a database"),
            make_tool("send_email", "Send an email message to a recipient"),
        ];
        let query_terms = tokenize("read a file from disk");
        let docs: Vec<String> = tools.iter().map(tool_text).collect();
        let scores = bm25_scores(&query_terms, &docs);

        assert!(
            scores[0] > scores[1],
            "file_read ({:.3}) should outscore database_query ({:.3})",
            scores[0],
            scores[1]
        );
        assert!(
            scores[0] > scores[2],
            "file_read ({:.3}) should outscore send_email ({:.3})",
            scores[0],
            scores[2]
        );
    }

    #[test]
    fn irrelevant_tool_scores_zero() {
        let query_terms = tokenize("send email");
        let docs = vec!["read sql database rows count".to_string()];
        let scores = bm25_scores(&query_terms, &docs);
        assert_eq!(scores[0], 0.0, "non-matching tool should score zero");
    }

    #[test]
    fn param_descriptions_contribute_to_score() {
        let tools = vec![
            make_tool_with_params(
                "generic_action",
                "Perform an action",
                &[
                    ("email", "recipient email address"),
                    ("subject", "email subject line"),
                ],
            ),
            make_tool("file_read", "Read file contents from disk"),
        ];
        let query_terms = tokenize("send email to recipient");
        let docs: Vec<String> = tools.iter().map(tool_text).collect();
        let scores = bm25_scores(&query_terms, &docs);

        assert!(
            scores[0] > scores[1],
            "tool with matching param descriptions ({:.3}) should outscore file_read ({:.3})",
            scores[0],
            scores[1]
        );
    }

    #[test]
    fn respects_max_tools_cap() {
        // 250 tools: exceeds MAX_TOOLS. Result must be <= MAX_TOOLS.
        let mut tools: Vec<serde_json::Value> = (0..249)
            .map(|i| {
                make_tool(
                    &format!("gateway__pub_{i}__action"),
                    "some API functionality",
                )
            })
            .collect();
        tools.push(make_tool("send_email", "Send email message to a recipient"));

        let result = select_relevant_tools("send an email", &tools);
        assert!(
            result.len() <= MAX_TOOLS,
            "expected <= {MAX_TOOLS} tools, got {}",
            result.len()
        );
    }

    #[test]
    fn always_includes_at_least_min_tools_when_available() {
        let tools = vec![
            make_tool("tool_a", "alpha beta gamma delta"),
            make_tool("tool_b", "epsilon zeta eta theta"),
        ];
        let result = select_relevant_tools("xyzzyx unrelated query", &tools);
        assert!(!result.is_empty(), "must return something when tools exist");
    }

    #[test]
    fn selects_relevant_tool_over_budget_noise() {
        let mut tools: Vec<serde_json::Value> = (0..200)
            .map(|i| {
                make_tool(
                    &format!("unrelated_{i}"),
                    &format!("does something unrelated {i}"),
                )
            })
            .collect();
        tools.push(make_tool(
            "read_file",
            "read a file from the filesystem path",
        ));

        let result = select_relevant_tools("read file from filesystem", &tools);

        let has_read_file = result
            .iter()
            .any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some("read_file"));
        assert!(
            has_read_file,
            "read_file should be selected for a file-reading query"
        );
        assert!(
            result.len() < tools.len(),
            "should filter tools when over budget"
        );
    }

    #[test]
    fn original_ordering_preserved_in_output() {
        let tools = vec![
            make_tool("alpha", "alpha tool functionality"),
            make_tool("beta", "beta tool functionality"),
            make_tool("gamma", "gamma tool functionality"),
        ];
        // All 3 are tiny — fast path returns them as-is.
        let result = select_relevant_tools("gamma functionality", &tools);
        for window in result.windows(2) {
            let a_name = window[0]
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let b_name = window[1]
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let a_pos = tools
                .iter()
                .position(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some(a_name))
                .unwrap();
            let b_pos = tools
                .iter()
                .position(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some(b_name))
                .unwrap();
            assert!(a_pos < b_pos, "original ordering must be preserved");
        }
    }

    #[test]
    fn tool_text_extracts_name_description_and_params() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "execute_bash",
                "description": "Run a shell command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "shell command to run" }
                    }
                }
            }
        });
        let text = tool_text(&tool);
        assert!(text.contains("execute_bash"));
        assert!(text.contains("run a shell command"));
        assert!(text.contains("command"));
    }

    #[test]
    fn extract_mcp_publisher_parses_both_prefixes() {
        assert_eq!(
            extract_mcp_publisher("mcp__google__get_messages"),
            Some("google")
        );
        assert_eq!(
            extract_mcp_publisher("mcp__slack__post_message"),
            Some("slack")
        );
        assert_eq!(
            extract_mcp_publisher("gateway__gmail__get_messages"),
            Some("gmail")
        );
        assert_eq!(
            extract_mcp_publisher("gateway__firecrawl-serenai__scrape"),
            Some("firecrawl-serenai")
        );
        assert_eq!(extract_mcp_publisher("execute_bash"), None);
        assert_eq!(extract_mcp_publisher("mcp__"), None);
        assert_eq!(extract_mcp_publisher("gateway__"), None);
    }

    #[test]
    fn gateway_gmail_tools_selected_for_gmail_query() {
        // Simulate real scenario: 120+ tools, 17 Gmail with gateway__ prefix
        let mut tools: Vec<serde_json::Value> = Vec::new();

        let gmail_names = [
            "get_health",
            "get_messages",
            "get_messages_by_message_id",
            "post_messages_send",
            "delete_messages_by_message_id",
            "post_messages_by_message_id_trash",
            "post_messages_by_message_id_modify",
            "get_labels",
            "get_labels_by_label_id",
            "post_labels",
            "delete_labels_by_label_id",
            "get_threads",
            "get_threads_by_thread_id",
            "post_threads_by_thread_id_trash",
            "get_drafts",
            "post_drafts",
            "post_drafts_by_draft_id_send",
        ];
        for name in &gmail_names {
            tools.push(make_tool(
                &format!("gateway__gmail__{name}"),
                "Email operation",
            ));
        }

        // Fill with other publisher tools to exceed MAX_TOOLS
        for i in 0..50 {
            tools.push(make_tool(
                &format!("gateway__firecrawl-serenai__action_{i}"),
                "Web scraping",
            ));
        }
        for i in 0..50 {
            tools.push(make_tool(
                &format!("gateway__perplexity-serenai__search_{i}"),
                "AI search",
            ));
        }
        tools.push(make_tool("file_read", "Read file contents from disk"));
        tools.push(make_tool("execute_bash", "Run a shell command"));

        assert!(tools.len() > 100);

        let result = select_relevant_tools("Do you have access to my gmail?", &tools);
        let gmail_count = result
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__gmail__"))
                    .unwrap_or(false)
            })
            .count();

        assert!(
            gmail_count >= 5,
            "Expected >=5 Gmail tools, got {gmail_count} of {} selected",
            result.len()
        );
    }

    #[test]
    fn publisher_boost_works_for_both_prefixes() {
        let mcp_tool = make_tool("mcp__slack__post_message", "Post a message to a channel");
        let gateway_tool = make_tool("gateway__gmail__get_messages", "List messages in mailbox");

        let mcp_text = tool_text(&mcp_tool);
        let gateway_text = tool_text(&gateway_tool);

        assert!(
            mcp_text.matches("slack").count() >= 3,
            "mcp__ publisher should be boosted"
        );
        assert!(
            gateway_text.matches("gmail").count() >= 3,
            "gateway__ publisher should be boosted"
        );
    }

    #[test]
    fn pinned_local_tools_always_included() {
        // Simulate 138 tools: 7 local + 131 gateway tools.
        // Query is domain-specific with zero overlap with local tool names.
        let mut tools: Vec<serde_json::Value> = Vec::new();

        // Add all 7 pinned local tools
        tools.push(make_tool(
            "read_file",
            "Read file contents from the filesystem",
        ));
        tools.push(make_tool("write_file", "Write content to a file on disk"));
        tools.push(make_tool("list_directory", "List entries in a directory"));
        tools.push(make_tool(
            "path_exists",
            "Check whether a filesystem path exists",
        ));
        tools.push(make_tool("create_directory", "Create a new directory"));
        tools.push(make_tool(
            "seren_web_fetch",
            "Fetch a URL and return its content",
        ));
        tools.push(make_tool(
            "execute_command",
            "Execute a shell command on the user machine",
        ));

        // Fill with 131 gateway tools so total exceeds MAX_TOOLS
        for i in 0..65 {
            tools.push(make_tool(
                &format!("gateway__polymarket-data__action_{i}"),
                "Polymarket prediction market data",
            ));
        }
        for i in 0..66 {
            tools.push(make_tool(
                &format!("gateway__firecrawl-serenai__scrape_{i}"),
                "Web scraping and crawling",
            ));
        }

        assert!(tools.len() > 100);

        // Query has no overlap with local tool keywords
        let result = select_relevant_tools(
            "scan polymarket prediction markets for mispriced bets",
            &tools,
        );

        // All 7 pinned tools must be present
        for pinned_name in PINNED_TOOL_NAMES {
            let found = result
                .iter()
                .any(|t| t.pointer("/function/name").and_then(|v| v.as_str()) == Some(pinned_name));
            assert!(
                found,
                "pinned tool '{}' must always be included, but was dropped",
                pinned_name
            );
        }

        assert!(result.len() <= MAX_TOOLS, "must respect MAX_TOOLS cap");
    }
}
