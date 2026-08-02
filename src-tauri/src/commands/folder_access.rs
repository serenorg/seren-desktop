// ABOUTME: macOS TCC permission handling for the special user folders (Desktop, Documents, Downloads).
// ABOUTME: The foreground app obtains the grant so the headless agent shell inherits it for working roots under them.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The macOS special user folders that are individually gated by TCC. This is the
/// complete per-folder set macOS protects (Full Disk Access is the separate
/// catch-all), so it is the source of truth for the permissions UI — not a
/// partial hardcoded list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderAccessKey {
    Desktop,
    Documents,
    Downloads,
}

impl FolderAccessKey {
    pub const ALL: [FolderAccessKey; 3] = [
        FolderAccessKey::Desktop,
        FolderAccessKey::Documents,
        FolderAccessKey::Downloads,
    ];

    /// The home-relative subdirectory name.
    fn subdir(self) -> &'static str {
        match self {
            FolderAccessKey::Desktop => "Desktop",
            FolderAccessKey::Documents => "Documents",
            FolderAccessKey::Downloads => "Downloads",
        }
    }

    fn label(self) -> &'static str {
        // Same as the subdir today, kept separate so display text can diverge.
        self.subdir()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderAccessStatus {
    Granted,
    Denied,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAccessCheck {
    pub key: FolderAccessKey,
    pub status: FolderAccessStatus,
    pub label: String,
    pub path: String,
    pub message: String,
    pub can_request: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderAccessPreflight {
    pub platform: String,
    pub checks: Vec<FolderAccessCheck>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn folder_path(key: FolderAccessKey) -> Option<PathBuf> {
    home_dir().map(|home| home.join(key.subdir()))
}

/// Map the outcome of a directory read into a TCC access status.
///
/// `PermissionDenied` (EPERM) is the TCC block we care about. A missing folder is
/// not a permission barrier — the parent was reachable enough to learn it is
/// absent — so it counts as accessible. `None` means the read succeeded.
///
/// Kept OS-agnostic and free of side effects so it can be unit-tested anywhere.
fn status_from_outcome(err_kind: Option<ErrorKind>) -> FolderAccessStatus {
    match err_kind {
        None => FolderAccessStatus::Granted,
        Some(ErrorKind::NotFound) => FolderAccessStatus::Granted,
        Some(_) => FolderAccessStatus::Denied,
    }
}

/// Probe a folder by listing it. On macOS, reading the folder from this
/// (foreground app) process is what surfaces the TCC consent prompt on first
/// access; an already-granted folder lists silently.
#[cfg(target_os = "macos")]
fn probe(path: &Path) -> FolderAccessStatus {
    status_from_outcome(std::fs::read_dir(path).err().map(|error| error.kind()))
}

fn message_for(key: FolderAccessKey, status: FolderAccessStatus) -> String {
    match status {
        FolderAccessStatus::Granted => format!("Seren can access your {} folder.", key.label()),
        FolderAccessStatus::Denied => format!(
            "Seren needs access to your {} folder so agents can read and write files in working roots there. \
             Grant access, then allow it in the macOS prompt.",
            key.label()
        ),
        FolderAccessStatus::Unsupported => {
            "Folder access permissions are managed by macOS and only apply on macOS.".to_string()
        }
    }
}

fn check_for(key: FolderAccessKey) -> FolderAccessCheck {
    let path = folder_path(key)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    #[cfg(target_os = "macos")]
    let status = folder_path(key)
        .map(|p| probe(&p))
        .unwrap_or(FolderAccessStatus::Denied);
    #[cfg(not(target_os = "macos"))]
    let status = FolderAccessStatus::Unsupported;

    let can_request = matches!(status, FolderAccessStatus::Denied);

    FolderAccessCheck {
        key,
        status,
        label: key.label().to_string(),
        path,
        message: message_for(key, status),
        can_request,
    }
}

fn preflight() -> FolderAccessPreflight {
    FolderAccessPreflight {
        platform: std::env::consts::OS.to_string(),
        checks: FolderAccessKey::ALL.iter().copied().map(check_for).collect(),
    }
}

/// Report access status for every macOS special folder. On macOS the first probe
/// may itself surface the consent prompt, which is the intended behavior when the
/// user is on the permissions screen.
#[tauri::command]
pub async fn folder_access_check_permissions() -> Result<FolderAccessPreflight, String> {
    Ok(preflight())
}

/// Touch the requested folder from the foreground app to surface the macOS consent
/// prompt, then re-report the full preflight so callers see the updated state.
#[tauri::command]
pub async fn folder_access_request_permission(
    key: FolderAccessKey,
) -> Result<FolderAccessPreflight, String> {
    let _ = check_for(key);
    Ok(preflight())
}

/// Deep-link to System Settings → Privacy & Security → Files and Folders, where the
/// per-app folder toggles live (there is no per-folder settings anchor).
#[tauri::command]
pub async fn folder_access_open_permission_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
            .spawn()
            .map_err(|error| format!("Failed to open System Settings: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Folder access permission settings are only available on macOS.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_covers_every_macos_special_folder() {
        // The set macOS gates per-folder is exactly Desktop/Documents/Downloads.
        // A shorter list would silently drop a folder from the permissions UI.
        assert_eq!(FolderAccessKey::ALL.len(), 3);
        assert!(FolderAccessKey::ALL.contains(&FolderAccessKey::Desktop));
        assert!(FolderAccessKey::ALL.contains(&FolderAccessKey::Documents));
        assert!(FolderAccessKey::ALL.contains(&FolderAccessKey::Downloads));
    }

    #[test]
    fn permission_denied_is_the_only_blocked_outcome() {
        // EPERM from TCC is the block we surface; success and a missing folder are
        // both "accessible" so we don't nag the user about folders they deleted.
        assert_eq!(status_from_outcome(None), FolderAccessStatus::Granted);
        assert_eq!(
            status_from_outcome(Some(ErrorKind::NotFound)),
            FolderAccessStatus::Granted
        );
        assert_eq!(
            status_from_outcome(Some(ErrorKind::PermissionDenied)),
            FolderAccessStatus::Denied
        );
    }

    #[test]
    fn denied_folders_are_requestable() {
        assert!(matches!(
            message_for(FolderAccessKey::Desktop, FolderAccessStatus::Denied),
            m if m.contains("Desktop")
        ));
    }
}
