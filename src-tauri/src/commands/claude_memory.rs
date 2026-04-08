// ABOUTME: Tauri commands for the Claude Code auto-memory interceptor.
// ABOUTME: Exposes start/stop/status, startup migration, render, and identity lookup.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

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

/// Start watching `~/.claude/projects/*/memory/` for Claude Code memory writes.
#[tauri::command]
pub fn claude_memory_start(app: AppHandle) -> Result<ClaudeMemoryStatus, String> {
    let root = claude_memory::start_watcher(app)?;
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

/// Walk every existing Claude memory directory and intercept any files already
/// on disk. Returns the number migrated.
#[tauri::command]
pub fn claude_memory_migrate_existing(app: AppHandle) -> Result<usize, String> {
    claude_memory::migrate_existing_files(&app)
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
/// authenticated user's SerenDB memory bootstrap. Used by the frontend when a
/// project is opened so Claude Code reads fresh content on the next session.
#[tauri::command]
pub async fn claude_memory_render_memory_md(
    app: AppHandle,
    state: State<'_, MemoryState>,
    project_cwd: String,
    project_id: Option<String>,
) -> Result<String, String> {
    // Ensure the Claude project dir exists (Claude Code creates it lazily; if the
    // user hasn't run a session yet we still want a rendered MEMORY.md ready).
    let root = claude_memory::claude_projects_root()?;
    let encoded = claude_memory::encode_project_dir(Path::new(&project_cwd));
    let claude_project_dir: PathBuf = root.join(&encoded);

    // Fetch the assembled memory prompt. Failures render a fallback header so
    // Claude Code never sees stale plaintext — it sees a clear "DB unavailable"
    // marker that tells the user preferences are being rehydrated in background.
    let rendered = match super::memory::memory_bootstrap(
        app.clone(),
        state,
        project_id,
    )
    .await
    {
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
