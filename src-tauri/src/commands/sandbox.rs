// ABOUTME: Tauri command that returns the verified macOS provider sandbox profile.
// ABOUTME: Credential-store paths are denied before the profile crosses into the child runtime.

use std::path::PathBuf;
use std::str::FromStr;

use crate::sandbox::{SandboxMode, SandboxPolicy, seatbelt_profile};

const CREDENTIAL_STORE_SUFFIXES: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".seren",
    ".config/seren",
    ".config/gcloud",
    ".config/autostart",
    "Library/LaunchAgents",
    ".netrc",
];

#[tauri::command]
pub fn agent_sandbox_profile(
    mode: String,
    project_root: String,
    network_enabled: Option<bool>,
) -> Result<String, String> {
    let mode = SandboxMode::from_str(&mode).map_err(|error| error.to_string())?;
    if mode == SandboxMode::FullAccess {
        return Err("No sandbox profile is generated for full-access mode.".to_string());
    }

    let project_root = project_root.trim();
    if project_root.is_empty() {
        return Err("A project root is required to generate a sandbox profile.".to_string());
    }

    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory.".to_string())?;
    let deny_read = CREDENTIAL_STORE_SUFFIXES
        .iter()
        .map(|suffix| home.join(suffix))
        .filter(|path| path.exists())
        .collect::<Vec<PathBuf>>();

    let policy = SandboxPolicy::new(
        mode,
        vec![PathBuf::from(project_root)],
        deny_read,
        network_enabled.unwrap_or(true),
    )
    .map_err(|error| error.to_string())?;

    seatbelt_profile(&policy).map_err(|error| error.to_string())
}
