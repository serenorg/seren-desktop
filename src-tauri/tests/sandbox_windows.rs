#![cfg(target_os = "windows")]

// Real Windows restricted-token and Job Object canaries. These run on the
// windows-latest matrix runner; no policy or process behavior is mocked.

use std::env;
use std::path::Path;
use std::process::{Command, Output};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy};
use tempfile::TempDir;

fn policy_payload(policy: &SandboxPolicy) -> String {
    STANDARD.encode(serde_json::to_vec(policy).expect("policy serializes"))
}

fn command_shell() -> String {
    env::var("ComSpec").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string())
}

fn run_command(policy: &SandboxPolicy, cwd: &Path, command: &str, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_Seren"))
        .args([
            "__seren-sandbox-run",
            &policy_payload(policy),
            "--",
            command,
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("sandbox launcher starts")
}

fn workspace_policy(mode: SandboxMode, workspace: &TempDir) -> SandboxPolicy {
    SandboxPolicy::new(mode, vec![workspace.path().to_path_buf()], Vec::new(), true)
        .expect("test workspace policy is valid")
}

fn redirect(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

#[test]
fn sandbox_windows_workspace_write_canary_succeeds() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let inside = workspace.path().join("inside.txt");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);
    let shell = command_shell();

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &["/d", "/c", &format!("echo allowed>{}", redirect(&inside))],
    );

    assert!(
        output.status.success(),
        "workspace write failed: status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(inside.is_file());
}

#[test]
fn sandbox_windows_outside_write_canary_is_denied() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let outside = tempfile::tempdir().expect("outside tempdir");
    let outside_file = outside.path().join("outside.txt");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);
    let shell = command_shell();

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &[
            "/d",
            "/c",
            &format!("echo denied>{}", redirect(&outside_file)),
        ],
    );

    assert!(
        !outside_file.exists(),
        "outside write unexpectedly succeeded: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn sandbox_windows_read_only_denies_workspace_write() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let inside = workspace.path().join("read-only.txt");
    let policy = workspace_policy(SandboxMode::ReadOnly, &workspace);
    let shell = command_shell();

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &["/d", "/c", &format!("echo denied>{}", redirect(&inside))],
    );

    assert!(
        !inside.exists(),
        "read-only workspace write unexpectedly succeeded: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn sandbox_windows_grandchild_cannot_escape_job() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let outside = tempfile::tempdir().expect("outside tempdir");
    let outside_file = outside.path().join("grandchild.txt");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);
    let shell = command_shell();
    let grandchild_script = format!("{} /d /c echo denied>{}", shell, redirect(&outside_file));

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &["/d", "/c", &grandchild_script],
    );

    assert!(
        !outside_file.exists(),
        "grandchild write unexpectedly succeeded: status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn sandbox_windows_bad_arguments_exit_64() {
    let output = Command::new(env!("CARGO_BIN_EXE_Seren"))
        .arg("__seren-sandbox-run")
        .output()
        .expect("sandbox launcher starts");

    assert_eq!(output.status.code(), Some(64));
}

#[test]
fn sandbox_windows_bad_policy_exits_65() {
    let output = Command::new(env!("CARGO_BIN_EXE_Seren"))
        .args(["__seren-sandbox-run", "not-base64", "--", "cmd.exe"])
        .output()
        .expect("sandbox launcher starts");

    assert_eq!(output.status.code(), Some(65));
}
