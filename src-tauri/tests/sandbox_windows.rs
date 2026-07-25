#![cfg(target_os = "windows")]

// Real Windows restricted-token launcher canaries. These run on the
// windows-latest matrix runner; no policy or process behavior is mocked.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Output};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use seren_desktop_lib::sandbox::{SandboxMode, SandboxPolicy};
use tempfile::TempDir;

const CANARY_DENIED_EXIT: i32 = 23;
const CANARY_PROBE_FAILURE_EXIT: i32 = 42;
const CANARY_TARGET_ENV: &str = "SEREN_WINDOWS_SANDBOX_CANARY_TARGET";
const CANARY_GRANDCHILD_ENV: &str = "SEREN_WINDOWS_SANDBOX_CANARY_GRANDCHILD";
const CANARY_WRITE_MARKER: &str = "SEREN_CANARY_WRITE_SUCCEEDED";
const CANARY_DENIED_MARKER: &str = "SEREN_CANARY_WRITE_ACCESS_DENIED";
const CANARY_GRANDCHILD_DENIED_MARKER: &str = "SEREN_CANARY_GRANDCHILD_ACCESS_DENIED";

fn policy_payload(policy: &SandboxPolicy) -> String {
    STANDARD.encode(serde_json::to_vec(policy).expect("policy serializes"))
}

fn workspace_policy(mode: SandboxMode, workspace: &Path) -> SandboxPolicy {
    SandboxPolicy::new(mode, vec![workspace.to_path_buf()], Vec::new(), true)
        .expect("test workspace policy is valid")
}

fn workspace_fixture() -> (TempDir, PathBuf) {
    let root = tempfile::tempdir().expect("sandbox fixture tempdir");
    let workspace = root.path().join("workspace with spaces");
    fs::create_dir(&workspace).expect("sandbox fixture workspace exists");
    (root, workspace)
}

fn prove_target_is_writable(target: &Path) {
    fs::write(target, b"preflight").expect("canary target is writable before sandboxing");
    fs::remove_file(target).expect("canary preflight target is removed");
}

fn sandbox_launcher_command(policy: &SandboxPolicy, cwd: &Path, program: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_Seren"));
    command
        .arg("__seren-sandbox-run")
        .arg(policy_payload(policy))
        .arg("--")
        .arg(program)
        .current_dir(cwd);
    command
}

fn run_native_write_probe(
    policy: &SandboxPolicy,
    cwd: &Path,
    target: &Path,
    spawn_grandchild: bool,
) -> Output {
    let source_executable = env::current_exe().expect("integration test executable is available");
    let probe_executable = cwd.join("seren-sandbox-native-probe.exe");
    fs::copy(source_executable, &probe_executable)
        .expect("native probe is copied into the sandbox workspace");
    let mut command = sandbox_launcher_command(policy, cwd, &probe_executable);
    command
        .args([
            "--ignored",
            "--exact",
            "sandbox_windows_native_write_probe",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CANARY_TARGET_ENV, target);
    if spawn_grandchild {
        command.env(CANARY_GRANDCHILD_ENV, "1");
    } else {
        command.env_remove(CANARY_GRANDCHILD_ENV);
    }
    command.output().expect("sandbox launcher starts")
}

fn assert_access_denied(output: &Output, marker: &str) {
    assert_eq!(
        output.status.code(),
        Some(CANARY_DENIED_EXIT),
        "native canary did not report Win32 access denied: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(marker),
        "native access-denied marker missing: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn exit_probe(code: i32, marker: &str) -> ! {
    println!("{marker}");
    let _ = std::io::stdout().flush();
    process::exit(code);
}

fn fail_probe(error: &std::io::Error) -> ! {
    eprintln!(
        "SEREN_CANARY_UNEXPECTED_IO_ERROR kind={:?} os_code={:?}",
        error.kind(),
        error.raw_os_error()
    );
    let _ = std::io::stderr().flush();
    process::exit(CANARY_PROBE_FAILURE_EXIT);
}

#[test]
#[ignore = "child-only native write probe invoked through the sandbox launcher"]
fn sandbox_windows_native_write_probe() {
    let Some(target) = env::var_os(CANARY_TARGET_ENV) else {
        eprintln!("SEREN_CANARY_TARGET_MISSING");
        process::exit(CANARY_PROBE_FAILURE_EXIT);
    };

    if env::var_os(CANARY_GRANDCHILD_ENV).is_some() {
        let probe_executable = env::current_exe().expect("probe executable is available");
        let output = Command::new(probe_executable)
            .args([
                "--ignored",
                "--exact",
                "sandbox_windows_native_write_probe",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_remove(CANARY_GRANDCHILD_ENV)
            .output()
            .expect("grandchild native probe starts");
        if output.status.code() == Some(CANARY_DENIED_EXIT)
            && String::from_utf8_lossy(&output.stdout).contains(CANARY_DENIED_MARKER)
        {
            exit_probe(CANARY_DENIED_EXIT, CANARY_GRANDCHILD_DENIED_MARKER);
        }
        eprintln!(
            "SEREN_CANARY_GRANDCHILD_UNEXPECTED_RESULT status={:?}",
            output.status
        );
        process::exit(CANARY_PROBE_FAILURE_EXIT);
    }

    let target = PathBuf::from(target);
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(5) => {
            exit_probe(CANARY_DENIED_EXIT, CANARY_DENIED_MARKER);
        }
        Err(error) => fail_probe(&error),
    };
    if let Err(error) = file.write_all(b"allowed") {
        if error.raw_os_error() == Some(5) {
            exit_probe(CANARY_DENIED_EXIT, CANARY_DENIED_MARKER);
        }
        fail_probe(&error);
    }
    println!("{CANARY_WRITE_MARKER}");
}

#[test]
fn sandbox_windows_workspace_write_canary_succeeds() {
    let (_root, workspace) = workspace_fixture();
    let inside = workspace.join("inside.txt");
    prove_target_is_writable(&inside);
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    // A relative target exercises the child-current-directory conversion.
    let output = run_native_write_probe(&policy, &workspace, Path::new("inside.txt"), false);

    assert!(
        output.status.success(),
        "workspace write failed: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(CANARY_WRITE_MARKER),
        "workspace-write marker missing"
    );
    assert_eq!(
        fs::read(&inside).expect("workspace canary file exists"),
        b"allowed"
    );
}

#[test]
fn sandbox_windows_outside_write_canary_is_denied() {
    let (root, workspace) = workspace_fixture();
    let outside = root.path().join("outside.txt");
    prove_target_is_writable(&outside);
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = run_native_write_probe(&policy, &workspace, &outside, false);

    assert_access_denied(&output, CANARY_DENIED_MARKER);
    assert!(!outside.exists(), "outside write unexpectedly succeeded");
}

#[test]
fn sandbox_windows_read_only_denies_workspace_write() {
    let (_root, workspace) = workspace_fixture();
    let inside = workspace.join("read-only.txt");
    prove_target_is_writable(&inside);
    let policy = workspace_policy(SandboxMode::ReadOnly, &workspace);

    // A relative target proves the workspace is reachable but not writable.
    let output = run_native_write_probe(&policy, &workspace, Path::new("read-only.txt"), false);

    assert_access_denied(&output, CANARY_DENIED_MARKER);
    assert!(
        !inside.exists(),
        "read-only workspace write unexpectedly succeeded"
    );
}

#[test]
fn sandbox_windows_grandchild_inherits_restricted_token() {
    let (root, workspace) = workspace_fixture();
    let outside = root.path().join("grandchild.txt");
    prove_target_is_writable(&outside);
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = run_native_write_probe(&policy, &workspace, &outside, true);

    assert_access_denied(&output, CANARY_GRANDCHILD_DENIED_MARKER);
    assert!(!outside.exists(), "grandchild write unexpectedly succeeded");
}

#[test]
fn sandbox_windows_batch_wrapper_preserves_quoted_paths_and_arguments() {
    let (_root, workspace) = workspace_fixture();
    let script_directory = workspace.join("batch scripts");
    fs::create_dir(&script_directory).expect("batch-script directory exists");
    let script = script_directory.join("write result.cmd");
    let result_file = workspace.join("batch result.txt");
    fs::write(
        &script,
        b"@echo off\r\nif not \"%~1\"==\"argument with spaces\" exit /b 43\r\n>\"%~2\" echo batch-ok\r\nexit /b 0\r\n",
    )
    .expect("batch canary is written");
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = sandbox_launcher_command(&policy, &workspace, &script)
        .arg("argument with spaces")
        .arg(&result_file)
        .output()
        .expect("sandbox batch launcher starts");

    assert!(
        output.status.success(),
        "batch wrapper failed: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(&result_file)
            .expect("batch result exists")
            .trim(),
        "batch-ok"
    );
}

fn find_on_path(exe: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|dir| dir.join(exe))
            .find(|candidate| candidate.is_file())
    })
}

/// A restricted-token child that loads the GUI-subsystem DLLs (user32/gdi32,
/// whose DllMain connects to win32k/CSRSS) must still start. node.exe statically
/// imports them, so it reproduces the STATUS_DLL_INIT_FAILED (0xC0000142) crash
/// claude-code hit on the release e2e (#3379). The existing canaries only spawn
/// cmd.exe (console-only), so this loader path was never exercised.
#[test]
fn sandbox_windows_gui_dll_child_starts() {
    // 0xC0000142 == 3221225794 == -1073741502 as i32 (how ExitStatus reports it).
    const STATUS_DLL_INIT_FAILED: i32 = -1_073_741_502;
    let Some(node) = find_on_path("node.exe") else {
        eprintln!("node.exe not on PATH; skipping GUI-DLL sandbox canary");
        return;
    };
    let (_root, workspace) = workspace_fixture();
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);

    let output = sandbox_launcher_command(&policy, &workspace, &node)
        .arg("-e")
        .arg("process.exit(0)")
        .output()
        .expect("sandbox launcher starts");

    assert_ne!(
        output.status.code(),
        Some(STATUS_DLL_INIT_FAILED),
        "node crashed with STATUS_DLL_INIT_FAILED (0xC0000142) under the restricted-token \
         sandbox: GUI DLL init was denied. stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(
        output.status.success(),
        "node did not exit cleanly under the sandbox: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

/// Faithful repro of #3379: install the real claude-code CLI and run it through
/// the restricted-token sandbox. node.exe alone runs fine sandboxed, so the
/// STATUS_DLL_INIT_FAILED (0xC0000142) crash is specific to claude-code's own
/// startup module graph (bundled JS + native addons). This exercises that graph.
#[test]
fn sandbox_windows_claude_cli_starts() {
    const STATUS_DLL_INIT_FAILED: i32 = -1_073_741_502; // 0xC0000142 as i32
    let Some(npm) = find_on_path("npm.cmd").or_else(|| find_on_path("npm.exe")) else {
        eprintln!("npm not on PATH; skipping claude sandbox canary");
        return;
    };

    let prefix = tempfile::tempdir().expect("claude install prefix");
    let install = Command::new(&npm)
        .args([
            "install",
            "-g",
            "--no-fund",
            "--no-audit",
            "@anthropic-ai/claude-code@latest",
        ])
        .env("npm_config_prefix", prefix.path())
        .output()
        .expect("npm install runs");
    if !install.status.success() {
        eprintln!(
            "npm install of claude-code failed (network?); skipping. stderr={}",
            String::from_utf8_lossy(&install.stderr)
        );
        return;
    }
    let claude_cmd = prefix.path().join("claude.cmd");
    assert!(
        claude_cmd.is_file(),
        "claude.cmd not installed at {}",
        claude_cmd.display()
    );

    // Baseline: the CLI starts fine OUTSIDE the sandbox on this runner.
    let direct = Command::new(&claude_cmd)
        .arg("--version")
        .output()
        .expect("claude --version runs");
    assert!(
        direct.status.success(),
        "claude --version failed unsandboxed (bad install, not a sandbox issue): status={:?} stdout={} stderr={}",
        direct.status,
        String::from_utf8_lossy(&direct.stdout),
        String::from_utf8_lossy(&direct.stderr),
    );

    // Through the restricted-token sandbox: this is where the release e2e died.
    let (_root, workspace) = workspace_fixture();
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);
    let sandboxed = sandbox_launcher_command(&policy, &workspace, &claude_cmd)
        .arg("--version")
        .output()
        .expect("sandbox launcher starts");

    assert_ne!(
        sandboxed.status.code(),
        Some(STATUS_DLL_INIT_FAILED),
        "claude crashed with STATUS_DLL_INIT_FAILED (0xC0000142) under the restricted-token \
         sandbox while starting fine unsandboxed (#3379). stdout={} stderr={}",
        String::from_utf8_lossy(&sandboxed.stdout),
        String::from_utf8_lossy(&sandboxed.stderr),
    );
    assert!(
        sandboxed.status.success(),
        "claude did not exit cleanly under the sandbox: status={:?} stdout={} stderr={}",
        sandboxed.status,
        String::from_utf8_lossy(&sandboxed.stdout),
        String::from_utf8_lossy(&sandboxed.stderr),
    );
}

/// The real spawn runs the agent through the app's EMBEDDED node (bundled as a
/// tauri resource), not the stock node on PATH. If that specific build is the
/// differentiator behind #3379, it crashes here while stock node passes.
#[test]
fn sandbox_windows_embedded_node_starts() {
    const STATUS_DLL_INIT_FAILED: i32 = -1_073_741_502; // 0xC0000142 as i32
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("embedded-runtime");
    let candidates = [
        base.join("win32-x64").join("node").join("node.exe"),
        base.join("win32-x64").join("node.exe"),
    ];
    let Some(embedded) = candidates.iter().find(|p| p.is_file()) else {
        eprintln!(
            "embedded node not staged under {}; skipping embedded-node canary",
            base.display()
        );
        return;
    };

    let (_root, workspace) = workspace_fixture();
    let policy = workspace_policy(SandboxMode::WorkspaceWrite, &workspace);
    let output = sandbox_launcher_command(&policy, &workspace, embedded)
        .arg("-e")
        .arg("process.exit(0)")
        .output()
        .expect("sandbox launcher starts");

    assert_ne!(
        output.status.code(),
        Some(STATUS_DLL_INIT_FAILED),
        "EMBEDDED node crashed with STATUS_DLL_INIT_FAILED (0xC0000142) under the sandbox \
         while stock node did not (#3379). stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(
        output.status.success(),
        "embedded node did not exit cleanly under the sandbox: status={:?} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
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
