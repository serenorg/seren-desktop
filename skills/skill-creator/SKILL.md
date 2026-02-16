---
name: Skill Creator
description: Guides users through creating new skills following the AgentSkills.io standard. Use when the user wants to create a custom skill.
---

# Skill Creator

Guides users through creating new skills that work with Claude Code, OpenAI Codex, and other compatible LLMs.

## When to Use This Skill

Use this skill when:
- User asks to create a new skill
- User wants to customize agent behavior for a specific task
- User mentions "create a skill", "make a skill", or "custom command"

## Skill Creation Workflow

When creating a skill, follow these steps:

### 1. Gather Requirements

Ask the user:
- **Skill name**: A short, kebab-case identifier (e.g., `code-reviewer`, `api-tester`)
- **Purpose**: What task should this skill help with?
- **When to use**: What triggers or context should activate this skill?
- **Workflow**: What are the key steps the agent should follow?

### 2. Choose Scope

Skills can be installed in three scopes:
- **Project** (`skills/`): Available only in this project
- **Claude** (`~/.claude/skills/`): Available globally in Claude Code
- **Seren** (app data): Available globally in Seren Desktop

For most cases, recommend **Project scope**.

### 3. Generate SKILL.md

Create a `SKILL.md` file following the AgentSkills.io format:

```markdown
---
name: skill-name
description: Brief description of what this skill does and when to use it
author: Author Name (optional)
version: 1.0.0 (optional)
tags: [tag1, tag2] (optional)
---

# Skill Name

## Overview

Describe the skill's purpose and capabilities.

## When to Use

Explain when and why an agent should use this skill.

## Workflow

1. First step
2. Second step
3. Third step

## Examples

### Example 1: Use Case Name

```
User: "trigger phrase"
Agent: [expected behavior]
```

## Best Practices

- Guideline 1
- Guideline 2

## Common Pitfalls

- What to avoid
- Edge cases to handle
```

### 4. Create the Skill Directory

Use the file system to create:
- `skills/{skill-name}/SKILL.md` - The main skill file
- `skills/{skill-name}/examples/` - (Optional) Example outputs
- `skills/{skill-name}/scripts/` - (Optional) Helper scripts

### 5. Test the Skill

After creating:
1. Verify the skill appears in the Skills sidebar
2. Test activation with a relevant prompt
3. Iterate based on results

## Skill Best Practices

### Writing Effective Skills

- **Be specific**: Clear triggers and workflows produce better results
- **Use examples**: Show concrete input/output examples
- **Keep it focused**: One skill = one responsibility
- **Test iteratively**: Create, test, refine

### Skill Metadata

The YAML frontmatter should include:
- `name`: Kebab-case identifier (required)
- `description`: When to use this skill (required)
- `author`: Creator name (optional)
- `version`: Semantic version (optional)
- `tags`: Categories for filtering (optional)

### Progressive Disclosure

For complex skills:
1. Start with a clear overview
2. Provide step-by-step workflows
3. Include detailed examples
4. Add optional advanced sections

## Example Skills

### Example: Code Reviewer

```markdown
---
name: code-reviewer
description: Performs thorough code reviews following best practices
tags: [code-quality, review, best-practices]
---

# Code Reviewer

Reviews code changes for quality, security, and best practices.

## Workflow

1. Read the code changes
2. Check for common issues:
   - Security vulnerabilities
   - Performance problems
   - Code style violations
   - Missing error handling
3. Provide constructive feedback
4. Suggest improvements with examples
```

### Example: API Tester

```markdown
---
name: api-tester
description: Tests API endpoints and validates responses
tags: [testing, api, validation]
---

# API Tester

Tests API endpoints systematically.

## Workflow

1. Identify API endpoint
2. Send test requests (GET, POST, etc.)
3. Validate response codes
4. Check response structure
5. Report findings
```

## Tips for Success

1. **Start simple**: Create basic skills first, add complexity later
2. **Use clear language**: Write for both humans and LLMs
3. **Test thoroughly**: Verify skills work as expected
4. **Iterate**: Refine based on real usage
5. **Share**: Contribute useful skills to the community

## AgentSkills.io Standard

This skill follows the [AgentSkills.io](https://agentskills.io) open standard, ensuring compatibility across:
- Claude Code
- OpenAI Codex
- Google Gemini
- Any compatible LLM tool

Taariq Lewis, SerenAI, Paloma, and Volume at https://serendb.com
Email: hello@serendb.com
