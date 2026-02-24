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
    }

    None
}

/// Discovers the paths to embedded Node.js and Git installations.
pub fn discover_embedded_runtime(app: &AppHandle) -> EmbeddedRuntimePaths {
    let runtime_dir = match get_embedded_runtime_dir(app) {
        Some(dir) => dir,
        None => {
            log::warn!(
                "[EmbeddedRuntime] No runtime directory found for {}. \
                 Child processes may fail to locate node/git.",
                platform_subdir()
            );
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

    // Check for sidecar binaries in bin/ directory (all platforms)
    // This is where seren-acp-claude, seren-acp-codex, and seren-mcp are located
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
    // sidecars can find installed CLIs (e.g., `codex`).
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::collections::HashSet;

        let mut seen: HashSet<String> = entries.iter().cloned().collect();

        #[cfg(target_os = "macos")]
        let common_bins: [&str; 6] = [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ];

        #[cfg(target_os = "linux")]
        let common_bins: [&str; 5] = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

        for bin in common_bins {
            if !seen.contains(bin) {
                let bin = bin.to_string();
                entries.push(bin.clone());
                seen.insert(bin);
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
