// ABOUTME: Critical guard for #3230 — the app binary is the only source of a sandbox launch spec.
// ABOUTME: Runs the real binary's hidden subcommand; every rejected input must fail closed.

use std::process::{Command, Output};
use tempfile::tempdir;

fn spec_command(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_Seren"))
        .arg("__seren-sandbox-spec")
        .args(args)
        .output()
        .expect("run the sandbox spec subcommand")
}

#[test]
fn spec_dispatch_emits_a_launch_spec_for_a_bounded_session() {
    let workspace = tempdir().expect("workspace tempdir");
    let root = workspace.path().to_string_lossy().into_owned();

    let output = spec_command(&["workspace-write", "false", &root]);

    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let spec: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("spec is a single JSON document");
    let kind = spec["kind"].as_str().expect("spec carries a kind");
    assert!(
        matches!(kind, "seatbelt" | "linux-launcher" | "windows-launcher"),
        "unexpected launch spec kind: {kind}"
    );
}

#[test]
fn spec_dispatch_refuses_full_access() {
    let workspace = tempdir().expect("workspace tempdir");
    let root = workspace.path().to_string_lossy().into_owned();

    let output = spec_command(&["full-access", "true", &root]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn spec_dispatch_refuses_an_unknown_mode() {
    let workspace = tempdir().expect("workspace tempdir");
    let root = workspace.path().to_string_lossy().into_owned();

    let output = spec_command(&["allow-everything", "true", &root]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn spec_dispatch_refuses_a_root_that_does_not_resolve() {
    let workspace = tempdir().expect("workspace tempdir");
    let missing = workspace.path().join("absent");

    let output = spec_command(&[
        "workspace-write",
        "true",
        &missing.to_string_lossy().into_owned(),
    ]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn spec_dispatch_refuses_a_malformed_network_flag() {
    let workspace = tempdir().expect("workspace tempdir");
    let root = workspace.path().to_string_lossy().into_owned();

    let output = spec_command(&["workspace-write", "yes", &root]);

    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
