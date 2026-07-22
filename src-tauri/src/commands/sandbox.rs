// ABOUTME: Tauri command that returns the verified OS provider sandbox launch spec.
// ABOUTME: Credential-store paths are denied before the policy crosses into the child runtime.

use std::path::PathBuf;
use std::str::FromStr;

use serde::Serialize;

#[cfg(target_os = "linux")]
use crate::sandbox::encode_policy;
#[cfg(target_os = "windows")]
use crate::sandbox::encode_policy;
#[cfg(target_os = "macos")]
use crate::sandbox::seatbelt_profile;
use crate::sandbox::{SandboxMode, SandboxPolicy};

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

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum AgentSandboxLaunchSpec {
    #[serde(rename = "seatbelt")]
    Seatbelt { profile: String },
    #[serde(rename = "linux-launcher")]
    LinuxLauncher {
        #[serde(rename = "launcherPath")]
        launcher_path: String,
        #[serde(rename = "policyBase64")]
        policy_base64: String,
    },
    #[serde(rename = "windows-launcher")]
    WindowsLauncher {
        #[serde(rename = "launcherPath")]
        launcher_path: String,
        #[serde(rename = "policyBase64")]
        policy_base64: String,
    },
}

#[tauri::command]
pub fn agent_sandbox_profile(
    mode: String,
    project_root: String,
    network_enabled: Option<bool>,
) -> Result<AgentSandboxLaunchSpec, String> {
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

    #[cfg(target_os = "macos")]
    {
        return seatbelt_profile(&policy)
            .map(|profile| AgentSandboxLaunchSpec::Seatbelt { profile })
            .map_err(|error| error.to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let launcher_path = std::env::current_exe()
            .map_err(|error| format!("Could not resolve the sandbox launcher: {error}"))?
            .to_string_lossy()
            .into_owned();
        let policy_base64 = encode_policy(&policy).map_err(|error| error.to_string())?;
        return Ok(AgentSandboxLaunchSpec::LinuxLauncher {
            launcher_path,
            policy_base64,
        });
    }

    #[cfg(target_os = "windows")]
    {
        let launcher_path = std::env::current_exe()
            .map_err(|error| format!("Could not resolve the sandbox launcher: {error}"))?
            .to_string_lossy()
            .into_owned();
        let policy_base64 = encode_policy(&policy).map_err(|error| error.to_string())?;
        return Ok(AgentSandboxLaunchSpec::WindowsLauncher {
            launcher_path,
            policy_base64,
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = policy;
        Err("The provider sandbox backend is unavailable on this platform.".to_string())
    }
}
