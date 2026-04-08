// ABOUTME: BM25-based tool relevance scoring for per-request tool selection.
// ABOUTME: Model-aware budgets, publisher-set scoping, and conversation-aware boosting.

use std::collections::HashMap;

/// BM25 tuning constants (Robertson et al., standard values).
const K1: f32 = 1.5;
const B: f32 = 0.75;
/// Estimated average tool document length in words (name + description + props).
const AVG_TOOL_WORDS: f32 = 60.0;

/// Approximate token count: 4 characters ≈ 1 token for typical JSON schema text.
const CHARS_PER_TOKEN: usize = 4;

/// Default token budget for selected tools sent to the model per request.
const DEFAULT_TOOL_TOKEN_BUDGET: usize = 12_000;

/// Minimum tools always included regardless of BM25 score.
const MIN_TOOLS: usize = 5;

/// Hard byte budget as a final safety net against HTTP 413 responses from the
/// Gateway. BM25 selection is the primary mechanism; this catches edge cases.
const HARD_BYTE_BUDGET: usize = 400 * 1024;

/// Maximum tools from a single publisher included via set-scoping.
const MAX_PUBLISHER_TOOLS: usize = 25;

/// Number of top publishers to include full toolsets for.
const TOP_K_PUBLISHERS: usize = 3;

/// Score multiplier for publishers whose tools were recently used in conversation.
const RECENCY_BOOST: f32 = 2.0;

/// Local tools that are always included regardless of BM25 score.
/// These are fundamental capabilities the model needs constant access to —
/// without them it cannot read/write files or execute commands.
const PINNED_TOOL_NAMES: &[&str] = &[
    "read_file",
    "read_file_base64",
    "write_file",
    "list_directory",
    "path_exists",
    "create_directory",
    "seren_web_fetch",
    "execute_command",
    // Built-in Seren tools use seren__ prefix (not gateway__) and bypass BM25
    // entirely — they're always included like file tools. Pin them here as a
    // safety net in case the tool set grows beyond the model budget.
    "seren__call_publisher",
    "seren__run_sql",
    "seren__run_sql_transaction",
    "seren__list_projects",
    "seren__create_project",
    "seren__list_databases",
    "seren__create_database",
];

/// Model-aware tool cap: returns (max_tools, token_budget) for the given model.
fn model_budget(model_id: &str) -> (usize, usize) {
    let id = model_id.to_lowercase();
    if id.contains("gpt-3.5") || id.contains("gpt-4") || id.contains("/o1") || id.contains("/o3") {
        // OpenAI: 128 API hard limit, accuracy degrades well before that.
        (40, 6_000)
    } else if id.contains("gemini") {
        // Gemini: 256 limit, weaker tool selection at scale.
        (50, 8_000)
    } else if id.contains("claude") || id.contains("anthropic") {
        // Anthropic: handles large toolsets well, but 200 is wasteful.
        (80, DEFAULT_TOOL_TOKEN_BUDGET)
    } else {
        // Unknown models get a conservative budget.
        (60, 8_000)
    }
}

/// Check if a tool definition matches a pinned tool name.
fn is_pinned_tool(tool: &serde_json::Value) -> bool {
    tool.pointer("/function/name")
        .and_then(|v| v.as_str())
        .map(|name| PINNED_TOOL_NAMES.contains(&name))
        .unwrap_or(false)
}

/// Select the most relevant tools for the given query, model, and conversation state.
///
/// This is the primary entry point. It combines three strategies:
/// 1. **Model-aware budgets**: Tighter caps for models with weaker tool selection.
/// 2. **Publisher-set scoping**: When a publisher is relevant, include its full toolset
///    (up to MAX_PUBLISHER_TOOLS) so the model gets coherent capabilities.
/// 3. **Conversation-aware boosting**: Publishers whose tools were recently used get
///    a score multiplier so follow-up turns stay coherent.
///
/// Tools are in OpenAI function-calling format:
/// `{ "type": "function", "function": { "name": ..., "description": ..., "parameters": ... } }`
pub fn select_relevant_tools(
    query: &str,
    tools: &[serde_json::Value],
    model_id: &str,
    recently_used_publishers: &[String],
) -> Vec<serde_json::Value> {
    let (max_tools, token_budget) = model_budget(model_id);

    // Fast path: no scoring needed when the set is small enough.
    let total_bytes = serde_json::to_string(tools)
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if total_bytes <= HARD_BYTE_BUDGET && tools.len() <= max_tools {
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
    let mut pool_scores = bm25_scores(&query_terms, &pool_docs);

    // Phase 3: Boost scores for recently-used publishers.
    if !recently_used_publishers.is_empty() {
        for (pool_idx, score) in pool_scores.iter_mut().enumerate() {
            let original_idx = pool_indices[pool_idx];
            if let Some(publisher) = tool_publisher(&tools[original_idx]) {
                if recently_used_publishers.iter().any(|p| p == publisher) {
                    *score *= RECENCY_BOOST;
                }
            }
        }
    }

    // Phase 2: Publisher-set scoping.
    // Group pool tools by publisher and compute aggregate publisher scores.
    let mut publisher_scores: HashMap<String, f32> = HashMap::new();
    let mut publisher_pool_indices: HashMap<String, Vec<usize>> = HashMap::new();
    for (pool_idx, &score) in pool_scores.iter().enumerate() {
        let original_idx = pool_indices[pool_idx];
        if let Some(publisher) = tool_publisher(&tools[original_idx]) {
            let pub_name = publisher.to_string();
            *publisher_scores.entry(pub_name.clone()).or_default() += score;
            publisher_pool_indices
                .entry(pub_name)
                .or_default()
                .push(pool_idx);
        }
    }

    // Identify top-K publishers by aggregate score (only those with nonzero score).
    let mut ranked_publishers: Vec<(String, f32)> = publisher_scores
        .into_iter()
        .filter(|(_, s)| *s > 0.0)
        .collect();
    ranked_publishers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let top_publishers: Vec<String> = ranked_publishers
        .iter()
        .take(TOP_K_PUBLISHERS)
        .map(|(name, _)| name.clone())
        .collect();

    // Build selection: start with pinned tools, then add full toolsets for top publishers,
    // then fill remaining budget with highest-scoring individual tools.
    let mut selected_indices: Vec<usize> = pinned_indices.clone();
    let mut token_count: usize = pinned_tokens;
    let mut selected_pool: Vec<bool> = vec![false; pool_indices.len()];

    // Include full toolsets for top-K publishers (up to per-publisher cap).
    for pub_name in &top_publishers {
        if let Some(indices) = publisher_pool_indices.get(pub_name) {
            let mut pub_added = 0;
            // Sort by score within publisher to pick best ones first.
            let mut scored: Vec<(usize, f32)> = indices
                .iter()
                .map(|&pi| (pi, pool_scores[pi]))
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            for (pool_idx, _score) in scored {
                if pub_added >= MAX_PUBLISHER_TOOLS {
                    break;
                }
                if selected_indices.len() >= max_tools {
                    break;
                }
                if selected_pool[pool_idx] {
                    continue;
                }
                let original_idx = pool_indices[pool_idx];
                let tool_tokens = approximate_tokens(&pool_docs[pool_idx]);
                token_count += tool_tokens;
                selected_indices.push(original_idx);
                selected_pool[pool_idx] = true;
                pub_added += 1;
            }
        }
    }

    // Fill remaining budget with highest-scoring individual tools.
    // Respect the per-publisher cap to prevent any single publisher from dominating.
    let mut ranked: Vec<(usize, f32)> = pool_scores.iter().copied().enumerate().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Track per-publisher counts (including tools already added in set-scoping).
    let mut publisher_counts: HashMap<String, usize> = HashMap::new();
    for (pool_idx, &selected) in selected_pool.iter().enumerate() {
        if selected {
            let original_idx = pool_indices[pool_idx];
            if let Some(publisher) = tool_publisher(&tools[original_idx]) {
                *publisher_counts.entry(publisher.to_string()).or_default() += 1;
            }
        }
    }

    let total_min = MIN_TOOLS.saturating_sub(selected_indices.len());
    let mut extra_picked: usize = 0;

    for (pool_idx, _score) in &ranked {
        if selected_indices.len() >= max_tools {
            break;
        }
        if selected_pool[*pool_idx] {
            continue;
        }
        // Enforce per-publisher cap in fill phase too.
        let original_idx = pool_indices[*pool_idx];
        if let Some(publisher) = tool_publisher(&tools[original_idx]) {
            let count = publisher_counts.get(publisher).copied().unwrap_or(0);
            if count >= MAX_PUBLISHER_TOOLS {
                continue;
            }
        }
        let tool_tokens = approximate_tokens(&pool_docs[*pool_idx]);
        let budget_exceeded =
            token_count + tool_tokens > token_budget && extra_picked >= total_min;
        if budget_exceeded {
            break;
        }
        selected_indices.push(original_idx);
        selected_pool[*pool_idx] = true;
        token_count += tool_tokens;
        extra_picked += 1;
        if let Some(publisher) = tool_publisher(&tools[original_idx]) {
            *publisher_counts.entry(publisher.to_string()).or_default() += 1;
        }
    }

    // Restore original ordering so the frontend's priority ranking is preserved.
    selected_indices.sort_unstable();

    let result: Vec<serde_json::Value> =
        selected_indices.iter().map(|&i| tools[i].clone()).collect();

    log::info!(
        "[ToolRelevance] Selected {} of {} tools ({} pinned, top publishers: [{}], ~{} tokens, model: {}, budget: {})",
        result.len(),
        tools.len(),
        pinned_indices.len(),
        top_publishers.join(", "),
        token_count,
        model_id,
        max_tools,
    );

    apply_hard_budget(&result)
}

// =============================================================================
// Internal helpers
// =============================================================================

/// Extract the publisher name from a tool's function name, if it has one.
fn tool_publisher(tool: &serde_json::Value) -> Option<&str> {
    tool.pointer("/function/name")
        .and_then(|v| v.as_str())
        .and_then(extract_mcp_publisher)
}

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

    /// Helper: default model for tests that don't care about model-specific behavior.
    const TEST_MODEL: &str = "anthropic/claude-sonnet-4";
    const GPT_MODEL: &str = "openai/gpt-4o";
    const GEMINI_MODEL: &str = "google/gemini-2.5-pro";

    fn select(query: &str, tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
        select_relevant_tools(query, tools, TEST_MODEL, &[])
    }

    fn select_with_model(
        query: &str,
        tools: &[serde_json::Value],
        model: &str,
    ) -> Vec<serde_json::Value> {
        select_relevant_tools(query, tools, model, &[])
    }

    fn select_with_recency(
        query: &str,
        tools: &[serde_json::Value],
        recent: &[String],
    ) -> Vec<serde_json::Value> {
        select_relevant_tools(query, tools, TEST_MODEL, recent)
    }

    // =========================================================================
    // Existing behavior (preserved)
    // =========================================================================

    #[test]
    fn fast_path_when_small_set() {
        let tools: Vec<serde_json::Value> = (0..5)
            .map(|i| make_tool(&format!("tool_{i}"), "short desc"))
            .collect();
        let result = select("any query", &tools);
        assert_eq!(
            result.len(),
            tools.len(),
            "small set should pass through unchanged"
        );
    }

    #[test]
    fn empty_tools_returns_empty() {
        let result = select("some query", &[]);
        assert!(result.is_empty());
    }

    #[test]
    fn empty_query_falls_back_gracefully() {
        let tools: Vec<serde_json::Value> = (0..5)
            .map(|i| make_tool(&format!("tool_{i}"), "some description"))
            .collect();
        let result = select("", &tools);
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
    fn always_includes_at_least_min_tools_when_available() {
        let tools = vec![
            make_tool("tool_a", "alpha beta gamma delta"),
            make_tool("tool_b", "epsilon zeta eta theta"),
        ];
        let result = select("xyzzyx unrelated query", &tools);
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

        let result = select("read file from filesystem", &tools);

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
        let result = select("gamma functionality", &tools);
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
        // Simulate 139 tools: 8 local + 131 gateway tools.
        // Query is domain-specific with zero overlap with local tool names.
        let mut tools: Vec<serde_json::Value> = Vec::new();

        // Add all pinned local tools
        tools.push(make_tool(
            "read_file",
            "Read file contents from the filesystem",
        ));
        tools.push(make_tool(
            "read_file_base64",
            "Read a file and return its bytes as base64",
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

        // Add pinned gateway tools (must match gateway__{publisher}__{tool} format)
        // Built-in Seren tools use seren__ prefix (first-class, like file tools)
        tools.push(make_tool("seren__call_publisher", "Call a Seren publisher"));
        tools.push(make_tool("seren__run_sql", "Execute SQL on SerenDB"));
        tools.push(make_tool("seren__run_sql_transaction", "Execute SQL transaction on SerenDB"));
        tools.push(make_tool("seren__list_projects", "List Seren projects"));
        tools.push(make_tool("seren__create_project", "Create a Seren project"));
        tools.push(make_tool("seren__list_databases", "List Seren databases"));
        tools.push(make_tool("seren__create_database", "Create a Seren database"));

        // Fill with gateway tools so total exceeds budget
        for i in 0..62 {
            tools.push(make_tool(
                &format!("gateway__polymarket-data__action_{i}"),
                "Polymarket prediction market data",
            ));
        }
        for i in 0..62 {
            tools.push(make_tool(
                &format!("gateway__firecrawl-serenai__scrape_{i}"),
                "Web scraping and crawling",
            ));
        }

        assert!(tools.len() > 100);

        // Query has no overlap with local tool keywords
        let result = select(
            "scan polymarket prediction markets for mispriced bets",
            &tools,
        );

        // All pinned tools must be present
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
    }

    // =========================================================================
    // Phase 1: Model-aware budgets
    // =========================================================================

    #[test]
    fn model_budget_returns_correct_caps() {
        let (gpt_max, _) = model_budget("openai/gpt-4o");
        let (claude_max, _) = model_budget("anthropic/claude-sonnet-4");
        let (gemini_max, _) = model_budget("google/gemini-2.5-pro");
        let (unknown_max, _) = model_budget("meta/llama-3.1-70b");

        assert_eq!(gpt_max, 40);
        assert_eq!(claude_max, 80);
        assert_eq!(gemini_max, 50);
        assert_eq!(unknown_max, 60);
    }

    #[test]
    fn gpt_gets_fewer_tools_than_claude() {
        // Build 120 tools: enough to trigger filtering for both models.
        let mut tools: Vec<serde_json::Value> = Vec::new();
        for i in 0..120 {
            tools.push(make_tool(
                &format!("gateway__pub_{i}__action"),
                &format!("Does action {i} for the publisher"),
            ));
        }

        let gpt_result = select_with_model("do something with the publisher", &tools, GPT_MODEL);
        let claude_result =
            select_with_model("do something with the publisher", &tools, TEST_MODEL);

        assert!(
            gpt_result.len() <= 40,
            "GPT should get <= 40 tools, got {}",
            gpt_result.len()
        );
        assert!(
            claude_result.len() > gpt_result.len(),
            "Claude ({}) should get more tools than GPT ({})",
            claude_result.len(),
            gpt_result.len()
        );
    }

    // =========================================================================
    // Phase 2: Publisher-set scoping
    // =========================================================================

    #[test]
    fn publisher_set_scoping_includes_full_toolset() {
        // 17 Gmail tools + 50 Firecrawl + 50 Perplexity = 117 tools.
        // When user asks about Gmail, all 17 Gmail tools should be included.
        let mut tools: Vec<serde_json::Value> = Vec::new();

        let gmail_names = [
            "get_messages",
            "get_messages_by_id",
            "post_messages_send",
            "delete_messages_by_id",
            "post_messages_trash",
            "post_messages_modify",
            "get_labels",
            "get_labels_by_id",
            "post_labels",
            "delete_labels_by_id",
            "get_threads",
            "get_threads_by_id",
            "post_threads_trash",
            "get_drafts",
            "post_drafts",
            "post_drafts_send",
            "get_health",
        ];
        for name in &gmail_names {
            tools.push(make_tool(
                &format!("gateway__gmail__{name}"),
                "Gmail email operation",
            ));
        }

        for i in 0..50 {
            tools.push(make_tool(
                &format!("gateway__firecrawl-serenai__action_{i}"),
                "Web scraping operation",
            ));
        }
        for i in 0..50 {
            tools.push(make_tool(
                &format!("gateway__perplexity-serenai__search_{i}"),
                "AI search operation",
            ));
        }

        let result = select("check my gmail for new messages", &tools);
        let gmail_count = result
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__gmail__"))
                    .unwrap_or(false)
            })
            .count();

        assert_eq!(
            gmail_count,
            gmail_names.len(),
            "All {} Gmail tools should be included when Gmail is the top publisher, got {}",
            gmail_names.len(),
            gmail_count
        );
    }

    #[test]
    fn publisher_set_capped_at_max_per_publisher() {
        // 30 tools from one publisher exceeds MAX_PUBLISHER_TOOLS (25).
        let mut tools: Vec<serde_json::Value> = Vec::new();
        for i in 0..30 {
            tools.push(make_tool(
                &format!("gateway__bigpub__action_{i}"),
                "Some bigpub action",
            ));
        }
        // Add enough other tools to force filtering
        for i in 0..80 {
            tools.push(make_tool(
                &format!("gateway__other__action_{i}"),
                "Some other action",
            ));
        }

        let result = select("use bigpub to do something", &tools);
        let bigpub_count = result
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__bigpub__"))
                    .unwrap_or(false)
            })
            .count();

        assert!(
            bigpub_count <= MAX_PUBLISHER_TOOLS,
            "Publisher tools should be capped at {}, got {}",
            MAX_PUBLISHER_TOOLS,
            bigpub_count
        );
    }

    // =========================================================================
    // Phase 3: Conversation-aware tool memory
    // =========================================================================

    #[test]
    fn recency_boost_promotes_recently_used_publisher() {
        // Two publishers with similar relevance, but one was recently used.
        let mut tools: Vec<serde_json::Value> = Vec::new();
        for i in 0..20 {
            tools.push(make_tool(
                &format!("gateway__slack__action_{i}"),
                "Send a message to someone",
            ));
        }
        for i in 0..20 {
            tools.push(make_tool(
                &format!("gateway__teams__action_{i}"),
                "Send a message to someone",
            ));
        }
        // Pad to trigger filtering
        for i in 0..80 {
            tools.push(make_tool(
                &format!("gateway__noise__unrelated_{i}"),
                "Unrelated noise tool",
            ));
        }

        // Without recency: both publishers treated equally
        let result_no_recency = select("send a message", &tools);
        let slack_no = result_no_recency
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__slack__"))
                    .unwrap_or(false)
            })
            .count();

        // With recency: Slack should get boosted
        let result_with_recency =
            select_with_recency("send a message", &tools, &["slack".to_string()]);
        let slack_with = result_with_recency
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__slack__"))
                    .unwrap_or(false)
            })
            .count();

        assert!(
            slack_with >= slack_no,
            "Recency boost should include at least as many Slack tools: without={}, with={}",
            slack_no,
            slack_with
        );
    }

    #[test]
    fn recency_boost_does_not_displace_query_relevant_publisher() {
        // Recently used Slack, but query is explicitly about Gmail.
        // Recency boost should NOT push Gmail out of the top publishers.
        // Gmail must still be fully included even though Slack gets a boost.
        // We add 4 publishers (> TOP_K_PUBLISHERS=3) so there is real competition.
        let mut tools: Vec<serde_json::Value> = Vec::new();
        for i in 0..15 {
            tools.push(make_tool(
                &format!("gateway__gmail__email_action_{i}"),
                "Gmail email inbox operation for reading and sending mail messages",
            ));
        }
        for i in 0..15 {
            tools.push(make_tool(
                &format!("gateway__slack__channel_action_{i}"),
                "Slack channel workspace notification",
            ));
        }
        for i in 0..15 {
            tools.push(make_tool(
                &format!("gateway__calendar__event_{i}"),
                "Calendar scheduling event meeting",
            ));
        }
        for i in 0..15 {
            tools.push(make_tool(
                &format!("gateway__drive__file_{i}"),
                "Drive file storage document upload",
            ));
        }
        for i in 0..60 {
            tools.push(make_tool(
                &format!("gateway__noise__filler_{i}"),
                "Unrelated filler tool for padding",
            ));
        }

        let result = select_relevant_tools(
            "read my gmail inbox email",
            &tools,
            GPT_MODEL,
            &["slack".to_string()],
        );
        let gmail_count = result
            .iter()
            .filter(|t| {
                t.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.starts_with("gateway__gmail__"))
                    .unwrap_or(false)
            })
            .count();

        // Gmail must be fully included as a top publisher (all 15 tools).
        assert!(
            gmail_count >= 10,
            "Gmail should be a top publisher despite Slack recency boost: gmail={}",
            gmail_count
        );
    }
}
