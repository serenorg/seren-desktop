// ABOUTME: CLI availability checks and guarded installation handoffs.
// ABOUTME: Avoids executing downloaded scripts; unverified tools require official manual setup.

use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliTool {
    Claude,
    Codex,
    Gemini,
}

/// Check if a CLI tool is installed and in PATH
#[tauri::command]
pub async fn check_cli_installed(tool: CliTool) -> Result<bool, String> {
    let bin_name = match tool {
        CliTool::Claude => "claude",
        CliTool::Codex => "codex",
        CliTool::Gemini => "gemini",
    };

    // Try to run --version command
    let result = if cfg!(target_os = "windows") {
        let mut c = Command::new("where");
        c.arg(bin_name);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.output()
    } else {
        Command::new("which").arg(bin_name).output()
    };

    match result {
        Ok(output) => Ok(output.status.success()),
        Err(e) => {
            log::debug!("[CliInstaller] Failed to check {}: {}", bin_name, e);
            Ok(false)
        }
    }
}

fn manual_install_url(tool: &CliTool) -> &'static str {
    match tool {
        CliTool::Claude => "https://code.claude.com/docs/en/installation",
        CliTool::Codex => "https://developers.openai.com/codex/cli/",
        CliTool::Gemini => "https://github.com/google-gemini/gemini-cli",
    }
}

/// Fail closed from the legacy Rust installer. Agent CLI installation belongs
/// to the embedded provider runtime; this bridge must never invoke system npm
/// or pipe mutable remote scripts into a shell.
#[tauri::command]
pub async fn install_cli_tool(app: AppHandle, tool: CliTool) -> Result<bool, String> {
    let url = manual_install_url(&tool);
    let message = format!(
        "Automatic installation is disabled on this legacy path. Install from {url}, then retry in Seren."
    );
    let _ = app.emit(
        "cli-install-status",
        serde_json::json!({
            "tool": tool,
            "status": "action_required",
            "message": message,
            "officialInstructionsUrl": url,
        }),
    );
    Err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unverified_tools_only_return_https_instructions() {
        for tool in [CliTool::Claude, CliTool::Codex, CliTool::Gemini] {
            let url = manual_install_url(&tool);
            assert!(url.starts_with("https://"));
            assert!(!url.contains('|'));
        }
    }
}
