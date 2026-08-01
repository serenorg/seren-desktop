// ABOUTME: Filesystem and Git workspace provisioning for durable run leases.
// ABOUTME: Keeps provisioning explicit-path, side-effect scoped, and independent of Tauri or SQLite.

use super::types::LeaseMode;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SETUP_OUTPUT_LIMIT: usize = 2_000;

/// Every child this module spawns is background work for a run. Without this
/// flag Windows opens a console window for each one — setup scripts, evidence
/// checks, and every git call during provisioning.
fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

#[derive(Debug, Clone)]
pub struct ProvisionRequest {
    pub run_id: String,
    pub task_id: String,
    pub task_slug: String,
    pub mode: LeaseMode,
    pub source_path: Option<PathBuf>,
    pub setup_script: Option<String>,
    pub workspaces_root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProvisionedWorkspace {
    pub root_path: PathBuf,
    pub base_revision: Option<String>,
    pub branch_name: Option<String>,
    pub uncommitted_warning: Option<String>,
    pub setup: Option<SetupResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupResult {
    pub command: String,
    pub exit_code: i32,
    pub duration_ms: u64,
    pub output_tail: String,
}

#[derive(Debug)]
pub enum ProvisionError {
    InvalidRequest(String),
    MissingSource,
    NotARepository,
    Io(io::Error),
    GitCommand { command: String, output: String },
}

impl fmt::Display for ProvisionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid workspace request: {message}"),
            Self::MissingSource => write!(formatter, "workspace mode requires a source path"),
            Self::NotARepository => write!(formatter, "source path is not a Git repository"),
            Self::Io(error) => write!(formatter, "workspace filesystem error: {error}"),
            Self::GitCommand { command, output } => {
                write!(formatter, "Git command failed ({command}): {output}")
            }
        }
    }
}

impl std::error::Error for ProvisionError {}

impl From<io::Error> for ProvisionError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn short_run_id(run_id: &str) -> String {
    run_id.chars().take(8).collect()
}

pub fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;

    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            pending_dash = false;
        } else if !slug.is_empty() {
            pending_dash = true;
        }
    }

    slug.truncate(40);
    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        "task".to_string()
    } else {
        slug
    }
}

pub fn provision(request: &ProvisionRequest) -> Result<ProvisionedWorkspace, ProvisionError> {
    if request.run_id.is_empty() {
        return Err(ProvisionError::InvalidRequest(
            "run_id must not be empty".to_string(),
        ));
    }
    if request.task_id.is_empty() {
        return Err(ProvisionError::InvalidRequest(
            "task_id must not be empty".to_string(),
        ));
    }

    match request.mode {
        LeaseMode::Scratch => provision_scratch(request),
        LeaseMode::Worktree => provision_worktree(request),
        LeaseMode::SharedReadonly => Ok(ProvisionedWorkspace {
            root_path: request
                .source_path
                .clone()
                .ok_or(ProvisionError::MissingSource)?,
            base_revision: None,
            branch_name: None,
            uncommitted_warning: None,
            setup: None,
        }),
        LeaseMode::ExternalRead | LeaseMode::ExternalWrite => Ok(ProvisionedWorkspace {
            root_path: request.workspaces_root.clone(),
            base_revision: None,
            branch_name: None,
            uncommitted_warning: None,
            setup: None,
        }),
    }
}

fn provision_scratch(request: &ProvisionRequest) -> Result<ProvisionedWorkspace, ProvisionError> {
    let base = request
        .workspaces_root
        .join(short_run_id(&request.run_id))
        .join(slugify(&request.task_slug));
    let root_path = create_unique_directory(&base)?;

    Ok(ProvisionedWorkspace {
        root_path,
        base_revision: None,
        branch_name: None,
        uncommitted_warning: None,
        setup: None,
    })
}

fn provision_worktree(request: &ProvisionRequest) -> Result<ProvisionedWorkspace, ProvisionError> {
    let source_path = request
        .source_path
        .as_ref()
        .ok_or(ProvisionError::MissingSource)?;
    ensure_git_repository(source_path)?;

    let base_revision = git_stdout(source_path, &["rev-parse", "HEAD"])?;
    let status = git_stdout(source_path, &["status", "--porcelain"])?;
    let uncommitted_warning = warning_for_status(&status);

    let base_root = request
        .workspaces_root
        .join(short_run_id(&request.run_id))
        .join(slugify(&request.task_slug));
    let base_branch = format!(
        "seren/{}/{}",
        short_run_id(&request.run_id),
        slugify(&request.task_slug)
    );
    let parent = base_root
        .parent()
        .ok_or_else(|| ProvisionError::InvalidRequest("workspace root has no parent".to_string()))?;
    fs::create_dir_all(parent)?;

    for suffix in 0u32.. {
        let root_path = with_suffix(&base_root, suffix);
        let branch_name = branch_with_suffix(&base_branch, suffix);
        if root_path.exists() || git_branch_exists(source_path, &branch_name)? {
            continue;
        }

        let output = hidden_command("git")
            .current_dir(source_path)
            .args(["worktree", "add"])
            .arg(&root_path)
            .args(["-b", &branch_name, "HEAD"])
            .output()
            .map_err(ProvisionError::Io)?;
        if output.status.success() {
            return Ok(ProvisionedWorkspace {
                root_path,
                base_revision: Some(base_revision.clone()),
                branch_name: Some(branch_name),
                uncommitted_warning: uncommitted_warning.clone(),
                setup: None,
            });
        }

        // A concurrent provisioner may have claimed the path or branch between
        // the existence check and git worktree add. A live worktree there is
        // theirs and holds real work, so only clear a leftover that is not one
        // before retrying with the next suffix.
        if root_path.exists() && !root_path.join(".git").exists() {
            let _ = fs::remove_dir_all(&root_path);
        }
        if !git_branch_exists(source_path, &branch_name)? {
            return Err(git_error(
                [
                    "git",
                    "worktree",
                    "add",
                    &root_path.to_string_lossy(),
                    "-b",
                    &branch_name,
                    "HEAD",
                ]
                .join(" "),
                output,
            ));
        }
    }

    Err(ProvisionError::InvalidRequest(
        "exhausted workspace collision suffixes".to_string(),
    ))
}

fn ensure_git_repository(source_path: &Path) -> Result<(), ProvisionError> {
    let output = hidden_command("git")
        .args(["-C"])
        .arg(source_path)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map_err(ProvisionError::Io)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(ProvisionError::NotARepository)
    }
}

fn git_stdout(source_path: &Path, arguments: &[&str]) -> Result<String, ProvisionError> {
    let output = hidden_command("git")
        .current_dir(source_path)
        .args(arguments)
        .output()
        .map_err(ProvisionError::Io)?;
    if !output.status.success() {
        return Err(git_error(
            format!("git {}", arguments.join(" ")),
            output,
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_branch_exists(source_path: &Path, branch_name: &str) -> Result<bool, ProvisionError> {
    let status = hidden_command("git")
        .current_dir(source_path)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch_name}"))
        .status()
        .map_err(ProvisionError::Io)?;
    if status.success() {
        Ok(true)
    } else if status.code() == Some(1) {
        Ok(false)
    } else {
        Err(ProvisionError::GitCommand {
            command: format!("git show-ref --verify --quiet refs/heads/{branch_name}"),
            output: format!("exit status {status}"),
        })
    }
}

fn git_error(command: String, output: Output) -> ProvisionError {
    let mut text = String::from_utf8_lossy(&output.stderr).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stdout).to_string();
    }
    ProvisionError::GitCommand {
        command,
        output: text.trim().to_string(),
    }
}

fn warning_for_status(status: &str) -> Option<String> {
    let file_count = status.lines().filter(|line| !line.trim().is_empty()).count();
    (file_count > 0).then(|| {
        format!(
            "source repository has {file_count} uncommitted file{}",
            if file_count == 1 { "" } else { "s" }
        )
    })
}

fn create_unique_directory(base: &Path) -> Result<PathBuf, ProvisionError> {
    let parent = base
        .parent()
        .ok_or_else(|| ProvisionError::InvalidRequest("workspace root has no parent".to_string()))?;
    fs::create_dir_all(parent)?;
    for suffix in 0u32.. {
        let candidate = with_suffix(base, suffix);
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(ProvisionError::Io(error)),
        }
    }
    Err(ProvisionError::InvalidRequest(
        "exhausted workspace collision suffixes".to_string(),
    ))
}

fn with_suffix(path: &Path, suffix: u32) -> PathBuf {
    if suffix == 0 {
        return path.to_path_buf();
    }
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    path.with_file_name(format!("{name}-{suffix}"))
}

fn branch_with_suffix(branch: &str, suffix: u32) -> String {
    if suffix == 0 {
        branch.to_string()
    } else {
        format!("{branch}-{suffix}")
    }
}

pub fn default_setup_script(root: &Path) -> Option<String> {
    if root.join("package.json").is_file() {
        Some("pnpm install --prefer-offline".to_string())
    } else if root.join("Cargo.toml").is_file() {
        Some("cargo fetch".to_string())
    } else {
        None
    }
}

pub fn run_setup_script(
    root: &Path,
    script: &str,
    env_path: Option<String>,
    timeout: Duration,
) -> SetupResult {
    let started = Instant::now();
    let mut command = setup_command(script);
    command.current_dir(root);
    if let Some(path) = env_path {
        command.env("PATH", path);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return SetupResult {
                command: script.to_string(),
                exit_code: -1,
                duration_ms: started.elapsed().as_millis() as u64,
                output_tail: tail_output(error.to_string().into_bytes()),
            };
        }
    };

    let stdout = child.stdout.take().map(read_pipe);
    let stderr = child.stderr.take().map(read_pipe);
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut exit_code = -1;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code().unwrap_or(-1);
                break;
            }
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                kill_setup_process_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let output = collect_output(stdout, stderr);
                return SetupResult {
                    command: script.to_string(),
                    exit_code: -1,
                    duration_ms: started.elapsed().as_millis() as u64,
                    output_tail: tail_output([output, error.to_string().into_bytes()].concat()),
                };
            }
        }
    }

    let mut output = collect_output(stdout, stderr);
    if timed_out {
        output.extend_from_slice(
            format!("\nsetup timed out after {} ms", timeout.as_millis()).as_bytes(),
        );
        exit_code = -1;
    }

    SetupResult {
        command: script.to_string(),
        exit_code,
        duration_ms: started.elapsed().as_millis() as u64,
        output_tail: tail_output(output),
    }
}

fn setup_command(script: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = hidden_command("cmd");
        command.args(["/C", script]);
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = hidden_command("/bin/sh");
        command.args(["-c", script]);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
    }
}

#[cfg(unix)]
fn kill_setup_process_group(pid: u32) {
    // SAFETY: the child was spawned with process_group(0), so its pid is the
    // process-group id; killpg signals every process in that group.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_setup_process_group(pid: u32) {
    let _ = hidden_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_setup_process_group(_pid: u32) {}

fn read_pipe(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let _ = pipe.read_to_end(&mut output);
        output
    })
}

fn collect_output(
    stdout: Option<thread::JoinHandle<Vec<u8>>>,
    stderr: Option<thread::JoinHandle<Vec<u8>>>,
) -> Vec<u8> {
    let mut output = Vec::new();
    if let Some(handle) = stdout {
        output.extend(handle.join().unwrap_or_default());
    }
    if let Some(handle) = stderr {
        output.extend(handle.join().unwrap_or_default());
    }
    output
}

fn tail_output(output: Vec<u8>) -> String {
    let start = output.len().saturating_sub(SETUP_OUTPUT_LIMIT);
    String::from_utf8_lossy(&output[start..]).to_string()
}

pub fn release(
    root: &Path,
    source_repo: Option<&Path>,
    mode: LeaseMode,
) -> Result<(), String> {
    match mode {
        LeaseMode::Worktree => {
            if !root.exists() {
                return Ok(());
            }
            let source_repo = source_repo
                .ok_or_else(|| "worktree release requires source repository".to_string())?;
            let output = hidden_command("git")
                .current_dir(source_repo)
                .args(["worktree", "remove", "--force"])
                .arg(root)
                .output()
                .map_err(|error| error.to_string())?;
            if output.status.success() || !root.exists() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
            }
        }
        LeaseMode::Scratch
        | LeaseMode::SharedReadonly
        | LeaseMode::ExternalRead
        | LeaseMode::ExternalWrite => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::store;
    use crate::run::types::{NewLease, Run, RunStatus, Task, TaskState};
    use crate::services::database::{configure_connection, setup_schema};
    use rusqlite::Connection;
    use std::sync::Arc;

    fn request(
        run_id: &str,
        task_id: &str,
        task_slug: &str,
        mode: LeaseMode,
        source_path: Option<PathBuf>,
        workspaces_root: &Path,
    ) -> ProvisionRequest {
        ProvisionRequest {
            run_id: run_id.to_string(),
            task_id: task_id.to_string(),
            task_slug: task_slug.to_string(),
            mode,
            source_path,
            setup_script: None,
            workspaces_root: workspaces_root.to_path_buf(),
        }
    }

    fn git_command(cwd: &Path, arguments: &[&str]) {
        let output = hidden_command("git")
            .current_dir(cwd)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(cwd: &Path, arguments: &[&str]) -> String {
        let output = hidden_command("git")
            .current_dir(cwd)
            .args(arguments)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn make_git_repo(root: &Path) {
        git_command(root, &["init"]);
        git_command(root, &["config", "user.email", "workspace-tests@seren.local"]);
        git_command(root, &["config", "user.name", "Workspace Tests"]);
        fs::write(root.join("tracked.txt"), "initial\n").unwrap();
        git_command(root, &["add", "tracked.txt"]);
        git_command(root, &["commit", "-m", "initial"]);
    }

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn test_run() -> Run {
        Run {
            id: "run-1".to_string(),
            objective: "workspace test".to_string(),
            root_path: None,
            status: RunStatus::Running,
            cancel_requested: false,
            interrupted_at: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
        }
    }

    fn test_task() -> Task {
        Task {
            id: "task-1".to_string(),
            run_id: "run-1".to_string(),
            title: "workspace task".to_string(),
            brief: "workspace test".to_string(),
            state: TaskState::Pending,
            blocked_reason: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn slugify_normalizes_task_titles() {
        assert_eq!(slugify("  Build Workspace / Phase 3! "), "build-workspace-phase-3");
        assert_eq!(slugify("---"), "task");
        assert!(slugify(&"a".repeat(100)).len() <= 40);
    }

    #[test]
    fn scratch_provisions_in_non_git_dir() {
        let source = tempfile::tempdir().unwrap();
        let workspaces = tempfile::tempdir().unwrap();
        let provisioned = provision(&request(
            "run-123456789",
            "task-1",
            "Scratch task",
            LeaseMode::Scratch,
            Some(source.path().to_path_buf()),
            workspaces.path(),
        ))
        .unwrap();
        assert!(provisioned.root_path.exists());
        assert!(provisioned.root_path.starts_with(workspaces.path()));
        assert!(provisioned.base_revision.is_none());

        let conn = test_db();
        store::create_run(&conn, &test_run()).unwrap();
        store::add_task(&conn, &test_task(), &[]).unwrap();
        store::insert_lease(
            &conn,
            NewLease {
                id: "lease-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: "task-1".to_string(),
                mode: LeaseMode::Scratch,
            },
        )
        .unwrap();
        store::transition_task(&conn, "task-1", TaskState::Ready, None).unwrap();
        store::transition_task(&conn, "task-1", TaskState::Provisioning, None).unwrap();
        let root_string = provisioned.root_path.to_string_lossy().to_string();
        store::update_lease_state(&conn, "lease-1", "active", Some(&root_string), None).unwrap();
        store::transition_task(&conn, "task-1", TaskState::Ready, None).unwrap();
        let lease = store::get_lease(&conn, "lease-1").unwrap().unwrap();
        assert_eq!(lease.state, "active");
        assert_eq!(lease.root_path.as_deref(), Some(root_string.as_str()));
        let state: String = conn
            .query_row("SELECT state FROM run_tasks WHERE id = 'task-1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(state, "ready");
    }

    #[test]
    fn worktree_leaves_user_checkout_byte_identical() {
        let repo_root = tempfile::tempdir().unwrap();
        make_git_repo(repo_root.path());
        fs::write(repo_root.path().join("tracked.txt"), "uncommitted\n").unwrap();
        let before_status = git_output(repo_root.path(), &["status", "--porcelain"]);
        let before_head = git_output(repo_root.path(), &["rev-parse", "HEAD"]);
        let before_branch = git_output(repo_root.path(), &["rev-parse", "--abbrev-ref", "HEAD"]);
        let workspaces = tempfile::tempdir().unwrap();
        let provisioned = provision(&request(
            "run-123456789",
            "task-1",
            "A Workspace Task",
            LeaseMode::Worktree,
            Some(repo_root.path().to_path_buf()),
            workspaces.path(),
        ))
        .unwrap();
        let after_status = git_output(repo_root.path(), &["status", "--porcelain"]);
        let after_head = git_output(repo_root.path(), &["rev-parse", "HEAD"]);
        let after_branch = git_output(repo_root.path(), &["rev-parse", "--abbrev-ref", "HEAD"]);
        assert_eq!(before_status, after_status);
        assert_eq!(before_head, after_head);
        assert_eq!(before_branch, after_branch);
        assert_eq!(provisioned.base_revision.as_deref(), Some(before_head.trim()));
        assert_eq!(
            provisioned.branch_name.as_deref(),
            Some("seren/run-1234/a-workspace-task"),
        );
        assert!(provisioned.uncommitted_warning.is_some());
        assert!(!provisioned.root_path.starts_with(repo_root.path()));
        let second = provision(&request(
            "run-123456789",
            "task-1",
            "A Workspace Task",
            LeaseMode::Worktree,
            Some(repo_root.path().to_path_buf()),
            workspaces.path(),
        ))
        .unwrap();
        assert_ne!(provisioned.root_path, second.root_path);
        assert_ne!(provisioned.branch_name, second.branch_name);
        release(&second.root_path, Some(repo_root.path()), LeaseMode::Worktree).unwrap();
        release(
            &provisioned.root_path,
            Some(repo_root.path()),
            LeaseMode::Worktree,
        )
        .unwrap();
    }

    #[test]
    fn concurrent_writers_get_different_roots() {
        let workspaces = tempfile::tempdir().unwrap();
        let first = request(
            "run-123456789",
            "task-1",
            "Same Task",
            LeaseMode::Scratch,
            None,
            workspaces.path(),
        );
        let second = first.clone();
        let first = Arc::new(first);
        let second = Arc::new(second);
        let left = {
            let request = Arc::clone(&first);
            thread::spawn(move || provision(&request))
        };
        let right = {
            let request = Arc::clone(&second);
            thread::spawn(move || provision(&request))
        };
        let left = left.join().unwrap().unwrap();
        let right = right.join().unwrap().unwrap();
        assert_ne!(left.root_path, right.root_path);
        release(&left.root_path, None, LeaseMode::Scratch).unwrap();
        release(&right.root_path, None, LeaseMode::Scratch).unwrap();
    }

    #[test]
    fn setup_failure_is_recoverable_not_a_hang() {
        let root = tempfile::tempdir().unwrap();
        let failed = run_setup_script(root.path(), "exit 7", None, Duration::from_secs(2));
        assert_eq!(failed.exit_code, 7);
        let started = Instant::now();
        let timed_out = run_setup_script(root.path(), "sleep 60", None, Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(timed_out.exit_code, -1);
        assert!(timed_out.output_tail.contains("timed out"));

        let conn = test_db();
        store::create_run(&conn, &test_run()).unwrap();
        store::add_task(&conn, &test_task(), &[]).unwrap();
        store::insert_lease(
            &conn,
            NewLease {
                id: "lease-1".to_string(),
                run_id: "run-1".to_string(),
                task_id: "task-1".to_string(),
                mode: LeaseMode::Scratch,
            },
        )
        .unwrap();
        store::transition_task(&conn, "task-1", TaskState::Ready, None).unwrap();
        store::transition_task(&conn, "task-1", TaskState::Provisioning, None).unwrap();
        store::update_lease_state(&conn, "lease-1", "setup_failed", None, None).unwrap();
        store::transition_task(&conn, "task-1", TaskState::Ready, None).unwrap();
        assert_eq!(
            store::get_lease(&conn, "lease-1").unwrap().unwrap().state,
            "setup_failed"
        );
    }

    #[test]
    fn setup_timeout_kills_process_group() {
        let root = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let timed_out = run_setup_script(
            root.path(),
            "sleep 60 & wait",
            None,
            Duration::from_secs(2),
        );

        assert!(
            started.elapsed() < Duration::from_secs(5),
            "setup timeout took {:?}",
            started.elapsed()
        );
        assert_eq!(timed_out.exit_code, -1);
        assert!(timed_out.output_tail.contains("timed out"));
    }

    #[test]
    fn release_removes_worktree_and_keeps_scratch() {
        let repo_root = tempfile::tempdir().unwrap();
        make_git_repo(repo_root.path());
        let workspaces = tempfile::tempdir().unwrap();
        let worktree = provision(&request(
            "run-release",
            "task-1",
            "worktree",
            LeaseMode::Worktree,
            Some(repo_root.path().to_path_buf()),
            workspaces.path(),
        ))
        .unwrap();
        let worktree_root = worktree.root_path.clone();
        release(&worktree_root, Some(repo_root.path()), LeaseMode::Worktree).unwrap();
        assert!(!worktree_root.exists());
        let worktree_root_string = worktree_root.to_string_lossy().to_string();
        assert!(!git_output(repo_root.path(), &["worktree", "list"])
            .contains(worktree_root_string.as_str()));

        let scratch = provision(&request(
            "run-release",
            "task-2",
            "scratch",
            LeaseMode::Scratch,
            None,
            workspaces.path(),
        ))
        .unwrap();
        let scratch_root = scratch.root_path.clone();
        release(&scratch_root, None, LeaseMode::Scratch).unwrap();
        assert!(scratch_root.exists());
    }
}
