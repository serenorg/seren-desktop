// ABOUTME: Heuristic prompt decomposer that splits compound prompts into sub-tasks.
// ABOUTME: Detects numbered lists, sequential conjunctions, and parallel conjunctions.

use std::collections::HashMap;
use uuid::Uuid;

use super::classifier;
use super::types::{SkillRef, SubTask, TaskClassification};

// =============================================================================
// Decomposition
// =============================================================================

/// Decompose a prompt into sub-tasks using heuristic pattern detection.
///
/// Detection patterns (checked in order):
/// 1. Numbered lists: "1. Research X  2. Write Y  3. Review Z"
/// 2. Sequential conjunctions: "Research X and then summarize it"
/// 3. Parallel conjunctions: "Scrape URL1 and also scrape URL2"
/// 4. Single task (default): wraps the original classification as-is
///
/// Each extracted fragment is re-classified via the classifier.
pub fn decompose(
    prompt: &str,
    classification: &TaskClassification,
    skills: &[SkillRef],
) -> Vec<SubTask> {
    // Try numbered list first
    if let Some(subtasks) = try_numbered_list(prompt, skills) {
        if subtasks.len() > 1 {
            return subtasks;
        }
    }

    // Try sequential conjunction ("and then", "then", "after that")
    if let Some(subtasks) = try_sequential_conjunction(prompt, skills) {
        if subtasks.len() > 1 {
            return subtasks;
        }
    }

    // Try parallel conjunction ("and also", stand-alone "and" between clauses)
    if let Some(subtasks) = try_parallel_conjunction(prompt, skills) {
        if subtasks.len() > 1 {
            return subtasks;
        }
    }

    // Default: single sub-task wrapping the original
    vec![SubTask {
        id: Uuid::new_v4().to_string(),
        prompt: prompt.to_string(),
        classification: classification.clone(),
        depends_on: vec![],
    }]
}

// =============================================================================
// Numbered List Detection
// =============================================================================

/// Detect numbered list items (e.g. "1. Do X\n2. Do Y\n3. Do Z").
///
/// Each numbered item becomes a sequential sub-task depending on the previous one.
fn try_numbered_list(prompt: &str, skills: &[SkillRef]) -> Option<Vec<SubTask>> {
    let mut items: Vec<String> = Vec::new();

    for line in prompt.lines() {
        let trimmed = line.trim();
        // Match patterns: "1. ", "1) ", "2. ", etc.
        if let Some(rest) = strip_numbered_prefix(trimmed) {
            let rest = rest.trim();
            if !rest.is_empty() {
                items.push(rest.to_string());
            }
        }
    }

    if items.len() < 2 {
        return None;
    }

    // Numbered lists are sequential by default — each depends on the previous
    let mut subtasks = Vec::with_capacity(items.len());
    let mut prev_id: Option<String> = None;

    for item in &items {
        let id = Uuid::new_v4().to_string();
        let classification = classifier::classify(item, skills);
        let depends_on = prev_id.iter().cloned().collect();

        subtasks.push(SubTask {
            id: id.clone(),
            prompt: item.clone(),
            classification,
            depends_on,
        });

        prev_id = Some(id);
    }

    Some(subtasks)
}

/// Strip a numbered prefix like "1. ", "2) ", "10. " from a string.
fn strip_numbered_prefix(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let mut i = 0;

    // Skip digits
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }

    // Need at least one digit
    if i == 0 {
        return None;
    }

    // Expect '.' or ')'
    if i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b')') {
        i += 1;
    } else {
        return None;
    }

    // Skip optional space
    if i < bytes.len() && bytes[i] == b' ' {
        i += 1;
    }

    Some(&s[i..])
}

// =============================================================================
// Sequential Conjunction Detection
// =============================================================================

/// Detect sequential conjunctions: "Do X and then do Y", "Do X, then do Y",
/// "Do X. After that, do Y".
fn try_sequential_conjunction(prompt: &str, skills: &[SkillRef]) -> Option<Vec<SubTask>> {
    let lower = prompt.to_lowercase();

    // Try splitting on sequential markers (ordered by specificity)
    let markers = [
        " and then ",
        ", then ",
        ". then ",
        ". after that, ",
        ". after that ",
    ];

    for marker in &markers {
        if let Some(pos) = lower.find(marker) {
            let first = prompt[..pos].trim();
            let second = prompt[pos + marker.len()..].trim();

            if first.is_empty() || second.is_empty() {
                continue;
            }

            let id1 = Uuid::new_v4().to_string();
            let id2 = Uuid::new_v4().to_string();

            return Some(vec![
                SubTask {
                    id: id1.clone(),
                    prompt: first.to_string(),
                    classification: classifier::classify(first, skills),
                    depends_on: vec![],
                },
                SubTask {
                    id: id2,
                    prompt: second.to_string(),
                    classification: classifier::classify(second, skills),
                    depends_on: vec![id1],
                },
            ]);
        }
    }

    None
}

// =============================================================================
// Parallel Conjunction Detection
// =============================================================================

/// Detect parallel conjunctions: "Scrape A and also scrape B", "Do X and do Y".
///
/// Only triggers when:
/// - "and also" appears
/// - "and" appears between what look like independent clauses (both sides have verbs)
fn try_parallel_conjunction(prompt: &str, skills: &[SkillRef]) -> Option<Vec<SubTask>> {
    let lower = prompt.to_lowercase();

    // "and also" is a strong parallel signal
    if let Some(pos) = lower.find(" and also ") {
        let first = prompt[..pos].trim();
        let second = prompt[pos + " and also ".len()..].trim();

        if !first.is_empty() && !second.is_empty() {
            return Some(vec![
                SubTask {
                    id: Uuid::new_v4().to_string(),
                    prompt: first.to_string(),
                    classification: classifier::classify(first, skills),
                    depends_on: vec![],
                },
                SubTask {
                    id: Uuid::new_v4().to_string(),
                    prompt: second.to_string(),
                    classification: classifier::classify(second, skills),
                    depends_on: vec![],
                },
            ]);
        }
    }

    // Bare "and" — only if both sides look like independent clauses
    // (both start with a verb-like word). This avoids splitting "research AI and ML".
    if let Some(pos) = find_clause_boundary_and(&lower) {
        let first = prompt[..pos].trim();
        let second = prompt[pos + " and ".len()..].trim();

        if !first.is_empty() && !second.is_empty() && looks_like_clause(second) {
            return Some(vec![
                SubTask {
                    id: Uuid::new_v4().to_string(),
                    prompt: first.to_string(),
                    classification: classifier::classify(first, skills),
                    depends_on: vec![],
                },
                SubTask {
                    id: Uuid::new_v4().to_string(),
                    prompt: second.to_string(),
                    classification: classifier::classify(second, skills),
                    depends_on: vec![],
                },
            ]);
        }
    }

    None
}

/// Find " and " that appears to be between independent clauses.
/// Returns the byte position of the space before "and".
fn find_clause_boundary_and(lower: &str) -> Option<usize> {
    let mut search_start = 0;
    while let Some(pos) = lower[search_start..].find(" and ") {
        let abs_pos = search_start + pos;

        // Skip if this is "and then" / "and also" (handled by other detectors)
        let after_and = &lower[abs_pos + " and ".len()..];
        if after_and.starts_with("then ") || after_and.starts_with("also ") {
            search_start = abs_pos + 5;
            continue;
        }

        return Some(abs_pos);
    }
    None
}

/// Check if text looks like an independent clause (starts with a common verb).
fn looks_like_clause(text: &str) -> bool {
    let lower = text.to_lowercase();
    let first_word = lower.split_whitespace().next().unwrap_or("");

    const CLAUSE_STARTERS: &[&str] = &[
        "search",
        "scrape",
        "find",
        "write",
        "create",
        "read",
        "delete",
        "move",
        "copy",
        "run",
        "build",
        "deploy",
        "implement",
        "add",
        "remove",
        "update",
        "fix",
        "refactor",
        "test",
        "check",
        "list",
        "show",
        "get",
        "set",
        "make",
        "help",
        "explain",
        "summarize",
        "draft",
        "review",
        "analyze",
        "compare",
        "fetch",
        "download",
        "upload",
        "install",
        "configure",
        "generate",
        "convert",
        "translate",
        "parse",
        "compile",
        "debug",
        "research",
        "look",
        "open",
        "close",
        "save",
        "load",
        "send",
        "publish",
    ];

    CLAUSE_STARTERS.contains(&first_word)
}

// =============================================================================
// Topological Sort
// =============================================================================

/// Group sub-tasks into dependency layers for parallel execution.
///
/// Layer 0: sub-tasks with no dependencies (can all run in parallel)
/// Layer 1: sub-tasks depending only on layer-0 tasks
/// Layer N: sub-tasks depending only on tasks in layers 0..N-1
///
/// Returns layers in execution order. Each layer's tasks can run in parallel.
pub fn dependency_layers(subtasks: &[SubTask]) -> Vec<Vec<&SubTask>> {
    if subtasks.is_empty() {
        return vec![];
    }

    // Build a map of id → layer index
    let mut layer_map: HashMap<&str, usize> = HashMap::new();
    let mut max_layer: usize = 0;

    // Iteratively assign layers until stable
    // (Simple approach: iterate until all assigned. Works because our DAGs are small.)
    let mut changed = true;
    while changed {
        changed = false;
        for subtask in subtasks {
            if layer_map.contains_key(subtask.id.as_str()) {
                continue;
            }

            if subtask.depends_on.is_empty() {
                layer_map.insert(&subtask.id, 0);
                changed = true;
            } else {
                // Check if all dependencies have been assigned
                let all_deps_assigned = subtask
                    .depends_on
                    .iter()
                    .all(|dep| layer_map.contains_key(dep.as_str()));

                if all_deps_assigned {
                    let dep_max = subtask
                        .depends_on
                        .iter()
                        .map(|dep| layer_map[dep.as_str()])
                        .max()
                        .unwrap_or(0);
                    let layer = dep_max + 1;
                    layer_map.insert(&subtask.id, layer);
                    if layer > max_layer {
                        max_layer = layer;
                    }
                    changed = true;
                }
            }
        }
    }

    // Build layer vectors
    let mut layers: Vec<Vec<&SubTask>> = vec![vec![]; max_layer + 1];
    for subtask in subtasks {
        if let Some(&layer) = layer_map.get(subtask.id.as_str()) {
            layers[layer].push(subtask);
        }
    }

    layers
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::types::TaskComplexity;

    fn make_classification() -> TaskClassification {
        TaskClassification {
            task_type: "general_chat".to_string(),
            requires_tools: false,
            requires_file_system: false,
            complexity: TaskComplexity::Simple,
            relevant_skills: vec![],
        }
    }

    // =========================================================================
    // Numbered Prefix Stripping
    // =========================================================================

    #[test]
    fn strip_numbered_prefix_with_dot() {
        assert_eq!(strip_numbered_prefix("1. Do X"), Some("Do X"));
        assert_eq!(strip_numbered_prefix("10. Do Y"), Some("Do Y"));
    }

    #[test]
    fn strip_numbered_prefix_with_paren() {
        assert_eq!(strip_numbered_prefix("1) Do X"), Some("Do X"));
        assert_eq!(strip_numbered_prefix("3) Do Z"), Some("Do Z"));
    }

    #[test]
    fn strip_numbered_prefix_rejects_non_numbered() {
        assert_eq!(strip_numbered_prefix("Do X"), None);
        assert_eq!(strip_numbered_prefix("- Do X"), None);
        assert_eq!(strip_numbered_prefix(""), None);
    }

    // =========================================================================
    // Single Task (Default Path)
    // =========================================================================

    #[test]
    fn single_prompt_returns_one_subtask() {
        let classification = make_classification();
        let result = decompose("What is the weather?", &classification, &[]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].prompt, "What is the weather?");
        assert!(result[0].depends_on.is_empty());
    }

    // =========================================================================
    // Numbered List Decomposition
    // =========================================================================

    #[test]
    fn numbered_list_decomposes_into_sequential_subtasks() {
        let classification = make_classification();
        let prompt = "1. Research AI news\n2. Write a summary\n3. Review the draft";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].prompt, "Research AI news");
        assert_eq!(result[1].prompt, "Write a summary");
        assert_eq!(result[2].prompt, "Review the draft");

        // Sequential dependencies
        assert!(result[0].depends_on.is_empty());
        assert_eq!(result[1].depends_on, vec![result[0].id.clone()]);
        assert_eq!(result[2].depends_on, vec![result[1].id.clone()]);
    }

    #[test]
    fn numbered_list_with_parentheses() {
        let classification = make_classification();
        let prompt = "1) Search for docs\n2) Summarize findings";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].prompt, "Search for docs");
        assert_eq!(result[1].prompt, "Summarize findings");
    }

    #[test]
    fn numbered_list_reclassifies_fragments() {
        let classification = make_classification();
        let prompt = "1. Write a Python function\n2. Search for documentation";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].classification.task_type, "code_generation");
        assert_eq!(result[1].classification.task_type, "research");
    }

    #[test]
    fn single_numbered_item_falls_through() {
        let classification = make_classification();
        let prompt = "1. Just one item here";
        let result = decompose(prompt, &classification, &[]);

        // Single numbered item should not decompose
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].prompt, "1. Just one item here");
    }

    // =========================================================================
    // Sequential Conjunction
    // =========================================================================

    #[test]
    fn sequential_and_then_creates_dependency() {
        let classification = make_classification();
        let prompt = "Research AI trends and then summarize the findings";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].prompt, "Research AI trends");
        assert_eq!(result[1].prompt, "summarize the findings");

        assert!(result[0].depends_on.is_empty());
        assert_eq!(result[1].depends_on, vec![result[0].id.clone()]);
    }

    #[test]
    fn sequential_comma_then() {
        let classification = make_classification();
        let prompt = "Scrape the website, then write a report";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].prompt, "Scrape the website");
        assert_eq!(result[1].prompt, "write a report");
        assert_eq!(result[1].depends_on, vec![result[0].id.clone()]);
    }

    #[test]
    fn sequential_after_that() {
        let classification = make_classification();
        let prompt = "Read the logs. After that, summarize the errors";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].prompt, "Read the logs");
        assert_eq!(result[1].prompt, "summarize the errors");
        assert_eq!(result[1].depends_on, vec![result[0].id.clone()]);
    }

    // =========================================================================
    // Parallel Conjunction
    // =========================================================================

    #[test]
    fn parallel_and_also_creates_independent_subtasks() {
        let classification = make_classification();
        let prompt = "Scrape website A and also scrape website B";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].prompt, "Scrape website A");
        assert_eq!(result[1].prompt, "scrape website B");

        assert!(result[0].depends_on.is_empty());
        assert!(result[1].depends_on.is_empty());
    }

    #[test]
    fn parallel_and_with_verb_clauses() {
        let classification = make_classification();
        let prompt = "Search for AI news and summarize the latest papers";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        assert!(result[0].depends_on.is_empty());
        assert!(result[1].depends_on.is_empty());
    }

    #[test]
    fn bare_and_without_clause_does_not_split() {
        let classification = make_classification();
        // "AI and ML" — "ML" doesn't start with a verb, so no split
        let prompt = "Research AI and ML trends";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].prompt, "Research AI and ML trends");
    }

    // =========================================================================
    // Dependency Layers (Topological Sort)
    // =========================================================================

    #[test]
    fn dependency_layers_empty_input() {
        let result = dependency_layers(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn dependency_layers_single_subtask() {
        let subtasks = vec![SubTask {
            id: "a".to_string(),
            prompt: "Do X".to_string(),
            classification: make_classification(),
            depends_on: vec![],
        }];

        let layers = dependency_layers(&subtasks);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].len(), 1);
        assert_eq!(layers[0][0].id, "a");
    }

    #[test]
    fn dependency_layers_all_independent() {
        let subtasks = vec![
            SubTask {
                id: "a".to_string(),
                prompt: "Do A".to_string(),
                classification: make_classification(),
                depends_on: vec![],
            },
            SubTask {
                id: "b".to_string(),
                prompt: "Do B".to_string(),
                classification: make_classification(),
                depends_on: vec![],
            },
        ];

        let layers = dependency_layers(&subtasks);
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].len(), 2);
    }

    #[test]
    fn dependency_layers_sequential_chain() {
        let subtasks = vec![
            SubTask {
                id: "a".to_string(),
                prompt: "Do A".to_string(),
                classification: make_classification(),
                depends_on: vec![],
            },
            SubTask {
                id: "b".to_string(),
                prompt: "Do B".to_string(),
                classification: make_classification(),
                depends_on: vec!["a".to_string()],
            },
            SubTask {
                id: "c".to_string(),
                prompt: "Do C".to_string(),
                classification: make_classification(),
                depends_on: vec!["b".to_string()],
            },
        ];

        let layers = dependency_layers(&subtasks);
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0].len(), 1);
        assert_eq!(layers[0][0].id, "a");
        assert_eq!(layers[1].len(), 1);
        assert_eq!(layers[1][0].id, "b");
        assert_eq!(layers[2].len(), 1);
        assert_eq!(layers[2][0].id, "c");
    }

    #[test]
    fn dependency_layers_diamond_pattern() {
        // a → b, a → c, b+c → d
        let subtasks = vec![
            SubTask {
                id: "a".to_string(),
                prompt: "Do A".to_string(),
                classification: make_classification(),
                depends_on: vec![],
            },
            SubTask {
                id: "b".to_string(),
                prompt: "Do B".to_string(),
                classification: make_classification(),
                depends_on: vec!["a".to_string()],
            },
            SubTask {
                id: "c".to_string(),
                prompt: "Do C".to_string(),
                classification: make_classification(),
                depends_on: vec!["a".to_string()],
            },
            SubTask {
                id: "d".to_string(),
                prompt: "Do D".to_string(),
                classification: make_classification(),
                depends_on: vec!["b".to_string(), "c".to_string()],
            },
        ];

        let layers = dependency_layers(&subtasks);
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0].len(), 1); // a
        assert_eq!(layers[1].len(), 2); // b, c
        assert_eq!(layers[2].len(), 1); // d
        assert_eq!(layers[2][0].id, "d");
    }

    // =========================================================================
    // Priority: Numbered > Sequential > Parallel
    // =========================================================================

    #[test]
    fn numbered_list_takes_priority_over_conjunction() {
        let classification = make_classification();
        // Has both numbered list and "and then" — numbered list wins
        let prompt = "1. Research the topic and then read the file\n2. Write a summary";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        // First item contains "and then" but is treated as a single item
        assert_eq!(
            result[0].prompt,
            "Research the topic and then read the file"
        );
        assert_eq!(result[1].prompt, "Write a summary");
    }

    #[test]
    fn sequential_takes_priority_over_parallel() {
        let classification = make_classification();
        // "and then" is sequential, should not be treated as parallel
        let prompt = "Search for news and then summarize the results";
        let result = decompose(prompt, &classification, &[]);

        assert_eq!(result.len(), 2);
        // Second task should depend on first (sequential, not parallel)
        assert_eq!(result[1].depends_on, vec![result[0].id.clone()]);
    }
}
