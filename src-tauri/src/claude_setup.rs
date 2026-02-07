// ABOUTME: Configures Claude Code environment on app startup.
// ABOUTME: Adds cargo to PATH in ~/.claude/settings.json if not already configured.

use log::info;
use std::fs;

/// Configure Claude Code environment if both cargo and Claude Code are installed.
/// Adds cargo to PATH in ~/.claude/settings.json.
pub fn configure_claude_code_environment() {
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
    let cargo_path = cargo_bin.to_string_lossy();

    if !claude_settings.exists() {
        // Create new settings file
        let settings = format!(
            r#"{{
  "env": {{
    "PATH": "{}:/usr/local/bin:/usr/bin:/bin"
  }}
}}"#,
            cargo_path
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
    "PATH": "{}:/usr/local/bin:/usr/bin:/bin"
  }},"#,
                cargo_path
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
