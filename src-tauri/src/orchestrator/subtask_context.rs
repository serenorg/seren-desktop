// ABOUTME: Propagates completed sub-task outputs into the worker history of dependent sub-tasks.
// ABOUTME: Lets later layers in a multi-task plan see what earlier layers produced (GH #1930).

use std::collections::{HashMap, HashSet, VecDeque};

use super::types::SubTask;

/// Maximum number of ancestor sub-task results that may be injected into a
/// downstream worker's history. Keeps context bounded for plans with deep
/// dependency chains.
pub const MAX_CONTEXT_SUBTASKS: usize = 5;

/// Per-result byte cap. Single noisy ancestor cannot blow out the context
/// budget for the rest of the plan.
pub const MAX_SUBTASK_RESULT_BYTES: usize = 4 * 1024;

/// Walk the dependency DAG breadth-first from `subtask` and return ancestor
/// IDs ordered by distance (direct parents first, grandparents next, …).
fn transitive_dependencies(
    subtask: &SubTask,
    subtasks_by_id: &HashMap<String, SubTask>,
) -> Vec<String> {
    let mut visited: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    let mut queue: VecDeque<String> = subtask.depends_on.iter().cloned().collect();
    while let Some(id) = queue.pop_front() {
        if !visited.insert(id.clone()) {
            continue;
        }
        ordered.push(id.clone());
        if let Some(parent) = subtasks_by_id.get(&id) {
            for dep in &parent.depends_on {
                queue.push_back(dep.clone());
            }
        }
    }
    ordered
}

/// Truncate `result` to `max_bytes` on a UTF-8 char boundary. Appends a
/// marker so the worker can tell the result was clipped.
fn truncate_result(result: &str, max_bytes: usize) -> String {
    if result.len() <= max_bytes {
        return result.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !result.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[…truncated…]", &result[..end])
}

/// Inject completed ancestor sub-task results into the history a downstream
/// worker will see. The original `base_history` (the user-facing chat
/// transcript) is preserved at the head; synthesized assistant turns are
/// appended so the worker can reference what earlier sub-tasks produced.
///
/// Returns a new history vector — `base_history` is not mutated.
pub fn inject_dependency_results(
    base_history: &[serde_json::Value],
    subtask: &SubTask,
    subtasks_by_id: &HashMap<String, SubTask>,
    results: &HashMap<String, String>,
    max_subtasks: usize,
    max_bytes_per_subtask: usize,
) -> Vec<serde_json::Value> {
    let mut history = base_history.to_vec();

    let deps = transitive_dependencies(subtask, subtasks_by_id);

    // Collect available results in BFS-order (closest ancestor first),
    // stop at the cap. Missing results (worker error, cancellation) are
    // silently skipped — we do not stall on them.
    let mut included: Vec<(String, String)> = Vec::new();
    for dep_id in &deps {
        if let Some(result) = results.get(dep_id) {
            if result.trim().is_empty() {
                continue;
            }
            let prompt = subtasks_by_id
                .get(dep_id)
                .map(|st| st.prompt.as_str())
                .unwrap_or("(unknown sub-task)");
            included.push((prompt.to_string(), truncate_result(result, max_bytes_per_subtask)));
            if included.len() >= max_subtasks {
                break;
            }
        }
    }

    // Emit in chronological order: oldest ancestor first so the most recent
    // assistant turn (= the direct parent) sits closest to the new user
    // prompt the worker is about to answer.
    for (prompt_text, content) in included.iter().rev() {
        let snippet = truncate_prompt_for_label(prompt_text, 160);
        let synthesized = format!("[Sub-task result from \"{}\"]:\n{}", snippet, content);
        history.push(serde_json::json!({
            "role": "assistant",
            "content": synthesized,
        }));
    }

    history
}

fn truncate_prompt_for_label(s: &str, max_chars: usize) -> String {
    let collapsed = s.replace('\n', " ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(max_chars).collect();
    format!("{truncated}…")
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::types::{TaskClassification, TaskComplexity};

    fn classification() -> TaskClassification {
        TaskClassification {
            task_type: "general_chat".to_string(),
            requires_tools: false,
            requires_file_system: false,
            complexity: TaskComplexity::Simple,
            relevant_skills: vec![],
        }
    }

    fn subtask(id: &str, prompt: &str, depends_on: Vec<&str>) -> SubTask {
        SubTask {
            id: id.to_string(),
            prompt: prompt.to_string(),
            classification: classification(),
            depends_on: depends_on.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    fn by_id(subtasks: &[SubTask]) -> HashMap<String, SubTask> {
        subtasks
            .iter()
            .cloned()
            .map(|s| (s.id.clone(), s))
            .collect()
    }

    #[test]
    fn sequential_chain_receives_predecessor_result() {
        // A → B. B's history must contain A's output.
        let a = subtask("a", "Research the topic", vec![]);
        let b = subtask("b", "Write a summary", vec!["a"]);
        let subtasks = vec![a.clone(), b.clone()];
        let mut results = HashMap::new();
        results.insert("a".to_string(), "Research finding: rates are up".to_string());

        let history = inject_dependency_results(
            &[],
            &b,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        assert_eq!(history.len(), 1);
        let content = history[0]["content"].as_str().unwrap();
        assert!(content.contains("Research finding: rates are up"));
        assert!(content.contains("Research the topic"));
        assert_eq!(history[0]["role"].as_str(), Some("assistant"));
    }

    #[test]
    fn dependent_sees_only_its_own_ancestors() {
        // A, B independent. C depends only on A. C must see A but not B.
        let a = subtask("a", "Research the topic", vec![]);
        let b = subtask("b", "Read the file", vec![]);
        let c = subtask("c", "Review the draft", vec!["a"]);
        let subtasks = vec![a.clone(), b.clone(), c.clone()];
        let mut results = HashMap::new();
        results.insert("a".to_string(), "A_OUTPUT_TOKEN".to_string());
        results.insert("b".to_string(), "B_OUTPUT_TOKEN".to_string());

        let history = inject_dependency_results(
            &[],
            &c,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        assert_eq!(history.len(), 1);
        let content = history[0]["content"].as_str().unwrap();
        assert!(content.contains("A_OUTPUT_TOKEN"));
        assert!(!content.contains("B_OUTPUT_TOKEN"));
    }

    #[test]
    fn cap_trims_to_most_recent_ancestors() {
        // 10-step chain s0 → s1 → … → s9. Injected history for s9 must
        // contain at most MAX_CONTEXT_SUBTASKS ancestors, and they must be
        // the most recent ones (s4..s8) — never the oldest (s0).
        let mut subtasks: Vec<SubTask> = Vec::new();
        let mut results: HashMap<String, String> = HashMap::new();
        for i in 0..10 {
            let id = format!("s{i}");
            let prev = if i == 0 { vec![] } else { vec![format!("s{}", i - 1)] };
            subtasks.push(SubTask {
                id: id.clone(),
                prompt: format!("Step {i}"),
                classification: classification(),
                depends_on: prev,
            });
            results.insert(id, format!("OUT_{i}"));
        }
        let target = subtasks.last().unwrap().clone();

        let history = inject_dependency_results(
            &[],
            &target,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        assert_eq!(history.len(), MAX_CONTEXT_SUBTASKS);
        let joined: String = history
            .iter()
            .map(|h| h["content"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        // Most recent ancestor of s9 is s8 — must be present.
        assert!(joined.contains("OUT_8"), "missing most recent ancestor s8");
        // Oldest ancestor s0 must be trimmed.
        assert!(!joined.contains("OUT_0"), "oldest ancestor leaked past cap");
    }

    #[test]
    fn missing_result_is_skipped_silently() {
        // Dependency completed without a stored result (worker error, etc.).
        // Inject what we have, ignore the rest.
        let a = subtask("a", "Step A", vec![]);
        let b = subtask("b", "Step B", vec!["a"]);
        let c = subtask("c", "Step C", vec!["b"]);
        let subtasks = vec![a, b.clone(), c.clone()];
        let mut results = HashMap::new();
        results.insert("a".to_string(), "A_RESULT".to_string());
        // No result for b.

        let history = inject_dependency_results(
            &[],
            &c,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        assert_eq!(history.len(), 1);
        let content = history[0]["content"].as_str().unwrap();
        assert!(content.contains("A_RESULT"));
    }

    #[test]
    fn base_history_is_preserved_at_head() {
        let a = subtask("a", "Step A", vec![]);
        let b = subtask("b", "Step B", vec!["a"]);
        let subtasks = vec![a, b.clone()];
        let mut results = HashMap::new();
        results.insert("a".to_string(), "A_RESULT".to_string());

        let base = vec![
            serde_json::json!({"role": "user", "content": "Original question"}),
            serde_json::json!({"role": "assistant", "content": "Prior reply"}),
        ];
        let history = inject_dependency_results(
            &base,
            &b,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["content"].as_str(), Some("Original question"));
        assert_eq!(history[1]["content"].as_str(), Some("Prior reply"));
        assert!(history[2]["content"].as_str().unwrap().contains("A_RESULT"));
    }

    #[test]
    fn oversize_result_is_truncated_with_marker() {
        let a = subtask("a", "Step A", vec![]);
        let b = subtask("b", "Step B", vec!["a"]);
        let subtasks = vec![a, b.clone()];
        let mut results = HashMap::new();
        let big = "x".repeat(MAX_SUBTASK_RESULT_BYTES + 1024);
        results.insert("a".to_string(), big);

        let history = inject_dependency_results(
            &[],
            &b,
            &by_id(&subtasks),
            &results,
            MAX_CONTEXT_SUBTASKS,
            MAX_SUBTASK_RESULT_BYTES,
        );

        let content = history[0]["content"].as_str().unwrap();
        assert!(content.contains("[…truncated…]"));
        // Body of synthesized message must not exceed the cap by more than
        // the truncation marker plus the synthesized prefix.
        assert!(content.len() < MAX_SUBTASK_RESULT_BYTES + 256);
    }
}
