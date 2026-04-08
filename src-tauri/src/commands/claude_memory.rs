// ABOUTME: Tauri commands for the Claude Code auto-memory interceptor.
// ABOUTME: Exposes start/stop/status, startup migration, render, and identity lookup.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::claude_memory;
use crate::commands::memory::MemoryState;

/// Public status snapshot for the frontend.
#[derive(Debug, Serialize)]
pub struct ClaudeMemoryStatus {
    pub running: bool,
    pub watching_root: Option<String>,
}

/// Public project identity payload for the frontend.
#[derive(Debug, Serialize)]
pub struct ClaudeMemoryProjectIdentity {
    pub identifier: String,
    pub source: String,
}

fn parse_project_id(project_id: Option<String>) -> Result<Option<Uuid>, String> {
    match project_id.as_deref() {
        Some(s) if !s.is_empty() => Uuid::parse_str(s)
            .map(Some)
            .map_err(|e| format!("invalid project_id UUID: {e}")),
        _ => Ok(None),
    }
}

/// Start watching `~/.claude/projects/*/memory/` for Claude Code memory writes.
/// Requires the user to be authenticated and to pass the SerenDB project UUID
/// that intercepted memories should be written to.
#[tauri::command]
pub fn claude_memory_start(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<ClaudeMemoryStatus, String> {
    let project_uuid = parse_project_id(project_id)?;
    let root = claude_memory::start_watcher(app, project_uuid)?;
    Ok(ClaudeMemoryStatus {
        running: true,
        watching_root: Some(root.to_string_lossy().to_string()),
    })
}

/// Stop the watcher if running.
#[tauri::command]
pub fn claude_memory_stop() -> Result<ClaudeMemoryStatus, String> {
    claude_memory::stop_watcher()?;
    Ok(ClaudeMemoryStatus {
        running: false,
        watching_root: None,
    })
}

/// Return the current watcher status without mutating it.
#[tauri::command]
pub fn claude_memory_status() -> Result<ClaudeMemoryStatus, String> {
    let running = claude_memory::is_watcher_running();
    let watching_root = if running {
        claude_memory::claude_projects_root()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(ClaudeMemoryStatus {
        running,
        watching_root,
    })
}

/// Walk every existing Claude memory directory and push any files already on
/// disk to SerenDB. Returns persisted + failures.
#[tauri::command]
pub async fn claude_memory_migrate_existing(
    app: AppHandle,
    project_id: Option<String>,
) -> Result<claude_memory::MigrationReport, String> {
    let project_uuid = parse_project_id(project_id)?;
    claude_memory::migrate_existing_files(&app, project_uuid).await
}

/// Resolve a stable project identifier for `project_cwd` (git remote or UUID).
#[tauri::command]
pub fn claude_memory_get_project_identity(
    project_cwd: String,
) -> Result<ClaudeMemoryProjectIdentity, String> {
    let identity = claude_memory::resolve_project_identity(Path::new(&project_cwd))?;
    let source = match identity.source {
        claude_memory::ProjectIdentitySource::GitRemote => "git_remote",
        claude_memory::ProjectIdentitySource::PersistedUuid => "persisted_uuid",
        claude_memory::ProjectIdentitySource::GeneratedUuid => "generated_uuid",
    }
    .to_string();
    Ok(ClaudeMemoryProjectIdentity {
        identifier: identity.identifier,
        source,
    })
}

/// Render `~/.claude/projects/<encoded(project_cwd)>/MEMORY.md` from the
/// authenticated user's SerenDB memory bootstrap. The frontend calls this
/// when a project is opened so Claude Code reads fresh content next session.
#[tauri::command]
pub async fn claude_memory_render_memory_md(
    app: AppHandle,
    state: State<'_, MemoryState>,
    project_cwd: String,
    project_id: Option<String>,
) -> Result<String, String> {
    let root = claude_memory::claude_projects_root()?;
    let encoded = claude_memory::encode_project_dir(Path::new(&project_cwd));
    let claude_project_dir: PathBuf = root.join(&encoded);

    let rendered = match super::memory::memory_bootstrap(app, state, project_id).await {
        Ok(Some(prompt)) if !prompt.trim().is_empty() => prompt,
        Ok(_) => "# Claude Memory\n\n_No preferences stored yet._\n".to_string(),
        Err(e) => {
            log::warn!("[ClaudeMemory] memory_bootstrap failed during render: {e}");
            format!(
                "# Claude Memory\n\n> Preferences are rehydrating from SerenDB. This message will be replaced on the next successful sync.\n\n_Last error: {e}_\n"
            )
        }
    };

    let final_path = claude_memory::write_rendered_memory_md(&claude_project_dir, &rendered)?;
    Ok(final_path.to_string_lossy().to_string())
}
