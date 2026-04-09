// ABOUTME: Configures embedded Node.js and Git runtime paths at application startup.
// ABOUTME: Stores bundled runtime directories for injection into child process environments.

use std::env;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// Global storage for the computed PATH with embedded runtime directories.
/// This is set once during app initialization and read when spawning child processes.
static EMBEDDED_PATH: OnceLock<String> = OnceLock::new();

/// Paths to the embedded runtime binaries
#[derive(Debug, Clone)]
pub struct EmbeddedRuntimePaths {
    pub node_dir: Option<PathBuf>,
    pub git_dir: Option<PathBuf>,
    pub bin_dir: Option<PathBuf>,
}

/// Returns the platform-specific subdirectory name (e.g., "darwin-arm64", "win32-x64").
pub fn platform_subdir() -> String {
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };

    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        log::warn!("[EmbeddedRuntime] Unknown target architecture, falling back to x64");
        "x64"
    };

    format!("{}-{}", platform, arch)
}

/// Gets the path to the embedded runtime directory based on the application location.
/// The embedded runtime is stored in the resources folder of the application.
fn get_embedded_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    let subdir = platform_subdir();

    // Use Tauri's resource resolver to find the embedded-runtime directory
    let resource_path = app.path().resource_dir().ok()?;
    let runtime_dir = resource_path.join("embedded-runtime");

    if runtime_dir.exists() {
        // Check for platform-specific subdirectory first
        let platform_dir = runtime_dir.join(&subdir);
        if platform_dir.exists() {
            return Some(platform_dir);
        }
        // Fall back to flat layout (node/bin directly in embedded-runtime)
        return Some(runtime_dir);
    }

    // In development mode, check src-tauri/embedded-runtime
    if cfg!(debug_assertions) {
        let dev_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("embedded-runtime");
        let platform_runtime = dev_runtime.join(&subdir);
        if platform_runtime.exists() {
            return Some(platform_runtime);
        }
        log::info!(
            "[EmbeddedRuntime] Dev runtime not found at {:?}. \
             Run `pnpm prepare:runtime:{}` to set it up.",
            platform_runtime,
            subdir
        );
    }

    None
}

/// Discovers the paths to embedded Node.js and Git installations.
pub fn discover_embedded_runtime(app: &AppHandle) -> EmbeddedRuntimePaths {
    let runtime_dir = match get_embedded_runtime_dir(app) {
        Some(dir) => dir,
        None => {
            let subdir = platform_subdir();
            if cfg!(debug_assertions) {
                log::warn!(
                    "[EmbeddedRuntime] Embedded runtime missing for {}. \
                     Node.js and Git will not be available to child processes. \
                     Fix: run `pnpm prepare:runtime:{}`.",
                    subdir,
                    subdir
                );
            } else {
                log::warn!(
                    "[EmbeddedRuntime] No runtime directory found for {}. \
                     Child processes may fail to locate node/git.",
                    subdir
                );
            }
            return EmbeddedRuntimePaths {
                node_dir: None,
                git_dir: None,
                bin_dir: None,
            };
        }
    };

    let mut node_dir: Option<PathBuf> = None;
    let mut git_dir: Option<PathBuf> = None;

    #[cfg(target_os = "windows")]
    {
        // Windows: runtime/node/ and runtime/git/bin/
        let node_path = runtime_dir.join("node");
        let git_path = runtime_dir.join("git");

        if node_path.exists() {
            node_dir = Some(node_path);
        }
        if git_path.exists() {
            // Git for Windows has bin folder with executables
            let git_bin = git_path.join("bin");
            if git_bin.exists() {
                git_dir = Some(git_bin);
            } else {
                git_dir = Some(git_path);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS: runtime/node/bin/ and runtime/git/bin/
        let node_bin_path = runtime_dir.join("node").join("bin");
        let git_bin_path = runtime_dir.join("git").join("bin");

        if node_bin_path.exists() {
            node_dir = Some(node_bin_path);
        }
        if git_bin_path.exists() {
            git_dir = Some(git_bin_path);
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: runtime/node/bin/ and runtime/git/bin/
        let node_bin_path = runtime_dir.join("node").join("bin");
        let git_bin_path = runtime_dir.join("git").join("bin");

        if node_bin_path.exists() {
            node_dir = Some(node_bin_path);
        }
        if git_bin_path.exists() {
            git_dir = Some(git_bin_path);
        }
    }

    // Check for bundled helper binaries in bin/ directory (all platforms).
    let bin_dir = runtime_dir.join("bin");
    let bin_dir = if bin_dir.exists() {
        Some(bin_dir)
    } else {
        None
    };

    EmbeddedRuntimePaths {
        node_dir,
        git_dir,
        bin_dir,
    }
}

/// Configures the embedded runtime paths.
/// Computes and stores the PATH with embedded runtime directories prepended.
/// The computed PATH can be retrieved via `get_embedded_path()` for use when spawning processes.
pub fn configure_embedded_runtime(app: &AppHandle) -> EmbeddedRuntimePaths {
    let paths = discover_embedded_runtime(app);
    let mut paths_to_add: Vec<String> = Vec::new();

    if let Some(ref node_dir) = paths.node_dir {
        paths_to_add.push(node_dir.to_string_lossy().to_string());
    }
    if let Some(ref git_dir) = paths.git_dir {
        paths_to_add.push(git_dir.to_string_lossy().to_string());
    }
    if let Some(ref bin_dir) = paths.bin_dir {
        paths_to_add.push(bin_dir.to_string_lossy().to_string());
    }

    // Compute the new PATH but store it instead of modifying global env
    #[cfg(target_os = "windows")]
    let path_separator = ";";
    #[cfg(not(target_os = "windows"))]
    let path_separator = ":";

    // In GUI app contexts (especially macOS), the process PATH can be missing common tool locations
    // like Homebrew (/opt/homebrew/bin) or /usr/local/bin. Ensure those are present so spawned
    // helper processes can find installed CLIs (e.g., `codex`).
    let current_path = env::var("PATH").unwrap_or_default();
    let current_path = extend_path_with_common_bins(&current_path, path_separator);
    let new_path = if paths_to_add.is_empty() {
        current_path
    } else {
        format!(
            "{}{}{}",
            paths_to_add.join(path_separator),
            path_separator,
            current_path
        )
    };

    // Store the computed PATH for later use
    let _ = EMBEDDED_PATH.set(new_path.clone());

    log::info!("[EmbeddedRuntime] Configured paths: {:?}", paths_to_add);
    log::debug!("[EmbeddedRuntime] Full PATH: {}", new_path);

    paths
}

fn extend_path_with_common_bins(current_path: &str, path_separator: &str) -> String {
    let mut entries: Vec<String> = current_path
        .split(path_separator)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect();

    // Keep the user's order, but append missing common locations.
    // GUI apps don't source shell profiles so CLI install directories
    // (e.g., ~/.claude/bin, %APPDATA%\npm) are typically missing from PATH.
    {
        use std::collections::HashSet;

        let mut seen: HashSet<String> = entries.iter().cloned().collect();
        let mut common_bins: Vec<String> = Vec::new();

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let home = std::env::var("HOME").unwrap_or_default();
            if !home.is_empty() {
                common_bins.push(format!("{}/.claude/bin", home));
                common_bins.push(format!("{}/.local/bin", home));
            }
        }

        #[cfg(target_os = "macos")]
        {
            common_bins.extend([
                "/usr/local/bin".to_string(),
                "/opt/homebrew/bin".to_string(),
                "/usr/bin".to_string(),
                "/bin".to_string(),
                "/usr/sbin".to_string(),
                "/sbin".to_string(),
            ]);
        }

        #[cfg(target_os = "linux")]
        {
            common_bins.extend([
                "/usr/local/bin".to_string(),
                "/usr/bin".to_string(),
                "/bin".to_string(),
                "/usr/sbin".to_string(),
                "/sbin".to_string(),
            ]);
        }

        #[cfg(target_os = "windows")]
        {
            // Claude Code native installer (install.ps1) puts binary here
            let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
            if !userprofile.is_empty() {
                common_bins.push(format!("{}\\.claude\\bin", userprofile));
            }
            // npm global installs land here
            let appdata = std::env::var("APPDATA").unwrap_or_default();
            if !appdata.is_empty() {
                common_bins.push(format!("{}\\npm", appdata));
            }
        }

        for bin in common_bins {
            if !seen.contains(&bin) {
                seen.insert(bin.clone());
                entries.push(bin);
            }
        }
    }

    entries.join(path_separator)
}

/// Returns the PATH value with embedded runtime directories prepended.
/// Use this when spawning child processes that need access to embedded node/git.
///
/// # Example
/// ```ignore
/// use std::process::Command;
/// let mut cmd = Command::new("node");
/// cmd.env("PATH", embedded_runtime::get_embedded_path());
/// ```
pub fn get_embedded_path() -> &'static str {
    EMBEDDED_PATH.get().map(|s| s.as_str()).unwrap_or("")
}

/// Environment variables injected by Electron-based parent processes
/// (VSCode, Cursor, ToDesktop-wrapped apps, the Claude Code extension) that
/// leak into every subprocess spawned from their integrated terminals.
///
/// Two classes of variables are stripped here:
///
/// 1. **Node.js / Electron runtime hijacks** (`ELECTRON_RUN_AS_NODE`,
///    `VSCODE_ESM_ENTRYPOINT`, and the surrounding `VSCODE_*` family): when
///    these leak into an embedded Node.js subprocess, Node tries to
///    bootstrap as a VSCode extension host and hangs in ESM module
///    resolution looking for `vs/workbench/api/node/extensionHostProcess`,
///    which only exists inside the VSCode app bundle — not in our
///    embedded-runtime tree. Documented in serenorg/seren-desktop#1516 /
///    fixed in #1518.
///
/// 2. **CoreFoundation bundle-identity hijacks** (`__CFBundleIdentifier`,
///    `__CF_USER_TEXT_ENCODING`): ToDesktop / Electron / Cursor inject
///    these to tell macOS CoreFoundation which app bundle the process is
///    part of. When a CoreFoundation-linked binary inherits them, CF tries
///    to resolve the parent's bundle via LaunchServices from inside a
///    foreign subprocess context. That lookup hangs or pulls in unrelated
///    framework state (Metal, RenderBox) *before* our provider runtime's
///    `server.listen()` is ever reached. The embedded Node.js binary
///    statically links `CoreFoundation.framework`, so it's directly
///    affected. Documented in serenorg/seren-desktop#1521.
///
/// Strip them from every `Command` that spawns the embedded node binary or
/// a node-based child (provider runtime, local MCP servers, etc.) BEFORE
/// calling `.spawn()`. This is a no-op outside of Electron-host terminals
/// and fixes the "Timed out waiting for provider runtime readiness" loop
/// documented in #1516.
const POLLUTING_PARENT_ENV_VARS: &[&str] = &[
    // The two Node.js / Electron vars that actually trigger the ESM
    // bootstrap hijack — Node interprets ELECTRON_RUN_AS_NODE +
    // VSCODE_ESM_ENTRYPOINT as "boot as an extension host" and tries to
    // load a nonexistent entry point.
    "ELECTRON_RUN_AS_NODE",
    "VSCODE_ESM_ENTRYPOINT",
    // The two CoreFoundation-private vars that trigger the bundle-lookup
    // hang on macOS (#1521). `__CFBundleIdentifier` is the load-bearing
    // one; `__CF_USER_TEXT_ENCODING` is stripped together because it's
    // set by the same parent and has no reason to be inherited by an
    // embedded subprocess.
    "__CFBundleIdentifier",
    "__CF_USER_TEXT_ENCODING",
    // Additional VSCode/Cursor vars that are noise at best and may
    // confuse downstream tooling — stripping them is cheap and keeps
    // the embedded node env clean.
    "VSCODE_NLS_CONFIG",
    "VSCODE_PID",
    "VSCODE_IPC_HOOK",
    "VSCODE_CODE_CACHE_PATH",
    "VSCODE_CWD",
    "VSCODE_CRASH_REPORTER_PROCESS_TYPE",
    "VSCODE_HANDLES_UNCAUGHT_ERRORS",
    "VSCODE_L10N_BUNDLE_LOCATION",
    "VSCODE_PROCESS_TITLE",
];

/// Trait implemented for both `std::process::Command` and
/// `tokio::process::Command` so `sanitize_spawn_env` can work with either
/// spawn flavor used across the codebase.
pub trait CommandEnvSanitize {
    fn env_remove_str(&mut self, key: &str) -> &mut Self;
}

impl CommandEnvSanitize for std::process::Command {
    fn env_remove_str(&mut self, key: &str) -> &mut Self {
        self.env_remove(key);
        self
    }
}

impl CommandEnvSanitize for tokio::process::Command {
    fn env_remove_str(&mut self, key: &str) -> &mut Self {
        self.env_remove(key);
        self
    }
}

/// Remove environment variables injected by Electron-based parent processes
/// (VSCode, Cursor, ToDesktop, Claude Code extension) from a `Command` before
/// spawning. Call this on every spawn of the embedded Node.js binary (and any
/// other subprocess that might load it transitively).
///
/// See [`POLLUTING_PARENT_ENV_VARS`] and serenorg/seren-desktop#1516 / #1521
/// for the full motivation. Safe to call from any context — it's a pure
/// env-scrub and does nothing when the variables aren't present.
pub fn sanitize_spawn_env<C: CommandEnvSanitize>(command: &mut C) -> &mut C {
    for var in POLLUTING_PARENT_ENV_VARS {
        command.env_remove_str(var);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Critical test for serenorg/seren-desktop#1516 and #1521.
    ///
    /// Verifies that `sanitize_spawn_env` actually removes the load-bearing
    /// variables that cause the embedded Node.js subprocess hang when
    /// spawned from a VSCode / Cursor / ToDesktop extension host process
    /// tree. Without this test, a future refactor that accidentally drops
    /// any of the `env_remove` calls would re-introduce the "no chat
    /// window" regression without any unit-level signal.
    ///
    /// Four load-bearing variables in total:
    ///   - `ELECTRON_RUN_AS_NODE` + `VSCODE_ESM_ENTRYPOINT` → Node tries to
    ///     boot as a VSCode extension host and hangs in ESM resolution
    ///     (#1516 / #1518).
    ///   - `__CFBundleIdentifier` + `__CF_USER_TEXT_ENCODING` →
    ///     CoreFoundation tries to resolve the parent's bundle identity
    ///     via LaunchServices from inside the subprocess and hangs before
    ///     `server.listen()` (#1521).
    ///
    /// We assert via `get_envs()` inspection because `tokio::process::Command`
    /// stores env overrides as explicit (key, None) entries when removed,
    /// which is exactly the shape we need to verify the scrub happened.
    #[test]
    fn sanitize_spawn_env_removes_extension_host_and_corefoundation_vars() {
        let mut cmd = tokio::process::Command::new("/bin/true");

        sanitize_spawn_env(&mut cmd);

        // Collect every (key, value) override that was applied to the
        // Command. A removed env var appears as (key, None).
        let overrides: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().to_string(),
                    v.map(|v| v.to_string_lossy().to_string()),
                )
            })
            .collect();

        // All four load-bearing variables MUST be explicitly removed.
        // If any is missing from the override list (or present with a
        // non-None value), the embedded node subprocess will inherit the
        // parent's Electron-host env and hang during init.
        let critical_vars = [
            "ELECTRON_RUN_AS_NODE",
            "VSCODE_ESM_ENTRYPOINT",
            "__CFBundleIdentifier",
            "__CF_USER_TEXT_ENCODING",
        ];
        for var in critical_vars {
            let entry = overrides
                .iter()
                .find(|(k, _)| k == var)
                .unwrap_or_else(|| {
                    panic!(
                        "sanitize_spawn_env must env_remove \"{var}\" — without this the \
                         provider runtime node subprocess hangs when spawned from a \
                         VSCode/Cursor/ToDesktop extension host process tree \
                         (serenorg/seren-desktop#1516 / #1521)"
                    )
                });
            assert!(
                entry.1.is_none(),
                "sanitize_spawn_env must REMOVE \"{var}\", not overwrite it; got value={:?}",
                entry.1
            );
        }
    }

    #[test]
    fn sanitize_spawn_env_is_idempotent() {
        // Calling the helper twice should produce the same effect as
        // calling it once — no duplicate removals, no panics. This
        // matters because the fix is applied at multiple spawn sites
        // and helper functions may compose.
        let mut cmd = tokio::process::Command::new("/bin/true");
        sanitize_spawn_env(&mut cmd);
        sanitize_spawn_env(&mut cmd);

        let removed_count = cmd
            .as_std()
            .get_envs()
            .filter(|(k, v)| {
                v.is_none()
                    && POLLUTING_PARENT_ENV_VARS
                        .iter()
                        .any(|p| *p == k.to_string_lossy())
            })
            .count();
        assert_eq!(
            removed_count,
            POLLUTING_PARENT_ENV_VARS.len(),
            "every POLLUTING_PARENT_ENV_VARS entry must appear exactly once as a removal"
        );
    }
}

/// Tauri command to get embedded runtime information (for debugging/UI)
#[tauri::command]
pub fn get_embedded_runtime_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let paths = discover_embedded_runtime(&app);

    Ok(serde_json::json!({
        "node_dir": paths.node_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
        "git_dir": paths.git_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
        "node_available": paths.node_dir.is_some(),
        "git_available": paths.git_dir.is_some(),
    }))
}
