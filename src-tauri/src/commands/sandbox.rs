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
