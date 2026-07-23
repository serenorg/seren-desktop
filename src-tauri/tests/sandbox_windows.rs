#![cfg(target_os = "windows")]

// Real Windows restricted-token and Job Object canaries. These run on the
// windows-latest matrix runner; no policy or process behavior is mocked.

use std::env;
use std::path::Path;
use std::process::{Command, Output};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy};
use tempfile::TempDir;

const CANARY_DENIED_EXIT: i32 = 23;
const CANARY_UNEXPECTED_WRITE_EXIT: i32 = 41;

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
    format!("\"{}\"", cmd_compatible_path(path))
}

fn cmd_compatible_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    // tempfile paths can carry Windows' extended-length prefix. cmd.exe does
    // not accept that spelling in redirections, even though the sandbox policy
    // intentionally retains the canonical form for enforcement.
    if let Some(unc) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else if let Some(local) = raw.strip_prefix("\\\\?\\") {
        local.to_owned()
    } else {
        raw.into_owned()
    }
}

fn denied_write_script(path: &Path, started_marker: &str, denied_marker: &str) -> String {
    let target = redirect(path);
    format!(
        "echo {started_marker} & echo denied>{target} & if exist {target} (echo SEREN_CANARY_UNEXPECTED_WRITE & exit /b {CANARY_UNEXPECTED_WRITE_EXIT}) else (echo {denied_marker} & exit /b {CANARY_DENIED_EXIT})"
    )
}

fn assert_contained_denial(output: &Output, denied_marker: &str) {
    let status = output.status.code();
    // A launcher parse, policy, or enforcement failure must never satisfy a
    // denial canary. The child command itself returns CANARY_DENIED_EXIT only
    // after it observes that its write did not land. #3219.
    assert_ne!(status, Some(64), "launcher rejected arguments: {output:?}");
    assert_ne!(status, Some(65), "launcher rejected policy: {output:?}");
    assert_ne!(
        status,
        Some(69),
        "launcher failed before the canary ran: {output:?}"
    );
    assert_eq!(
        status,
        Some(CANARY_DENIED_EXIT),
        "canary did not report its contained denial: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(denied_marker),
        "canary denial marker missing: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
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
    let started_marker = "SEREN_CANARY_OUTSIDE_WRITE_STARTED";
    let denied_marker = "SEREN_CANARY_OUTSIDE_WRITE_DENIED";

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &[
            "/d",
            "/c",
            &denied_write_script(&outside_file, started_marker, denied_marker),
        ],
    );

    assert_contained_denial(&output, denied_marker);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(started_marker),
        "outside-write canary never started: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
    let started_marker = "SEREN_CANARY_READ_ONLY_WRITE_STARTED";
    let denied_marker = "SEREN_CANARY_READ_ONLY_WRITE_DENIED";

    let output = run_command(
        &policy,
        workspace.path(),
        &shell,
        &[
            "/d",
            "/c",
            &denied_write_script(&inside, started_marker, denied_marker),
        ],
    );

    assert_contained_denial(&output, denied_marker);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(started_marker),
        "read-only canary never started: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
    let started_marker = "SEREN_CANARY_GRANDCHILD_STARTED";
    let denied_marker = "SEREN_CANARY_GRANDCHILD_WRITE_DENIED";
    // Run a marker from a real child cmd.exe before the write-attempt child.
    // The parent then emits the denial marker only after observing no escape.
    let grandchild_script = format!(
        "{shell} /d /c echo {started_marker} & {shell} /d /c echo denied>{outside}",
        outside = redirect(&outside_file)
    );
    let script = format!(
        "{grandchild_script} & if exist {outside} (echo SEREN_CANARY_UNEXPECTED_WRITE & exit /b {CANARY_UNEXPECTED_WRITE_EXIT}) else (echo {denied_marker} & exit /b {CANARY_DENIED_EXIT})",
        outside = redirect(&outside_file)
    );

    let output = run_command(&policy, workspace.path(), &shell, &["/d", "/c", &script]);

    assert_contained_denial(&output, denied_marker);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(started_marker),
        "grandchild canary never started: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
