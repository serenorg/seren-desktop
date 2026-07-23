// ABOUTME: Builds the verified OS provider sandbox launch spec and exposes it to trusted callers.
// ABOUTME: Credential-store paths are denied before the policy crosses into the child runtime.

use std::io::Write;
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

/// A truthful renderer-facing summary of the sandbox that will be used for a
/// local agent launch. This reports whether the trusted backend can build a
/// launch specification; it does not claim a child is already confined.
#[derive(Debug, Serialize)]
pub struct AgentSandboxStatus {
    pub backend: String,
    pub spec_available: bool,
    pub enforced_at_launch: bool,
    pub fail_closed: bool,
    pub effective_mode: String,
    pub network_enabled: bool,
    pub detail: String,
}

/// Hidden app-binary subcommand that prints the launch spec as JSON on stdout.
///
/// The provider runtime shells out to this so a bounded session's real launcher
/// is produced by the signed app binary rather than handed in by whichever
/// caller issued `provider_spawn`. #3230.
pub const SANDBOX_SPEC_ARGUMENT: &str = "__seren-sandbox-spec";

const BAD_ARGUMENTS_EXIT: i32 = 64;
const SPEC_FAILURE_EXIT: i32 = 70;

#[tauri::command]
pub fn agent_sandbox_profile(
    mode: String,
    project_root: String,
    network_enabled: Option<bool>,
) -> Result<AgentSandboxLaunchSpec, String> {
    build_launch_spec(&mode, &project_root, network_enabled.unwrap_or(true))
}

/// Reports the effective sandbox posture from the Rust policy layer instead of
/// echoing the renderer's requested mode. Bounded modes fail closed when a
/// launch specification cannot be built; full access is deliberately shown as
/// unconfined rather than as a failed sandbox.
#[tauri::command]
pub fn agent_sandbox_status(
    mode: String,
    project_root: String,
    network_enabled: Option<bool>,
) -> AgentSandboxStatus {
    let network_enabled = network_enabled.unwrap_or(true);
    let parsed_mode = SandboxMode::from_str(&mode);
    let is_full_access = matches!(&parsed_mode, Ok(SandboxMode::FullAccess));
    let effective_mode = match &parsed_mode {
        Ok(SandboxMode::ReadOnly) => "read-only".to_string(),
        Ok(SandboxMode::WorkspaceWrite) => "workspace-write".to_string(),
        Ok(SandboxMode::FullAccess) => "full-access".to_string(),
        Err(_) => mode.trim().to_string(),
    };

    if is_full_access {
        return AgentSandboxStatus {
            backend: "unconfined".to_string(),
            spec_available: false,
            enforced_at_launch: false,
            fail_closed: false,
            effective_mode: "full-access".to_string(),
            network_enabled,
            detail: "No OS sandbox — the agent runs unconfined.".to_string(),
        };
    }

    match build_launch_spec(&mode, &project_root, network_enabled) {
        Ok(_) => AgentSandboxStatus {
            backend: resolve_backend_kind().to_string(),
            spec_available: true,
            enforced_at_launch: true,
            fail_closed: true,
            effective_mode,
            network_enabled,
            detail: launch_enforcement_detail().to_string(),
        },
        Err(error) => AgentSandboxStatus {
            backend: resolve_backend_kind().to_string(),
            spec_available: false,
            enforced_at_launch: false,
            fail_closed: true,
            effective_mode,
            network_enabled,
            detail: error,
        },
    }
}

/// Entry point for `<app-binary> __seren-sandbox-spec <mode> <network> <root>`.
///
/// Runs before Tauri starts, so no window is created. Success writes one JSON
/// line to stdout; every failure writes the reason to stderr and exits non-zero
/// so the caller fails closed instead of launching unconfined.
pub fn sandbox_spec_main(args: Vec<String>) -> ! {
    let rest = args.into_iter().skip(1).collect::<Vec<_>>();
    if rest.len() != 4 || rest[0] != SANDBOX_SPEC_ARGUMENT {
        exit_with(
            BAD_ARGUMENTS_EXIT,
            format!("usage: {SANDBOX_SPEC_ARGUMENT} <mode> <network-enabled> <project-root>"),
        );
    }

    let network_enabled = match rest[2].trim() {
        "true" => true,
        "false" => false,
        other => exit_with(
            BAD_ARGUMENTS_EXIT,
            format!("invalid network-enabled value: {other}"),
        ),
    };

    let spec = match build_launch_spec(&rest[1], &rest[3], network_enabled) {
        Ok(spec) => spec,
        Err(error) => exit_with(SPEC_FAILURE_EXIT, error),
    };

    match serde_json::to_string(&spec) {
        Ok(encoded) => {
            let mut stdout = std::io::stdout();
            if writeln!(stdout, "{encoded}")
                .and_then(|()| stdout.flush())
                .is_err()
            {
                exit_with(SPEC_FAILURE_EXIT, "could not write the sandbox launch spec");
            }
            std::process::exit(0);
        }
        Err(error) => exit_with(
            SPEC_FAILURE_EXIT,
            format!("could not serialize the sandbox launch spec: {error}"),
        ),
    }
}

fn exit_with(code: i32, message: impl std::fmt::Display) -> ! {
    eprintln!("Seren sandbox spec: {message}");
    std::process::exit(code);
}

fn resolve_backend_kind() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "seatbelt";
    }

    #[cfg(target_os = "linux")]
    {
        return "linux-landlock";
    }

    #[cfg(target_os = "windows")]
    {
        return "windows-restricted-token";
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "unsupported"
    }
}

fn launch_enforcement_detail() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "Seatbelt enforcement is applied when the agent process launches.";
    }

    #[cfg(target_os = "linux")]
    {
        return "Landlock support is checked when the agent launches; a missing kernel primitive fails the bounded session closed.";
    }

    #[cfg(target_os = "windows")]
    {
        return "Restricted-token support is checked when the agent launches; a missing OS primitive fails the bounded session closed.";
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "No supported OS sandbox backend is available on this platform."
    }
}

fn build_launch_spec(
    mode: &str,
    project_root: &str,
    network_enabled: bool,
) -> Result<AgentSandboxLaunchSpec, String> {
    let mode = SandboxMode::from_str(mode).map_err(|error| error.to_string())?;
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
        network_enabled,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_access_status_reports_unconfined() {
        let status = agent_sandbox_status("full-access".to_string(), String::new(), Some(true));

        assert_eq!(status.backend, "unconfined");
        assert!(!status.spec_available);
        assert!(!status.enforced_at_launch);
        assert!(!status.fail_closed);
        assert_eq!(status.effective_mode, "full-access");
        assert!(status.detail.contains("unconfined"));
    }

    #[test]
    fn workspace_write_status_reports_a_launchable_fail_closed_spec() {
        let workspace = tempfile::tempdir().expect("workspace tempdir");
        let status = agent_sandbox_status(
            "workspace-write".to_string(),
            workspace.path().display().to_string(),
            Some(false),
        );

        assert_eq!(status.backend, resolve_backend_kind());
        assert!(status.spec_available, "{}", status.detail);
        assert!(status.enforced_at_launch);
        assert!(status.fail_closed);
        assert_eq!(status.effective_mode, "workspace-write");
        assert!(!status.network_enabled);
    }

    #[test]
    fn empty_project_root_reports_an_unavailable_spec() {
        let status =
            agent_sandbox_status("workspace-write".to_string(), "   ".to_string(), Some(true));

        assert!(!status.spec_available);
        assert!(!status.enforced_at_launch);
        assert!(status.fail_closed);
        assert!(!status.detail.is_empty());
    }
}
