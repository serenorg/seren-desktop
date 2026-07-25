// ABOUTME: Real macOS Seatbelt canaries for the provider-independent sandbox boundary.
// ABOUTME: Every case runs a child process through the generated profile with no mocks.

#![cfg(target_os = "macos")]

use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy, wrap_spawn};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::tempdir;

fn shell_literal(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn run_shell(policy: &SandboxPolicy, shell: &str, script: String) -> Output {
    let args = vec!["-c".to_string(), script];
    let (executable, wrapped_args) = wrap_spawn(shell, &args, policy).expect("wrap spawn");
    Command::new(executable)
        .args(wrapped_args)
        .current_dir(
            policy
                .workspace_roots
                .first()
                .expect("workspace root for sandbox child"),
        )
        .output()
        .expect("run sandboxed child")
}

fn policy(
    mode: SandboxMode,
    workspace: &Path,
    deny_read: &[PathBuf],
    network_enabled: bool,
) -> SandboxPolicy {
    SandboxPolicy::new(
        mode,
        vec![workspace.to_path_buf()],
        deny_read.to_vec(),
        network_enabled,
    )
    .expect("valid sandbox policy")
}

#[test]
fn sandbox_workspace_write_canary_succeeds() {
    let workspace = tempdir().expect("workspace tempdir");
    let inside = workspace.path().join("inside.txt");
    let sandbox = policy(SandboxMode::WorkspaceWrite, workspace.path(), &[], true);

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!("set -e; touch {}", shell_literal(&inside)),
    );

    assert!(
        output.status.success(),
        "status={:?}\nstdout={}\nstderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(inside.is_file());
}

#[test]
fn sandbox_outside_write_canary_is_denied() {
    let workspace = tempdir().expect("workspace tempdir");
    let outside = tempdir().expect("outside tempdir");
    let canary = outside.path().join("outside.txt");
    let sandbox = policy(SandboxMode::WorkspaceWrite, workspace.path(), &[], true);

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!("set -e; touch {}", shell_literal(&canary)),
    );

    assert!(!output.status.success());
    assert!(!canary.exists());
}

#[test]
fn sandbox_deny_read_canary_is_denied() {
    let workspace = tempdir().expect("workspace tempdir");
    let denied = tempdir().expect("denied tempdir");
    let secret = denied.path().join("secret.txt");
    fs::write(&secret, "do not read").expect("secret fixture");
    let sandbox = policy(
        SandboxMode::WorkspaceWrite,
        workspace.path(),
        &[denied.path().to_path_buf()],
        true,
    );

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!("set -e; cat {}", shell_literal(&secret)),
    );

    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("do not read"));
}

// A credential directory that sits INSIDE the writable workspace root must not
// be writable either: workspace-write allows writes to the workspace, so
// without an explicit write-deny a deny_read path nested in the workspace (e.g.
// the user opens ~ as the project) stays a persistence vector (#3347).
#[test]
fn sandbox_deny_read_path_inside_workspace_is_not_writable() {
    let workspace = tempdir().expect("workspace tempdir");
    let creds = workspace.path().join("dot-ssh");
    fs::create_dir_all(&creds).expect("creds dir");
    let target = creds.join("authorized_keys");
    let sandbox = policy(
        SandboxMode::WorkspaceWrite,
        workspace.path(),
        &[creds.clone()],
        true,
    );

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!(
            "if printf pwned > {} 2>/dev/null; then echo WROTE; else echo DENIED; fi",
            shell_literal(&target)
        ),
    );

    assert!(
        String::from_utf8_lossy(&output.stdout).contains("DENIED"),
        "write to a deny_read dir inside the workspace must be denied: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        fs::read_to_string(&target).unwrap_or_default().is_empty(),
        "the credential file must not have been written"
    );
}

#[test]
fn sandbox_grandchild_write_cannot_escape() {
    let workspace = tempdir().expect("workspace tempdir");
    let outside = tempdir().expect("outside tempdir");
    let canary = outside.path().join("grandchild.txt");
    let sandbox = policy(SandboxMode::WorkspaceWrite, workspace.path(), &[], true);

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!("set -e; /bin/sh -c 'touch {}'", shell_literal(&canary)),
    );

    assert!(!output.status.success());
    assert!(!canary.exists());
}

#[test]
fn sandbox_network_disabled_denies_dev_tcp() {
    let workspace = tempdir().expect("workspace tempdir");
    let sandbox = policy(SandboxMode::WorkspaceWrite, workspace.path(), &[], false);

    let output = run_shell(
        &sandbox,
        "/bin/bash",
        "set -e; exec 3<>/dev/tcp/127.0.0.1/80".to_string(),
    );

    assert!(!output.status.success());
}

#[test]
fn sandbox_read_only_denies_workspace_write() {
    let workspace = tempdir().expect("workspace tempdir");
    let inside = workspace.path().join("read-only.txt");
    let sandbox = policy(SandboxMode::ReadOnly, workspace.path(), &[], true);

    let output = run_shell(
        &sandbox,
        "/bin/sh",
        format!("set -e; touch {}", shell_literal(&inside)),
    );

    assert!(!output.status.success());
    assert!(!inside.exists());
}
