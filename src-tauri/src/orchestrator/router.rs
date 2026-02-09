// ABOUTME: Bootstrap router that maps task classifications to worker routing decisions.
// ABOUTME: Selects worker type, model, and delegation level based on capabilities.

use super::types::{
    DelegationType, RoutingDecision, SkillRef, TaskClassification, TaskComplexity,
    UserCapabilities, WorkerType,
};

/// Preferred models for code tasks (ordered by capability).
const CODE_PREFERRED_MODELS: &[&str] = &[
    "anthropic/claude-opus-4-6",
    "openai/gpt-5.3",
];

/// Preferred models for simple Q&A (ordered by speed/cost).
const SIMPLE_PREFERRED_MODELS: &[&str] = &[
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash",
    "anthropic/claude-haiku-4.5",
    "moonshot/kimi-k2.5",
    "thudm/glm-4.7",
    "anthropic/claude-sonnet-4",
];

/// Route a classified task to the appropriate worker.
///
/// Bootstrap routing logic:
/// 1. Code generation + file system + ACP agent available → AcpAgent
/// 2. Requires tools + tools available → ChatModel (with tools)
/// 3. Default → ChatModel (without tools)
///
/// Model selection:
/// - Code tasks: prefer the most capable model
/// - Simple Q&A: prefer a fast/cheap model
///
/// Delegation: always InLoop for bootstrap (trust graduation comes in Phase 4).
pub fn route(
    classification: &TaskClassification,
    capabilities: &UserCapabilities,
) -> RoutingDecision {
    let worker_type = select_worker_type(classification, capabilities);
    let model_id = select_model(classification, capabilities);
    let selected_skills = resolve_skills(classification, capabilities);
    let reason = build_reason(classification, &worker_type, &model_id);

    let publisher_slug = extract_publisher_slug(&worker_type, capabilities);

    RoutingDecision {
        worker_type,
        model_id,
        delegation: DelegationType::InLoop,
        reason,
        selected_skills,
        publisher_slug,
    }
}

/// Select the worker type based on task requirements and available capabilities.
fn select_worker_type(
    classification: &TaskClassification,
    capabilities: &UserCapabilities,
) -> WorkerType {
    // Code generation with file system access + ACP agent → AcpAgent
    if classification.task_type == "code_generation"
        && classification.requires_file_system
        && capabilities.has_acp_agent
    {
        return WorkerType::AcpAgent;
    }

    // Task requiring tools + publisher tools available → McpPublisher
    if classification.requires_tools
        && capabilities
            .available_tools
            .iter()
            .any(|t| t.starts_with("mcp__"))
    {
        return WorkerType::McpPublisher;
    }

    // Everything else → ChatModel
    WorkerType::ChatModel
}

/// Extract the publisher slug from available MCP tools.
///
/// MCP tool names follow the pattern `mcp__<publisher-slug>__<tool-name>`.
/// Returns the first publisher slug found, or None.
fn extract_publisher_slug(
    worker_type: &WorkerType,
    capabilities: &UserCapabilities,
) -> Option<String> {
    if *worker_type != WorkerType::McpPublisher {
        return None;
    }

    capabilities
        .available_tools
        .iter()
        .filter_map(|t| {
            let rest = t.strip_prefix("mcp__")?;
            let slug_end = rest.find("__")?;
            Some(rest[..slug_end].to_string())
        })
        .next()
}

/// Select the best available model for the task.
///
/// If the user explicitly selected a model in the UI, respect that choice.
/// Otherwise, fall back to heuristic-based selection by task complexity.
fn select_model(
    classification: &TaskClassification,
    capabilities: &UserCapabilities,
) -> String {
    // Respect the user's explicit model selection
    if let Some(ref selected) = capabilities.selected_model {
        if !selected.is_empty() {
            return selected.clone();
        }
    }

    let preferred = match classification.complexity {
        TaskComplexity::Complex | TaskComplexity::Moderate => CODE_PREFERRED_MODELS,
        TaskComplexity::Simple => SIMPLE_PREFERRED_MODELS,
    };

    // Override: code tasks always prefer capable models regardless of complexity
    let preferred = if classification.task_type == "code_generation" {
        CODE_PREFERRED_MODELS
    } else {
        preferred
    };

    // Find the first preferred model that's available
    for model in preferred {
        if capabilities.available_models.iter().any(|m| m == model) {
            return model.to_string();
        }
    }

    // Fallback: use the first available model, or a sensible default
    capabilities
        .available_models
        .first()
        .cloned()
        .unwrap_or_else(|| "anthropic/claude-sonnet-4".to_string())
}

/// Resolve skill slugs from the classification to full SkillRef objects.
fn resolve_skills(
    classification: &TaskClassification,
    capabilities: &UserCapabilities,
) -> Vec<SkillRef> {
    classification
        .relevant_skills
        .iter()
        .filter_map(|slug| {
            capabilities
                .installed_skills
                .iter()
                .find(|s| s.slug == *slug)
                .cloned()
        })
        .collect()
}

/// Build a human-readable reason string for the transition announcement.
fn build_reason(
    classification: &TaskClassification,
    worker_type: &WorkerType,
    model_id: &str,
) -> String {
    let model_name = humanize_model_id(model_id);
    let task_desc = humanize_task_type(&classification.task_type);

    match worker_type {
        WorkerType::AcpAgent => {
            format!("Working with agent on {}", task_desc)
        }
        WorkerType::ChatModel => {
            format!("Working with {} on {}", model_name, task_desc)
        }
        WorkerType::McpPublisher => {
            format!("Working with publisher on {}", task_desc)
        }
    }
}

/// Convert a model ID to a human-readable name.
fn humanize_model_id(model_id: &str) -> &str {
    match model_id {
        "anthropic/claude-opus-4-6" => "Claude Opus",
        "anthropic/claude-opus-4.5" => "Claude Opus",
        "anthropic/claude-sonnet-4" => "Claude Sonnet",
        "anthropic/claude-haiku-4.5" => "Claude Haiku",
        "openai/gpt-5.3" => "GPT-5.3",
        "openai/gpt-5" => "GPT-5",
        "openai/gpt-4o" => "GPT-4o",
        "openai/gpt-4o-mini" => "GPT-4o Mini",
        "google/gemini-2.5-pro" => "Gemini Pro",
        "google/gemini-2.5-flash" => "Gemini Flash",
        "google/gemini-3-flash-preview" => "Gemini 3 Flash",
        "moonshot/kimi-k2.5" => "Kimi K2.5",
        "thudm/glm-4.7" => "GLM-4.7",
        "thudm/glm-4" => "GLM-4",
        _ => model_id,
    }
}

/// HTTP status codes that indicate a transient failure eligible for model reroute.
const REROUTABLE_STATUS_CODES: &[u16] = &[408, 429, 502, 503, 504];

/// Maximum number of reroute attempts before giving up.
pub const MAX_REROUTE_ATTEMPTS: usize = 2;

/// Check whether an error message indicates a transient failure eligible for reroute.
pub fn is_reroutable_error(error_message: &str) -> bool {
    // Don't reroute auth or client errors
    if error_message.contains("401")
        || error_message.contains("403")
        || error_message.contains("400")
        || error_message.contains("API key")
        || error_message.contains("Insufficient credits")
    {
        return false;
    }

    REROUTABLE_STATUS_CODES
        .iter()
        .any(|code| error_message.contains(&code.to_string()))
}

/// Select a fallback model after a transient failure, ranked by satisfaction signals.
///
/// Queries the local eval_signals table for models with positive satisfaction
/// for the given task_type, then falls back to the hardcoded preference list.
/// Excludes any models already tried.
pub fn reroute_on_failure(
    conn: &rusqlite::Connection,
    task_type: &str,
    tried_models: &[String],
    available_models: &[String],
    classification: &TaskClassification,
) -> Option<(String, String)> {
    // 1. Query satisfaction-ranked models from eval_signals
    if let Ok(ranked) = query_satisfaction_ranked_models(conn, task_type, tried_models) {
        for (model_id, score) in &ranked {
            if available_models.iter().any(|m| m == model_id) {
                let reason = format!(
                    "Rerouted to {} (rated helpful for {}, score: {})",
                    humanize_model_id(model_id),
                    humanize_task_type(task_type),
                    score,
                );
                return Some((model_id.clone(), reason));
            }
        }
    }

    // 2. Fall back to hardcoded preference list, skipping tried models
    let preferred = if classification.task_type == "code_generation" {
        CODE_PREFERRED_MODELS
    } else {
        match classification.complexity {
            TaskComplexity::Complex | TaskComplexity::Moderate => CODE_PREFERRED_MODELS,
            TaskComplexity::Simple => SIMPLE_PREFERRED_MODELS,
        }
    };

    for model in preferred {
        let model_str = model.to_string();
        if !tried_models.contains(&model_str) && available_models.iter().any(|m| m == model) {
            let reason = format!(
                "Rerouted to {} for {}",
                humanize_model_id(model),
                humanize_task_type(task_type),
            );
            return Some((model_str, reason));
        }
    }

    // 3. Try any available model not yet tried
    for model in available_models {
        if !tried_models.contains(model) {
            let reason = format!(
                "Rerouted to {} for {}",
                humanize_model_id(model),
                humanize_task_type(task_type),
            );
            return Some((model.clone(), reason));
        }
    }

    None
}

/// Query eval_signals for models ranked by positive satisfaction count.
///
/// Returns (model_id, positive_count) pairs sorted descending, excluding tried models.
fn query_satisfaction_ranked_models(
    conn: &rusqlite::Connection,
    task_type: &str,
    tried_models: &[String],
) -> Result<Vec<(String, i64)>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT model_id, SUM(CASE WHEN satisfaction = 1 THEN 1 ELSE 0 END) as positive_count
         FROM eval_signals
         WHERE task_type = ?1 AND model_id IS NOT NULL
         GROUP BY model_id
         HAVING positive_count > 0
         ORDER BY positive_count DESC",
    )?;

    let rows = stmt.query_map(rusqlite::params![task_type], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;

    let mut results = Vec::new();
    for row in rows {
        if let Ok((model_id, score)) = row {
            if !tried_models.contains(&model_id) {
                results.push((model_id, score));
            }
        }
    }

    Ok(results)
}

/// Convert a task type to a human-readable description.
fn humanize_task_type(task_type: &str) -> &str {
    match task_type {
        "code_generation" => "code generation",
        "file_operations" => "file operations",
        "research" => "research",
        "document_generation" => "document generation",
        "general_chat" => "your question",
        _ => task_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_capabilities(has_agent: bool, models: &[&str], tools: &[&str]) -> UserCapabilities {
        UserCapabilities {
            has_acp_agent: has_agent,
            agent_type: if has_agent {
                Some("claude-code".to_string())
            } else {
                None
            },
            selected_model: None,
            available_models: models.iter().map(|m| m.to_string()).collect(),
            available_tools: tools.iter().map(|t| t.to_string()).collect(),
            installed_skills: vec![],
        }
    }

    fn make_capabilities_with_skills(
        has_agent: bool,
        models: &[&str],
        skills: Vec<SkillRef>,
    ) -> UserCapabilities {
        UserCapabilities {
            has_acp_agent: has_agent,
            agent_type: if has_agent {
                Some("claude-code".to_string())
            } else {
                None
            },
            selected_model: None,
            available_models: models.iter().map(|m| m.to_string()).collect(),
            available_tools: vec![],
            installed_skills: skills,
        }
    }

    fn make_classification(task_type: &str, requires_tools: bool, requires_fs: bool) -> TaskClassification {
        TaskClassification {
            task_type: task_type.to_string(),
            requires_tools,
            requires_file_system: requires_fs,
            complexity: if task_type == "general_chat" {
                TaskComplexity::Simple
            } else {
                TaskComplexity::Moderate
            },
            relevant_skills: vec![],
        }
    }

    fn make_skill(slug: &str, name: &str) -> SkillRef {
        SkillRef {
            slug: slug.to_string(),
            name: name.to_string(),
            description: String::new(),
            tags: vec![],
            path: format!("/skills/{}/SKILL.md", slug),
        }
    }

    // =========================================================================
    // Worker Type Selection
    // =========================================================================

    #[test]
    fn routes_code_generation_with_agent_to_acp() {
        let classification = make_classification("code_generation", true, true);
        let capabilities = make_capabilities(
            true,
            &["anthropic/claude-opus-4-6"],
            &["firecrawl"],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::AcpAgent);
    }

    #[test]
    fn routes_code_generation_without_agent_to_chat_model() {
        let classification = make_classification("code_generation", true, true);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4"],
            &["firecrawl"],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::ChatModel);
    }

    #[test]
    fn routes_general_chat_to_chat_model() {
        let classification = make_classification("general_chat", false, false);
        let capabilities = make_capabilities(
            true,
            &["anthropic/claude-sonnet-4"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::ChatModel);
    }

    #[test]
    fn routes_research_with_non_mcp_tools_to_chat_model() {
        let classification = make_classification("research", true, false);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4"],
            &["web_search"],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::ChatModel);
    }

    #[test]
    fn routes_research_with_mcp_tools_to_mcp_publisher() {
        let classification = make_classification("research", true, false);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4"],
            &["mcp__firecrawl-serenai__scrape"],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::McpPublisher);
        assert_eq!(
            decision.publisher_slug,
            Some("firecrawl-serenai".to_string())
        );
    }

    #[test]
    fn mcp_publisher_does_not_trigger_without_requires_tools() {
        let classification = make_classification("general_chat", false, false);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4"],
            &["mcp__firecrawl-serenai__scrape"],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.worker_type, WorkerType::ChatModel);
        assert_eq!(decision.publisher_slug, None);
    }

    // =========================================================================
    // Model Selection
    // =========================================================================

    #[test]
    fn selects_capable_model_for_code_tasks() {
        let classification = make_classification("code_generation", true, true);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4", "anthropic/claude-opus-4-6"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "anthropic/claude-opus-4-6");
    }

    #[test]
    fn selects_fast_model_for_simple_tasks() {
        let classification = make_classification("general_chat", false, false);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "google/gemini-2.5-flash");
    }

    #[test]
    fn falls_back_to_first_available_model() {
        let classification = make_classification("general_chat", false, false);
        let capabilities = make_capabilities(
            false,
            &["some/unknown-model"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "some/unknown-model");
    }

    #[test]
    fn falls_back_to_default_when_no_models() {
        let classification = make_classification("general_chat", false, false);
        let capabilities = make_capabilities(false, &[], &[]);
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "anthropic/claude-sonnet-4");
    }

    #[test]
    fn respects_user_selected_model() {
        let classification = make_classification("general_chat", false, false);
        let mut capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4", "google/gemini-2.5-flash", "openai/gpt-5"],
            &[],
        );
        // Without selection, router picks gemini flash for simple tasks
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "google/gemini-2.5-flash");

        // With explicit selection, router respects the user's choice
        capabilities.selected_model = Some("openai/gpt-5".to_string());
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.model_id, "openai/gpt-5");
        assert!(decision.reason.contains("GPT-5"));
    }

    // =========================================================================
    // Delegation
    // =========================================================================

    #[test]
    fn always_uses_in_loop_delegation() {
        let classification = make_classification("code_generation", true, true);
        let capabilities = make_capabilities(
            true,
            &["anthropic/claude-opus-4-6"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert_eq!(decision.delegation, DelegationType::InLoop);
    }

    // =========================================================================
    // Reason String
    // =========================================================================

    #[test]
    fn reason_is_human_readable() {
        let classification = make_classification("code_generation", true, true);
        let capabilities = make_capabilities(
            true,
            &["anthropic/claude-opus-4-6"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert!(decision.reason.contains("agent"));
        assert!(decision.reason.contains("code generation"));
    }

    #[test]
    fn reason_includes_model_name_for_chat() {
        let classification = make_classification("research", true, false);
        let capabilities = make_capabilities(
            false,
            &["anthropic/claude-sonnet-4"],
            &[],
        );
        let decision = route(&classification, &capabilities);
        assert!(decision.reason.contains("Claude Sonnet"));
        assert!(decision.reason.contains("research"));
    }

    // =========================================================================
    // Skill Resolution
    // =========================================================================

    #[test]
    fn resolves_matching_skills_from_capabilities() {
        let mut classification = make_classification("code_generation", true, true);
        classification.relevant_skills = vec!["prose".to_string()];

        let capabilities = make_capabilities_with_skills(
            false,
            &["anthropic/claude-sonnet-4"],
            vec![make_skill("prose", "Prose")],
        );

        let decision = route(&classification, &capabilities);
        assert_eq!(decision.selected_skills.len(), 1);
        assert_eq!(decision.selected_skills[0].slug, "prose");
    }

    #[test]
    fn ignores_nonexistent_skill_slugs() {
        let mut classification = make_classification("code_generation", true, true);
        classification.relevant_skills = vec!["nonexistent".to_string()];

        let capabilities = make_capabilities_with_skills(
            false,
            &["anthropic/claude-sonnet-4"],
            vec![make_skill("prose", "Prose")],
        );

        let decision = route(&classification, &capabilities);
        assert!(decision.selected_skills.is_empty());
    }

    #[test]
    fn resolves_multiple_skills() {
        let mut classification = make_classification("code_generation", true, true);
        classification.relevant_skills =
            vec!["prose".to_string(), "git-commit".to_string()];

        let capabilities = make_capabilities_with_skills(
            false,
            &["anthropic/claude-sonnet-4"],
            vec![
                make_skill("prose", "Prose"),
                make_skill("git-commit", "Git Commit"),
            ],
        );

        let decision = route(&classification, &capabilities);
        assert_eq!(decision.selected_skills.len(), 2);
    }

    // =========================================================================
    // Reroutable Error Detection
    // =========================================================================

    #[test]
    fn detects_408_as_reroutable() {
        assert!(is_reroutable_error("Gateway returned HTTP 408 Request Timeout"));
    }

    #[test]
    fn detects_429_as_reroutable() {
        assert!(is_reroutable_error("HTTP 429: Rate limit exceeded"));
    }

    #[test]
    fn detects_502_as_reroutable() {
        assert!(is_reroutable_error("Gateway returned HTTP 502"));
    }

    #[test]
    fn rejects_401_as_not_reroutable() {
        assert!(!is_reroutable_error("HTTP 401: Unauthorized"));
    }

    #[test]
    fn rejects_403_as_not_reroutable() {
        assert!(!is_reroutable_error("HTTP 403: Forbidden"));
    }

    #[test]
    fn rejects_400_as_not_reroutable() {
        assert!(!is_reroutable_error("HTTP 400: Bad Request"));
    }

    #[test]
    fn rejects_insufficient_credits() {
        assert!(!is_reroutable_error("HTTP 402: Insufficient credits"));
    }

    #[test]
    fn rejects_generic_error_as_not_reroutable() {
        assert!(!is_reroutable_error("Something went wrong"));
    }

    // =========================================================================
    // Reroute Fallback (without DB — hardcoded preferences)
    // =========================================================================

    #[test]
    fn reroute_skips_tried_models() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS eval_signals (
                message_id TEXT PRIMARY KEY,
                task_type TEXT NOT NULL,
                model_id TEXT,
                worker_type TEXT,
                satisfaction INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                synced INTEGER DEFAULT 0
            )",
            [],
        )
        .unwrap();

        let classification = make_classification("general_chat", false, false);
        let tried = vec!["google/gemini-3-flash-preview".to_string()];
        let available = vec![
            "google/gemini-3-flash-preview".to_string(),
            "google/gemini-2.5-flash".to_string(),
            "anthropic/claude-sonnet-4".to_string(),
        ];

        let result = reroute_on_failure(&conn, "general_chat", &tried, &available, &classification);
        assert!(result.is_some());
        let (model, _reason) = result.unwrap();
        // Should skip gemini-3-flash (tried) and pick gemini-2.5-flash (next preferred)
        assert_eq!(model, "google/gemini-2.5-flash");
    }

    #[test]
    fn reroute_returns_none_when_all_models_tried() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS eval_signals (
                message_id TEXT PRIMARY KEY,
                task_type TEXT NOT NULL,
                model_id TEXT,
                worker_type TEXT,
                satisfaction INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                synced INTEGER DEFAULT 0
            )",
            [],
        )
        .unwrap();

        let classification = make_classification("general_chat", false, false);
        let available = vec!["anthropic/claude-sonnet-4".to_string()];
        let tried = vec!["anthropic/claude-sonnet-4".to_string()];

        let result = reroute_on_failure(&conn, "general_chat", &tried, &available, &classification);
        assert!(result.is_none());
    }

    #[test]
    fn reroute_prefers_satisfaction_ranked_model() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS eval_signals (
                message_id TEXT PRIMARY KEY,
                task_type TEXT NOT NULL,
                model_id TEXT,
                worker_type TEXT,
                satisfaction INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                synced INTEGER DEFAULT 0
            )",
            [],
        )
        .unwrap();

        // Insert satisfaction signals: sonnet has 3 positive, haiku has 1
        for i in 0..3 {
            conn.execute(
                "INSERT INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, created_at, synced)
                 VALUES (?1, 'general_chat', 'anthropic/claude-sonnet-4', 'chat_model', 1, 1000, 0)",
                rusqlite::params![format!("msg-sonnet-{}", i)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, created_at, synced)
             VALUES ('msg-haiku-1', 'general_chat', 'anthropic/claude-haiku-4.5', 'chat_model', 1, 1000, 0)",
            [],
        )
        .unwrap();

        let classification = make_classification("general_chat", false, false);
        let tried = vec!["moonshot/kimi-k2.5".to_string()];
        let available = vec![
            "moonshot/kimi-k2.5".to_string(),
            "anthropic/claude-haiku-4.5".to_string(),
            "anthropic/claude-sonnet-4".to_string(),
        ];

        let result = reroute_on_failure(&conn, "general_chat", &tried, &available, &classification);
        assert!(result.is_some());
        let (model, reason) = result.unwrap();
        // Should prefer sonnet (3 positive signals) over haiku (1)
        assert_eq!(model, "anthropic/claude-sonnet-4");
        assert!(reason.contains("rated helpful"));
        assert!(reason.contains("score: 3"));
    }
}
