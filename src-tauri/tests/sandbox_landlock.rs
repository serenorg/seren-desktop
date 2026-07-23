#![cfg(target_os = "linux")]

// Real Linux Landlock canaries. The CI Ubuntu runner executes these against the kernel.

use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy};
use tempfile::TempDir;

const CANARY_DENIED_EXIT: i32 = 23;
const CANARY_UNEXPECTED_ACCESS_EXIT: i32 = 41;

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

fn assert_launcher_ran(output: &Output) {
    let status = output.status.code();
    // A launcher fault is not a Landlock denial. Individual canaries must
    // prove their own command ran and observed the expected restriction. #3219.
    assert_ne!(status, Some(64), "launcher rejected arguments: {output:?}");
    assert_ne!(status, Some(65), "launcher rejected policy: {output:?}");
    assert_ne!(
        status,
        Some(69),
        "launcher failed before the canary ran: {output:?}"
    );
}

fn assert_contained_denial(output: &Output, denied_marker: &str) {
    assert_launcher_ran(output);
    assert_eq!(
        output.status.code(),
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
        &[
            "-c",
            &format!(
                "printf 'SEREN_CANARY_OUTSIDE_WRITE_STARTED\\n'; if touch '{}'; then printf 'SEREN_CANARY_UNEXPECTED_WRITE\\n'; exit {CANARY_UNEXPECTED_ACCESS_EXIT}; else printf 'SEREN_CANARY_OUTSIDE_WRITE_DENIED\\n'; exit {CANARY_DENIED_EXIT}; fi",
                outside_file.display()
            ),
        ],
    );

    assert_contained_denial(&output, "SEREN_CANARY_OUTSIDE_WRITE_DENIED");
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
                "cat '{}'; if cat '{}'; then printf 'SEREN_CANARY_UNEXPECTED_READ\\n'; exit {CANARY_UNEXPECTED_ACCESS_EXIT}; else printf 'SEREN_CANARY_DENY_READ_DENIED\\n'; fi",
                readable_file.display(),
                denied_file.display()
            ),
        ],
    );

    assert_launcher_ran(&output);
    assert!(
        output.status.success(),
        "read canary failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("readable"));
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("SEREN_CANARY_DENY_READ_DENIED"),
        "deny-read canary did not reach its own denial marker: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
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
            &format!(
                "/bin/sh -c \"printf 'SEREN_CANARY_GRANDCHILD_STARTED\\n'; touch '{}'\"; if [ -e '{}' ]; then printf 'SEREN_CANARY_UNEXPECTED_WRITE\\n'; exit {CANARY_UNEXPECTED_ACCESS_EXIT}; else printf 'SEREN_CANARY_GRANDCHILD_WRITE_DENIED\\n'; exit {CANARY_DENIED_EXIT}; fi",
                outside_file.display(),
                outside_file.display()
            ),
        ],
    );

    assert_contained_denial(&output, "SEREN_CANARY_GRANDCHILD_WRITE_DENIED");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("SEREN_CANARY_GRANDCHILD_STARTED"),
        "grandchild canary never started: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
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
        &[
            "-c",
            &format!(
                "if exec 3<>/dev/tcp/127.0.0.1/{port}; then printf 'SEREN_CANARY_UNEXPECTED_CONNECT\\n'; exit {CANARY_UNEXPECTED_ACCESS_EXIT}; else printf 'SEREN_CANARY_NETWORK_DENIED\\n'; exit {CANARY_DENIED_EXIT}; fi"
            ),
        ],
    );

    let status = output.status.code();
    assert_ne!(status, Some(64), "launcher rejected arguments: {output:?}");
    assert_ne!(status, Some(65), "launcher rejected policy: {output:?}");
    if status == Some(69) {
        // Older kernels may lack Landlock's TCP ABI. This remains an allowed,
        // explicit fail-closed result only when the backend identifies that
        // capability gap, not a generic launcher fault.
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("Landlock")
                && String::from_utf8_lossy(&output.stderr).contains("TCP"),
            "network launcher exit 69 was not the documented TCP-ABI fail-closed path: stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        assert_contained_denial(&output, "SEREN_CANARY_NETWORK_DENIED");
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
        &[
            "-c",
            &format!(
                "if touch read-only-escape; then printf 'SEREN_CANARY_UNEXPECTED_WRITE\\n'; exit {CANARY_UNEXPECTED_ACCESS_EXIT}; else printf 'SEREN_CANARY_READ_ONLY_WRITE_DENIED\\n'; exit {CANARY_DENIED_EXIT}; fi"
            ),
        ],
    );

    assert_contained_denial(&output, "SEREN_CANARY_READ_ONLY_WRITE_DENIED");
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
