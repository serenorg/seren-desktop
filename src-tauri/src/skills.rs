// ABOUTME: Tauri commands for skills directory management.
// ABOUTME: Provides commands to get seren, claude, and project skills directories.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use url::Url;

use crate::services::database::init_db;

const SKILL_SYNC_STATE_FILE: &str = ".seren-sync.json";
const RECORDING_LOCAL_METADATA_DIR: &str = ".seren-recording";

fn is_recording_local_metadata_path(posix: &str) -> bool {
    posix == RECORDING_LOCAL_METADATA_DIR
        || posix
            .strip_prefix(RECORDING_LOCAL_METADATA_DIR)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSyncStateFile {
    version: u8,
    upstream_source: String,
    upstream_source_url: String,
    synced_revision: Option<String>,
    synced_at: i64,
    managed_files: std::collections::BTreeMap<String, String>,
}

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
    if let Some(validation_config_home) = std::env::var_os("SEREN_VALIDATION_CONFIG_HOME") {
        let path = PathBuf::from(validation_config_home);
        if !path.as_os_str().is_empty() && path.is_absolute() {
            return Ok(path.join("seren"));
        }
    }

    if let Some(xdg_config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        let path = PathBuf::from(xdg_config_home);
        if !path.as_os_str().is_empty() && path.is_absolute() {
            return Ok(path.join("seren"));
        }
    }

    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".config").join("seren"))
}

fn default_project_dir() -> Result<PathBuf, String> {
    if let Some(validation_project_dir) = std::env::var_os("SEREN_VALIDATION_PROJECT_DIR") {
        let path = PathBuf::from(validation_project_dir);
        if !path.as_os_str().is_empty() && path.is_absolute() {
            return Ok(path);
        }
    }

    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let docs = home.join("Documents");
    if docs.is_dir() {
        Ok(docs.join("Seren"))
    } else {
        Ok(home.join("Seren"))
    }
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
    let project_dir = default_project_dir()?;

    if !project_dir.exists() {
        fs::create_dir_all(&project_dir)
            .map_err(|e| format!("Failed to create default project directory: {}", e))?;
    }

    Ok(project_dir.to_string_lossy().to_string())
}

/// Get the local authoring directory for user-created skills.
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_seren_skill_authoring_dir() -> Result<String, String> {
    let skills_dir = default_project_dir()?.join("skills");

    if !skills_dir.exists() {
        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create Seren skills authoring directory: {}", e))?;
    }

    Ok(skills_dir.to_string_lossy().to_string())
}

/// Get the Claude Code skills directory (~/.claude/skills/).
/// Creates the directory if it doesn't exist.
#[tauri::command]
pub fn get_claude_skills_dir() -> Result<String, String> {
    if let Some(validation_claude_home) = std::env::var_os("SEREN_VALIDATION_CLAUDE_HOME") {
        let path = PathBuf::from(validation_claude_home);
        if !path.as_os_str().is_empty() && path.is_absolute() {
            let skills_dir = path.join("skills");
            if !skills_dir.exists() {
                fs::create_dir_all(&skills_dir)
                    .map_err(|e| format!("Failed to create skills directory: {}", e))?;
            }
            return Ok(skills_dir.to_string_lossy().to_string());
        }
    }

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

fn resolve_relative_skill_path(
    skill_dir: &PathBuf,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!(
            "Invalid skill-relative path (must be relative, no ..): {}",
            relative_path
        ));
    }

    Ok(skill_dir.join(relative))
}

fn validate_skill_slug(slug: &str) -> Result<(), String> {
    let trimmed = slug.trim();
    if trimmed.is_empty() || trimmed != slug || trimmed == "." || trimmed == ".." {
        return Err(format!("Invalid skill slug: {}", slug));
    }
    if slug.chars().any(|c| {
        c.is_whitespace() || c.is_control() || c == '/' || c == '\\' || c == '\0'
    })
    {
        return Err(format!("Invalid skill slug: {}", slug));
    }
    Ok(())
}

fn validate_sync_state_file(state: &SkillSyncStateFile) -> Result<(), String> {
    if state.version != 1 {
        return Err(format!("Unsupported sync state version: {}", state.version));
    }
    if state.upstream_source.trim().is_empty() {
        return Err("Sync state upstreamSource cannot be empty".to_string());
    }
    if state.upstream_source_url.trim().is_empty() {
        return Err("Sync state upstreamSourceUrl cannot be empty".to_string());
    }

    // The Seren Skills publisher migration replaced `serenorg` + raw GitHub
    // URLs with the `seren` source identifier and a `seren-skills:{slug}`
    // bare-scheme URL. Both are accepted; legacy `serenorg` still requires
    // the canonical raw-GitHub URL it was installed against, and any other
    // upstream still must be https.
    if state.upstream_source == "seren" {
        let url = state.upstream_source_url.trim();
        let slug = url
            .strip_prefix("seren-skills:")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "Seren upstream sync state must use a seren-skills:{slug} URL".to_string()
            })?;
        validate_skill_slug(slug)
            .map_err(|_| format!("Seren upstream sync state slug is invalid: {}", slug))?;
    } else {
        let parsed_url = Url::parse(&state.upstream_source_url)
            .map_err(|e| format!("Invalid sync state upstreamSourceUrl: {}", e))?;
        if parsed_url.scheme() != "https" {
            return Err("Sync state upstreamSourceUrl must use https".to_string());
        }
        if state.upstream_source == "serenorg" {
            let host = parsed_url.host_str().unwrap_or_default();
            let path = parsed_url.path();
            if host != "raw.githubusercontent.com" || !path.starts_with("/serenorg/seren-skills/")
            {
                return Err(
                    "Seren upstream sync state must point at the canonical seren-skills raw URL"
                        .to_string(),
                );
            }
        }
    }
    if !state.managed_files.contains_key("SKILL.md") {
        return Err("Sync state managedFiles must include SKILL.md".to_string());
    }
    if state
        .managed_files
        .iter()
        .any(|(path, hash)| path.trim().is_empty() || hash.trim().is_empty())
    {
        return Err("Sync state managedFiles entries must be non-empty".to_string());
    }
    if state.managed_files.keys().any(|path| {
        let relative = PathBuf::from(path);
        relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
    }) {
        return Err("Sync state managedFiles must use skill-relative paths".to_string());
    }
    if matches!(state.synced_revision.as_deref(), Some("")) {
        return Err("Sync state syncedRevision cannot be empty".to_string());
    }

    Ok(())
}

fn normalize_sync_state_json(state_json: &str) -> Result<String, String> {
    let parsed: SkillSyncStateFile =
        serde_json::from_str(state_json).map_err(|e| format!("Invalid sync state JSON: {}", e))?;
    validate_sync_state_file(&parsed)?;

    let mut serialized = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("Failed to serialize sync state JSON: {}", e))?;
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }

    Ok(serialized)
}

fn write_sync_state_file(skill_dir: &PathBuf, state_json: &str) -> Result<(), String> {
    let metadata_path = skill_dir.join(SKILL_SYNC_STATE_FILE);
    let serialized = normalize_sync_state_json(state_json)?;
    fs::write(&metadata_path, serialized)
        .map_err(|e| format!("Failed to write {}: {}", SKILL_SYNC_STATE_FILE, e))
}

fn canonicalize_within_skill_dir(skill_dir: &PathBuf, target: &PathBuf) -> Result<PathBuf, String> {
    let canonical_skill_dir = skill_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill directory: {}", e))?;
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill-relative path: {}", e))?;

    if !canonical_target.starts_with(&canonical_skill_dir) {
        return Err("Resolved skill-relative path escapes the skill directory".to_string());
    }

    Ok(canonical_target)
}

fn unique_temp_path(parent: &PathBuf, slug: &str, label: &str) -> Result<PathBuf, String> {
    for attempt in 0..16 {
        let candidate = parent.join(format!(
            ".{slug}.{label}.{}-{}-{attempt}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to build temp path: {}", e))?
                .as_nanos()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!("Failed to allocate temporary path for {}", slug))
}

fn write_skill_tree(
    skill_dir: &PathBuf,
    content: &str,
    extra_files: &[ExtraFile],
    sync_state_json: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;

    let skill_file = skill_dir.join("SKILL.md");
    fs::write(&skill_file, content).map_err(|e| format!("Failed to write SKILL.md: {}", e))?;

    for file in extra_files {
        let relative = PathBuf::from(&file.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!(
                "Invalid file path (must be relative, no ..): {}",
                file.path
            ));
        }

        let normalized = normalize_bundle_path(&file.path);
        if is_user_state_path(&normalized) {
            log::warn!(
                "bundle claimed user-state path {}; refusing to write (defense-in-depth, see #1933)",
                normalized
            );
            continue;
        }

        let target = skill_dir.join(&relative);

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory for {}: {}", file.path, e))?;
        }

        fs::write(&target, file.bytes()?)
            .map_err(|e| format!("Failed to write {}: {}", file.path, e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file.path.ends_with(".sh") || file.path.ends_with(".py") {
                let perms = fs::Permissions::from_mode(0o755);
                let _ = fs::set_permissions(&target, perms);
            }
        }
    }

    if let Some(state_json) = sync_state_json {
        write_sync_state_file(skill_dir, state_json)?;
    }

    Ok(())
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

/// Create a skill directory and write SKILL.md content along with optional payload files.
/// `extra_files` is a JSON-encoded array of `{ "path": "relative/path", "content": "..." }` objects.
#[tauri::command]
pub fn install_skill(
    skills_dir: String,
    slug: String,
    content: String,
    extra_files: Option<String>,
    sync_state_json: Option<String>,
) -> Result<String, String> {
    validate_skill_slug(&slug)?;
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = dir_path.join(&slug);
    let parsed_extra_files: Vec<ExtraFile> = match extra_files {
        Some(files_json) => serde_json::from_str(&files_json)
            .map_err(|e| format!("Failed to parse extra_files JSON: {}", e))?,
        None => Vec::new(),
    };
    let sync_state_json = sync_state_json.as_deref();

    let temp_skill_dir = unique_temp_path(&dir_path, &slug, "installing")?;
    let backup_skill_dir = if skill_dir.exists() {
        Some(unique_temp_path(&dir_path, &slug, "backup")?)
    } else {
        None
    };

    let install_result = (|| -> Result<(), String> {
        write_skill_tree(
            &temp_skill_dir,
            &content,
            &parsed_extra_files,
            sync_state_json,
        )?;

        if let Some(backup_dir) = &backup_skill_dir {
            fs::rename(&skill_dir, backup_dir)
                .map_err(|e| format!("Failed to stage existing skill directory: {}", e))?;
        }

        fs::rename(&temp_skill_dir, &skill_dir)
            .map_err(|e| format!("Failed to activate skill directory: {}", e))?;

        Ok(())
    })();

    if let Err(error) = install_result {
        let _ = fs::remove_dir_all(&temp_skill_dir);
        if let Some(backup_dir) = &backup_skill_dir {
            if backup_dir.exists() && !skill_dir.exists() {
                let _ = fs::rename(backup_dir, &skill_dir);
            }
        }
        return Err(error);
    }

    if let Some(backup_dir) = backup_skill_dir {
        if backup_dir.exists() {
            let bundle_paths =
                bundle_managed_paths(&parsed_extra_files, sync_state_json.is_some());
            match preserve_user_files(&backup_dir, &skill_dir, &bundle_paths) {
                Ok(()) => {
                    if let Err(error) = fs::remove_dir_all(&backup_dir) {
                        log::warn!(
                            "Installed skill '{}' successfully but failed to remove backup directory {}: {}",
                            slug,
                            backup_dir.display(),
                            error
                        );
                    }
                }
                Err(error) => {
                    log::warn!(
                        "Installed skill '{}' but preserving user files from backup {} failed: {}. Backup retained for manual recovery.",
                        slug,
                        backup_dir.display(),
                        error
                    );
                }
            }
        }
    }

    Ok(skill_dir.join("SKILL.md").to_string_lossy().to_string())
}

/// Create a local authoring skill from a complete generated bundle.
/// Unlike `install_skill`, this refuses to overwrite an existing slug.
#[tauri::command]
pub fn create_skill_bundle_folder(
    skills_dir: String,
    slug: String,
    content: String,
    extra_files: Option<String>,
) -> Result<String, String> {
    validate_skill_slug(&slug)?;
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = dir_path.join(&slug);
    if skill_dir.exists() {
        return Err(format!("Skill folder '{}' already exists", slug));
    }

    let parsed_extra_files: Vec<ExtraFile> = match extra_files {
        Some(files_json) => serde_json::from_str(&files_json)
            .map_err(|e| format!("Failed to parse extra_files JSON: {}", e))?,
        None => Vec::new(),
    };

    let temp_skill_dir = unique_temp_path(&dir_path, &slug, "creating")?;
    let create_result = (|| -> Result<(), String> {
        write_skill_tree(&temp_skill_dir, &content, &parsed_extra_files, None)?;
        if skill_dir.exists() {
            return Err(format!("Skill folder '{}' already exists", slug));
        }
        fs::rename(&temp_skill_dir, &skill_dir)
            .map_err(|e| format!("Failed to activate skill directory: {}", e))?;
        Ok(())
    })();

    if let Err(error) = create_result {
        let _ = fs::remove_dir_all(&temp_skill_dir);
        return Err(error);
    }

    Ok(skill_dir.join("SKILL.md").to_string_lossy().to_string())
}

/// Build the set of relative paths the bundle owns: `SKILL.md`, every payload
/// file, and the sync manifest when one is being written. Anything outside
/// this set in the previous installation is user-provisioned and must survive
/// a re-install.
///
/// Paths matching [`is_user_state_path`] are stripped here even when the
/// bundle's `extra_files` claim them. Defense-in-depth against a publisher
/// that leaks `.env`, `state/*`, `logs/*`, or `config.json` into a bundle —
/// see serenorg/seren-desktop#1933.
fn bundle_managed_paths(
    extra_files: &[ExtraFile],
    sync_state_provided: bool,
) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    set.insert("SKILL.md".to_string());
    if sync_state_provided {
        set.insert(SKILL_SYNC_STATE_FILE.to_string());
    }
    for file in extra_files {
        let normalized = normalize_bundle_path(&file.path);
        if is_user_state_path(&normalized) {
            log::warn!(
                "bundle claimed user-state path {}; ignoring claim (defense-in-depth, see #1933)",
                normalized
            );
            continue;
        }
        set.insert(normalized);
    }
    set
}

fn normalize_bundle_path(path: &str) -> String {
    path.trim_start_matches("./").replace('\\', "/")
}

/// Paths the user owns inside a skill directory. Bundles may not claim them
/// even when the publisher ships them — defense-in-depth for #1933 against
/// the upstream contamination tracked in seren-skills-publisher#36.
///
/// Deny-list (matched on a normalized POSIX path):
///   - `.env` and any `.env.*` except `.env.example` / `.env.sample` / `.env.template`
///   - `config.json` (but `config.example.json` is allowed)
///   - `state/`, `logs/`, `.venv/`, `node_modules/`, `__pycache__/`, `.pytest_cache/`
///     anywhere in the path
///   - any `*.pyc`
///   - `.DS_Store`
fn is_user_state_path(rel: &str) -> bool {
    let basename = rel.rsplit('/').next().unwrap_or(rel);

    match basename {
        ".env.example" | ".env.sample" | ".env.template" | "config.example.json" => {
            return false;
        }
        ".env" | "config.json" | ".DS_Store" => return true,
        _ => {}
    }

    if basename.starts_with(".env.") {
        return true;
    }
    if basename.ends_with(".pyc") {
        return true;
    }

    rel.split('/').any(|segment| {
        matches!(
            segment,
            "state" | "logs" | ".venv" | "node_modules" | "__pycache__" | ".pytest_cache"
        )
    })
}

/// Move every file in `backup_dir` whose relative path is not part of the new
/// bundle into `skill_dir`. Preserves user-provisioned files like `.env`,
/// `config.json`, and runtime artifacts (`state/`, `logs/`, ...) across a
/// re-install. Bundle files that the publisher updated are left in `backup_dir`
/// and removed by the caller's cleanup.
fn preserve_user_files(
    backup_dir: &Path,
    skill_dir: &Path,
    bundle_paths: &std::collections::HashSet<String>,
) -> Result<(), String> {
    preserve_user_files_recursive(backup_dir, backup_dir, skill_dir, bundle_paths)
}

fn preserve_user_files_recursive(
    current: &Path,
    backup_root: &Path,
    skill_dir: &Path,
    bundle_paths: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|e| format!("Failed to read backup directory {}: {}", current.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read backup entry: {}", e))?;
        let path = entry.path();
        let rel = path.strip_prefix(backup_root).map_err(|_| {
            format!(
                "Backup entry {} escapes backup root {}",
                path.display(),
                backup_root.display()
            )
        })?;
        let rel_key = rel.to_string_lossy().replace('\\', "/");

        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read entry type for {}: {}", rel_key, e))?;

        if file_type.is_dir() {
            preserve_user_files_recursive(&path, backup_root, skill_dir, bundle_paths)?;
            continue;
        }

        if bundle_paths.contains(&rel_key) {
            continue;
        }

        let target = skill_dir.join(rel);
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create parent for preserved file {}: {}",
                    rel_key, e
                )
            })?;
        }
        fs::rename(&path, &target)
            .map_err(|e| format!("Failed to preserve user file {}: {}", rel_key, e))?;
    }

    Ok(())
}

/// Validate that a skill directory contains all files referenced in SKILL.md.
/// Returns a list of missing file paths (empty if all present).
#[tauri::command]
pub fn validate_skill_payload(skills_dir: String, slug: String) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Err(format!("Skill directory not found for slug: {}", slug)),
    };

    let skill_file = skill_dir.join("SKILL.md");
    if !skill_file.exists() {
        return Err("SKILL.md not found".to_string());
    }

    let content =
        fs::read_to_string(&skill_file).map_err(|e| format!("Failed to read SKILL.md: {}", e))?;

    let referenced = extract_referenced_files(&content);
    let mut missing = Vec::new();

    for path in referenced {
        if is_runtime_artifact_path(&path) {
            continue;
        }
        let full_path = skill_dir.join(&path);
        if !full_path.exists() && !has_template_sibling(&skill_dir, &path) {
            missing.push(path);
        }
    }

    Ok(missing)
}

/// Returns true when `path` refers to a runtime artifact a skill creates
/// lazily at execution time (caches, logs, output dirs, scratch files,
/// host-absolute paths), rather than a payload file the publisher ships.
///
/// Issue serenorg/seren-desktop#1926: `extract_referenced_files` matches
/// any backticked `*.json` / `*.log` / `*.txt` / etc. mention in prose,
/// which misclassifies runtime mentions like `state/session_cache.json`
/// or `logs/trading_*.log` as missing bundle files. Skipping these here
/// keeps the validator strict for real payload references while letting
/// SKILL.md document runtime artifacts in prose without tripping it.
fn is_runtime_artifact_path(path: &str) -> bool {
    let trimmed = path.trim_start_matches("./");
    const RUNTIME_PREFIXES: [&str; 7] = [
        "state/", "logs/", "log/", "cache/", ".cache/", "output/", "tmp/",
    ];
    if RUNTIME_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return true;
    }
    // Host-absolute or user-home references are never bundle-relative.
    trimmed.starts_with('~')
        || trimmed.starts_with('/')
        || trimmed.starts_with("$HOME")
}

/// Append one JSON line per install/refresh failure to a long-lived log file.
///
/// Issue serenorg/seren-desktop#1917: when `validate_skill_payload` reports
/// missing files post-install, callers used to only log to the in-memory
/// console. That made silent partial-installs invisible after an app restart
/// and caused agents to scaffold from scratch (e.g. Windows users hitting
/// `prophet-arb-bot`). This command writes a durable audit line so the
/// failure survives the process and can be inspected after the fact.
///
/// Schema (one JSON object per line, append-only):
///   {
///     "timestamp": "2026-05-15T16:00:00.000Z",
///     "slug": "<skill slug>",
///     "phase": "install" | "refresh",
///     "missingFiles": ["scripts/agent.py", ...]
///   }
#[tauri::command]
pub fn log_skill_install_failure(
    log_path: String,
    slug: String,
    phase: String,
    missing_files: Vec<String>,
) -> Result<(), String> {
    use std::io::Write;

    let path = PathBuf::from(&log_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create log directory: {}", e))?;
        }
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to read clock: {}", e))?;
    let secs = timestamp.as_secs();
    let millis = timestamp.subsec_millis();
    // ISO-8601 (UTC). Hand-formatted so we don't pull in a date crate.
    let datetime = format_iso8601_utc(secs, millis);

    let entry = serde_json::json!({
        "timestamp": datetime,
        "slug": slug,
        "phase": phase,
        "missingFiles": missing_files,
    });
    let mut line = serde_json::to_string(&entry)
        .map_err(|e| format!("Failed to serialize log entry: {}", e))?;
    line.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open install log {}: {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write install-log entry: {}", e))?;

    Ok(())
}

fn format_iso8601_utc(secs: u64, millis: u32) -> String {
    // Days since 1970-01-01 (UTC). Civil-from-days conversion (Howard Hinnant).
    const SECS_PER_DAY: u64 = 86_400;
    let days = (secs / SECS_PER_DAY) as i64;
    let seconds_in_day = secs % SECS_PER_DAY;
    let hour = (seconds_in_day / 3600) as u32;
    let minute = ((seconds_in_day % 3600) / 60) as u32;
    let second = (seconds_in_day % 60) as u32;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Returns true when `path` is a user-provisioned target whose template
/// sibling (`.example` / `.template` / `.sample`) ships in the bundle.
/// SKILL.md routinely instructs users to copy the template — flagging the
/// uncopied target as "missing" is a false positive.
fn has_template_sibling(skill_dir: &Path, path: &str) -> bool {
    let rel = Path::new(path);
    let file_name = match rel.file_name().and_then(|n| n.to_str()) {
        Some(name) => name,
        None => return false,
    };
    let parent_dir = match rel.parent() {
        Some(p) => skill_dir.join(p),
        None => skill_dir.to_path_buf(),
    };

    const INFIXES: [&str; 3] = ["example", "template", "sample"];

    // Pattern A: dotfile suffix (`.env` -> `.env.example`).
    for infix in INFIXES {
        if parent_dir.join(format!("{}.{}", file_name, infix)).exists() {
            return true;
        }
    }

    // Pattern B: extension infix (`config.json` -> `config.example.json`).
    if let (Some(stem), Some(ext)) = (
        rel.file_stem().and_then(|s| s.to_str()),
        rel.extension().and_then(|e| e.to_str()),
    ) {
        for infix in INFIXES {
            if parent_dir
                .join(format!("{}.{}.{}", stem, infix, ext))
                .exists()
            {
                return true;
            }
        }
    }

    false
}

/// Rename a skill directory when the resolved slug no longer matches the
/// filesystem directory name (e.g. after an upstream SKILL.md name change).
/// Returns the new SKILL.md path on success.
#[tauri::command]
pub fn rename_skill_dir(
    skills_dir: String,
    old_dir_name: String,
    new_dir_name: String,
) -> Result<String, String> {
    let base = PathBuf::from(&skills_dir);
    let old_path = base.join(&old_dir_name);
    let new_path = base.join(&new_dir_name);

    if !old_path.is_dir() {
        return Err(format!(
            "Source directory does not exist: {}",
            old_path.display()
        ));
    }
    if new_path.exists() {
        // Target already has the correct content (synced under the new name).
        // Remove the stale source directory instead of failing.
        fs::remove_dir_all(&old_path).map_err(|e| {
            format!(
                "Target {} exists but failed to remove stale source {}: {}",
                new_path.display(),
                old_path.display(),
                e
            )
        })?;
        let skill_md = new_path.join("SKILL.md");
        return Ok(skill_md.to_string_lossy().to_string());
    }

    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename skill directory: {}", e))?;

    let skill_md = new_path.join("SKILL.md");
    Ok(skill_md.to_string_lossy().to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtraFile {
    path: String,
    /// Plain-text content. Legacy field; lossy for non-UTF-8 bytes.
    #[serde(default)]
    content: Option<String>,
    /// Base64 of the raw file bytes. Binary-safe; preferred over `content`.
    #[serde(default)]
    content_b64: Option<String>,
}

impl ExtraFile {
    fn bytes(&self) -> Result<Vec<u8>, String> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        match (&self.content_b64, &self.content) {
            (Some(encoded), _) => STANDARD
                .decode(encoded)
                .map_err(|e| format!("Invalid base64 content for {}: {}", self.path, e)),
            (None, Some(text)) => Ok(text.as_bytes().to_vec()),
            (None, None) => Err(format!("Bundle file {} has no content", self.path)),
        }
    }
}

/// Extract file paths referenced in SKILL.md content.
///
/// Markdown links (`[text](path)`) are unambiguous, so we read them from
/// the full document. Backticked paths (`` `scripts/agent.py` ``) only
/// count when they appear inside fenced code blocks — prose backticks
/// like "dispatches to `agent.py`" are documentation, not install
/// manifests, and treating them as required payload paths produced
/// false-positive "missing file" failures on valid skills (#2036).
fn extract_referenced_files(content: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Match markdown links: [text](path), only relative paths.
    let link_re = regex::Regex::new(r"\[(?:[^\]]*)\]\(([^)]+)\)").unwrap();
    for cap in link_re.captures_iter(content) {
        let path = cap[1].trim();
        if !path.starts_with("http") && !path.starts_with('#') && !path.starts_with("mailto:") {
            let clean = path.split('#').next().unwrap_or(path).trim();
            if !clean.is_empty() && seen.insert(clean.to_string()) {
                files.push(clean.to_string());
            }
        }
    }

    // Match backtick code references inside fenced code blocks only.
    let fenced = extract_fenced_block_content(content);
    let code_re =
        regex::Regex::new(r"`([a-zA-Z0-9_./-]+\.(py|sh|json|txt|toml|yaml|yml|js|ts))`").unwrap();
    for cap in code_re.captures_iter(&fenced) {
        let path = cap[1].trim();
        if !path.contains(' ') && seen.insert(path.to_string()) {
            files.push(path.to_string());
        }
    }

    files
}

/// Return the concatenated content of every fenced code block in `content`.
///
/// A fence line starts with three or more backticks or tildes (with optional
/// leading whitespace and language tag). Toggle in/out on each fence line;
/// accumulate the lines between. Mismatched fences are tolerated — SKILL.md
/// authors don't nest fences, so a simple toggle is sufficient.
fn extract_fenced_block_content(content: &str) -> String {
    let mut out = String::new();
    let mut in_fence = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
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
/// `description` populates the frontmatter and overview when supplied; the
/// frontmatter description is what the agent reads to decide whether to invoke
/// a skill, so a meaningful value here matters more than the name does.
#[tauri::command]
pub fn create_skill_folder(
    skills_dir: String,
    slug: String,
    name: String,
    description: Option<String>,
) -> Result<String, String> {
    validate_skill_slug(&slug)?;
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

    let trimmed_description = description.as_deref().map(str::trim).unwrap_or("");
    let frontmatter_description = if trimmed_description.is_empty() {
        "TODO: describe what this skill does and when to use it".to_string()
    } else {
        trimmed_description.replace('\n', " ").trim().to_string()
    };
    let overview_body = if trimmed_description.is_empty() {
        "Describe the skill's purpose and capabilities here.".to_string()
    } else {
        trimmed_description.to_string()
    };

    let skill_md = format!(
        "---\nname: {slug}\ndescription: {description}\n---\n\n# {name}\n\n## Overview\n\n{overview}\n\n## Workflow\n\n1. Step one\n2. Step two\n3. Step three\n\n## Examples\n\nSee [examples/sample.md](examples/sample.md) for example output.\n\n## Scripts\n\n- [scripts/validate.sh](scripts/validate.sh) - validation script\n",
        slug = slug,
        name = name,
        description = frontmatter_description,
        overview = overview_body,
    );

    let template_md = format!(
        "# {name} - Template\n\nUse this template as a starting point. Fill in each section.\n\n## Input\n\nDescribe the input this skill expects.\n\n## Output\n\nDescribe the expected output format.\n",
        name = name
    );

    let sample_md = format!(
        "# {name} - Example Output\n\nThis file shows an example of the expected output format.\n\n## Sample\n\nReplace this with a real example.\n",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPayloadFile {
    /// POSIX-style path relative to the skill root.
    pub path: String,
    /// Base64-encoded raw bytes of the file. Binary-safe.
    pub content_b64: String,
}

/// Walk a skill directory and return every non-canonical file as a
/// base64-encoded payload entry suitable for `BundleFileInput`. Excludes
/// `SKILL.md` (canonical Markdown column on the publisher) and the local
/// `.seren-sync.json` metadata file. Symlinks are not followed; recursion
/// depth is bounded.
#[tauri::command]
pub fn list_skill_payload_files(
    skills_dir: String,
    slug: String,
) -> Result<Vec<SkillPayloadFile>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Err(format!("Skill directory not found for slug: {}", slug)),
    };

    let mut out: Vec<SkillPayloadFile> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![skill_dir.clone()];
    let mut depth = 0usize;
    while let Some(dir) = stack.pop() {
        depth += 1;
        if depth > 4096 {
            return Err("Skill directory walk exceeded depth bound".to_string());
        }
        let read = fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;
        for entry in read {
            let entry = entry.map_err(|e| format!("Directory entry error: {}", e))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = match path.strip_prefix(&skill_dir) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            let posix = relative
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(s) => s.to_str().map(str::to_string),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/");
            if posix == "SKILL.md"
                || posix == SKILL_SYNC_STATE_FILE
                || is_recording_local_metadata_path(&posix)
            {
                continue;
            }
            let bytes = fs::read(&path)
                .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
            out.push(SkillPayloadFile {
                path: posix,
                content_b64: STANDARD.encode(&bytes),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Read a relative file from a skill directory.
#[tauri::command]
pub fn read_skill_file(
    skills_dir: String,
    slug: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Ok(None),
    };

    let target = resolve_relative_skill_path(&skill_dir, &relative_path)?;
    if !target.exists() {
        return Ok(None);
    }
    let target = canonicalize_within_skill_dir(&skill_dir, &target)?;

    let content = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read {}: {}", relative_path, e))?;
    Ok(Some(content))
}

/// Read a relative file from a skill directory as base64 of its raw bytes.
/// Binary-safe counterpart of `read_skill_file` for sync-state hashing (#2297).
#[tauri::command]
pub fn read_skill_file_b64(
    skills_dir: String,
    slug: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Ok(None),
    };

    let target = resolve_relative_skill_path(&skill_dir, &relative_path)?;
    if !target.exists() {
        return Ok(None);
    }
    let target = canonicalize_within_skill_dir(&skill_dir, &target)?;

    let bytes =
        fs::read(&target).map_err(|e| format!("Failed to read {}: {}", relative_path, e))?;
    Ok(Some(STANDARD.encode(&bytes)))
}

/// Read the persisted sync state for a skill if present.
#[tauri::command]
pub fn read_skill_sync_state(skills_dir: String, slug: String) -> Result<Option<String>, String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Ok(None),
    };

    let metadata_path = skill_dir.join(SKILL_SYNC_STATE_FILE);
    if !metadata_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read {}: {}", SKILL_SYNC_STATE_FILE, e))?;
    Ok(Some(content))
}

/// Persist sync state metadata for a skill.
#[tauri::command]
pub fn write_skill_sync_state(
    skills_dir: String,
    slug: String,
    state_json: String,
) -> Result<(), String> {
    let dir_path = PathBuf::from(&skills_dir);
    let skill_dir = match resolve_skill_dir_path(&dir_path, &slug) {
        Some(path) => path,
        None => return Err(format!("Skill directory not found for slug: {}", slug)),
    };

    write_sync_state_file(&skill_dir, &state_json)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn extract_referenced_files_finds_markdown_links() {
        let content = r#"# My Skill

See [agent script](scripts/agent.py) and [config](config.example.json).
Also check [external](https://example.com) which should be ignored.
"#;
        let files = extract_referenced_files(content);
        assert!(files.contains(&"scripts/agent.py".to_string()));
        assert!(files.contains(&"config.example.json".to_string()));
        assert!(!files.iter().any(|f| f.contains("example.com")));
    }

    #[test]
    fn extract_referenced_files_only_extracts_backticks_from_fenced_blocks() {
        // Prose backticks (e.g. `agent.py` mentioned in a paragraph) used to
        // be extracted and flagged as missing payload files. The correct
        // contract: only backtick references inside fenced code blocks count
        // as install manifests. Mirrors the pk-lead-intelligence regression
        // where a parenthetical "dispatches to `agent.py`" stamped the
        // install failed.
        let content = "# My Skill\n\
\n\
Prose mention of `agent.py` in a paragraph should be ignored.\n\
\n\
```bash\n\
# Run `scripts/setup.py` to bootstrap.\n\
```\n\
\n\
Another prose mention of `config.json` should also be ignored.\n";
        let files = extract_referenced_files(content);
        assert!(
            files.contains(&"scripts/setup.py".to_string()),
            "fenced-block backtick reference should be extracted, got {:?}",
            files
        );
        assert!(
            !files.contains(&"agent.py".to_string()),
            "prose backtick mention must not be extracted, got {:?}",
            files
        );
        assert!(
            !files.contains(&"config.json".to_string()),
            "prose backtick mention must not be extracted, got {:?}",
            files
        );
    }

    #[test]
    fn extract_referenced_files_deduplicates() {
        let content = r#"
Use [agent](scripts/agent.py) and also `scripts/agent.py` for running.
"#;
        let files = extract_referenced_files(content);
        let count = files.iter().filter(|f| *f == "scripts/agent.py").count();
        assert_eq!(count, 1, "should not duplicate");
    }

    #[test]
    fn extract_referenced_files_ignores_anchors_and_mailto() {
        let content = r#"
See [section](#overview) and [email](mailto:test@example.com).
"#;
        let files = extract_referenced_files(content);
        assert!(files.is_empty());
    }

    #[test]
    fn install_skill_writes_manifest_only_when_no_extras() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let result = install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            None,
        );
        assert!(result.is_ok());

        let skill_md = tmp.path().join("test-skill").join("SKILL.md");
        assert!(skill_md.exists());
        assert_eq!(
            fs::read_to_string(&skill_md).unwrap(),
            "# Test Skill\nHello"
        );
    }

    #[test]
    fn install_skill_writes_extra_files() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let extras = serde_json::json!([
            {"path": "scripts/agent.py", "content": "print('hello')"},
            {"path": "requirements.txt", "content": "requests==2.31.0"},
        ]);

        let result = install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test\n".to_string(),
            Some(extras.to_string()),
            None,
        );
        assert!(result.is_ok());

        let skill_dir = tmp.path().join("test-skill");
        assert!(skill_dir.join("SKILL.md").exists());
        assert!(skill_dir.join("scripts").join("agent.py").exists());
        assert!(skill_dir.join("requirements.txt").exists());
        assert_eq!(
            fs::read_to_string(skill_dir.join("scripts/agent.py")).unwrap(),
            "print('hello')"
        );
    }

    #[test]
    fn create_skill_bundle_folder_writes_generated_bundle_once() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let extras = serde_json::json!([
            {"path": "scripts/agent.py", "content": "print('hello')"},
            {"path": "skill.spec.yaml", "content": "{\"skill\":\"demo\"}\n"},
        ]);

        let path = create_skill_bundle_folder(
            skills_dir.clone(),
            "recorded-demo".to_string(),
            "# Recorded Demo\n".to_string(),
            Some(extras.to_string()),
        )
        .unwrap();

        let skill_dir = tmp.path().join("recorded-demo");
        assert_eq!(
            path,
            skill_dir.join("SKILL.md").to_string_lossy().to_string()
        );
        assert_eq!(
            fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "# Recorded Demo\n"
        );
        assert_eq!(
            fs::read_to_string(skill_dir.join("scripts/agent.py")).unwrap(),
            "print('hello')"
        );

        let duplicate = create_skill_bundle_folder(
            skills_dir,
            "recorded-demo".to_string(),
            "# New\n".to_string(),
            None,
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn create_skill_bundle_folder_cleans_up_failed_bundle() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let extras = serde_json::json!([
            {"path": "../bad.py", "content": "print('bad')"},
        ]);

        let result = create_skill_bundle_folder(
            skills_dir,
            "recorded-demo".to_string(),
            "# Recorded Demo\n".to_string(),
            Some(extras.to_string()),
        );

        assert!(result.is_err());
        assert!(!tmp.path().join("recorded-demo").exists());
        let leftover_staging: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".creating.")
            })
            .collect();
        assert!(leftover_staging.is_empty());
    }

    #[test]
    fn install_skill_writes_binary_extra_file_byte_identical() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        // zip/pptx magic followed by bytes that are not valid UTF-8. A text
        // round-trip would replace them with U+FFFD (#2297).
        let payload: Vec<u8> = vec![
            0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFE, 0x00, 0x80, 0xC3, 0x28, 0xA0, 0xA1,
        ];
        let extras = serde_json::json!([
            {"path": "assets/template.pptx", "contentB64": STANDARD.encode(&payload)},
        ]);

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test\n".to_string(),
            Some(extras.to_string()),
            None,
        )
        .unwrap();

        let written = fs::read(tmp.path().join("test-skill/assets/template.pptx")).unwrap();
        assert_eq!(written, payload, "binary payload must be byte-identical");
    }

    #[test]
    fn install_skill_rejects_extra_file_without_content() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let extras = serde_json::json!([
            {"path": "assets/empty.bin"},
        ]);

        let result = install_skill(
            skills_dir,
            "test-skill".to_string(),
            "# Test\n".to_string(),
            Some(extras.to_string()),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no content"));
    }

    #[test]
    fn read_skill_file_b64_returns_raw_bytes() {
        use base64::{Engine, engine::general_purpose::STANDARD};

        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let skill_dir = tmp.path().join("test-skill");
        fs::create_dir_all(skill_dir.join("assets")).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# Test\n").unwrap();

        let payload: Vec<u8> = vec![0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFE, 0x00, 0x80];
        fs::write(skill_dir.join("assets/template.pptx"), &payload).unwrap();

        let encoded = read_skill_file_b64(
            skills_dir,
            "test-skill".to_string(),
            "assets/template.pptx".to_string(),
        )
        .unwrap()
        .expect("file should be found");
        assert_eq!(STANDARD.decode(encoded).unwrap(), payload);
    }

    #[test]
    fn install_skill_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let extras = serde_json::json!([
            {"path": "../evil.txt", "content": "malicious"},
        ]);

        let result = install_skill(
            skills_dir,
            "test-skill".to_string(),
            "# Test\n".to_string(),
            Some(extras.to_string()),
            None,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must be relative, no .."));
    }

    #[test]
    fn install_skill_rejects_unsafe_slug() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        for slug in [".", "..", "bad/slug", "bad\\slug", "bad slug"] {
            let result = install_skill(
                skills_dir.clone(),
                slug.to_string(),
                "# Test\n".to_string(),
                None,
                None,
            );
            assert!(result.is_err(), "expected install to reject {slug}");
        }
    }

    #[test]
    fn create_skill_folder_rejects_unsafe_slug() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let result = create_skill_folder(
            skills_dir,
            "../bad".to_string(),
            "Bad Skill".to_string(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn create_skill_folder_writes_description_into_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let path = create_skill_folder(
            skills_dir,
            "lead-finder".to_string(),
            "Lead Finder".to_string(),
            Some("Find new leads from a list of websites and report back".to_string()),
        )
        .unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains(
            "description: Find new leads from a list of websites and report back",
        ));
        assert!(
            content
                .contains("Find new leads from a list of websites and report back\n\n## Workflow"),
            "overview body should reuse the supplied description, got:\n{}",
            content,
        );
    }

    #[test]
    fn create_skill_folder_falls_back_to_todo_when_description_blank() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let path = create_skill_folder(
            skills_dir,
            "blank".to_string(),
            "Blank".to_string(),
            Some("   ".to_string()),
        )
        .unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("description: TODO: describe"));
    }

    #[test]
    fn validate_skill_payload_detects_missing_files() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        // Install skill with manifest referencing files that don't exist.
        // Backticked paths must live inside a fenced code block to count as
        // payload references (#2036); prose mentions are documentation.
        let content = "---\n\
name: test-skill\n\
description: Test\n\
---\n\
\n\
# Test Skill\n\
\n\
Run [agent](scripts/agent.py) with config.\n\
\n\
## Install\n\
\n\
```bash\n\
cp `config.example.json` config.json\n\
pip install -r `requirements.txt`\n\
```\n";
        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            None,
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir.clone(), "test-skill".to_string()).unwrap();
        assert!(missing.contains(&"scripts/agent.py".to_string()));
        assert!(missing.contains(&"config.example.json".to_string()));
        assert!(missing.contains(&"requirements.txt".to_string()));
    }

    #[test]
    fn validate_skill_payload_passes_when_files_present() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let content = r#"# Test
Run [agent](scripts/agent.py) with `requirements.txt`.
"#;
        let extras = serde_json::json!([
            {"path": "scripts/agent.py", "content": "print('ok')"},
            {"path": "requirements.txt", "content": "requests"},
        ]);

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            Some(extras.to_string()),
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir, "test-skill".to_string()).unwrap();
        assert!(missing.is_empty(), "all referenced files should be present");
    }

    #[test]
    fn validate_skill_payload_skips_files_with_example_sibling() {
        // Real-world case: SKILL.md instructs `Copy config.example.json to config.json`.
        // config.example.json ships in the bundle; config.json is user-provisioned.
        // The validator must not flag it as missing.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let content = r#"# Test
Copy `config.example.json` to `config.json`.
"#;
        let extras = serde_json::json!([
            {"path": "config.example.json", "content": "{}"},
        ]);

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            Some(extras.to_string()),
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir, "test-skill".to_string()).unwrap();
        assert!(
            !missing.contains(&"config.json".to_string()),
            "config.json must not be flagged when config.example.json sibling exists, got {:?}",
            missing,
        );
    }

    #[test]
    fn validate_skill_payload_still_flags_truly_missing_files() {
        // Regression guard: the user-provisioned-template skip must not
        // hide genuinely broken references (file with no .example sibling).
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let content = r#"# Test
Run [agent](scripts/agent.py) and read `config.example.json`.
"#;
        let extras = serde_json::json!([
            {"path": "config.example.json", "content": "{}"},
        ]);

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            Some(extras.to_string()),
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir, "test-skill".to_string()).unwrap();
        assert!(
            missing.contains(&"scripts/agent.py".to_string()),
            "scripts/agent.py has no .example sibling and must still be flagged, got {:?}",
            missing,
        );
    }

    #[test]
    fn validate_skill_payload_skips_runtime_artifact_paths() {
        // Issue #1926: SKILL.md prose mentions runtime artifacts that the
        // skill creates lazily at execution time (JWT caches, logs, output
        // dirs, etc.). The publisher does not ship these — the runtime
        // creates them on first use. The validator must not flag them.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let content = r#"# Test
The operator must pre-supply a JWT or seed `state/session_cache.json` by hand.
Logs are written to `logs/trading_2026.log`.
The pipeline writes `output/persist_sql.json` and `cache/markets.json`.
Temporary scratch goes in `tmp/scratch.txt`.
"#;
        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            None,
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir, "test-skill".to_string()).unwrap();
        assert!(
            missing.is_empty(),
            "runtime artifact paths must not be flagged as missing, got {:?}",
            missing,
        );
    }

    #[test]
    fn validate_skill_payload_skips_runtime_paths_but_still_flags_real_payload() {
        // Regression guard: runtime-path skip must not mask a genuinely
        // missing bundle payload file referenced alongside runtime paths.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let content = r#"# Test
Run [agent](scripts/agent.py) — it writes to `state/session_cache.json` lazily.
"#;
        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            content.to_string(),
            None,
            None,
        )
        .unwrap();

        let missing = validate_skill_payload(skills_dir, "test-skill".to_string()).unwrap();
        assert!(
            missing.contains(&"scripts/agent.py".to_string()),
            "scripts/agent.py is a real payload reference and must still be flagged, got {:?}",
            missing,
        );
        assert!(
            !missing.contains(&"state/session_cache.json".to_string()),
            "state/* is a runtime path and must be skipped, got {:?}",
            missing,
        );
    }

    #[test]
    fn install_skill_writes_sync_state_when_provided() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let sync_state = serde_json::json!({
            "version": 1,
            "upstreamSource": "serenorg",
            "upstreamSourceUrl": "https://raw.githubusercontent.com/serenorg/seren-skills/main/seren/test-skill/SKILL.md",
            "syncedRevision": "abc123",
            "syncedAt": 1,
            "managedFiles": {
                "SKILL.md": "hash"
            }
        });

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            Some(sync_state.to_string()),
        )
        .unwrap();

        let raw = read_skill_sync_state(skills_dir, "test-skill".to_string())
            .unwrap()
            .expect("sync state should exist");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, sync_state);
    }

    #[test]
    fn install_skill_accepts_seren_publisher_sync_state() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let sync_state = serde_json::json!({
            "version": 1,
            "upstreamSource": "seren",
            "upstreamSourceUrl": "seren-skills:test-skill",
            "syncedRevision": "abc123",
            "syncedAt": 1,
            "managedFiles": {
                "SKILL.md": "hash"
            }
        });

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            Some(sync_state.to_string()),
        )
        .unwrap();

        let raw = read_skill_sync_state(skills_dir, "test-skill".to_string())
            .unwrap()
            .expect("sync state should exist");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, sync_state);
    }

    #[test]
    fn install_skill_rejects_seren_sync_state_without_skills_scheme() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let sync_state = serde_json::json!({
            "version": 1,
            "upstreamSource": "seren",
            "upstreamSourceUrl": "https://example.com/test-skill",
            "syncedRevision": null,
            "syncedAt": 1,
            "managedFiles": { "SKILL.md": "hash" }
        });

        let err = install_skill(
            skills_dir,
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            Some(sync_state.to_string()),
        )
        .unwrap_err();
        assert!(err.contains("seren-skills:{slug}"));
    }

    #[test]
    fn validate_sync_state_rejects_seren_slugs_with_unsafe_characters() {
        let make_state = |url: &str| SkillSyncStateFile {
            version: 1,
            upstream_source: "seren".to_string(),
            upstream_source_url: url.to_string(),
            synced_revision: None,
            synced_at: 1,
            managed_files: std::collections::BTreeMap::from([(
                "SKILL.md".to_string(),
                "hash".to_string(),
            )]),
        };

        for url in [
            "seren-skills:",
            "seren-skills:   ",
            "seren-skills:.",
            "seren-skills:foo/bar",
            "seren-skills:foo\\bar",
            "seren-skills:foo bar",
            "seren-skills:foo\nbar",
            "seren-skills:..",
        ] {
            let result = validate_sync_state_file(&make_state(url));
            let err = match result {
                Ok(_) => panic!("expected validator to reject {}", url),
                Err(e) => e,
            };
            assert!(
                err.contains("Seren upstream sync state"),
                "unexpected error for {}: {}",
                url,
                err
            );
        }
    }

    #[test]
    fn validate_sync_state_accepts_seren_slug_with_dots_and_dashes() {
        let state = SkillSyncStateFile {
            version: 1,
            upstream_source: "seren".to_string(),
            upstream_source_url: "seren-skills:my.skill-v2".to_string(),
            synced_revision: None,
            synced_at: 1,
            managed_files: std::collections::BTreeMap::from([(
                "SKILL.md".to_string(),
                "hash".to_string(),
            )]),
        };
        validate_sync_state_file(&state).unwrap();
    }

    #[test]
    fn write_and_read_skill_sync_state_round_trip() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            None,
        )
        .unwrap();

        let sync_state = serde_json::json!({
            "version": 1,
            "upstreamSource": "serenorg",
            "upstreamSourceUrl": "https://raw.githubusercontent.com/serenorg/seren-skills/main/seren/test-skill/SKILL.md",
            "syncedRevision": null,
            "syncedAt": 2,
            "managedFiles": {
                "SKILL.md": "hash",
                "scripts/agent.py": "hash2"
            }
        });
        write_skill_sync_state(
            skills_dir.clone(),
            "test-skill".to_string(),
            sync_state.to_string(),
        )
        .unwrap();

        let raw = read_skill_sync_state(skills_dir, "test-skill".to_string())
            .unwrap()
            .expect("sync state should exist");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, sync_state);
    }

    #[cfg(unix)]
    #[test]
    fn read_skill_file_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let outside = TempDir::new().unwrap();
        let secret_path = outside.path().join("secret.txt");
        fs::write(&secret_path, "secret").unwrap();

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            None,
            None,
        )
        .unwrap();

        let skill_dir = tmp.path().join("test-skill");
        symlink(outside.path(), skill_dir.join("linked")).unwrap();

        let result = read_skill_file(
            skills_dir,
            "test-skill".to_string(),
            "linked/secret.txt".to_string(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("escapes the skill directory"));
    }

    #[cfg(unix)]
    #[test]
    fn list_skill_payload_files_skips_symlink_escape() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            Some(
                serde_json::json!([
                    {"path": "scripts/agent.py", "content": "print('ok')"}
                ])
                .to_string(),
            ),
            None,
        )
        .unwrap();

        let skill_dir = tmp.path().join("test-skill");
        symlink(outside.path(), skill_dir.join("linked")).unwrap();

        let payload = list_skill_payload_files(skills_dir, "test-skill".to_string()).unwrap();
        assert_eq!(payload.len(), 1);
        assert_eq!(payload[0].path, "scripts/agent.py");
    }

    #[test]
    fn list_skill_payload_files_excludes_recording_local_metadata() {
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        install_skill(
            skills_dir.clone(),
            "test-skill".to_string(),
            "# Test Skill\nHello".to_string(),
            Some(
                serde_json::json!([
                    {"path": "scripts/agent.py", "content": "print('ok')"}
                ])
                .to_string(),
            ),
            None,
        )
        .unwrap();

        let skill_dir = tmp.path().join("test-skill");
        let metadata_dir = skill_dir.join(RECORDING_LOCAL_METADATA_DIR);
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(metadata_dir.join("provenance.json"), "{}").unwrap();

        let payload = list_skill_payload_files(skills_dir, "test-skill".to_string()).unwrap();

        assert_eq!(payload.len(), 1);
        assert_eq!(payload[0].path, "scripts/agent.py");
    }

    #[test]
    fn log_skill_install_failure_appends_jsonl_line() {
        // Critical regression guard for #1917: install/refresh failures must
        // produce a durable audit line so silent partial-installs are never
        // invisible. The TS layer calls this after validate_skill_payload
        // returns missing files; this test pins the on-disk schema.
        let tmp = TempDir::new().unwrap();
        let log_path = tmp.path().join("skill-install.log");

        log_skill_install_failure(
            log_path.to_string_lossy().to_string(),
            "prophet-arb-bot".to_string(),
            "install".to_string(),
            vec![
                "scripts/agent.py".to_string(),
                "requirements.txt".to_string(),
            ],
        )
        .unwrap();

        let raw = fs::read_to_string(&log_path).unwrap();
        let line = raw.trim_end();
        assert!(!line.is_empty(), "log file should contain one JSONL line");

        let entry: serde_json::Value = serde_json::from_str(line).unwrap();
        assert_eq!(entry["slug"], "prophet-arb-bot");
        assert_eq!(entry["phase"], "install");
        assert_eq!(
            entry["missingFiles"],
            serde_json::json!(["scripts/agent.py", "requirements.txt"])
        );
        assert!(
            entry["timestamp"].as_str().is_some(),
            "timestamp must be an ISO-8601 string, got {:?}",
            entry["timestamp"]
        );

        // Append-only: a second call adds a new line, never truncates.
        log_skill_install_failure(
            log_path.to_string_lossy().to_string(),
            "another-skill".to_string(),
            "refresh".to_string(),
            vec!["lib/missing.py".to_string()],
        )
        .unwrap();

        let after = fs::read_to_string(&log_path).unwrap();
        assert_eq!(after.lines().count(), 2);
    }

    #[test]
    fn install_skill_writes_sync_state_atomically_with_payload() {
        // Regression guard for #1917: `.seren-sync.json` must land in the
        // staging directory before the rename, so a partial install can
        // never produce an active skill dir with payload files but no
        // sync manifest (or vice versa). The agent's downstream payload
        // check relies on the manifest matching the on-disk files.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().join("skills");
        fs::create_dir_all(&skills_dir).unwrap();

        let extra_files = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('hi')\n" }
        ])
        .to_string();
        let sync_state = serde_json::json!({
            "version": 1,
            "upstreamSource": "seren",
            "upstreamSourceUrl": "seren-skills:prophet-arb-bot",
            "syncedAt": 1,
            "managedFiles": { "SKILL.md": "abc" },
        })
        .to_string();

        install_skill(
            skills_dir.to_string_lossy().to_string(),
            "prophet-arb-bot".to_string(),
            "# Prophet Arb Bot\n".to_string(),
            Some(extra_files),
            Some(sync_state),
        )
        .unwrap();

        let active_dir = skills_dir.join("prophet-arb-bot");
        assert!(active_dir.join("SKILL.md").exists());
        assert!(active_dir.join("scripts/agent.py").exists());
        assert!(
            active_dir.join(".seren-sync.json").exists(),
            "sync state must land alongside payload in the activated dir"
        );

        // And the staging dir must be cleaned up — no stray `*.installing.*`
        // sibling left behind that could fool a future scan.
        let leftover_staging: Vec<_> = fs::read_dir(&skills_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".installing.")
            })
            .collect();
        assert!(
            leftover_staging.is_empty(),
            "no .installing.* leftovers expected"
        );
    }

    #[test]
    fn install_skill_preserves_user_files_on_reinstall() {
        // Issue serenorg/seren-desktop#1928: re-installing a skill used to
        // wipe everything the user added to the skill dir (`.env`,
        // `config.json`, `state/*`, `logs/*`, etc.). Files outside the new
        // bundle must survive a refresh; bundle files must be replaced.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let v1_extras = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('v1')\n" },
            { "path": "config.example.json", "content": "{\"v\":1}\n" },
        ])
        .to_string();
        install_skill(
            skills_dir.clone(),
            "prophet-arb-bot".to_string(),
            "# v1\n".to_string(),
            Some(v1_extras),
            None,
        )
        .unwrap();

        let active_dir = tmp.path().join("prophet-arb-bot");
        fs::write(active_dir.join(".env"), "SEREN_API_KEY=secret\n").unwrap();
        fs::write(active_dir.join("config.json"), "{\"funded\":true}\n").unwrap();
        fs::create_dir_all(active_dir.join("state")).unwrap();
        fs::write(
            active_dir.join("state/session_cache.json"),
            "{\"jwt\":\"eyJ\"}\n",
        )
        .unwrap();
        fs::create_dir_all(active_dir.join("logs")).unwrap();
        fs::write(
            active_dir.join("logs/trading_2026.jsonl"),
            "{\"trade\":1}\n",
        )
        .unwrap();

        let v2_extras = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('v2')\n" },
            { "path": "config.example.json", "content": "{\"v\":2}\n" },
        ])
        .to_string();
        install_skill(
            skills_dir,
            "prophet-arb-bot".to_string(),
            "# v2\n".to_string(),
            Some(v2_extras),
            None,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(active_dir.join(".env")).ok().as_deref(),
            Some("SEREN_API_KEY=secret\n"),
            ".env must survive re-install",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("config.json"))
                .ok()
                .as_deref(),
            Some("{\"funded\":true}\n"),
            "config.json must survive re-install",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("state/session_cache.json"))
                .ok()
                .as_deref(),
            Some("{\"jwt\":\"eyJ\"}\n"),
            "state/* must survive re-install",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("logs/trading_2026.jsonl"))
                .ok()
                .as_deref(),
            Some("{\"trade\":1}\n"),
            "logs/* must survive re-install",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("SKILL.md")).unwrap(),
            "# v2\n",
            "SKILL.md must be replaced with v2",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("scripts/agent.py")).unwrap(),
            "print('v2')\n",
            "bundle files must be replaced with v2",
        );
    }

    #[test]
    fn is_user_state_path_denies_runtime_artifacts_and_allows_templates() {
        // Issue serenorg/seren-desktop#1933: paths the user owns must be
        // classified as user-state even when the bundle claims them. Template
        // siblings (`.env.example`, `config.example.json`) stay bundle-owned.
        let user_state = [
            ".env",
            ".env.local",
            ".env.production",
            "config.json",
            "state",
            "state/wallet.local.json",
            "state/cost_basis_lots.json",
            "logs/trading.jsonl",
            "scripts/state/cache.bin",
            ".venv/bin/python",
            "node_modules/foo/index.js",
            "scripts/__pycache__/agent.cpython.pyc",
            ".pytest_cache/v/cache",
            "build/foo.pyc",
            ".DS_Store",
            "subdir/.DS_Store",
        ];
        for path in user_state {
            assert!(
                is_user_state_path(path),
                "expected {} to classify as user-state",
                path
            );
        }
        let bundle_owned = [
            "SKILL.md",
            "scripts/agent.py",
            "requirements.txt",
            "config.example.json",
            ".env.example",
            ".env.sample",
            ".env.template",
            "state.md",
            "logs.md",
        ];
        for path in bundle_owned {
            assert!(
                !is_user_state_path(path),
                "expected {} to classify as bundle-owned",
                path
            );
        }
    }

    #[test]
    fn bundle_managed_paths_drops_user_state_claims() {
        // The publisher must not be able to claim user-owned paths. If it
        // tries, `bundle_managed_paths` strips them so `preserve_user_files`
        // keeps the backup copy and `write_skill_tree` refuses to lay down
        // the contaminated bundle file.
        let extra = |path: &str, content: &str| ExtraFile {
            path: path.to_string(),
            content: Some(content.to_string()),
            content_b64: None,
        };
        let extras = vec![
            extra("scripts/agent.py", "print('ok')\n"),
            extra(".env", "SEREN_API_KEY=leaked\n"),
            extra("state/session.json", "{}\n"),
            extra("logs/old.jsonl", ""),
            extra(".env.example", "SEREN_API_KEY=\n"),
        ];
        let paths = bundle_managed_paths(&extras, true);
        assert!(paths.contains("SKILL.md"));
        assert!(paths.contains(SKILL_SYNC_STATE_FILE));
        assert!(paths.contains("scripts/agent.py"));
        assert!(paths.contains(".env.example"));
        assert!(
            !paths.contains(".env"),
            ".env must not be bundle-managed even when extras claim it",
        );
        assert!(!paths.contains("state/session.json"));
        assert!(!paths.contains("logs/old.jsonl"));
    }

    #[test]
    fn install_skill_refuses_contaminated_bundle_overwriting_user_state() {
        // Issue serenorg/seren-desktop#1933: defense-in-depth against the
        // publisher leaking user-state files into a bundle. A re-install
        // whose extras claim `.env`, `state/*`, `logs/*`, or `config.json`
        // must (a) preserve the user's existing copy, and (b) refuse to
        // write the bundle's contaminated version anywhere on disk.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let v1_extras = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('v1')\n" },
        ])
        .to_string();
        install_skill(
            skills_dir.clone(),
            "leaky-skill".to_string(),
            "# v1\n".to_string(),
            Some(v1_extras),
            None,
        )
        .unwrap();

        let active_dir = tmp.path().join("leaky-skill");
        fs::write(active_dir.join(".env"), "SEREN_API_KEY=user-real\n").unwrap();
        fs::write(active_dir.join("config.json"), "{\"funded\":true}\n").unwrap();
        fs::create_dir_all(active_dir.join("state")).unwrap();
        fs::write(active_dir.join("state/session.json"), "{\"jwt\":\"eyJ\"}\n").unwrap();
        fs::create_dir_all(active_dir.join("logs")).unwrap();
        fs::write(active_dir.join("logs/trades.jsonl"), "{\"t\":1}\n").unwrap();

        let contaminated_extras = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('v2')\n" },
            { "path": ".env", "content": "SEREN_API_KEY=leaked-template\n" },
            { "path": "config.json", "content": "{\"funded\":false}\n" },
            { "path": "state/session.json", "content": "{}\n" },
            { "path": "logs/trades.jsonl", "content": "\n" },
        ])
        .to_string();
        install_skill(
            skills_dir,
            "leaky-skill".to_string(),
            "# v2\n".to_string(),
            Some(contaminated_extras),
            None,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(active_dir.join(".env")).unwrap(),
            "SEREN_API_KEY=user-real\n",
            ".env must survive even when the bundle claims it",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("config.json")).unwrap(),
            "{\"funded\":true}\n",
            "config.json must survive even when the bundle claims it",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("state/session.json")).unwrap(),
            "{\"jwt\":\"eyJ\"}\n",
            "state/* must survive even when the bundle claims it",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("logs/trades.jsonl")).unwrap(),
            "{\"t\":1}\n",
            "logs/* must survive even when the bundle claims it",
        );
        assert_eq!(
            fs::read_to_string(active_dir.join("scripts/agent.py")).unwrap(),
            "print('v2')\n",
            "non-user-state bundle files must still be replaced",
        );
    }

    #[test]
    fn install_skill_skips_user_state_extras_on_fresh_install() {
        // On a fresh install (no backup dir to merge from), the deny-list
        // must still refuse to lay down user-state files from the bundle.
        // Otherwise a contaminated `.env` would land on disk on the very
        // first install — the preservation path never gets a chance.
        let tmp = TempDir::new().unwrap();
        let skills_dir = tmp.path().to_string_lossy().to_string();

        let contaminated_extras = serde_json::json!([
            { "path": "scripts/agent.py", "content": "print('ok')\n" },
            { "path": ".env", "content": "SEREN_API_KEY=leaked\n" },
            { "path": "state/cache.bin", "content": "" },
        ])
        .to_string();
        install_skill(
            skills_dir,
            "fresh-skill".to_string(),
            "# fresh\n".to_string(),
            Some(contaminated_extras),
            None,
        )
        .unwrap();

        let active_dir = tmp.path().join("fresh-skill");
        assert!(active_dir.join("scripts/agent.py").exists());
        assert!(
            !active_dir.join(".env").exists(),
            "user-state .env must never be written from a bundle",
        );
        assert!(
            !active_dir.join("state/cache.bin").exists(),
            "user-state state/* must never be written from a bundle",
        );
    }
}
