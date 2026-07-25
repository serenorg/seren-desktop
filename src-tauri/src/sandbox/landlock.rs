// ABOUTME: Applies the Linux Landlock policy and provides the hidden app-binary launcher mode.
// ABOUTME: The launcher enforces the policy before exec so every descendant inherits the boundary.

#[cfg(target_os = "linux")]
mod linux {
    use std::env;
    use std::path::{Path, PathBuf};
    use std::process::{self, Command};

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use landlock::{
        ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
        RulesetAttr, RulesetCreated, RulesetCreatedAttr, RulesetStatus,
    };
    use std::os::unix::process::CommandExt;

    use super::super::policy::{SandboxError, SandboxMode, SandboxPolicy};

    const SANDBOX_LAUNCHER_ARGUMENT: &str = "__seren-sandbox-run";
    const BAD_ARGUMENTS_EXIT: i32 = 64;
    const BAD_POLICY_EXIT: i32 = 65;
    const ENFORCEMENT_FAILURE_EXIT: i32 = 69;
    const EXEC_FAILURE_EXIT: i32 = 127;

    pub fn apply_landlock(policy: &SandboxPolicy) -> Result<(), SandboxError> {
        apply_landlock_for_command(policy, None, &[])
    }

    fn apply_landlock_for_command(
        policy: &SandboxPolicy,
        command: Option<&Path>,
        command_args: &[String],
    ) -> Result<(), SandboxError> {
        if policy.mode == SandboxMode::FullAccess {
            return Err(SandboxError::FullAccessNoProfile);
        }

        let mut allowed_paths = system_read_paths();
        allowed_paths.extend(policy.workspace_roots.iter().cloned());
        if let Some(command) = command {
            allowed_paths.extend(command_related_paths(command));
        }
        let argument_file_paths = command_argument_file_paths(command_args);
        allowed_paths.extend(argument_file_paths.iter().cloned());
        validate_deny_read(policy, &allowed_paths)?;

        // Hard-require the first Landlock version — supported on every kernel that has Landlock at
        // all (>= 5.13) — then best-effort every newer right. HardRequirement on the full V7 set
        // would reject any kernel below 6.10 (the ABI that introduces the newest AccessFs right,
        // IoctlDev), i.e. Ubuntu 22.04/24.04 and Debian 12 — the bulk of deployed desktops — which
        // fails the launch closed instead of enforcing what the kernel can. BestEffort silently
        // drops the rights the running kernel lacks while still enforcing everything it supports;
        // FullyEnforced below still rejects a kernel with no Landlock at all.
        let abi = ABI::V7;
        let mut ruleset = Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessFs::from_all(ABI::V1))
            .map_err(|error| SandboxError::Landlock(error.to_string()))?
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(AccessFs::from_all(abi))
            .map_err(|error| SandboxError::Landlock(error.to_string()))?;

        if !policy.network_enabled {
            // No NetPort rules are added, so every handled TCP bind/connect is denied. AccessNet
            // arrives in ABI V4 (kernel 6.7); best-effort so an older kernel drops the network
            // handle rather than failing the whole launch, matching the filesystem handling above.
            //
            // Landlock only governs TCP: UDP (and other L4) is not restrictable, so a
            // network-disabled bounded session on Linux can still send UDP (e.g. DNS-based
            // exfiltration). This is a kernel limitation, unlike macOS Seatbelt's comprehensive
            // `(deny network*)`. Documented so the "network disabled" promise is not overread (#3347).
            ruleset = ruleset
                .set_compatibility(CompatLevel::BestEffort)
                .handle_access(AccessNet::from_all(ABI::V4))
                .map_err(|error| SandboxError::Landlock(error.to_string()))?;
        }

        let mut created = ruleset
            .create()
            .map_err(|error| SandboxError::Landlock(error.to_string()))?;
        let read_access = AccessFs::from_read(abi);
        let write_access = AccessFs::from_all(abi);

        for path in system_read_paths()
            .into_iter()
            .chain(command.map(command_related_paths).into_iter().flatten())
        {
            if path.exists() {
                created = add_path_rule(created, &path, read_access)?;
            }
        }
        for path in argument_file_paths {
            created = add_file_rule(created, &path)?;
        }

        let workspace_access = if policy.mode == SandboxMode::WorkspaceWrite {
            write_access
        } else {
            read_access
        };
        for path in &policy.workspace_roots {
            created = add_path_rule(created, path, workspace_access)?;
        }

        let status = created
            .restrict_self()
            .map_err(|error| SandboxError::Landlock(error.to_string()))?;
        // `PartiallyEnforced` is the expected result on a kernel that supports Landlock but not
        // every V7 access right (e.g. 6.7-6.9 without IoctlDev): the workspace confinement from the
        // hard-required V1 floor is enforced, only the newest rights the kernel never had are
        // dropped. `NotEnforced` means the kernel has no Landlock at all — but the HardRequirement
        // V1 handle above already errors before we reach here on such a kernel, so this rejects it
        // defensively rather than running unconfined.
        if status.ruleset == RulesetStatus::NotEnforced {
            return Err(SandboxError::Landlock(
                "Landlock is unavailable on this kernel; refusing to run unconfined".to_string(),
            ));
        }

        Ok(())
    }

    fn add_path_rule(
        created: RulesetCreated,
        path: &Path,
        access: impl Into<landlock::BitFlags<AccessFs>>,
    ) -> Result<RulesetCreated, SandboxError> {
        let path_fd = PathFd::new(path)
            .map_err(|error| SandboxError::Landlock(format!("cannot open {path:?}: {error}")))?;
        created
            .add_rule(PathBeneath::new(path_fd, access))
            .map_err(|error| SandboxError::Landlock(error.to_string()))
    }

    fn add_file_rule(created: RulesetCreated, path: &Path) -> Result<RulesetCreated, SandboxError> {
        let path_fd = PathFd::new(path)
            .map_err(|error| SandboxError::Landlock(format!("cannot open {path:?}: {error}")))?;
        created
            .add_rule(PathBeneath::new(path_fd, AccessFs::ReadFile))
            .map_err(|error| SandboxError::Landlock(error.to_string()))
    }

    fn system_read_paths() -> Vec<PathBuf> {
        [
            "/bin", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sbin", "/sys", "/usr",
        ]
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .collect()
    }

    fn command_related_paths(command: &Path) -> Vec<PathBuf> {
        if command.is_absolute() || command.components().count() > 1 {
            return command
                .parent()
                .map(Path::to_path_buf)
                .into_iter()
                .collect();
        }

        env::var_os("PATH")
            .into_iter()
            .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
            // Drop empty PATH components (a trailing ':' yields one). An empty
            // path is not a real directory to grant, and it makes
            // validate_deny_read's `starts_with` prefix-match every deny_read
            // path, failing an otherwise-valid launch closed (#3347).
            .filter(|path| !path.as_os_str().is_empty() && path.is_dir())
            .collect()
    }

    fn command_argument_file_paths(args: &[String]) -> Vec<PathBuf> {
        args.windows(2)
            .filter(|window| matches!(window[0].as_str(), "--mcp-config" | "--settings"))
            .map(|window| PathBuf::from(&window[1]))
            .filter(|path| path.is_file())
            .collect()
    }

    fn validate_deny_read(
        policy: &SandboxPolicy,
        allowed_paths: &[PathBuf],
    ) -> Result<(), SandboxError> {
        for denied in &policy.deny_read {
            if allowed_paths
                .iter()
                .any(|allowed| denied.starts_with(allowed) || allowed.starts_with(denied))
            {
                return Err(SandboxError::Landlock(format!(
                    "deny-read path {:?} overlaps an allowed hierarchy",
                    denied
                )));
            }
        }
        Ok(())
    }

    fn decode_policy(encoded: &str) -> Result<SandboxPolicy, SandboxError> {
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|error| SandboxError::PolicyDecode(error.to_string()))?;
        let decoded: SandboxPolicy = serde_json::from_slice(&bytes)
            .map_err(|error| SandboxError::PolicyDecode(error.to_string()))?;
        SandboxPolicy::new(
            decoded.mode,
            decoded.workspace_roots,
            decoded.deny_read,
            decoded.network_enabled,
        )
        .map_err(|error| SandboxError::PolicyDecode(error.to_string()))
    }

    fn exit_with(code: i32, message: impl std::fmt::Display) -> ! {
        eprintln!("Seren sandbox launcher: {message}");
        process::exit(code);
    }

    pub fn sandbox_run_main(args: Vec<String>) -> ! {
        let rest = args.into_iter().skip(1).collect::<Vec<_>>();
        if rest.len() < 4
            || rest[0] != SANDBOX_LAUNCHER_ARGUMENT
            || rest[2] != "--"
            || rest[3].trim().is_empty()
        {
            exit_with(
                BAD_ARGUMENTS_EXIT,
                "usage: __seren-sandbox-run <base64-policy-json> -- <command> [args...]",
            );
        }

        let policy = match decode_policy(&rest[1]) {
            Ok(policy) => policy,
            Err(error) => exit_with(BAD_POLICY_EXIT, error),
        };
        let command = rest[3].clone();
        let command_args = &rest[4..];

        if let Some(workspace_root) = policy.workspace_roots.first()
            && let Err(error) = env::set_current_dir(workspace_root)
        {
            exit_with(ENFORCEMENT_FAILURE_EXIT, error);
        }

        if let Err(error) =
            apply_landlock_for_command(&policy, Some(Path::new(&command)), command_args)
        {
            exit_with(ENFORCEMENT_FAILURE_EXIT, error);
        }

        let error = Command::new(&command).args(command_args).exec();
        exit_with(EXEC_FAILURE_EXIT, error);
    }
}

#[cfg(not(target_os = "linux"))]
mod unsupported {
    use super::super::policy::{SandboxError, SandboxPolicy};

    pub fn apply_landlock(_policy: &SandboxPolicy) -> Result<(), SandboxError> {
        Err(SandboxError::BackendUnavailable)
    }

    pub fn sandbox_run_main(_args: Vec<String>) -> ! {
        eprintln!(
            "Seren sandbox launcher: Linux Landlock backend is unavailable on this platform."
        );
        std::process::exit(78);
    }
}

#[cfg(target_os = "linux")]
pub use linux::{apply_landlock, sandbox_run_main};
#[cfg(not(target_os = "linux"))]
pub use unsupported::{apply_landlock, sandbox_run_main};
