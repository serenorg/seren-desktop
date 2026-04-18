// ABOUTME: File system operations for the editor.
// ABOUTME: Provides commands for reading, writing, and listing files/directories.

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::path_util::expand_tilde;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

/// Read the contents of a file.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let resolved = expand_tilde(&path)?;

    // Check if path is a directory before attempting to read
    if resolved.is_dir() {
        return Err(format!(
            "Cannot read directory '{}'. Directories cannot be read as files. Use the list_directory tool instead to see the contents of this directory.",
            path
        ));
    }

    fs::read_to_string(&resolved).map_err(|e| format!("Failed to read file: {}", e))
}

/// Read a file and return its contents as base64.
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let resolved = expand_tilde(&path)?;

    if resolved.is_dir() {
        return Err(format!(
            "Cannot read directory '{}'. Directories cannot be read as files. Use the list_directory tool instead.",
            path
        ));
    }

    let bytes = fs::read(&resolved).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(STANDARD.encode(&bytes))
}

/// Write content to a file.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = expand_tilde(&path)?;
    reject_literal_tilde_segment(&resolved)?;
    fs::write(&resolved, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// List entries in a directory.
#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let resolved = expand_tilde(&path)?;

    if !resolved.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = fs::read_dir(&resolved)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            Some(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_directory: path.is_dir(),
            })
        })
        .collect();

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Check if a path exists.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    expand_tilde(&path).map(|p| p.exists()).unwrap_or(false)
}

/// Check if a path is a directory.
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    expand_tilde(&path).map(|p| p.is_dir()).unwrap_or(false)
}

/// Create a new file with optional content.
#[tauri::command]
pub fn create_file(path: String, content: Option<String>) -> Result<(), String> {
    let resolved = expand_tilde(&path)?;
    reject_literal_tilde_segment(&resolved)?;

    // Create parent directories if they don't exist
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    let content = content.unwrap_or_default();
    fs::write(&resolved, content).map_err(|e| format!("Failed to create file: {}", e))
}

/// Create a new directory.
#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    let resolved = expand_tilde(&path)?;
    reject_literal_tilde_segment(&resolved)?;
    fs::create_dir_all(&resolved).map_err(|e| format!("Failed to create directory: {}", e))
}

/// Delete a file or empty directory.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let resolved = expand_tilde(&path)?;

    if resolved.is_dir() {
        fs::remove_dir(&resolved).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&resolved).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

/// Rename/move a file or directory.
#[tauri::command]
pub fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let resolved_old = expand_tilde(&old_path)?;
    let resolved_new = expand_tilde(&new_path)?;
    reject_literal_tilde_segment(&resolved_new)?;
    fs::rename(&resolved_old, &resolved_new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Reveal a file or directory in the system file manager (Finder on macOS).
#[tauri::command]
pub fn reveal_in_file_manager(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let resolved = expand_tilde(&path)?;
    app.opener()
        .reveal_item_in_dir(&resolved)
        .map_err(|e| format!("Failed to reveal in file manager: {}", e))
}

/// Defence-in-depth guard (GH #1584): reject writes whose resolved path
/// still contains a literal `~` segment. Before GH #1583 landed, an
/// unexpanded `~/foo` would fall back to `Path::new("~/foo")` and resolve
/// relative to the dev-command cwd (`src-tauri/`), producing a
/// `src-tauri/~/...` tree that tripped Tauri dev's file watcher mid-task.
/// Even with tilde expansion in place, this catches any future regression
/// before it can silently restart the dev process during a user task.
///
/// Only active in debug/dev builds: in production the resolved path cannot
/// land inside a Rust source tree on the user's machine, and this guard
/// would be a false positive on any legitimate file that happens to contain
/// a `~` component in its path.
#[cfg(debug_assertions)]
fn reject_literal_tilde_segment(path: &Path) -> Result<(), String> {
    if path.components().any(|c| c.as_os_str() == "~") {
        return Err(format!(
            "Refusing write to '{}': path contains a literal '~' segment. \
             This means tilde expansion was skipped upstream. Use an absolute \
             path or a path starting with '~/' (which will be expanded to your \
             home directory).",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn reject_literal_tilde_segment(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// End-to-end guarantee (GH #1583): `write_file("~/…")` must land under
    /// `$HOME/…`, NOT under `<cwd>/~/…`. This is the exact failure mode that
    /// hit the Ishan invoice prompt.
    #[test]
    fn write_file_expands_tilde_to_home() {
        let home = dirs::home_dir().expect("home dir required for test");
        let unique = format!(".serendesktop-test-{}", Uuid::new_v4());
        let dir_rel = format!("~/{}", unique);
        let file_rel = format!("~/{}/hello.txt", unique);

        create_directory(dir_rel.clone()).expect("create_directory");
        write_file(file_rel.clone(), "hi".to_string()).expect("write_file");

        let expected = home.join(&unique).join("hello.txt");
        assert!(
            expected.exists(),
            "file should exist at {}",
            expected.display()
        );
        assert_eq!(std::fs::read_to_string(&expected).unwrap(), "hi");

        // Must NOT have leaked into <cwd>/~/<unique>/hello.txt (the old bug).
        let cwd = std::env::current_dir().expect("cwd");
        let broken = cwd.join("~").join(&unique).join("hello.txt");
        assert!(
            !broken.exists(),
            "file leaked into cwd/~/ at {}",
            broken.display()
        );

        let _ = std::fs::remove_dir_all(home.join(&unique));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn reject_literal_tilde_segment_catches_unexpanded_paths() {
        // In debug builds, any unexpanded `~` segment in the resolved path
        // must be rejected before IO (GH #1584 defence-in-depth).
        let sneaky = Path::new("~").join("Downloads").join("bar.txt");
        assert!(reject_literal_tilde_segment(&sneaky).is_err());

        // Normal absolute paths pass through fine.
        assert!(reject_literal_tilde_segment(Path::new("/tmp/fine.txt")).is_ok());

        // Tilde embedded inside a filename (no standalone `~` component) is fine.
        assert!(reject_literal_tilde_segment(Path::new("/tmp/~foo.txt")).is_ok());
    }
}
