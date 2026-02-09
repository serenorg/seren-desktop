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
    "bug",
    "stack trace",
    "variable",
    "method",
    "algorithm",
    "syntax",
    "module",
    "package",
    "dependency",
    "endpoint",
    "database",
    "query",
    "schema",
    "migration",
    "deploy",
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
    "code",
    "coding",
    "programming",
    "compiler",
    "runtime",
    "typescript",
    "javascript",
    "python",
    "rust",
];

const FILE_KEYWORDS: &[&str] = &[
    "read file",
    "read the file",
    "write file",
    "write to file",
    "write a file",
    "create file",
    "create a file",
    "delete file",
    "delete the file",
    "rename file",
    "rename the file",
    "move file",
    "move the file",
    "copy file",
    "copy the file",
    "list directory",
    "list the directory",
    "create directory",
    "create a directory",
    "file system",
    "file path",
    "file contents",
    "save to file",
    "open file",
    "open the file",
];

const RESEARCH_KEYWORDS: &[&str] = &[
    "search for",
    "search the",
    "look up",
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
];

const DOCUMENT_KEYWORDS: &[&str] = &[
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
// Word Boundary Matching
// =============================================================================

/// Check if a keyword appears in text with word boundaries.
/// Multi-word keywords use simple substring matching.
/// Single-word keywords require word boundary characters on both sides.
fn contains_keyword(text: &str, keyword: &str) -> bool {
    if keyword.contains(' ') {
        // Multi-word: simple substring match
        return text.contains(keyword);
    }

    // Single-word: check word boundaries
    let keyword_bytes = keyword.as_bytes();
    let text_bytes = text.as_bytes();

    if keyword_bytes.len() > text_bytes.len() {
        return false;
    }

    let mut start = 0;
    while let Some(pos) = text[start..].find(keyword) {
        let abs_pos = start + pos;
        let end_pos = abs_pos + keyword.len();

        let boundary_before =
            abs_pos == 0 || !text_bytes[abs_pos - 1].is_ascii_alphanumeric();
        let boundary_after =
            end_pos >= text_bytes.len() || !text_bytes[end_pos].is_ascii_alphanumeric();

        if boundary_before && boundary_after {
            return true;
        }

        // Move past this match to avoid infinite loop
        start = abs_pos + 1;
        if start >= text.len() {
            break;
        }
    }

    false
}

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
            .any(|kw| contains_keyword(&prompt_lower, kw))
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
        .any(|kw| contains_keyword(&prompt_lower, kw))
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
        .any(|kw| contains_keyword(&prompt_lower, kw))
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
        .any(|kw| contains_keyword(&prompt_lower, kw))
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
/// - Skill name appearing in the prompt (word boundary)
/// - Any skill tag appearing in the prompt (word boundary)
/// - Skill slug appearing in the prompt (word boundary)
pub fn select_relevant_skills(prompt: &str, skills: &[SkillRef]) -> Vec<String> {
    let prompt_lower = prompt.to_lowercase();

    skills
        .iter()
        .filter(|skill| {
            contains_keyword(&prompt_lower, &skill.name.to_lowercase())
                || skill
                    .tags
                    .iter()
                    .any(|tag| contains_keyword(&prompt_lower, &tag.to_lowercase()))
                || contains_keyword(&prompt_lower, &skill.slug.to_lowercase())
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
    // Word Boundary Tests
    // =========================================================================

    #[test]
    fn word_boundary_rejects_substring_match() {
        // "capital" should NOT match "api"
        assert!(!contains_keyword("capital", "api"));
        // "latest" should NOT match "test"
        assert!(!contains_keyword("latest", "test"));
        // "testing" should NOT match "test" (no boundary after)
        assert!(!contains_keyword("testing", "test"));
    }

    #[test]
    fn word_boundary_accepts_whole_word() {
        assert!(contains_keyword("run a test", "test"));
        assert!(contains_keyword("test this", "test"));
        assert!(contains_keyword("test", "test"));
        assert!(contains_keyword("the api is broken", "api"));
    }

    #[test]
    fn multi_word_keyword_uses_substring_match() {
        assert!(contains_keyword("search for the news", "search for"));
        assert!(contains_keyword("please write code here", "write code"));
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
        let result = classify("Help me git commit my code changes", &skills);
        assert_eq!(result.task_type, "code_generation");
        assert_eq!(result.relevant_skills, vec!["git-commit"]);
    }
}
