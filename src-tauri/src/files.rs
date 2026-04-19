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
///
/// Post-write, the on-disk state is re-stat'd via `verify_on_disk` so a
/// report of success always reflects bytes the kernel acknowledges
/// (see GH #1595). On Windows an independent `cmd.exe /c if exist` check
/// also runs to defend against any per-process filesystem view that
/// might diverge from what a user's Explorer or external shell sees.
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    let resolved = expand_tilde(&path)?;
    reject_literal_tilde_segment(&resolved)?;
    let expected = content.len() as u64;
    fs::write(&resolved, content).map_err(|e| format!("Failed to write file: {}", e))?;
    verify_on_disk(&resolved, expected)?;
    Ok(())
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
    let expected = content.len() as u64;
    fs::write(&resolved, content).map_err(|e| format!("Failed to create file: {}", e))?;
    verify_on_disk(&resolved, expected)?;
    Ok(())
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

/// Post-write ground-truth check (GH #1595).
///
/// After a file-writing tool call reports success, we must not trust the
/// write layer's own return code — we re-stat the path and, on Windows,
/// ask a fresh `cmd.exe /c if exist` whether the file is visible to a
/// process outside our writer's own view. A mismatch at any stage is
/// surfaced as a loud error so the model reports it to the user instead
/// of pretending the write succeeded.
///
/// This addresses the failure mode documented in GH #1595 where a
/// Windows user with admin access could not find a 38KB file that the
/// tool harness had self-verified as present. If NTFS doesn't see it,
/// neither should we.
fn verify_on_disk(path: &Path, expected_bytes: u64) -> Result<(), String> {
    // 1) Stat the path we just wrote to. If this fails, the write was
    //    fabricated / the fs rejected it silently / the path resolved
    //    somewhere we can no longer reach.
    let meta = fs::metadata(path).map_err(|e| {
        format!(
            "Write to '{}' reported success but post-write stat failed: {}. \
             The file is not readable at the path we wrote to — do not \
             report this write as successful.",
            path.display(),
            e
        )
    })?;

    // 2) Size must match what we handed to `fs::write`. A short write
    //    usually means a cancelled write-back or a sandboxed/overlay FS
    //    that tore down before flushing.
    if meta.len() != expected_bytes {
        return Err(format!(
            "Write to '{}' reported success but on-disk size is {} bytes \
             (expected {} bytes). The kernel did not persist the full \
             payload. Do not report this write as successful.",
            path.display(),
            meta.len(),
            expected_bytes
        ));
    }

    // 3) Windows-only: cross-process check. A user reported in GH #1595
    //    that every in-process check self-confirmed while Explorer and
    //    an external cmd.exe both saw nothing. A fresh cmd.exe process
    //    has a separate NTFS handle table and sees exactly what the user
    //    sees — if this check disagrees with steps 1-2, we must surface
    //    that divergence rather than silently paper over it.
    #[cfg(windows)]
    cross_process_exists_windows(path)?;

    Ok(())
}

/// Spawn a separate `cmd.exe /c if exist ...` and check its output.
///
/// This is independent from the Rust writer's own filesystem view: a
/// fresh cmd.exe inherits nothing from the writer and sees only the
/// real on-disk state. If this process says the file is not present
/// after a successful in-process write, something between the write and
/// the NTFS volume is lying to us (GH #1595).
#[cfg(windows)]
fn cross_process_exists_windows(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command as StdCommand;

    let display = path.display().to_string();
    let mut cmd = StdCommand::new("cmd");
    // /D disables AutoRun, /S strips one pair of outer quotes from /C.
    // CREATE_NO_WINDOW keeps the probe invisible.
    cmd.creation_flags(0x08000000)
        .args([
            "/D",
            "/S",
            "/C",
            // Double-quote the path so spaces and special chars survive.
            &format!("if exist \"{display}\" (echo FOUND) else (echo MISSING)"),
        ]);

    let output = cmd
        .output()
        .map_err(|e| format!("cross-process check for '{display}' failed to spawn cmd.exe: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("FOUND") {
        return Ok(());
    }
    if stdout.contains("MISSING") {
        return Err(format!(
            "Write to '{display}' self-verified in-process but an \
             independent cmd.exe reports the file is MISSING from disk. \
             This matches GH #1595: the tool-execution view has diverged \
             from the real NTFS volume. Do not report this write as \
             successful."
        ));
    }
    Err(format!(
        "Write to '{display}' post-verification is inconclusive: cmd.exe \
         returned unexpected output {:?}.",
        stdout.trim()
    ))
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

    /// GH #1595 critical contract: `verify_on_disk` must refuse to report
    /// success when the file is missing, and must refuse when the on-disk
    /// size disagrees with what the caller claimed to write.
    #[test]
    fn verify_on_disk_rejects_missing_file_and_size_mismatch() {
        let tmp = std::env::temp_dir().join(format!(
            "serendesktop-verify-{}.txt",
            Uuid::new_v4().simple()
        ));

        // Missing file — must error with a message naming the path.
        let err = verify_on_disk(&tmp, 42)
            .expect_err("missing file must not verify as success");
        assert!(
            err.contains("post-write stat failed"),
            "missing file err should mention the stat failure, got: {err}"
        );

        // Real write of 5 bytes — matching expected succeeds.
        std::fs::write(&tmp, b"hello").expect("seed write");
        assert!(
            verify_on_disk(&tmp, 5).is_ok(),
            "matching size must verify Ok"
        );

        // Same file, caller claims 1000 bytes were written. Must error.
        let err = verify_on_disk(&tmp, 1000)
            .expect_err("size mismatch must not verify as success");
        assert!(
            err.contains("on-disk size"),
            "size-mismatch err should mention the disk size, got: {err}"
        );
        assert!(
            err.contains("1000"),
            "size-mismatch err should mention the expected size, got: {err}"
        );

        let _ = std::fs::remove_file(&tmp);
    }

    /// GH #1595 Windows contract: the cross-process `cmd.exe` probe must
    /// agree with the Rust-side stat for a file that genuinely exists on
    /// disk. If this ever diverges on real hardware we've reproduced the
    /// customer's bug and should fail the write loudly. Gated to Windows
    /// since the probe itself is Windows-only.
    #[cfg(windows)]
    #[test]
    fn cross_process_exists_windows_sees_real_file() {
        let tmp = std::env::temp_dir().join(format!(
            "serendesktop-xproc-{}.txt",
            Uuid::new_v4().simple()
        ));
        std::fs::write(&tmp, b"hello").expect("seed write");
        cross_process_exists_windows(&tmp).expect("real file must be visible to cmd.exe");
        let _ = std::fs::remove_file(&tmp);

        // And: missing path must surface the MISSING divergence.
        let missing = std::env::temp_dir().join(format!(
            "serendesktop-xproc-missing-{}.txt",
            Uuid::new_v4().simple()
        ));
        let err = cross_process_exists_windows(&missing)
            .expect_err("missing file must surface MISSING divergence");
        assert!(
            err.contains("MISSING"),
            "Windows xproc err should flag MISSING, got: {err}"
        );
    }
}
