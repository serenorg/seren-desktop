// ABOUTME: Tauri commands for skills directory management.
// ABOUTME: Provides commands to get seren, claude, and project skills directories.

use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

/// Get the Seren-scope skills directory ({app_data_dir}/skills/).
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_seren_skills_dir(app: AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not determine app data directory: {}", e))?;
    let skills_dir = app_data.join("skills");

    if !skills_dir.exists() {
        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills directory: {}", e))?;
    }

    Ok(skills_dir.to_string_lossy().to_string())
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

/// Get the project-scope skills directory (.claude/skills/).
/// Returns the path if a project root is provided, otherwise returns None.
/// The project root is determined by the frontend based on the open folder.
#[tauri::command]
pub fn get_project_skills_dir(project_root: Option<String>) -> Result<Option<String>, String> {
    match project_root {
        Some(root) => {
            let root_path = PathBuf::from(&root);
            if !root_path.is_dir() {
                return Ok(None);
            }

            let skills_dir = root_path.join(".claude").join("skills");
            Ok(Some(skills_dir.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

/// List all skill directories in a given skills directory.
/// Returns a list of skill slugs (directory names).
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
        if path.is_dir() {
            // Check if SKILL.md exists in this directory
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                if let Some(name) = path.file_name() {
                    slugs.push(name.to_string_lossy().to_string());
                }
            }
        }
    }

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
    let skill_dir = dir_path.join(&slug);

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
#[tauri::command]
pub fn read_skill_content(skills_dir: String, slug: String) -> Result<Option<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_file = dir_path.join(&slug).join("SKILL.md");

    if !skill_file.exists() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(&skill_file).map_err(|e| format!("Failed to read SKILL.md: {}", e))?;

    Ok(Some(content))
}
