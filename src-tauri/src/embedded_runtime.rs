// ABOUTME: Configures embedded Node.js and Git runtime paths at application startup.
// ABOUTME: Prepends bundled runtime directories to PATH for Seren Desktop's sandboxed environment.

use std::env;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Paths to the embedded runtime binaries
#[derive(Debug, Clone)]
pub struct EmbeddedRuntimePaths {
    pub node_dir: Option<PathBuf>,
    pub git_dir: Option<PathBuf>,
}

/// Gets the path to the embedded runtime directory based on the application location.
/// The embedded runtime is stored in the resources folder of the application.
fn get_embedded_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    // Use Tauri's resource resolver to find the embedded-runtime directory
    let resource_path = app.path().resource_dir().ok()?;
    let runtime_dir = resource_path.join("embedded-runtime");

    if runtime_dir.exists() {
        Some(runtime_dir)
    } else {
        // In development mode, check if there's a .build directory
        if cfg!(debug_assertions) {
            // Try to find it relative to the source directory
            let dev_runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.join(".build").join("embedded-runtime"))?;

            // Detect current platform/arch
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

            let platform_runtime = dev_runtime.join(format!("{}-{}", platform, arch));
            if platform_runtime.exists() {
                return Some(platform_runtime);
            }
        }
        None
    }
}

/// Discovers the paths to embedded Node.js and Git installations.
pub fn discover_embedded_runtime(app: &AppHandle) -> EmbeddedRuntimePaths {
    let runtime_dir = match get_embedded_runtime_dir(app) {
        Some(dir) => dir,
        None => {
            return EmbeddedRuntimePaths {
                node_dir: None,
                git_dir: None,
            }
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

    EmbeddedRuntimePaths { node_dir, git_dir }
}

/// Configures the process environment to use embedded runtime.
/// Prepends embedded Node.js and Git paths to PATH, ensuring bundled versions
/// take precedence over system-installed versions.
pub fn configure_embedded_runtime(app: &AppHandle) -> EmbeddedRuntimePaths {
    let paths = discover_embedded_runtime(app);
    let mut paths_to_add: Vec<String> = Vec::new();

    if let Some(ref node_dir) = paths.node_dir {
        paths_to_add.push(node_dir.to_string_lossy().to_string());
    }
    if let Some(ref git_dir) = paths.git_dir {
        paths_to_add.push(git_dir.to_string_lossy().to_string());
    }

    if !paths_to_add.is_empty() {
        #[cfg(target_os = "windows")]
        let path_separator = ";";
        #[cfg(not(target_os = "windows"))]
        let path_separator = ":";

        let current_path = env::var("PATH").unwrap_or_default();
        let new_path = format!("{}{}{}", paths_to_add.join(path_separator), path_separator, current_path);

        env::set_var("PATH", &new_path);

        // On Windows, also set Path for compatibility
        #[cfg(target_os = "windows")]
        env::set_var("Path", &new_path);

        // Log for debugging if SEREN_DEBUG_RUNTIME is set
        if env::var("SEREN_DEBUG_RUNTIME").is_ok() {
            println!("[EmbeddedRuntime] Configured paths: {:?}", paths_to_add);
        }
    }

    paths
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
