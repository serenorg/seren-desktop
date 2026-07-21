// ABOUTME: Configures Claude Code environment on app startup.
// ABOUTME: Adds cargo to PATH in ~/.claude/settings.json if not already configured.

use log::info;
use std::fs;
use std::path::Path;

/// Build the PATH written into `~/.claude/settings.json`.
///
/// Claude Code's `env.PATH` **replaces** PATH for everything it spawns, so
/// whatever is missing here is missing for every MCP server and hook it
/// launches. The bundled runtime's node directory therefore has to lead the
/// list — on a machine with no system node (the case the bundled runtime
/// exists for) the system entries alone resolve nothing (#3148).
fn claude_code_path(node_dir: Option<&Path>, cargo_bin: &Path) -> String {
    let mut entries: Vec<String> = Vec::new();
    if let Some(node_dir) = node_dir {
        entries.push(node_dir.to_string_lossy().to_string());
    }
    entries.push(cargo_bin.to_string_lossy().to_string());
    // Windows separates PATH with `;` and has no /usr/bin. Joining with `:`
    // there also splits every entry at its drive letter, so the settings file
    // Claude Code reads becomes unparseable and the whole PATH is lost.
    if cfg!(target_os = "windows") {
        entries.join(";")
    } else {
        entries.extend([
            "/usr/local/bin".to_string(),
            "/usr/bin".to_string(),
            "/bin".to_string(),
        ]);
        entries.join(":")
    }
}

/// Configure Claude Code environment if both cargo and Claude Code are installed.
/// Adds the embedded runtime's node directory and cargo to PATH in
/// ~/.claude/settings.json.
pub fn configure_claude_code_environment(node_dir: Option<&Path>) {
    // Get home directory
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            info!("[Claude Setup] Could not determine home directory");
            return;
        }
    };

    let cargo_bin = home.join(".cargo").join("bin");
    let claude_dir = home.join(".claude");
    let claude_settings = claude_dir.join("settings.json");

    // Skip if cargo not installed
    if !cargo_bin.exists() {
        info!("[Claude Setup] Cargo not installed, skipping");
        return;
    }

    // Skip if Claude Code not installed
    if !claude_dir.exists() {
        info!("[Claude Setup] Claude Code not installed, skipping");
        return;
    }

    // Check if already configured
    if claude_settings.exists() {
        if let Ok(content) = fs::read_to_string(&claude_settings) {
            if content.contains(".cargo/bin") {
                info!("[Claude Setup] Cargo already in Claude Code PATH");
                return;
            }
        }
    }

    // Configure Claude Code
    let claude_path = claude_code_path(node_dir, &cargo_bin);

    if !claude_settings.exists() {
        // Create new settings file
        let settings = format!(
            r#"{{
  "env": {{
    "PATH": "{}"
  }}
}}"#,
            claude_path
        );

        if let Err(e) = fs::write(&claude_settings, settings) {
            info!("[Claude Setup] Failed to create settings: {}", e);
            return;
        }

        info!("[Claude Setup] Created Claude Code settings with cargo in PATH");
    } else {
        // Update existing settings - backup first
        let backup_path = claude_dir.join("settings.json.backup");
        if let Err(e) = fs::copy(&claude_settings, &backup_path) {
            info!("[Claude Setup] Failed to backup settings: {}", e);
            return;
        }

        // Read and modify
        let content = match fs::read_to_string(&claude_settings) {
            Ok(c) => c,
            Err(e) => {
                info!("[Claude Setup] Failed to read settings: {}", e);
                return;
            }
        };

        // Check if already has env section
        if content.contains("\"env\"") {
            info!("[Claude Setup] Settings already has env section, manual config needed");
            return;
        }

        // Insert env section after opening brace
        let new_content = content.replacen(
            "{",
            &format!(
                r#"{{
  "env": {{
    "PATH": "{}"
  }},"#,
                claude_path
            ),
            1,
        );

        if let Err(e) = fs::write(&claude_settings, new_content) {
            info!("[Claude Setup] Failed to update settings: {}", e);
            return;
        }

        info!("[Claude Setup] Updated Claude Code settings with cargo in PATH");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Regression guard for #3148.
    ///
    /// Claude Code replaces (not extends) PATH for its children from this
    /// value, so a settings file that lists only the system bin directories
    /// leaves node-based MCP servers and hooks unable to find node on a
    /// machine that has no system node — the exact machine the bundled
    /// runtime is shipped for.
    #[test]
    fn claude_code_path_leads_with_the_embedded_node_dir() {
        let node_dir = PathBuf::from("/Apps/Seren.app/Contents/Resources/embedded-runtime/node/bin");
        let cargo_bin = PathBuf::from("/Users/dev/.cargo/bin");

        let path = claude_code_path(Some(&node_dir), &cargo_bin);
        let entries: Vec<&str> = path.split(path_separator()).collect();

        assert_eq!(
            entries.first().copied(),
            Some(node_dir.to_string_lossy().as_ref()),
            "embedded node dir must lead the Claude Code PATH, got: {path}"
        );
        assert!(entries.contains(&cargo_bin.to_string_lossy().as_ref()));
        if !cfg!(target_os = "windows") {
            for system_bin in ["/usr/local/bin", "/usr/bin", "/bin"] {
                assert!(
                    entries.contains(&system_bin),
                    "expected {system_bin} in Claude Code PATH, got: {path}"
                );
            }
        }
    }

    fn path_separator() -> char {
        if cfg!(target_os = "windows") { ';' } else { ':' }
    }

    /// Claude Code replaces PATH with whatever this writes, so a Windows
    /// separator mistake costs the user every entry — `C:\...` splits at the
    /// drive letter, and /usr/bin does not exist there to fall back on.
    #[test]
    fn claude_code_path_uses_the_platform_separator() {
        let node_dir = PathBuf::from("/Apps/embedded-runtime/node/bin");
        let cargo_bin = PathBuf::from("/Users/dev/.cargo/bin");
        let path = claude_code_path(Some(&node_dir), &cargo_bin);

        if cfg!(target_os = "windows") {
            assert!(
                !path.contains(':') || !path.contains("/usr/bin"),
                "Windows must not inherit the Unix separator or /usr paths, got: {path}"
            );
            assert!(path.contains(';'), "expected ';' on Windows, got: {path}");
        } else {
            assert!(path.contains(':'), "expected ':' on Unix, got: {path}");
            assert!(path.ends_with("/bin"), "unexpected tail: {path}");
        }
    }

    /// Discovery can legitimately come back empty (runtime not staged in a
    /// dev checkout). The written PATH must stay valid rather than gain an
    /// empty entry, which resolves to the current directory.
    #[test]
    fn claude_code_path_omits_missing_node_dir() {
        let cargo_bin = PathBuf::from("/Users/dev/.cargo/bin");

        let path = claude_code_path(None, &cargo_bin);

        assert_eq!(path, "/Users/dev/.cargo/bin:/usr/local/bin:/usr/bin:/bin");
    }
}
