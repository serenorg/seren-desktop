#![cfg(target_os = "linux")]

// Real Linux Landlock canaries. The CI Ubuntu runner executes these against the kernel.

use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy};
use tempfile::TempDir;

fn policy_payload(policy: &SandboxPolicy) -> String {
    STANDARD.encode(serde_json::to_vec(policy).expect("policy serializes"))
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

#[test]
fn sandbox_workspace_write_canary_succeeds() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/sh",
        &["-c", "touch inside"],
    );

    assert!(
        output.status.success(),
        "workspace write failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(workspace.path().join("inside").is_file());
}

#[test]
fn sandbox_outside_write_canary_is_denied() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let outside = tempfile::tempdir().expect("outside tempdir");
    let outside_file = outside.path().join("escape");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/sh",
        &["-c", &format!("touch '{}'", outside_file.display())],
    );

    assert!(!output.status.success());
    assert!(!outside_file.exists());
}

#[test]
fn sandbox_deny_read_canary_is_denied() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let denied = tempfile::tempdir().expect("denied tempdir");
    let readable_file = workspace.path().join("readable");
    let denied_file = denied.path().join("secret");
    fs::write(&readable_file, "readable").expect("write readable canary");
    fs::write(&denied_file, "secret").expect("write denied canary");
    let policy = SandboxPolicy::new(
        SandboxMode::ReadOnly,
        vec![workspace.path().to_path_buf()],
        vec![denied.path().to_path_buf()],
        true,
    )
    .expect("deny-read policy is valid");

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/sh",
        &[
            "-c",
            &format!(
                "cat '{}' && ! cat '{}'",
                readable_file.display(),
                denied_file.display()
            ),
        ],
    );

    assert!(
        output.status.success(),
        "read canary failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&output.stdout), "readable");
}

#[test]
fn sandbox_grandchild_write_cannot_escape() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let outside = tempfile::tempdir().expect("outside tempdir");
    let outside_file = outside.path().join("grandchild-escape");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/sh",
        &[
            "-c",
            &format!("/bin/sh -c \"touch '{}'\"", outside_file.display()),
        ],
    );

    assert!(!output.status.success());
    assert!(!outside_file.exists());
}

#[test]
fn sandbox_network_disabled_denies_tcp_or_fails_closed() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind canary listener");
    let port = listener.local_addr().expect("listener address").port();
    let policy = SandboxPolicy::new(
        SandboxMode::ReadOnly,
        vec![workspace.path().to_path_buf()],
        Vec::new(),
        false,
    )
    .expect("network-disabled policy is valid");

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/bash",
        &["-c", &format!("exec 3<>/dev/tcp/127.0.0.1/{port}")],
    );

    if output.status.code() != Some(69) {
        assert!(
            !output.status.success()
                && (String::from_utf8_lossy(&output.stderr).contains("Permission denied")
                    || String::from_utf8_lossy(&output.stderr).contains("Operation not permitted")
                    || String::from_utf8_lossy(&output.stderr).contains("Network is unreachable")),
            "network canary did not show a denied connect: status={:?} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn sandbox_read_only_denies_workspace_write() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let inside_file = workspace.path().join("read-only-escape");
    let policy = workspace_policy(SandboxMode::ReadOnly, &workspace);

    let output = run_command(
        &policy,
        workspace.path(),
        "/bin/sh",
        &["-c", "touch read-only-escape"],
    );

    assert!(!output.status.success());
    assert!(!inside_file.exists());
}

#[test]
fn sandbox_bad_policy_payload_exits_65() {
    let output = Command::new(env!("CARGO_BIN_EXE_Seren"))
        .args(["__seren-sandbox-run", "not-base64", "--", "/bin/true"])
        .output()
        .expect("sandbox launcher starts");

    assert_eq!(output.status.code(), Some(65));
}
