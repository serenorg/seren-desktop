// ABOUTME: Shell command execution for AI tool calls.
// ABOUTME: Runs commands with timeout and output capture, invoked via Tauri IPC.

use serde::Serialize;
use std::time::Duration;
use tokio::process::Command;

const MAX_OUTPUT_BYTES: usize = 50_000;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[tauri::command]
pub async fn execute_shell_command(
    command: String,
    timeout_secs: Option<u64>,
) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("Command must not be empty".to_string());
    }

    let secs = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(MAX_TIMEOUT_SECS);
    let timeout = Duration::from_secs(secs);

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/c", &command]);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", &command]);
        c
    };

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let stdout = truncate_output(String::from_utf8_lossy(&output.stdout).to_string());
            let stderr = truncate_output(String::from_utf8_lossy(&output.stderr).to_string());
            Ok(CommandResult {
                stdout,
                stderr,
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Ok(Err(e)) => Err(format!("Command execution failed: {}", e)),
        Err(_) => Ok(CommandResult {
            stdout: String::new(),
            stderr: format!("Command timed out after {} seconds", secs),
            exit_code: None,
            timed_out: true,
        }),
    }
}

fn truncate_output(s: String) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        s
    } else {
        format!(
            "{}\n\n[Truncated: output was {} bytes]",
            &s[..MAX_OUTPUT_BYTES],
            s.len()
        )
    }
}
