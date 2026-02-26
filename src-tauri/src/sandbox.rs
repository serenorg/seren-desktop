// ABOUTME: macOS seatbelt sandbox profile generation and command wrapping.
// ABOUTME: Enforces filesystem and network restrictions via sandbox-exec.

use std::path::{Path, PathBuf};

/// Security tier controlling what the agent can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    /// Read workspace files only. No writes, no commands, no network.
    ReadOnly,
    /// Read anywhere, write to workspace + temp dirs, network allowed, secrets blocked.
    WorkspaceWrite,
    /// No restrictions. Sandbox is not applied.
    FullAccess,
}

impl Default for SandboxMode {
    fn default() -> Self {
        Self::WorkspaceWrite
    }
}

impl std::str::FromStr for SandboxMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "read-only" => Ok(Self::ReadOnly),
            "workspace-write" => Ok(Self::WorkspaceWrite),
            "full-access" => Ok(Self::FullAccess),
            _ => Err(format!("Unknown sandbox mode: {}", s)),
        }
    }
}

/// Configuration for the sandbox applied to a terminal process.
pub struct SandboxConfig {
    pub mode: SandboxMode,
    pub writable_paths: Vec<PathBuf>,
    pub sensitive_read_paths: Vec<PathBuf>,
    pub network_allowed: bool,
    /// Paths where Unix domain socket connections are allowed even when
    /// network access is otherwise denied (e.g. ~/.gnupg for gpg-agent).
    pub allowed_socket_paths: Vec<PathBuf>,
}

impl SandboxConfig {
    /// Create config from mode and workspace path, using sensible defaults.
    pub fn from_mode(mode: SandboxMode, workspace: &Path) -> Self {
        let home = dirs_home(workspace);

        let writable_paths = match mode {
            SandboxMode::ReadOnly => vec![],
            SandboxMode::WorkspaceWrite | SandboxMode::FullAccess => vec![
                workspace.to_path_buf(),
                PathBuf::from("/tmp"),
                PathBuf::from("/private/tmp"),
                // macOS per-user temp/cache dirs (DARWIN_USER_TEMP_DIR,
                // DARWIN_USER_CACHE_DIR) live under /var/folders.  Without
                // write access here, confstr() fails and git/xcodebuild
                // produce noisy errors.
                PathBuf::from("/private/var/folders"),
                PathBuf::from("/var/folders"),
                // GPG needs write access for lock files (~/.gnupg/.#lk*)
                home.join(".gnupg"),
            ],
        };

        // Block private key material but allow GPG config, public keyring,
        // and agent sockets so git signed commits work in the sandbox.
        let sensitive_read_paths = vec![
            home.join(".ssh"),
            home.join(".gnupg/private-keys-v1.d"),
            home.join(".gnupg/openpgp-revocs.d"),
            home.join(".aws"),
            home.join(".config/gcloud"),
            home.join("Library/Keychains"),
        ];

        // WorkspaceWrite allows network — blocking it prevents git, npm,
        // pip, cargo, and other essential developer tools from working.
        let network_allowed = matches!(mode, SandboxMode::WorkspaceWrite | SandboxMode::FullAccess);

        // Allow gpg-agent Unix socket connections for commit signing
        let allowed_socket_paths = vec![home.join(".gnupg")];

        Self {
            mode,
            writable_paths,
            sensitive_read_paths,
            network_allowed,
            allowed_socket_paths,
        }
    }
}

/// Generate a macOS seatbelt profile string in Scheme/Lisp syntax.
///
/// This is ported from Anthropic's sandbox-runtime TypeScript implementation.
/// The profile is passed to `sandbox-exec -p <profile>` to enforce restrictions.
pub fn generate_seatbelt_profile(config: &SandboxConfig) -> String {
    let mut lines = Vec::new();

    lines.push("(version 1)".to_string());
    lines.push("(deny default)".to_string());
    lines.push(String::new());

    // Process execution (required for the command to run at all)
    lines.push(";; Process execution".to_string());
    lines.push("(allow process-exec)".to_string());
    lines.push("(allow process-fork)".to_string());
    lines.push(String::new());

    // System access (required for basic process operation)
    lines.push(";; System access".to_string());
    lines.push("(allow sysctl-read)".to_string());
    lines.push("(allow mach-lookup)".to_string());
    lines.push("(allow mach-register)".to_string());
    lines.push("(allow signal (target self))".to_string());
    lines.push("(allow iokit-open)".to_string());
    lines.push(String::new());

    // DNS and system service access (required for DNS resolution via mDNSResponder).
    // macOS resolves DNS through XPC/Mach IPC to mDNSResponder, which needs
    // system-socket for resolver socket creation, POSIX shared memory for the
    // resolver cache, and user-preference-read for network/proxy configuration.
    lines.push(";; DNS and system service access".to_string());
    lines.push("(allow system-socket)".to_string());
    lines.push("(allow ipc-posix-shm*)".to_string());
    lines.push("(allow user-preference-read)".to_string());
    lines.push(String::new());

    // Pseudo-terminal access (required for terminal emulation)
    lines.push(";; Pseudo-terminal access".to_string());
    lines.push("(allow file-read* file-write* file-ioctl (regex #\"^/dev/pty\"))".to_string());
    lines.push("(allow file-read* file-write* file-ioctl (regex #\"^/dev/tty\"))".to_string());
    lines.push("(allow file-read* (literal \"/dev/urandom\"))".to_string());
    lines.push("(allow file-read* (literal \"/dev/null\"))".to_string());
    lines.push("(allow file-write* (literal \"/dev/null\"))".to_string());
    lines.push(String::new());

    // File read access
    lines.push(";; File read access".to_string());
    lines.push("(allow file-read*)".to_string());
    for path in &config.sensitive_read_paths {
        if path.exists() {
            lines.push(format!(
                "(deny file-read* (subpath \"{}\"))",
                escape_seatbelt_path(path)
            ));
        }
    }
    lines.push(String::new());

    // File write access
    lines.push(";; File write access".to_string());
    if config.mode == SandboxMode::ReadOnly {
        lines.push("(deny file-write*)".to_string());
    } else {
        lines.push("(deny file-write*)".to_string());
        for path in &config.writable_paths {
            lines.push(format!(
                "(allow file-write* (subpath \"{}\"))",
                escape_seatbelt_path(path)
            ));
        }
    }
    lines.push(String::new());

    // Network access
    lines.push(";; Network access".to_string());
    if config.network_allowed {
        lines.push("(allow network*)".to_string());
    } else {
        lines.push("(deny network*)".to_string());
        // Allow Unix domain socket connections to specific paths (e.g. gpg-agent)
        for path in &config.allowed_socket_paths {
            lines.push(format!(
                "(allow network-outbound (remote unix-socket (subpath \"{}\")))",
                escape_seatbelt_path(path)
            ));
        }
    }

    lines.join("\n")
}

/// Wrap a command with `sandbox-exec` on macOS.
///
/// Returns `(command, args)`. On non-macOS platforms or FullAccess mode,
/// returns the original command and args unchanged.
pub fn wrap_command(
    command: &str,
    args: &[String],
    config: &SandboxConfig,
) -> (String, Vec<String>) {
    if config.mode == SandboxMode::FullAccess {
        return (command.to_string(), args.to_vec());
    }

    #[cfg(target_os = "macos")]
    {
        let profile = generate_seatbelt_profile(config);

        // Build the inner command string: "command arg1 arg2 ..."
        let inner_command = if args.is_empty() {
            shell_escape(command)
        } else {
            let escaped_args: Vec<String> = args.iter().map(|a| shell_escape(a)).collect();
            format!("{} {}", shell_escape(command), escaped_args.join(" "))
        };

        let sandbox_args = vec![
            "-p".to_string(),
            profile,
            "/bin/sh".to_string(),
            "-c".to_string(),
            inner_command,
        ];

        ("sandbox-exec".to_string(), sandbox_args)
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Linux bubblewrap support is Phase 3.
        // For now, run unsandboxed on non-macOS platforms.
        (command.to_string(), args.to_vec())
    }
}

/// Escape a path for use in seatbelt profile strings.
fn escape_seatbelt_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// Escape a string for safe use in a POSIX shell command.
fn shell_escape(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    // If the string contains only safe characters, return as-is
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '=' | ':' | ','))
    {
        return s.to_string();
    }
    // Otherwise, wrap in single quotes and escape any single quotes within
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Get the user's home directory, falling back to workspace parent.
fn dirs_home(fallback: &Path) -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| fallback.parent().unwrap_or(fallback).to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_only_profile_denies_writes() {
        let config = SandboxConfig::from_mode(SandboxMode::ReadOnly, Path::new("/workspace"));
        let profile = generate_seatbelt_profile(&config);

        assert!(profile.contains("(deny file-write*)"));
        // Read-only should NOT allow writes to any subpath
        assert!(!profile.contains("(allow file-write* (subpath"));
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn test_workspace_write_allows_workspace() {
        let config = SandboxConfig::from_mode(SandboxMode::WorkspaceWrite, Path::new("/workspace"));
        let profile = generate_seatbelt_profile(&config);

        assert!(profile.contains("(allow file-write* (subpath \"/workspace\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/tmp\"))"));
        assert!(
            profile.contains("(allow file-write* (subpath \"/var/folders\"))"),
            "workspace-write should allow macOS user temp/cache dirs"
        );
        assert!(
            profile.contains("(allow network*)"),
            "workspace-write should allow network for git/npm/etc."
        );
        assert!(
            profile.contains("(allow system-socket)"),
            "profile should allow system-socket for DNS resolver"
        );
        assert!(
            profile.contains("(allow ipc-posix-shm*)"),
            "profile should allow POSIX shared memory for DNS resolver cache"
        );
        assert!(
            profile.contains("(allow user-preference-read)"),
            "profile should allow reading network/proxy preferences"
        );
    }

    #[test]
    fn test_full_access_not_sandboxed() {
        let (cmd, args) = wrap_command(
            "echo",
            &["hello".to_string()],
            &SandboxConfig {
                mode: SandboxMode::FullAccess,
                writable_paths: vec![],
                sensitive_read_paths: vec![],
                network_allowed: true,
                allowed_socket_paths: vec![],
            },
        );

        assert_eq!(cmd, "echo");
        assert_eq!(args, vec!["hello"]);
    }

    #[test]
    fn test_workspace_write_allows_gpg_agent() {
        // Use explicit paths to avoid dependency on filesystem state in CI.
        // generate_seatbelt_profile skips deny rules when path.exists() is
        // false, so we use /tmp paths that always exist.
        let gnupg = PathBuf::from("/tmp");
        let private_keys_dir = PathBuf::from("/tmp");
        let revocs_dir = PathBuf::from("/tmp");

        let config = SandboxConfig {
            mode: SandboxMode::WorkspaceWrite,
            writable_paths: vec![
                PathBuf::from("/workspace"),
                PathBuf::from("/tmp"),
                gnupg.clone(),
            ],
            sensitive_read_paths: vec![private_keys_dir.clone(), revocs_dir.clone()],
            network_allowed: false,
            allowed_socket_paths: vec![gnupg.clone()],
        };
        let profile = generate_seatbelt_profile(&config);

        // Private key dirs must be denied
        let deny_rule = format!(
            "(deny file-read* (subpath \"{}\"))",
            escape_seatbelt_path(&private_keys_dir)
        );
        assert!(profile.contains(&deny_rule));

        // Write access for lock files
        let gnupg_write = format!(
            "(allow file-write* (subpath \"{}\"))",
            escape_seatbelt_path(&gnupg)
        );
        assert!(profile.contains(&gnupg_write));

        // Unix socket access for gpg-agent
        let socket_allow = format!(
            "(allow network-outbound (remote unix-socket (subpath \"{}\")))",
            escape_seatbelt_path(&gnupg)
        );
        assert!(profile.contains(&socket_allow));

        // Network should be denied overall
        assert!(profile.contains("(deny network*)"));
    }

    #[test]
    fn test_from_mode_excludes_broad_gnupg_deny() {
        // Verify from_mode puts targeted subdirs in sensitive_read_paths,
        // not the broad ~/.gnupg directory.
        let config = SandboxConfig::from_mode(SandboxMode::WorkspaceWrite, Path::new("/workspace"));
        let home = dirs_home(Path::new("/workspace"));

        let has_broad = config
            .sensitive_read_paths
            .iter()
            .any(|p| *p == home.join(".gnupg"));
        assert!(
            !has_broad,
            "sensitive_read_paths should not contain broad ~/.gnupg"
        );

        let has_private = config
            .sensitive_read_paths
            .iter()
            .any(|p| *p == home.join(".gnupg/private-keys-v1.d"));
        assert!(
            has_private,
            "sensitive_read_paths should contain ~/.gnupg/private-keys-v1.d"
        );

        let has_socket = config
            .allowed_socket_paths
            .iter()
            .any(|p| *p == home.join(".gnupg"));
        assert!(has_socket, "allowed_socket_paths should contain ~/.gnupg");
    }

    #[test]
    fn test_shell_escape_safe_string() {
        assert_eq!(shell_escape("hello"), "hello");
        assert_eq!(shell_escape("/usr/bin/ls"), "/usr/bin/ls");
    }

    #[test]
    fn test_shell_escape_special_chars() {
        assert_eq!(shell_escape("hello world"), "'hello world'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn test_shell_escape_empty() {
        assert_eq!(shell_escape(""), "''");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_wrap_command_uses_sandbox_exec() {
        let config = SandboxConfig::from_mode(SandboxMode::WorkspaceWrite, Path::new("/workspace"));
        let (cmd, args) = wrap_command("ls", &["-la".to_string()], &config);

        assert_eq!(cmd, "sandbox-exec");
        assert_eq!(args[0], "-p");
        // args[1] is the profile string
        assert_eq!(args[2], "/bin/sh");
        assert_eq!(args[3], "-c");
        assert!(args[4].contains("ls"));
    }
}
