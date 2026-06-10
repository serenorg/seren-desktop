// ABOUTME: Pre-install shutdown command invoked by the in-app updater before downloadAndInstall.
// ABOUTME: Drains Seren-owned child processes, blocks new spawns, and waits for Windows file handles to release.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use std::time::Duration;
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

use crate::{mcp, provider_runtime, terminal};

/// Global flag set by `updater_pre_install` and cleared only by relaunch.
/// While set, spawn-side commands must reject new child processes so the
/// install window stays drained. Cleared on process exit when the new build
/// boots fresh.
#[derive(Default)]
pub struct ShutdownGuard {
    locked: AtomicBool,
}

impl ShutdownGuard {
    pub fn engage(&self) {
        self.locked.store(true, Ordering::SeqCst);
    }

    pub fn release(&self) {
        self.locked.store(false, Ordering::SeqCst);
    }

    pub fn is_engaged(&self) -> bool {
        self.locked.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreInstallReport {
    pub mcp_drained: bool,
    pub terminals_drained: bool,
    pub provider_runtime_drained: bool,
    pub claude_memory_drained: bool,
    pub handle_released: bool,
    pub locked_node_path: Option<String>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreflightReport {
    pub install_ready: bool,
    pub current_app_path: Option<String>,
    pub reason: Option<String>,
    pub remediation: Option<String>,
}

const MACOS_DMG_REASON: &str = "SerenDesktop is running from a mounted installer volume.";
const MACOS_DMG_REMEDIATION: &str = "Move SerenDesktop to /Applications, eject the installer disk image, reopen Seren, then install the update.";

/// Check whether the updater can safely replace the running app bundle before
/// downloading the update payload. On macOS, running directly from a mounted
/// DMG makes Tauri's bundle swap hit `EXDEV` because the current app is under
/// `/Volumes/*` and the updater's temp backup is on the system data volume.
#[tauri::command]
pub async fn updater_install_preflight() -> Result<InstallPreflightReport, String> {
    #[cfg(target_os = "macos")]
    {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("failed to resolve current executable: {e}"))?;
        return Ok(macos_install_preflight_for_exe_path(&exe_path));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(InstallPreflightReport::ready(None))
    }
}

impl InstallPreflightReport {
    fn ready(current_app_path: Option<String>) -> Self {
        Self {
            install_ready: true,
            current_app_path,
            reason: None,
            remediation: None,
        }
    }

    fn blocked(
        current_app_path: Option<String>,
        reason: impl Into<String>,
        remediation: impl Into<String>,
    ) -> Self {
        Self {
            install_ready: false,
            current_app_path,
            reason: Some(reason.into()),
            remediation: Some(remediation.into()),
        }
    }
}

fn macos_install_preflight_for_exe_path(exe_path: &Path) -> InstallPreflightReport {
    let current_app_path = app_bundle_path_from_exe_path(exe_path);

    if current_app_path
        .as_ref()
        .is_some_and(|path| is_mounted_macos_volume_path(path))
    {
        return InstallPreflightReport::blocked(
            current_app_path.clone(),
            MACOS_DMG_REASON,
            MACOS_DMG_REMEDIATION,
        );
    }

    InstallPreflightReport::ready(current_app_path)
}

fn app_bundle_path_from_exe_path(exe_path: &Path) -> Option<String> {
    let normalized = exe_path.to_string_lossy().replace('\\', "/");
    let mut search_start = 0;
    let mut app_bundle_path = None;

    while let Some(relative_index) = normalized[search_start..].find(".app") {
        let app_end = search_start + relative_index + ".app".len();
        let ends_component = normalized
            .as_bytes()
            .get(app_end)
            .is_none_or(|byte| *byte == b'/');
        if ends_component {
            app_bundle_path = Some(normalized[..app_end].to_string());
        }
        search_start = app_end;
    }

    app_bundle_path
}

fn is_mounted_macos_volume_path(path: &str) -> bool {
    path == "/Volumes" || path.starts_with("/Volumes/")
}

/// Drain every Seren-owned child process tree and wait until the bundled
/// `node.exe` file handle is writeable. Must be called by the frontend
/// updater BEFORE `pendingUpdate.downloadAndInstall()` runs, so the NSIS
/// installer never sees a locked embedded-runtime payload.
///
/// Returns a report so the renderer can surface a precise failure to the
/// user if any drain phase didn't complete.
#[tauri::command]
pub async fn updater_pre_install(
    app: AppHandle,
    guard: State<'_, Arc<ShutdownGuard>>,
) -> Result<PreInstallReport, String> {
    let start = Instant::now();

    // Engage the guard FIRST so any in-flight spawn races see it and abort.
    guard.engage();

    log::info!("[Updater] Pre-install shutdown engaged");

    // Stop the claude-memory file watcher. It spawns no children itself but
    // holds a notify watcher handle on the user's `~/.claude/projects` tree,
    // which is unrelated to install but cheap to drain for a clean restart.
    let claude_memory_drained = tokio::task::spawn_blocking(crate::claude_memory::stop_watcher)
        .await
        .map(|res| res.is_ok())
        .unwrap_or(false);

    // Drain MCP stdio children. These spawn `node.exe` from the bundled
    // runtime; the children frequently keep file locks on `node.exe`
    // (Windows holds the executable mapping open until the last reference
    // exits).
    let mcp_drained = if let Some(state) = app.try_state::<mcp::McpState>() {
        state.kill_all();
        true
    } else {
        false
    };

    // Drain interactive terminal PTYs. On Windows ConPTY, dropping the
    // master does not reliably terminate the shell tree — the existing
    // `kill_all` does `taskkill /F /T` to flatten the tree.
    let terminals_drained = if let Some(state) = app.try_state::<terminal::TerminalState>() {
        state.kill_all();
        true
    } else {
        false
    };

    // Drain the provider runtime supervisor. This is the largest holder of
    // the embedded `node.exe` handle.
    let provider_runtime_drained =
        if let Some(state) = app.try_state::<provider_runtime::ProviderRuntimeState>() {
            state.kill_sync();
            true
        } else {
            false
        };

    // Allow the kernel to flush handles after taskkill. Windows can take
    // several seconds, especially with Defender real-time scanning enabled.
    // We don't block on the full timeout if the handle is already releaseable.
    let (handle_released, locked_node_path) = wait_for_node_handle_release(&app).await;

    let report = PreInstallReport {
        mcp_drained,
        terminals_drained,
        provider_runtime_drained,
        claude_memory_drained,
        handle_released,
        locked_node_path,
        elapsed_ms: start.elapsed().as_millis(),
    };

    log::info!("[Updater] Pre-install shutdown report: {:?}", report);

    if !handle_released {
        // Don't fail — the renderer will warn the user and let them retry
        // or proceed. Returning an error here would block the install for
        // platforms (Linux/macOS) where this check is a no-op.
        log::warn!(
            "[Updater] Embedded node handle still locked after drain: {:?}",
            report.locked_node_path
        );
    }

    Ok(report)
}

/// Release the shutdown guard so provider runtime / MCP can spawn again.
/// Called from the renderer when downloadAndInstall fails — without this
/// the user is left unable to use the app until they manually restart
/// (#2230 functional audit).
#[tauri::command]
pub async fn updater_pre_install_release(
    guard: State<'_, Arc<ShutdownGuard>>,
) -> Result<(), String> {
    guard.release();
    log::info!("[Updater] Pre-install shutdown released (install failed or cancelled)");
    Ok(())
}

/// Poll the bundled `node.exe` file with FILE_GENERIC_WRITE access until the
/// kernel releases the handle or the deadline expires. On non-Windows targets
/// this is a no-op that immediately returns `(true, None)` — the issue is
/// Windows-specific (#2230).
async fn wait_for_node_handle_release(app: &AppHandle) -> (bool, Option<String>) {
    let node_path = bundled_node_path(app);
    let Some(path) = node_path else {
        return (true, None);
    };

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        return (true, None);
    }

    #[cfg(target_os = "windows")]
    {
        const MAX_WAIT: Duration = Duration::from_secs(15);
        const POLL_INTERVAL: Duration = Duration::from_millis(250);

        let path_str = path.to_string_lossy().to_string();
        let deadline = Instant::now() + MAX_WAIT;

        loop {
            if can_open_for_write(&path) {
                return (true, None);
            }
            if Instant::now() >= deadline {
                return (false, Some(path_str));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

#[cfg(target_os = "windows")]
fn can_open_for_write(path: &std::path::Path) -> bool {
    // OpenOptions::write(true) maps to GENERIC_WRITE on Windows, which the
    // kernel rejects with ERROR_SHARING_VIOLATION if any process still has
    // the executable image mapped. This is exactly the condition NSIS hits
    // when it tries to overwrite node.exe — we mirror it here so we know
    // we can safely hand control to the installer.
    std::fs::OpenOptions::new()
        .write(true)
        .create(false)
        .open(path)
        .is_ok()
}

fn bundled_node_path(app: &AppHandle) -> Option<PathBuf> {
    let paths = crate::embedded_runtime::discover_embedded_runtime(app);
    let node_dir = paths.node_dir?;
    let candidate = if cfg!(target_os = "windows") {
        node_dir.join("node.exe")
    } else {
        node_dir.join("node")
    };
    candidate.exists().then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_guard_engages_atomically() {
        let guard = ShutdownGuard::default();
        assert!(!guard.is_engaged());
        guard.engage();
        assert!(guard.is_engaged());
        // Engaging twice is idempotent.
        guard.engage();
        assert!(guard.is_engaged());
    }

    #[test]
    fn shutdown_guard_releases_on_install_failure() {
        // After a failed update, the renderer must be able to disengage the
        // guard so the user is not locked out of provider runtime / MCP
        // until they restart the app.
        let guard = ShutdownGuard::default();
        guard.engage();
        assert!(guard.is_engaged());
        guard.release();
        assert!(!guard.is_engaged());
        // Re-engaging after release works (a second update attempt).
        guard.engage();
        assert!(guard.is_engaged());
    }

    #[test]
    fn macos_install_preflight_blocks_mounted_dmg_bundle() {
        let report = macos_install_preflight_for_exe_path(Path::new(
            "/Volumes/SerenDesktop/SerenDesktop.app/Contents/MacOS/Seren",
        ));

        assert!(!report.install_ready);
        assert_eq!(
            report.current_app_path.as_deref(),
            Some("/Volumes/SerenDesktop/SerenDesktop.app")
        );
        assert_eq!(report.reason.as_deref(), Some(MACOS_DMG_REASON));
        assert_eq!(report.remediation.as_deref(), Some(MACOS_DMG_REMEDIATION));
    }

    #[test]
    fn macos_install_preflight_allows_applications_bundle() {
        let report = macos_install_preflight_for_exe_path(Path::new(
            "/Applications/SerenDesktop.app/Contents/MacOS/Seren",
        ));

        assert!(report.install_ready);
        assert_eq!(
            report.current_app_path.as_deref(),
            Some("/Applications/SerenDesktop.app")
        );
        assert!(report.reason.is_none());
        assert!(report.remediation.is_none());
    }

    #[test]
    fn app_bundle_path_resolves_from_nested_resource_paths() {
        let path = app_bundle_path_from_exe_path(Path::new(
            "/Volumes/SerenDesktop/SerenDesktop.app/Contents/Resources/embedded-runtime/darwin-arm64/node/bin/node",
        ));

        assert_eq!(
            path.as_deref(),
            Some("/Volumes/SerenDesktop/SerenDesktop.app")
        );
    }
}
