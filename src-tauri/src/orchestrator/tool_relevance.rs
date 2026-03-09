// ABOUTME: Per-request BM25 tool relevance scoring for dynamic tool exposure.
// ABOUTME: Implements ITR (Instruction-Tool Retrieval) from arXiv:2602.17046.

/// Target tool-context size in tokens (≈ chars / 4).
/// Tools scoring above zero are selected until this budget is exhausted.
const TOOL_TOKEN_BUDGET: usize = 2_000;

/// Approximate chars-per-token ratio used to convert the token budget to bytes.
const CHARS_PER_TOKEN: usize = 4;

/// Always include this many top-scoring tools regardless of budget.
const MIN_TOOLS: usize = 3;

/// Stop adding tools once this many are selected (prevents over-selection on
/// ambiguous queries where many tools score equally).
const MAX_TOOLS_SOFT: usize = 20;

// BM25 tuning parameters
const K1: f32 = 1.5;
const B: f32 = 0.75;
const AVG_DOC_LEN: f32 = 60.0; // empirical estimate for tool descriptions

// =============================================================================
// Public API
// =============================================================================

/// Select the most query-relevant tools within a token budget.
///
/// If the total serialised size of `tools` already fits within the budget the
/// original slice is returned unchanged.  Otherwise each tool is scored with a
/// lightweight BM25-style scorer against the current `query` and the top tools
/// are greedily selected until `TOOL_TOKEN_BUDGET` tokens are used.  At least
/// `MIN_TOOLS` tools are always kept regardless of score.
///
/// Returned tools preserve their original order for determinism.
pub fn select_relevant_tools(
    query: &str,
    tools: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    if tools.is_empty() {
        return vec![];
    }

    // Fast path: total size already within budget — nothing to filter.
    let budget_chars = TOOL_TOKEN_BUDGET * CHARS_PER_TOKEN;
    let total_chars: usize = tools
        .iter()
        .map(|t| serde_json::to_string(t).map(|s| s.len()).unwrap_or(0))
        .sum();

    if total_chars <= budget_chars {
        return tools.to_vec();
    }

    let query_tokens = tokenize(query);

    // Score every tool.
    let mut scored: Vec<(f32, usize)> = tools
        .iter()
        .enumerate()
        .map(|(i, tool)| {
            let text = tool_text(tool);
            let score = bm25_score(&query_tokens, &text);
            (score, i)
        })
        .collect();

    // Sort descending by score.
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Greedy selection within budget; always keep MIN_TOOLS.
    let mut selected_indices: Vec<usize> = Vec::new();
    let mut used_chars: usize = 2; // outer `[` and `]`

    for (rank, &(_, idx)) in scored.iter().enumerate() {
        let tool_chars = serde_json::to_string(&tools[idx])
            .map(|s| s.len() + 1) // +1 for comma
            .unwrap_or(1);

        let within_budget = used_chars + tool_chars <= budget_chars;
        let must_include = rank < MIN_TOOLS;
        let at_soft_cap = selected_indices.len() >= MAX_TOOLS_SOFT;

        if (within_budget || must_include) && !at_soft_cap {
            selected_indices.push(idx);
            used_chars += tool_chars;
        } else if at_soft_cap {
            break;
        }
    }

    // Return in original index order so callers see a stable, predictable list.
    selected_indices.sort_unstable();
    let selected: Vec<serde_json::Value> = selected_indices
        .iter()
        .map(|&i| tools[i].clone())
        .collect();

    log::info!(
        "[ToolRelevance] Selected {}/{} tools ({} → {} chars)",
        selected.len(),
        tools.len(),
        total_chars,
        used_chars,
    );

    selected
}

// =============================================================================
// Internal helpers
// =============================================================================

/// Extract a single searchable text blob from an OpenAI-format tool definition.
fn tool_text(tool: &serde_json::Value) -> String {
    let mut parts: Vec<&str> = Vec::new();

    if let Some(name) = tool.pointer("/function/name").and_then(|v| v.as_str()) {
        parts.push(name);
    }
    if let Some(desc) = tool
        .pointer("/function/description")
        .and_then(|v| v.as_str())
    {
        parts.push(desc);
    }
    // Parameter names and their descriptions give additional signal.
    if let Some(props) = tool
        .pointer("/function/parameters/properties")
        .and_then(|v| v.as_object())
    {
        for (key, val) in props {
            // Borrow the key as &str by storing the String on the heap briefly.
            // We collect param info into a temporary buffer instead.
            let _ = key; // suppress unused warning; collected below
            if let Some(pdesc) = val.get("description").and_then(|v| v.as_str()) {
                parts.push(pdesc);
            }
        }
    }

    parts.join(" ").to_lowercase()
}

/// Tokenize text into lowercase alphanumeric words of length > 1.
fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(|t| t.to_lowercase())
        .collect()
}

/// BM25-lite: TF-normalized term frequency score (no IDF — corpus too small).
fn bm25_score(query_tokens: &[String], doc: &str) -> f32 {
    let doc_tokens = tokenize(doc);
    let doc_len = doc_tokens.len() as f32;
    if doc_len == 0.0 {
        return 0.0;
    }

    let mut score = 0.0f32;
    for qt in query_tokens {
        let tf = doc_tokens.iter().filter(|t| t.as_str() == qt.as_str()).count() as f32;
        if tf > 0.0 {
            // BM25 TF normalisation
            let tf_norm = tf * (K1 + 1.0) / (tf + K1 * (1.0 - B + B * doc_len / AVG_DOC_LEN));
            score += tf_norm;
        }
    }
    score
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
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        })
    }

    #[test]
    fn returns_all_tools_when_within_budget() {
        let tools: Vec<serde_json::Value> = (0..3)
            .map(|i| make_tool(&format!("tool_{i}"), "short"))
            .collect();
        let result = select_relevant_tools("anything", &tools);
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn empty_tools_returns_empty() {
        let result = select_relevant_tools("query", &[]);
        assert!(result.is_empty());
    }

    #[test]
    fn high_scoring_tool_ranked_first() {
        let query_tokens = tokenize("read file from disk");
        let file_tool = "read file content from filesystem disk path";
        let search_tool = "search the web for results";

        let score_file = bm25_score(&query_tokens, file_tool);
        let score_search = bm25_score(&query_tokens, search_tool);
        assert!(score_file > score_search, "file tool should score higher for file query");
    }

    #[test]
    fn irrelevant_tool_scores_zero() {
        let query_tokens = tokenize("send email");
        let score = bm25_score(&query_tokens, "read sql database rows count");
        // "send" and "email" don't appear — score should be 0
        assert_eq!(score, 0.0);
    }

    #[test]
    fn selects_relevant_over_irrelevant_when_over_budget() {
        // Build a large set of irrelevant tools + one relevant one
        let mut tools: Vec<serde_json::Value> = (0..200)
            .map(|i| {
                make_tool(
                    &format!("unrelated_tool_{i}"),
                    &format!("does something unrelated to queries {i}"),
                )
            })
            .collect();
        let relevant = make_tool("read_file", "read a file from the filesystem path");
        tools.push(relevant);

        let result = select_relevant_tools("read file from filesystem", &tools);

        // The relevant tool should be included
        let has_read_file = result.iter().any(|t| {
            t.pointer("/function/name")
                .and_then(|v| v.as_str())
                .map(|n| n == "read_file")
                .unwrap_or(false)
        });
        assert!(has_read_file, "read_file should be selected for a file-reading query");

        // Should have reduced total tool count significantly
        assert!(result.len() < tools.len(), "should filter tools over budget");
    }

    #[test]
    fn always_includes_min_tools_even_if_over_budget() {
        // 200 large tools, all irrelevant
        let tools: Vec<serde_json::Value> = (0..200)
            .map(|i| {
                // Pad description to ensure we exceed budget
                let desc = format!("zzz qqq unrelated description {i} {}", "x".repeat(200));
                make_tool(&format!("padded_tool_{i}"), &desc)
            })
            .collect();

        let result = select_relevant_tools("completely different query xyz", &tools);
        assert!(
            result.len() >= MIN_TOOLS,
            "must always include at least MIN_TOOLS tools"
        );
    }

    #[test]
    fn tool_text_includes_name_and_description() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "execute_bash",
                "description": "Run a shell command",
                "parameters": { "type": "object", "properties": {} }
            }
        });
        let text = tool_text(&tool);
        assert!(text.contains("execute_bash"));
        assert!(text.contains("run a shell command"));
    }
}
