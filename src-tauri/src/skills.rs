// ABOUTME: Tauri commands for skills directory management.
// ABOUTME: Provides commands to get seren, claude, and project skills directories.

use rusqlite::{OptionalExtension, params};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::services::database::init_db;

fn normalize_project_root(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let project_path = PathBuf::from(trimmed);
    let abs = if project_path.is_absolute() {
        project_path
    } else {
        std::env::current_dir().ok()?.join(project_path)
    };

    let normalized = abs.canonicalize().unwrap_or(abs);
    Some(normalized.to_string_lossy().to_string())
}

fn project_seren_dir(project_root: &str) -> Result<PathBuf, String> {
    let normalized =
        normalize_project_root(project_root).ok_or("Invalid project root".to_string())?;
    let root_path = PathBuf::from(normalized);
    if !root_path.is_dir() {
        return Err("Project root is not a directory".to_string());
    }
    Ok(root_path.join(".seren"))
}

fn project_config_path(project_root: &str) -> Result<PathBuf, String> {
    Ok(project_seren_dir(project_root)?.join("config.json"))
}

fn seren_config_dir() -> Result<PathBuf, String> {
    if let Some(xdg_config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        let path = PathBuf::from(xdg_config_home);
        if !path.as_os_str().is_empty() && path.is_absolute() {
            return Ok(path.join("seren"));
        }
    }

    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".config").join("seren"))
}

/// Get the Seren-scope skills directory using XDG config home:
/// - `$XDG_CONFIG_HOME/seren/skills` when `XDG_CONFIG_HOME` is set to an absolute path
/// - `~/.config/seren/skills` otherwise
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_seren_skills_dir() -> Result<String, String> {
    let config_dir = seren_config_dir()?;
    let skills_dir = config_dir.join("skills");

    if !skills_dir.exists() {
        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills directory: {}", e))?;
    }

    Ok(skills_dir.to_string_lossy().to_string())
}

/// Get the default project directory (~/$DOCUMENTS/Seren).
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_default_project_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let docs = home.join("Documents");
    let project_dir = if docs.is_dir() {
        docs.join("Seren")
    } else {
        home.join("Seren")
    };

    if !project_dir.exists() {
        fs::create_dir_all(&project_dir)
            .map_err(|e| format!("Failed to create default project directory: {}", e))?;
    }

    Ok(project_dir.to_string_lossy().to_string())
}

/// Get the Claude Code skills directory (~/.claude/skills/).
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_claude_skills_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let skills_dir = home.join(".claude").join("skills");

    if !skills_dir.exists() {
        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills directory: {}", e))?;
    }

    Ok(skills_dir.to_string_lossy().to_string())
}

/// Get the project-scope skills directory (`project/skills`).
/// The project root is determined by the frontend based on the open folder.
#[tauri::command]
pub fn get_project_skills_dir(project_root: Option<String>) -> Result<Option<String>, String> {
    match project_root {
        Some(root) => {
            let root_path = PathBuf::from(&root);
            if !root_path.is_dir() {
                return Ok(None);
            }

            let local_skills_dir = root_path.join("skills");
            if local_skills_dir.is_dir() {
                return Ok(Some(local_skills_dir.to_string_lossy().to_string()));
            }

            Ok(None)
        }
        None => Ok(None),
    }
}

fn resolve_skill_file_path(dir_path: &PathBuf, slug: &str) -> Option<PathBuf> {
    // Try flat layout first: skills_dir/slug/SKILL.md
    let flat_path = dir_path.join(slug).join("SKILL.md");
    if flat_path.exists() {
        return Some(flat_path);
    }

    // Try nested layout by splitting on every hyphen:
    // e.g. "coinbase-grid-trader" -> "coinbase/grid-trader"
    // and "my-org-skill-name" -> "my/org-skill-name" then "my-org/skill-name".
    for (idx, ch) in slug.char_indices() {
        if ch != '-' {
            continue;
        }
        let org = &slug[..idx];
        let skill = &slug[idx + 1..];
        if org.is_empty() || skill.is_empty() {
            continue;
        }

        let nested_path = dir_path.join(org).join(skill).join("SKILL.md");
        if nested_path.exists() {
            return Some(nested_path);
        }
    }

    None
}

fn resolve_skill_dir_path(dir_path: &PathBuf, slug: &str) -> Option<PathBuf> {
    resolve_skill_file_path(dir_path, slug)
        .and_then(|skill_file| skill_file.parent().map(|parent| parent.to_path_buf()))
}

/// Create symlink from .claude/skills to the active skills directory for Claude Code compatibility.
/// This allows both Claude Code (via symlink) and OpenAI Codex (via direct path) to use the same skills.
#[tauri::command]
pub fn create_skills_symlink(project_root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&project_root);
    if !root_path.is_dir() {
        return Err("Project root is not a directory".to_string());
    }

    let claude_dir = root_path.join(".claude");
    let symlink_path = claude_dir.join("skills");

    // Create .claude directory if it doesn't exist
    if !claude_dir.exists() {
        fs::create_dir_all(&claude_dir)
            .map_err(|e| format!("Failed to create .claude directory: {}", e))?;
    }

    let skills_target = PathBuf::from("..").join("skills");
    let skills_dir = root_path.join("skills");

    if !skills_dir.exists() {
        return Err(format!(
            "Could not find a skills directory. Expected {}/skills",
            root_path.display()
        ));
    }

    // Remove existing symlink/directory if it exists.
    // Use symlink_metadata so broken symlinks are detected too.
    #[cfg(unix)]
    {
        if let Ok(metadata) = fs::symlink_metadata(&symlink_path) {
            if metadata.is_symlink() {
                fs::remove_file(&symlink_path)
                    .map_err(|e| format!("Failed to remove existing symlink: {}", e))?;
            } else {
                return Err(
                    ".claude/skills exists but is not a symlink. Please remove it manually."
                        .to_string(),
                );
            }
        }
    }
    #[cfg(windows)]
    {
        if fs::symlink_metadata(&symlink_path).is_ok() {
            if symlink_path.is_dir() {
                fs::remove_dir_all(&symlink_path)
                    .map_err(|e| format!("Failed to remove existing directory: {}", e))?;
            } else {
                fs::remove_file(&symlink_path)
                    .map_err(|e| format!("Failed to remove existing file: {}", e))?;
            }
        }
    }

    // Create the symlink
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&skills_target, &symlink_path)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_dir;
        symlink_dir(&skills_target, &symlink_path)
            .map_err(|e| format!("Failed to create symlink: {}", e))?;
    }

    Ok(())
}

/// Read `{project}/.seren/config.json` if present.
#[tauri::command]
pub fn read_project_config(project_root: String) -> Result<Option<String>, String> {
    let config_path = project_config_path(&project_root)?;
    if !config_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read project config: {}", e))?;
    Ok(Some(content))
}

/// Write `{project}/.seren/config.json`.
#[tauri::command]
pub fn write_project_config(project_root: String, config: String) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&config).map_err(|e| format!("Invalid config JSON: {}", e))?;

    let seren_dir = project_seren_dir(&project_root)?;
    if !seren_dir.exists() {
        fs::create_dir_all(&seren_dir)
            .map_err(|e| format!("Failed to create .seren directory: {}", e))?;
    }

    let config_path = seren_dir.join("config.json");
    let mut serialized = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("Failed to serialize config JSON: {}", e))?;
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }

    fs::write(&config_path, serialized)
        .map_err(|e| format!("Failed to write project config: {}", e))?;
    Ok(())
}

/// Clear `{project}/.seren/config.json` (fall back to global defaults).
#[tauri::command]
pub fn clear_project_config(project_root: String) -> Result<(), String> {
    let config_path = project_config_path(&project_root)?;
    if !config_path.exists() {
        return Ok(());
    }

    fs::remove_file(&config_path).map_err(|e| format!("Failed to clear project config: {}", e))?;
    Ok(())
}

/// Get per-thread skill override refs for a project/thread pair.
/// Returns `None` when no thread override exists.
#[tauri::command]
pub fn get_thread_skills(
    app: AppHandle,
    project_root: String,
    thread_id: String,
) -> Result<Option<Vec<String>>, String> {
    let normalized_root =
        normalize_project_root(&project_root).ok_or("Invalid project root".to_string())?;
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Err("Thread ID cannot be empty".to_string());
    }

    let conn = init_db(&app).map_err(|e| format!("Failed to open database: {}", e))?;

    let has_override: Option<i64> = conn
        .query_row(
            "SELECT 1
             FROM thread_skill_override_state
             WHERE thread_id = ?1 AND project_root = ?2
             LIMIT 1",
            params![thread_id, normalized_root],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to read thread override state: {}", e))?;

    if has_override.is_none() {
        return Ok(None);
    }

    let mut stmt = conn
        .prepare(
            "SELECT skill_ref
             FROM thread_skills
             WHERE thread_id = ?1 AND project_root = ?2
             ORDER BY skill_ref ASC",
        )
        .map_err(|e| format!("Failed to prepare thread skills query: {}", e))?;

    let rows = stmt
        .query_map(params![thread_id, normalized_root], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("Failed to query thread skills: {}", e))?;

    let mut refs = Vec::new();
    for row in rows {
        refs.push(row.map_err(|e| format!("Failed to read thread skill ref: {}", e))?);
    }

    Ok(Some(refs))
}

/// Replace per-thread skill override refs for a project/thread pair.
#[tauri::command]
pub fn set_thread_skills(
    app: AppHandle,
    project_root: String,
    thread_id: String,
    skill_refs: Vec<String>,
) -> Result<(), String> {
    let normalized_root =
        normalize_project_root(&project_root).ok_or("Invalid project root".to_string())?;
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Err("Thread ID cannot be empty".to_string());
    }

    let normalized_refs: Vec<String> = {
        let mut unique = std::collections::BTreeSet::new();
        for skill_ref in skill_refs {
            let trimmed = skill_ref.trim();
            if !trimmed.is_empty() {
                unique.insert(trimmed.to_string());
            }
        }
        unique.into_iter().collect()
    };

    let mut conn = init_db(&app).map_err(|e| format!("Failed to open database: {}", e))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    tx.execute(
        "INSERT INTO thread_skill_override_state (thread_id, project_root)
         VALUES (?1, ?2)
         ON CONFLICT(thread_id, project_root) DO NOTHING",
        params![thread_id, normalized_root],
    )
    .map_err(|e| format!("Failed to persist thread override state: {}", e))?;

    tx.execute(
        "DELETE FROM thread_skills
         WHERE thread_id = ?1 AND project_root = ?2",
        params![thread_id, normalized_root],
    )
    .map_err(|e| format!("Failed to clear existing thread skills: {}", e))?;

    for skill_ref in normalized_refs {
        tx.execute(
            "INSERT INTO thread_skills (thread_id, project_root, skill_ref)
             VALUES (?1, ?2, ?3)",
            params![thread_id, normalized_root, skill_ref],
        )
        .map_err(|e| format!("Failed to insert thread skill ref: {}", e))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit thread skills update: {}", e))?;
    Ok(())
}

/// Clear per-thread skill overrides for a project/thread pair.
#[tauri::command]
pub fn clear_thread_skills(
    app: AppHandle,
    project_root: String,
    thread_id: String,
) -> Result<(), String> {
    let normalized_root =
        normalize_project_root(&project_root).ok_or("Invalid project root".to_string())?;
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() {
        return Err("Thread ID cannot be empty".to_string());
    }

    let conn = init_db(&app).map_err(|e| format!("Failed to open database: {}", e))?;
    conn.execute(
        "DELETE FROM thread_skills
         WHERE thread_id = ?1 AND project_root = ?2",
        params![thread_id, normalized_root],
    )
    .map_err(|e| format!("Failed to clear thread skills: {}", e))?;
    conn.execute(
        "DELETE FROM thread_skill_override_state
         WHERE thread_id = ?1 AND project_root = ?2",
        params![thread_id, normalized_root],
    )
    .map_err(|e| format!("Failed to clear thread override state: {}", e))?;
    Ok(())
}

/// List all skill directories in a given skills directory.
/// Returns a list of skill slugs.
/// Supports both flat layout (slug/SKILL.md) and nested layout (org/skill/SKILL.md).
#[tauri::command]
pub fn list_skill_dirs(skills_dir: String) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);

    if !dir_path.exists() {
        return Ok(vec![]);
    }

    let entries =
        fs::read_dir(&dir_path).map_err(|e| format!("Failed to read skills directory: {}", e))?;

    let mut slugs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Skip hidden directories
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        // Flat layout: slug/SKILL.md
        let skill_file = path.join("SKILL.md");
        if skill_file.exists() {
            if let Some(name) = path.file_name() {
                slugs.push(name.to_string_lossy().to_string());
            }
            continue;
        }

        // Nested layout: org/skill/SKILL.md
        let org_name = match path.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };

        if let Ok(sub_entries) = fs::read_dir(&path) {
            for sub_entry in sub_entries.flatten() {
                let sub_path = sub_entry.path();
                if sub_path.is_dir() && sub_path.join("SKILL.md").exists() {
                    if let Some(skill_name) = sub_path.file_name() {
                        slugs.push(format!("{}-{}", org_name, skill_name.to_string_lossy()));
                    }
                }
            }
        }
    }

    slugs.sort();
    slugs.dedup();
    Ok(slugs)
}

/// Create a skill directory and write SKILL.md content.
#[tauri::command]
pub fn install_skill(skills_dir: String, slug: String, content: String) -> Result<String, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = dir_path.join(&slug);
    let skill_file = skill_dir.join("SKILL.md");

    // Create skill directory
    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    // Write SKILL.md content
    fs::write(&skill_file, content).map_err(|e| format!("Failed to write SKILL.md: {}", e))?;

    Ok(skill_file.to_string_lossy().to_string())
}

/// Remove a skill directory.
#[tauri::command]
pub fn remove_skill(skills_dir: String, slug: String) -> Result<(), String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Ok(()),
    };

    if !skill_dir.exists() {
        return Ok(());
    }

    fs::remove_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to remove skill directory: {}", e))?;

    Ok(())
}

/// Create a new skill folder with scaffold structure.
/// Generates SKILL.md, template.md, examples/sample.md, and scripts/validate.sh.
#[tauri::command]
pub fn create_skill_folder(
    skills_dir: String,
    slug: String,
    name: String,
) -> Result<String, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = dir_path.join(&slug);

    if skill_dir.exists() {
        return Err(format!("Skill folder '{}' already exists", slug));
    }

    // Create directory tree
    fs::create_dir_all(skill_dir.join("examples"))
        .map_err(|e| format!("Failed to create examples directory: {}", e))?;
    fs::create_dir_all(skill_dir.join("scripts"))
        .map_err(|e| format!("Failed to create scripts directory: {}", e))?;

    let skill_md = format!(
        "---\nname: {slug}\ndescription: TODO — describe what this skill does and when to use it\n---\n\n# {name}\n\n## Overview\n\nDescribe the skill's purpose and capabilities here.\n\n## Workflow\n\n1. Step one\n2. Step two\n3. Step three\n\n## Examples\n\nSee [examples/sample.md](examples/sample.md) for example output.\n\n## Scripts\n\n- [scripts/validate.sh](scripts/validate.sh) — validation script\n",
        slug = slug,
        name = name
    );

    let template_md = format!(
        "# {name} — Template\n\nUse this template as a starting point. Fill in each section.\n\n## Input\n\nDescribe the input this skill expects.\n\n## Output\n\nDescribe the expected output format.\n",
        name = name
    );

    let sample_md = format!(
        "# {name} — Example Output\n\nThis file shows an example of the expected output format.\n\n## Sample\n\nReplace this with a real example.\n",
        name = name
    );

    let validate_sh = "#!/usr/bin/env bash\n# Validation script for this skill.\nset -euo pipefail\necho \"Validation passed.\"\n";

    fs::write(skill_dir.join("SKILL.md"), skill_md)
        .map_err(|e| format!("Failed to write SKILL.md: {}", e))?;
    fs::write(skill_dir.join("template.md"), template_md)
        .map_err(|e| format!("Failed to write template.md: {}", e))?;
    fs::write(skill_dir.join("examples").join("sample.md"), sample_md)
        .map_err(|e| format!("Failed to write sample.md: {}", e))?;
    fs::write(skill_dir.join("scripts").join("validate.sh"), validate_sh)
        .map_err(|e| format!("Failed to write validate.sh: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script_path = skill_dir.join("scripts").join("validate.sh");
        let perms = fs::Permissions::from_mode(0o755);
        let _ = fs::set_permissions(&script_path, perms);
    }

    let skill_file = skill_dir.join("SKILL.md");
    Ok(skill_file.to_string_lossy().to_string())
}

/// Read a skill's SKILL.md content.
/// Supports both flat layout (slug/SKILL.md) and nested layout (org/skill/SKILL.md).
#[tauri::command]
pub fn read_skill_content(skills_dir: String, slug: String) -> Result<Option<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);

    let skill_file = match resolve_skill_file_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Ok(None),
    };

    let content =
        fs::read_to_string(&skill_file).map_err(|e| format!("Failed to read SKILL.md: {}", e))?;
    Ok(Some(content))
}

/// Resolve the full SKILL.md file path for a slug in a skills directory.
/// Supports both flat layout (slug/SKILL.md) and nested layout (org/skill/SKILL.md).
#[tauri::command]
pub fn resolve_skill_path(skills_dir: String, slug: String) -> Result<Option<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);
    if let Some(path) = resolve_skill_file_path(&dir_path, &slug) {
        return Ok(Some(path.to_string_lossy().to_string()));
    }
    Ok(None)
}
