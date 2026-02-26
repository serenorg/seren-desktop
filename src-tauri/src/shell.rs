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

    // Prepend embedded runtime to PATH so shell commands can find bundled Node/Git
    // while preserving access to system-installed tools.
    let embedded_path = crate::embedded_runtime::get_embedded_path();
    if !embedded_path.is_empty() {
        let sep = if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        };
        let system_path = std::env::var("PATH").unwrap_or_default();
        let combined = if system_path.is_empty() {
            embedded_path.to_string()
        } else {
            format!("{}{}{}", embedded_path, sep, system_path)
        };
        cmd.env("PATH", &combined);
    }

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

/// Run DNS + HTTP connectivity checks from a shell process and report results.
///
/// This diagnostic helps debug split-network issues where MCP (HTTP client)
/// has network access but shell subprocesses do not.
#[tauri::command]
pub async fn diagnose_shell_network() -> Result<serde_json::Value, String> {
    let mut results = serde_json::Map::new();

    // Check 1: DNS resolution via getent/host/nslookup
    let dns_check = run_diagnostic_command(
        "python3 -c \"import socket; print(socket.getaddrinfo('api.serendb.com', 443)[0][4][0])\"",
        5,
    )
    .await;
    results.insert("dns_resolve".into(), diagnostic_to_json(&dns_check));

    // Check 2: HTTP connectivity
    let http_check = run_diagnostic_command(
        "curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://api.serendb.com/health",
        10,
    )
    .await;
    results.insert("http_connect".into(), diagnostic_to_json(&http_check));

    // Check 3: PATH contents
    let path_check = run_diagnostic_command("echo $PATH", 2).await;
    results.insert("shell_path".into(), diagnostic_to_json(&path_check));

    // Check 4: resolv.conf (Linux) or scutil --dns (macOS)
    let resolver_check = if cfg!(target_os = "macos") {
        run_diagnostic_command("scutil --dns 2>&1 | head -20", 5).await
    } else {
        run_diagnostic_command("cat /etc/resolv.conf 2>&1", 2).await
    };
    results.insert(
        "resolver_config".into(),
        diagnostic_to_json(&resolver_check),
    );

    // Check 5: Raw IP connectivity (bypasses DNS)
    let ip_check = run_diagnostic_command("ping -c 1 -W 3 1.1.1.1 2>&1 | tail -2", 5).await;
    results.insert("ip_reachable".into(), diagnostic_to_json(&ip_check));

    // Overall pass/fail
    let dns_ok = dns_check.exit_code == Some(0);
    let http_ok = http_check.exit_code == Some(0);
    let ip_ok = ip_check.exit_code == Some(0);
    results.insert(
        "overall_pass".into(),
        serde_json::Value::Bool(dns_ok && http_ok),
    );
    results.insert("dns_ok".into(), serde_json::Value::Bool(dns_ok));
    results.insert("http_ok".into(), serde_json::Value::Bool(http_ok));
    results.insert("ip_ok".into(), serde_json::Value::Bool(ip_ok));

    Ok(serde_json::Value::Object(results))
}

async fn run_diagnostic_command(command: &str, timeout_secs: u64) -> CommandResult {
    match execute_shell_command(command.to_string(), Some(timeout_secs)).await {
        Ok(result) => result,
        Err(e) => CommandResult {
            stdout: String::new(),
            stderr: e,
            exit_code: None,
            timed_out: false,
        },
    }
}

fn diagnostic_to_json(result: &CommandResult) -> serde_json::Value {
    serde_json::json!({
        "stdout": result.stdout.trim(),
        "stderr": result.stderr.trim(),
        "exit_code": result.exit_code,
        "timed_out": result.timed_out,
    })
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
