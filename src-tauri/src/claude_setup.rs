// ABOUTME: Configures Claude Code environment on app startup.
// ABOUTME: Adds cargo to PATH in ~/.claude/settings.json if not already configured.

use log::info;
use std::fs;
use std::path::Path;

/// PATH separator Claude Code expects on this platform.
fn path_separator() -> char {
    if cfg!(target_os = "windows") { ';' } else { ':' }
}

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

/// Serialize a settings document, escaping PATH backslashes correctly (#3431).
fn render_settings(settings: &serde_json::Value) -> String {
    serde_json::to_string_pretty(settings).expect("a JSON value always serializes")
}

/// Serialize the settings document for a fresh `~/.claude/settings.json`.
fn initial_settings(claude_path: &str) -> String {
    render_settings(&serde_json::json!({ "env": { "PATH": claude_path } }))
}

/// Outcome of adding env.PATH to an existing settings document.
enum SettingsPatch {
    Updated(String),
    HasEnvSection,
    Invalid,
}

/// Add env.PATH to an existing settings document, keeping every other key.
fn patch_existing_settings(content: &str, claude_path: &str) -> SettingsPatch {
    let Ok(serde_json::Value::Object(mut settings)) =
        serde_json::from_str::<serde_json::Value>(content)
    else {
        return SettingsPatch::Invalid;
    };
    if settings.contains_key("env") {
        return SettingsPatch::HasEnvSection;
    }
    settings.insert(
        "env".to_string(),
        serde_json::json!({ "PATH": claude_path }),
    );
    SettingsPatch::Updated(render_settings(&serde_json::Value::Object(settings)))
}

/// True when env.PATH in `content` already lists `entry` as one of its
/// `separator`-delimited components.
fn env_path_lists_entry(content: &str, entry: &Path, separator: char) -> bool {
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(content) else {
        return false;
    };
    let Some(path) = settings
        .get("env")
        .and_then(|env| env.get("PATH"))
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let entry = entry.to_string_lossy();
    path.split(separator).any(|component| component == entry)
}

/// True when the settings content already routes Claude Code through cargo.
fn cargo_bin_already_configured(content: &str, cargo_bin: &Path) -> bool {
    env_path_lists_entry(content, cargo_bin, path_separator())
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
            if cargo_bin_already_configured(&content, &cargo_bin) {
                info!("[Claude Setup] Cargo already in Claude Code PATH");
                return;
            }
        }
    }

    // Configure Claude Code
    let claude_path = claude_code_path(node_dir, &cargo_bin);

    if !claude_settings.exists() {
        // Create new settings file
        if let Err(e) = fs::write(&claude_settings, initial_settings(&claude_path)) {
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

        match patch_existing_settings(&content, &claude_path) {
            SettingsPatch::Updated(patched) => {
                if let Err(e) = fs::write(&claude_settings, patched) {
                    info!("[Claude Setup] Failed to update settings: {}", e);
                    return;
                }
                info!("[Claude Setup] Updated Claude Code settings with cargo in PATH");
            }
            SettingsPatch::HasEnvSection => {
                info!("[Claude Setup] Settings already has env section, manual config needed");
            }
            SettingsPatch::Invalid => {
                info!("[Claude Setup] Settings file is not valid JSON, manual config needed");
            }
        }
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

    /// A realistic Windows PATH for #3431: `\U`, `\e`, and `\.` are invalid
    /// JSON escapes (a strict parser rejects the whole file), while `\r` and
    /// `\n` are valid ones that silently rewrite the value if left unescaped.
    fn windows_style_claude_path() -> &'static str {
        r"C:\Program Files\Seren\resources\embedded-runtime\node;C:\Users\nick\.cargo\bin"
    }

    /// Regression guard for #3431 (create-new path). The emitted settings
    /// file must be strict JSON even when PATH contains backslashes, and the
    /// PATH value must survive byte-for-byte.
    #[test]
    fn initial_settings_round_trip_a_windows_path_through_json() {
        let claude_path = windows_style_claude_path();

        let written = initial_settings(claude_path);

        let parsed: serde_json::Value = serde_json::from_str(&written)
            .unwrap_or_else(|e| panic!("settings.json must be strict JSON ({e}), got: {written}"));
        assert_eq!(parsed["env"]["PATH"].as_str(), Some(claude_path));
    }

    /// Regression guard for #3431 (update-existing path). Patching must stay
    /// strict JSON, round-trip the Windows PATH, and keep every other key.
    #[test]
    fn patched_settings_round_trip_a_windows_path_and_keep_other_keys() {
        let claude_path = windows_style_claude_path();
        let existing = r#"{ "model": "opus", "permissions": { "allow": ["Bash"] } }"#;

        let SettingsPatch::Updated(written) = patch_existing_settings(existing, claude_path) else {
            panic!("expected the settings document to be updated");
        };

        let parsed: serde_json::Value = serde_json::from_str(&written)
            .unwrap_or_else(|e| panic!("settings.json must be strict JSON ({e}), got: {written}"));
        assert_eq!(parsed["env"]["PATH"].as_str(), Some(claude_path));
        assert_eq!(parsed["model"].as_str(), Some("opus"));
        assert_eq!(parsed["permissions"]["allow"][0].as_str(), Some("Bash"));
    }

    /// An existing env section stays untouched — same contract as before.
    #[test]
    fn patching_leaves_an_existing_env_section_alone() {
        let existing = r#"{ "env": { "PATH": "/custom" } }"#;

        assert!(matches!(
            patch_existing_settings(existing, "/x"),
            SettingsPatch::HasEnvSection
        ));
    }

    /// A file that is not a JSON object cannot be patched safely; refuse
    /// instead of writing more garbage into a user-owned config.
    #[test]
    fn patching_refuses_content_that_is_not_a_json_object() {
        assert!(matches!(
            patch_existing_settings("not json at all", "/x"),
            SettingsPatch::Invalid
        ));
    }

    /// #3431: the idempotence probe must match the value Windows actually
    /// writes (backslashes, `;` separator), not just the Unix spelling.
    #[test]
    fn probe_finds_a_windows_written_cargo_bin_entry() {
        let cargo_bin = Path::new(r"C:\Users\nick\.cargo\bin");
        let content = serde_json::json!({
            "env": { "PATH": windows_style_claude_path() }
        })
        .to_string();

        assert!(env_path_lists_entry(&content, cargo_bin, ';'));
    }

    /// The probe must only trust env.PATH — a stray ".cargo/bin" elsewhere in
    /// the file (say a permissions rule) is not a configured PATH.
    #[test]
    fn probe_ignores_cargo_bin_mentions_outside_env_path() {
        let cargo_bin = PathBuf::from("/Users/dev/.cargo/bin");
        let content = r#"{ "permissions": { "allow": ["Bash(/Users/dev/.cargo/bin/cargo:*)"] } }"#;

        assert!(!cargo_bin_already_configured(content, &cargo_bin));
    }

    /// What this module writes, its own probe must recognize on re-launch.
    #[test]
    fn probe_finds_cargo_bin_in_env_path_written_by_this_module() {
        let cargo_bin = PathBuf::from("/Users/dev/.cargo/bin");
        let content = initial_settings(&claude_code_path(None, &cargo_bin));

        assert!(cargo_bin_already_configured(&content, &cargo_bin));
    }
}
