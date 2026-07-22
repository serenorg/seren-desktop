// ABOUTME: Generates and applies the macOS Seatbelt profile for provider children.
// ABOUTME: The profile is deny-by-default and is passed directly to sandbox-exec.

use std::path::{Path, PathBuf};

use super::policy::{SandboxError, SandboxMode, SandboxPolicy};
#[cfg(target_os = "linux")]
use super::policy::encode_policy;

const SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

pub fn seatbelt_profile(policy: &SandboxPolicy) -> Result<String, SandboxError> {
    if policy.mode == SandboxMode::FullAccess {
        return Err(SandboxError::FullAccessNoProfile);
    }

    let mut profile = vec![
        "(version 1)".to_string(),
        "(import \"system.sb\")".to_string(),
        "(deny default)".to_string(),
        "(allow process-exec)".to_string(),
        "(allow process-fork)".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow file-read-metadata".to_string(),
    ];
    profile.extend(read_subpaths(&policy.workspace_roots));
    profile.extend(read_subpaths(&system_read_paths()));
    profile.push(")".to_string());

    profile.push("(allow file-read*".to_string());
    profile.extend(read_subpaths(&policy.workspace_roots));
    profile.extend(read_subpaths(&system_read_paths()));
    let runtime_read_paths = runtime_read_paths();
    profile.extend(read_subpaths(&runtime_read_paths));
    profile.push(")".to_string());

    profile.push("(allow file-map-executable".to_string());
    profile.extend(read_subpaths(&runtime_read_paths));
    profile.push(")".to_string());

    if policy.mode == SandboxMode::WorkspaceWrite {
        profile.push("(allow file-write*".to_string());
        profile.extend(read_subpaths(&policy.workspace_roots));
        profile.push(")".to_string());
    }

    if policy.network_enabled {
        profile.push("(allow network*)".to_string());
    } else {
        profile.push("(deny network*)".to_string());
    }

    for path in &policy.deny_read {
        profile.push(format!("(deny file-read* (subpath {}))", sbpl_path(path)));
    }

    Ok(profile.join("\n"))
}

pub fn wrap_spawn(
    command: &str,
    args: &[String],
    policy: &SandboxPolicy,
) -> Result<(String, Vec<String>), SandboxError> {
    if command.trim().is_empty() {
        return Err(SandboxError::EmptyCommand);
    }

    #[cfg(target_os = "macos")]
    {
        let profile = seatbelt_profile(policy)?;
        let mut wrapped_args = Vec::with_capacity(args.len() + 3);
        wrapped_args.push("-p".to_string());
        wrapped_args.push(profile);
        wrapped_args.push(command.to_string());
        wrapped_args.extend(args.iter().cloned());
        Ok((SEATBELT_EXECUTABLE.to_string(), wrapped_args))
    }

    #[cfg(target_os = "linux")]
    {
        let launcher = std::env::current_exe()
            .map_err(|error| SandboxError::Landlock(format!("cannot resolve launcher: {error}")))?;
        let policy_base64 = encode_policy(policy)?;
        let mut wrapped_args = Vec::with_capacity(args.len() + 4);
        wrapped_args.push("__seren-sandbox-run".to_string());
        wrapped_args.push(policy_base64);
        wrapped_args.push("--".to_string());
        wrapped_args.push(command.to_string());
        wrapped_args.extend(args.iter().cloned());
        Ok((launcher.to_string_lossy().into_owned(), wrapped_args))
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
    {
        let _ = (args, policy);
        Err(SandboxError::BackendUnavailable)
    }
}

fn read_subpaths(paths: &[impl AsRef<Path>]) -> Vec<String> {
    paths
        .iter()
        .map(|path| format!("  (subpath {})", sbpl_path(path.as_ref())))
        .collect()
}

fn system_read_paths() -> Vec<&'static Path> {
    [
        Path::new("/System"),
        Path::new("/usr"),
        Path::new("/bin"),
        Path::new("/sbin"),
        Path::new("/private/etc"),
        Path::new("/dev"),
        Path::new("/private/tmp"),
        Path::new("/private/var/folders"),
    ]
    .to_vec()
}

fn runtime_read_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for suffix in [".local/bin", ".claude/bin"] {
            let path = home.join(suffix);
            if path.is_dir() {
                paths.push(path);
            }
        }
    }

    if let Ok(current_exe) = std::env::current_exe()
        && let Some(parent) = current_exe.parent()
    {
        paths.push(parent.to_path_buf());
    }

    paths
}

fn sbpl_path(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}
