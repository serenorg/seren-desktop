// ABOUTME: CLI installer commands for auto-installing Claude Code and Codex CLIs
// ABOUTME: Detects missing CLIs and downloads/installs them automatically

use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliTool {
    Claude,
    Codex,
}

/// Check if a CLI tool is installed and in PATH
#[tauri::command]
pub async fn check_cli_installed(tool: CliTool) -> Result<bool, String> {
    let bin_name = match tool {
        CliTool::Claude => "claude",
        CliTool::Codex => "codex",
    };

    // Try to run --version command
    let result = if cfg!(target_os = "windows") {
        Command::new("where").arg(bin_name).output()
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

/// Install a CLI tool using the official installer
#[tauri::command]
pub async fn install_cli_tool(app: AppHandle, tool: CliTool) -> Result<bool, String> {
    let install_script = match tool {
        CliTool::Claude => get_claude_install_script(),
        CliTool::Codex => get_codex_install_script(),
    };

    log::info!("[CliInstaller] Installing {:?} using: {}", tool, install_script);

    // Emit status update
    let _ = app.emit("cli-install-status", serde_json::json!({
        "tool": tool,
        "status": "downloading"
    }));

    // Run the installation command
    let result = if cfg!(target_os = "windows") {
        install_windows(&install_script)
    } else {
        install_unix(&install_script)
    };

    match result {
        Ok(success) => {
            if success {
                let _ = app.emit("cli-install-status", serde_json::json!({
                    "tool": tool,
                    "status": "installed"
                }));
                log::info!("[CliInstaller] {:?} installed successfully", tool);
            } else {
                let _ = app.emit("cli-install-status", serde_json::json!({
                    "tool": tool,
                    "status": "error",
                    "message": "Installation failed"
                }));
                log::error!("[CliInstaller] {:?} installation failed", tool);
            }
            Ok(success)
        }
        Err(e) => {
            let _ = app.emit("cli-install-status", serde_json::json!({
                "tool": tool,
                "status": "error",
                "message": e.clone()
            }));
            log::error!("[CliInstaller] {:?} installation error: {}", tool, e);
            Err(e)
        }
    }
}

/// Get Claude Code installation script for current platform
fn get_claude_install_script() -> String {
    if cfg!(target_os = "windows") {
        // PowerShell one-liner
        "irm https://claude.ai/install.ps1 | iex".to_string()
    } else {
        // macOS/Linux bash one-liner
        "curl -fsSL https://claude.ai/install.sh | bash".to_string()
    }
}

/// Get Codex installation script for current platform
fn get_codex_install_script() -> String {
    // TODO: Update with actual Codex installation URLs when available
    if cfg!(target_os = "windows") {
        "irm https://codex.example.com/install.ps1 | iex".to_string()
    } else {
        "curl -fsSL https://codex.example.com/install.sh | bash".to_string()
    }
}

/// Install on Windows using PowerShell
fn install_windows(script: &str) -> Result<bool, String> {
    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to execute PowerShell: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Installation failed: {}", stderr));
    }

    Ok(true)
}

/// Install on Unix-like systems using bash
fn install_unix(script: &str) -> Result<bool, String> {
    let output = Command::new("bash")
        .arg("-c")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to execute bash: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Installation failed: {}", stderr));
    }

    Ok(true)
}
