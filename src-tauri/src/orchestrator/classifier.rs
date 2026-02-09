// ABOUTME: Bootstrap task classifier using heuristic keyword matching.
// ABOUTME: Classifies prompts into task types and selects relevant skills.

use super::types::{SkillRef, TaskClassification, TaskComplexity};

// =============================================================================
// Keyword Lists
// =============================================================================

const CODE_KEYWORDS: &[&str] = &[
    "function",
    "class",
    "implement",
    "write code",
    "script",
    "compile",
    "debug",
    "refactor",
    "test",
    "bug",
    "error",
    "stack trace",
    "variable",
    "method",
    "algorithm",
    "syntax",
    "import",
    "module",
    "package",
    "dependency",
    "api",
    "endpoint",
    "database",
    "query",
    "schema",
    "migration",
    "deploy",
    "build",
    "lint",
    "type check",
    "async",
    "await",
    "promise",
    "callback",
    "struct",
    "enum",
    "trait",
    "interface",
    "generic",
    "template",
    "regex",
    "parse",
    "serialize",
    "deserialize",
    "docker",
    "kubernetes",
    "ci/cd",
    "pipeline",
    "git",
    "commit",
    "branch",
    "merge",
    "pull request",
    "code review",
];

const FILE_KEYWORDS: &[&str] = &[
    "read file",
    "write file",
    "create file",
    "delete file",
    "rename file",
    "move file",
    "copy file",
    "list directory",
    "create directory",
    "file system",
    "file path",
    "file contents",
    "save to file",
    "open file",
];

const RESEARCH_KEYWORDS: &[&str] = &[
    "search",
    "find",
    "look up",
    "what is",
    "explain",
    "research",
    "summarize",
    "definition",
    "how does",
    "compare",
    "difference between",
    "pros and cons",
    "best practice",
    "documentation",
    "tutorial",
    "guide",
    "reference",
];

const DOCUMENT_KEYWORDS: &[&str] = &[
    "write",
    "draft",
    "document",
    "report",
    "essay",
    "email",
    "letter",
    "memo",
    "proposal",
    "presentation",
    "blog post",
    "article",
    "readme",
    "changelog",
    "release notes",
];

// =============================================================================
// Task Classification
// =============================================================================

/// Classify a user prompt into a task type using keyword heuristics.
///
/// Rules are applied in priority order:
/// 1. Code generation (code keywords or code fences)
/// 2. File operations (file keywords)
/// 3. Research (search/explain keywords)
/// 4. Document generation (writing keywords)
/// 5. General chat (default)
pub fn classify(prompt: &str, skills: &[SkillRef]) -> TaskClassification {
    let prompt_lower = prompt.to_lowercase();

    let relevant_skills = select_relevant_skills(prompt, skills);

    // Rule 1: Code generation
    if contains_code_fence(prompt)
        || CODE_KEYWORDS
            .iter()
            .any(|kw| prompt_lower.contains(kw))
    {
        return TaskClassification {
            task_type: "code_generation".to_string(),
            requires_tools: true,
            requires_file_system: true,
            complexity: TaskComplexity::Moderate,
            relevant_skills,
        };
    }

    // Rule 2: File operations
    if FILE_KEYWORDS
        .iter()
        .any(|kw| prompt_lower.contains(kw))
    {
        return TaskClassification {
            task_type: "file_operations".to_string(),
            requires_tools: true,
            requires_file_system: true,
            complexity: TaskComplexity::Simple,
            relevant_skills,
        };
    }

    // Rule 3: Research
    if RESEARCH_KEYWORDS
        .iter()
        .any(|kw| prompt_lower.contains(kw))
    {
        return TaskClassification {
            task_type: "research".to_string(),
            requires_tools: true,
            requires_file_system: false,
            complexity: TaskComplexity::Simple,
            relevant_skills,
        };
    }

    // Rule 4: Document generation
    if DOCUMENT_KEYWORDS
        .iter()
        .any(|kw| prompt_lower.contains(kw))
    {
        return TaskClassification {
            task_type: "document_generation".to_string(),
            requires_tools: false,
            requires_file_system: false,
            complexity: TaskComplexity::Moderate,
            relevant_skills,
        };
    }

    // Rule 5: Default
    TaskClassification {
        task_type: "general_chat".to_string(),
        requires_tools: false,
        requires_file_system: false,
        complexity: TaskComplexity::Simple,
        relevant_skills,
    }
}

/// Check if the prompt contains a markdown code fence.
fn contains_code_fence(prompt: &str) -> bool {
    prompt.contains("```")
}

// =============================================================================
// Skill Selection
// =============================================================================

/// Select skills relevant to a prompt by matching against skill metadata.
///
/// Matches by:
/// - Skill name appearing in the prompt
/// - Any skill tag appearing in the prompt
/// - Skill slug appearing in the prompt
pub fn select_relevant_skills(prompt: &str, skills: &[SkillRef]) -> Vec<String> {
    let prompt_lower = prompt.to_lowercase();

    skills
        .iter()
        .filter(|skill| {
            prompt_lower.contains(&skill.name.to_lowercase())
                || skill
                    .tags
                    .iter()
                    .any(|tag| prompt_lower.contains(&tag.to_lowercase()))
                || prompt_lower.contains(&skill.slug.to_lowercase())
        })
        .map(|skill| skill.slug.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_skill(slug: &str, name: &str, tags: &[&str]) -> SkillRef {
        SkillRef {
            slug: slug.to_string(),
            name: name.to_string(),
            description: String::new(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            path: format!("/skills/{}/SKILL.md", slug),
        }
    }

    // =========================================================================
    // Task Classification Tests
    // =========================================================================

    #[test]
    fn classifies_code_generation_from_keywords() {
        let result = classify("Write a Python function that sorts a list", &[]);
        assert_eq!(result.task_type, "code_generation");
        assert!(result.requires_tools);
        assert!(result.requires_file_system);
        assert_eq!(result.complexity, TaskComplexity::Moderate);
    }

    #[test]
    fn classifies_code_generation_from_code_fence() {
        let prompt = "Fix this code:\n```python\ndef foo():\n    pass\n```";
        let result = classify(prompt, &[]);
        assert_eq!(result.task_type, "code_generation");
    }

    #[test]
    fn classifies_general_chat_for_simple_question() {
        let result = classify("What is the capital of France?", &[]);
        assert_eq!(result.task_type, "general_chat");
        assert!(!result.requires_tools);
        assert!(!result.requires_file_system);
        assert_eq!(result.complexity, TaskComplexity::Simple);
    }

    #[test]
    fn classifies_research_for_search_prompt() {
        let result = classify("Search for the latest news about AI", &[]);
        assert_eq!(result.task_type, "research");
        assert!(result.requires_tools);
        assert!(!result.requires_file_system);
    }

    #[test]
    fn classifies_document_generation() {
        let result = classify("Draft an email to my team about the Q3 results", &[]);
        assert_eq!(result.task_type, "document_generation");
        assert!(!result.requires_tools);
        assert_eq!(result.complexity, TaskComplexity::Moderate);
    }

    #[test]
    fn classifies_file_operations() {
        let result = classify("Read the file at /tmp/foo.txt", &[]);
        assert_eq!(result.task_type, "file_operations");
        assert!(result.requires_tools);
        assert!(result.requires_file_system);
        assert_eq!(result.complexity, TaskComplexity::Simple);
    }

    #[test]
    fn classifies_empty_string_as_general_chat() {
        let result = classify("", &[]);
        assert_eq!(result.task_type, "general_chat");
    }

    #[test]
    fn code_takes_priority_over_research() {
        // "explain" is research, but "function" is code — code wins
        let result = classify("Explain how this function works", &[]);
        assert_eq!(result.task_type, "code_generation");
    }

    #[test]
    fn case_insensitive_matching() {
        let result = classify("IMPLEMENT a CLASS in TypeScript", &[]);
        assert_eq!(result.task_type, "code_generation");
    }

    // =========================================================================
    // Skill Selection Tests
    // =========================================================================

    #[test]
    fn selects_skill_by_name() {
        let skills = vec![make_skill("prose", "Prose", &["writing", "ai"])];
        let result = select_relevant_skills("Use Prose to help me write", &skills);
        assert_eq!(result, vec!["prose"]);
    }

    #[test]
    fn selects_skill_by_tag() {
        let skills = vec![make_skill("git-commit", "Git Commit", &["git", "version-control"])];
        let result = select_relevant_skills("help me with git", &skills);
        assert_eq!(result, vec!["git-commit"]);
    }

    #[test]
    fn selects_skill_by_slug() {
        let skills = vec![make_skill("prose", "Prose Helper", &["ai", "orchestration"])];
        let result = select_relevant_skills("prose run my_workflow", &skills);
        assert_eq!(result, vec!["prose"]);
    }

    #[test]
    fn returns_empty_when_no_skills_match() {
        let skills = vec![
            make_skill("prose", "Prose", &["writing"]),
            make_skill("git-commit", "Git Commit", &["git"]),
        ];
        let result = select_relevant_skills("What's the weather?", &skills);
        assert!(result.is_empty());
    }

    #[test]
    fn selects_multiple_matching_skills() {
        let skills = vec![
            make_skill("prose", "Prose", &["writing"]),
            make_skill("docs", "Documentation", &["writing", "markdown"]),
        ];
        let result = select_relevant_skills("Help me with writing documentation", &skills);
        assert_eq!(result.len(), 2);
        assert!(result.contains(&"prose".to_string()));
        assert!(result.contains(&"docs".to_string()));
    }

    #[test]
    fn skill_selection_is_case_insensitive() {
        let skills = vec![make_skill("prose", "Prose", &["Writing"])];
        let result = select_relevant_skills("I need PROSE help", &skills);
        assert_eq!(result, vec!["prose"]);
    }

    #[test]
    fn classify_includes_relevant_skills() {
        let skills = vec![make_skill("git-commit", "Git Commit", &["git", "version-control"])];
        let result = classify("Help me commit my code changes", &skills);
        assert_eq!(result.task_type, "code_generation");
        assert_eq!(result.relevant_skills, vec!["git-commit"]);
    }
}
