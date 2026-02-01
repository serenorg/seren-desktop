// ABOUTME: Manages sandboxed terminal processes for ACP agent command execution.
// ABOUTME: Handles process spawning, output buffering, and lifecycle management.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

use crate::sandbox::SandboxConfig;

/// Exit status of a terminal process.
#[derive(Debug, Clone)]
pub struct ExitStatus {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

/// Internal output buffer with optional byte limit and truncation tracking.
struct OutputBuffer {
    buffer: String,
    byte_limit: Option<u64>,
    truncated: bool,
}

impl OutputBuffer {
    fn new(byte_limit: Option<u64>) -> Self {
        Self {
            buffer: String::new(),
            byte_limit,
            truncated: false,
        }
    }

    fn append(&mut self, text: &str) {
        self.buffer.push_str(text);

        if let Some(limit) = self.byte_limit {
            let limit = limit as usize;
            if self.buffer.len() > limit {
                self.truncated = true;
                // Truncate from the beginning, keeping the most recent output.
                // Find a valid char boundary near the target start position.
                let excess = self.buffer.len() - limit;
                // Find the nearest char boundary at or after `excess`
                let mut start = excess;
                while start < self.buffer.len() && !self.buffer.is_char_boundary(start) {
                    start += 1;
                }
                self.buffer = self.buffer[start..].to_string();
            }
        }
    }
}

/// A running or completed terminal process.
struct TerminalProcess {
    output: Arc<Mutex<OutputBuffer>>,
    exit_status: Arc<Mutex<Option<ExitStatus>>>,
    exit_notify: Arc<Notify>,
    child_id: Option<u32>,
}

/// Manages all terminal processes for a single ACP session.
pub struct TerminalManager {
    terminals: HashMap<String, TerminalProcess>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
        }
    }

    /// Spawn a new sandboxed terminal process.
    ///
    /// The command is wrapped with `sandbox-exec` on macOS when the sandbox mode
    /// is not FullAccess. Output from stdout and stderr is merged into a single buffer.
    pub async fn create(
        &mut self,
        terminal_id: String,
        command: &str,
        args: &[String],
        env_vars: &[(String, String)],
        cwd: &Path,
        output_byte_limit: Option<u64>,
        sandbox_config: &SandboxConfig,
        env_path: &str,
    ) -> Result<(), String> {
        if self.terminals.contains_key(&terminal_id) {
            return Err(format!("Terminal {} already exists", terminal_id));
        }

        // Wrap command with sandbox if applicable
        let (exec_cmd, exec_args) = crate::sandbox::wrap_command(command, args, sandbox_config);

        let mut cmd = Command::new(&exec_cmd);
        cmd.args(&exec_args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        // Set PATH with embedded runtime prepended
        if !env_path.is_empty() {
            cmd.env("PATH", env_path);
        }

        // Apply additional env vars from the request
        for (key, value) in env_vars {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn terminal: {}", e))?;

        let child_id = child.id();
        let output = Arc::new(Mutex::new(OutputBuffer::new(output_byte_limit)));
        let exit_status: Arc<Mutex<Option<ExitStatus>>> = Arc::new(Mutex::new(None));
        let exit_notify = Arc::new(Notify::new());

        // Take stdout and stderr handles before moving child
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Background task: read stdout
        if let Some(stdout) = stdout {
            let out = Arc::clone(&output);
            tokio::task::spawn_local(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buf = out.lock().await;
                    buf.append(&line);
                    buf.append("\n");
                }
            });
        }

        // Background task: read stderr
        if let Some(stderr) = stderr {
            let out = Arc::clone(&output);
            tokio::task::spawn_local(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut buf = out.lock().await;
                    buf.append(&line);
                    buf.append("\n");
                }
            });
        }

        // Background task: wait for exit
        let exit_s = Arc::clone(&exit_status);
        let exit_n = Arc::clone(&exit_notify);
        tokio::task::spawn_local(async move {
            match child.wait().await {
                Ok(status) => {
                    let code = status.code().map(|c| c as u32);
                    #[cfg(unix)]
                    let signal = {
                        use std::os::unix::process::ExitStatusExt;
                        status.signal().map(|s| format!("{}", s))
                    };
                    #[cfg(not(unix))]
                    let signal = None;

                    *exit_s.lock().await = Some(ExitStatus {
                        exit_code: code,
                        signal,
                    });
                }
                Err(e) => {
                    *exit_s.lock().await = Some(ExitStatus {
                        exit_code: None,
                        signal: Some(format!("error: {}", e)),
                    });
                }
            }
            exit_n.notify_waiters();
        });

        self.terminals.insert(
            terminal_id,
            TerminalProcess {
                output,
                exit_status,
                exit_notify,
                child_id,
            },
        );

        Ok(())
    }

    /// Get the current output buffer contents and exit status.
    pub async fn get_output(
        &self,
        terminal_id: &str,
    ) -> Result<(String, bool, Option<ExitStatus>), String> {
        let process = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

        let buf = process.output.lock().await;
        let exit = process.exit_status.lock().await;

        Ok((buf.buffer.clone(), buf.truncated, exit.clone()))
    }

    /// Wait for the terminal process to exit. Returns the exit status.
    pub async fn wait_for_exit(&self, terminal_id: &str) -> Result<ExitStatus, String> {
        let process = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

        // Check if already exited
        {
            let exit = process.exit_status.lock().await;
            if let Some(status) = exit.as_ref() {
                return Ok(status.clone());
            }
        }

        // Wait for the exit notification
        process.exit_notify.notified().await;

        let exit = process.exit_status.lock().await;
        exit.clone()
            .ok_or_else(|| format!("Terminal {} exited but status unavailable", terminal_id))
    }

    /// Send SIGKILL to the terminal process.
    pub fn kill(&self, terminal_id: &str) -> Result<(), String> {
        let process = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

        if let Some(pid) = process.child_id {
            #[cfg(unix)]
            {
                // SAFETY: Sending SIGTERM to a known child process PID
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
            #[cfg(not(unix))]
            {
                let _ = pid;
                // On Windows, kill_on_drop handles cleanup
            }
        }

        Ok(())
    }

    /// Release a terminal, freeing its resources.
    pub fn release(&mut self, terminal_id: &str) -> Result<(), String> {
        self.terminals.remove(terminal_id);
        Ok(())
    }

    /// Release all terminals, freeing all resources.
    /// Called when a session terminates to prevent orphaned processes.
    pub fn release_all(&mut self) {
        let count = self.terminals.len();
        self.terminals.clear();
        if count > 0 {
            log::info!("[TerminalManager] Released {} terminal(s) on session cleanup", count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_output_buffer_basic() {
        let mut buf = OutputBuffer::new(None);
        buf.append("hello\n");
        buf.append("world\n");
        assert_eq!(buf.buffer, "hello\nworld\n");
        assert!(!buf.truncated);
    }

    #[test]
    fn test_output_buffer_truncation() {
        let mut buf = OutputBuffer::new(Some(10));
        buf.append("0123456789"); // exactly 10 bytes
        assert!(!buf.truncated);

        buf.append("extra"); // now 15, over limit
        assert!(buf.truncated);
        assert!(buf.buffer.len() <= 10);
    }
}
