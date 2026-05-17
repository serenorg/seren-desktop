// ABOUTME: Shell command execution for AI tool calls.
// ABOUTME: Runs commands with timeout and output capture, invoked via Tauri IPC.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;
use tokio::process::Command;

const AUTH_STORE: &str = "auth.json";
const SEREN_API_KEY_KEY: &str = "seren_api_key";
const MAX_OUTPUT_BYTES: usize = 50_000;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;

/// Wrap a shell command string in outer double quotes so that `cmd.exe /S /C`
/// strips them verbatim. This keeps any inner quotes (e.g. around absolute
/// paths with spaces) intact instead of letting cmd.exe's default /C quote
/// rule mis-parse them as cwd-relative — the classic
/// `python: can't open file 'C:\cwd\"C:\abs\path.py"'` failure on Windows.
#[cfg(any(target_os = "windows", test))]
fn wrap_for_cmd_slash_s(command: &str) -> String {
    format!("\"{}\"", command)
}

/// Match the Microsoft Store / WindowsApps `python.exe` stub stderr. The
/// stub never runs Python — it tells the user to install from the Store
/// and exits 9009. Detecting it lets us retry with `py -3` (the python.org
/// launcher) so a skill that says `python foo.py` keeps working without
/// the user having to disable the App Execution Alias by hand.
///
/// Compiled in on Windows (where the retry path uses it) and under `test`
/// so the matcher is unit-tested on every CI runner.
#[cfg(any(target_os = "windows", test))]
fn looks_like_windows_apps_python_stub(stderr: &str) -> bool {
    stderr.contains("Python was not found") && stderr.contains("Microsoft Store")
}

/// Rewrite `python` invocations in a shell command to `py -3`, but only
/// at shell-token boundaries. Returns `None` when there is nothing to
/// rewrite — callers use that to skip the Windows retry entirely.
///
/// Boundary rules: the `python` token must start at end-of-string, after
/// whitespace, or after one of `& | ; (`. It must end at end-of-string,
/// before whitespace, or before one of `& | ; )`. That keeps `python3`,
/// `python.exe`, `/usr/bin/python` (preceded by `/`), and `pythonista`
/// untouched while still rewriting `python` at the start of a command or
/// after a shell separator.
#[cfg(any(target_os = "windows", test))]
fn translate_python_to_py_launcher(command: &str) -> Option<String> {
    const NEEDLE: &str = "python";

    fn is_boundary_before(prev: Option<char>) -> bool {
        match prev {
            None => true,
            Some(c) => matches!(c, ' ' | '\t' | '&' | '|' | ';' | '(' | '\n' | '\r'),
        }
    }

    fn is_boundary_after(next: Option<char>) -> bool {
        match next {
            None => true,
            Some(c) => matches!(c, ' ' | '\t' | '&' | '|' | ';' | ')' | '\n' | '\r'),
        }
    }

    let mut result = String::with_capacity(command.len() + 4);
    let mut last = 0usize;
    let mut replaced = false;

    for (idx, _) in command.match_indices(NEEDLE) {
        let prev = command[..idx].chars().last();
        let next = command[idx + NEEDLE.len()..].chars().next();
        if is_boundary_before(prev) && is_boundary_after(next) {
            result.push_str(&command[last..idx]);
            result.push_str("py -3");
            last = idx + NEEDLE.len();
            replaced = true;
        }
    }

    if !replaced {
        return None;
    }
    result.push_str(&command[last..]);
    Some(result)
}

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[tauri::command]
pub async fn execute_shell_command<R: Runtime>(
    app: AppHandle<R>,
    command: String,
    timeout_secs: Option<u64>,
    inject_seren_credentials: Option<bool>,
) -> Result<CommandResult, String> {
    let api_key = if should_inject_seren_credentials(&command, inject_seren_credentials) {
        read_stored_seren_api_key(&app)?
    } else {
        None
    };

    execute_shell_command_inner(command, timeout_secs, api_key.as_deref()).await
}

/// Execute an AI tool shell command with optional stored Seren auth injection.
///
/// `inject_seren_credentials = None` uses the same narrow auto-detect policy as
/// the Tauri command so skill-local commands keep working without exposing the
/// key to ordinary commands such as `ls`.
pub async fn execute_shell_command_for_tool<R: Runtime>(
    app: &AppHandle<R>,
    command: String,
    timeout_secs: Option<u64>,
    inject_seren_credentials: Option<bool>,
) -> Result<CommandResult, String> {
    let api_key = if should_inject_seren_credentials(&command, inject_seren_credentials) {
        read_stored_seren_api_key(app)?
    } else {
        None
    };

    execute_shell_command_inner(command, timeout_secs, api_key.as_deref()).await
}

pub async fn execute_shell_command_without_seren_credentials(
    command: String,
    timeout_secs: Option<u64>,
) -> Result<CommandResult, String> {
    execute_shell_command_inner(command, timeout_secs, None).await
}

async fn execute_shell_command_inner(
    command: String,
    timeout_secs: Option<u64>,
    seren_api_key: Option<&str>,
) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("Command must not be empty".to_string());
    }

    let secs = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(MAX_TIMEOUT_SECS);

    let result = spawn_one_shot(&command, secs, seren_api_key).await?;

    // GH #1908: on Windows, when the user has no real Python on PATH but the
    // App Execution Alias for Python is still enabled, `python …` is routed
    // to the WindowsApps stub which prints a Microsoft Store prompt and
    // exits without running Python. The python.org installer registers a
    // separate `py` launcher that always finds a real interpreter. When we
    // see both conditions — stub stderr and a rewritable `python` token —
    // retry once via the launcher.
    #[cfg(target_os = "windows")]
    {
        if looks_like_windows_apps_python_stub(&result.stderr) {
            if let Some(retry_command) = translate_python_to_py_launcher(&command) {
                log::info!(
                    "[Shell] WindowsApps Python stub detected; retrying via `py` launcher"
                );
                return spawn_one_shot(&retry_command, secs, seren_api_key).await;
            }
        }
    }

    Ok(result)
}

async fn spawn_one_shot(
    command: &str,
    secs: u64,
    seren_api_key: Option<&str>,
) -> Result<CommandResult, String> {
    let timeout = Duration::from_secs(secs);

    let mut cmd = Command::new(if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "/bin/sh"
    });

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // /D disables AutoRun, /S forces cmd.exe to strip exactly one pair
        // of outer quotes from the /C string (overriding its complex default
        // rule). We then wrap the command in those outer quotes ourselves
        // via raw_arg so any inner quotes around absolute paths survive.
        cmd.as_std_mut()
            .raw_arg("/D")
            .raw_arg("/S")
            .raw_arg("/C")
            .raw_arg(wrap_for_cmd_slash_s(command));
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    #[cfg(not(target_os = "windows"))]
    {
        cmd.args(["-c", command]);
    }

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

    cmd.env_remove("SEREN_API_KEY");
    cmd.env_remove("API_KEY");
    if let Some(api_key) = seren_api_key.filter(|key| !key.is_empty()) {
        cmd.env("SEREN_API_KEY", api_key);
        cmd.env("API_KEY", api_key);
    }

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Log the exact CWD we inherit and the command we're about to run.
    // GH #1595: a Windows user reported tool-written files landing
    // "nowhere on disk" — one plausible cause is a shell subprocess
    // writing to a relative path from a CWD the user didn't expect
    // (e.g. the app's install directory under UAC virtualisation).
    // Surfacing the CWD in the log makes that class of failure visible
    // instead of silent.
    let inherited_cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("<unknown: {e}>"));
    log::info!(
        "[Shell] spawning: cwd={} timeout={}s cmd={}",
        inherited_cwd,
        secs,
        &command[..command.len().min(500)]
    );

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

fn read_stored_seren_api_key<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    let key = app
        .store(AUTH_STORE)
        .map_err(|err| err.to_string())?
        .get(SEREN_API_KEY_KEY)
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();

    let trimmed = key.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

fn should_inject_seren_credentials(command: &str, requested: Option<bool>) -> bool {
    requested.unwrap_or_else(|| command_targets_seren_skill(command))
}

fn command_targets_seren_skill(command: &str) -> bool {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();
    normalized.contains(".config/seren/skills/")
        || normalized.contains("/seren/skills/")
        || normalized.contains("%appdata%/seren/skills/")
        || normalized.contains("appdata/roaming/seren/skills/")
        || normalized.contains("appdata/local/seren/skills/")
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
    match execute_shell_command_without_seren_credentials(command.to_string(), Some(timeout_secs))
        .await
    {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tauri_plugin_store::StoreExt;

    fn print_seren_key_env_command() -> &'static str {
        if cfg!(target_os = "windows") {
            "echo %SEREN_API_KEY%^|%API_KEY%"
        } else {
            "printf '%s|%s' \"${SEREN_API_KEY:-}\" \"${API_KEY:-}\""
        }
    }

    fn mock_app_with_api_key(api_key: Option<&str>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");

        // Open the store and ALWAYS reset the key — `tauri-plugin-store`
        // persists `auth.json` to the mock runtime's data dir, which is
        // shared across sibling test invocations on the same host. Without
        // an explicit delete, a prior `mock_app_with_api_key(Some("..."))`
        // call leaves the key on disk; the next `Some(None)` call inherits
        // it and the "logged out" assertion fails. Per-test self-containment
        // is the only safe contract here. #1945.
        let store = app.store(AUTH_STORE).expect("auth store opens");
        store.delete(SEREN_API_KEY_KEY);
        if let Some(api_key) = api_key {
            store.set(SEREN_API_KEY_KEY, json!(api_key));
        }

        app
    }

    #[test]
    fn wrap_for_cmd_slash_s_preserves_inner_quotes() {
        // Regression for #1579: wrapping the command in an extra outer pair
        // of quotes is what lets `cmd.exe /D /S /C` strip exactly that pair,
        // so any inner quotes around absolute paths survive untouched. The
        // function itself is platform-independent; we exercise it on every
        // target so CI catches breakage without needing Windows.
        let cmd = r#"python "C:\Users\test\script.py""#;
        let wrapped = wrap_for_cmd_slash_s(cmd);
        assert!(wrapped.starts_with('"'));
        assert!(wrapped.ends_with('"'));
        assert!(wrapped.contains(r#""C:\Users\test\script.py""#));
    }

    #[tokio::test]
    async fn execute_shell_command_injects_stored_seren_credentials_when_requested() {
        let app = mock_app_with_api_key(Some("seren_test_shell_key"));

        let result = execute_shell_command(
            app.handle().clone(),
            print_seren_key_env_command().to_string(),
            Some(5),
            Some(true),
        )
        .await
        .expect("command succeeds");

        assert_eq!(result.exit_code, Some(0));
        assert_eq!(
            result.stdout.trim(),
            "seren_test_shell_key|seren_test_shell_key"
        );
    }

    #[tokio::test]
    async fn execute_shell_command_scrubs_seren_credentials_when_not_requested() {
        let app = mock_app_with_api_key(Some("seren_test_shell_key"));

        let result = execute_shell_command(
            app.handle().clone(),
            print_seren_key_env_command().to_string(),
            Some(5),
            None,
        )
        .await
        .expect("command succeeds");

        assert_eq!(result.exit_code, Some(0));
        assert!(!result.stdout.contains("seren_test_shell_key"));
    }

    #[tokio::test]
    async fn execute_shell_command_leaves_seren_credentials_empty_when_logged_out() {
        let app = mock_app_with_api_key(None);

        let result = execute_shell_command(
            app.handle().clone(),
            print_seren_key_env_command().to_string(),
            Some(5),
            Some(true),
        )
        .await
        .expect("command succeeds");

        assert_eq!(result.exit_code, Some(0));
        assert_ne!(
            result.stdout.trim(),
            "seren_test_shell_key|seren_test_shell_key"
        );
    }

    #[test]
    fn auto_injection_only_targets_seren_skill_directories() {
        assert!(should_inject_seren_credentials(
            "cd ~/.config/seren/skills/prophet-arb-bot && python3 scripts/agent.py",
            None,
        ));
        assert!(should_inject_seren_credentials(
            r#"cd "%APPDATA%\Seren\skills\prophet-arb-bot" && python scripts\agent.py"#,
            None,
        ));
        assert!(!should_inject_seren_credentials("ls -la", None));
        assert!(!should_inject_seren_credentials(
            "python3 ./scripts/agent.py",
            None,
        ));
    }

    /// GH #1908: the matcher must recognise the WindowsApps stub stderr and
    /// reject ordinary Python stderr. This is the only signal we have to
    /// trigger the `py -3` retry; a false negative leaves Windows users
    /// looking at a Microsoft Store prompt, a false positive would silently
    /// retry a legitimate Python error and confuse the user further.
    #[test]
    fn looks_like_windows_apps_python_stub_matches_only_store_stub() {
        let real_stub = "Python was not found; run without arguments to install \
                         from the Microsoft Store, or disable this shortcut from \
                         Settings > Apps > Advanced app settings > App execution \
                         aliases.";
        assert!(looks_like_windows_apps_python_stub(real_stub));

        // Real Python tracebacks must not match — they don't carry the
        // Store anchor, even if the word "Python" shows up.
        let traceback = "Traceback (most recent call last):\n  File \"a.py\", \
                        line 1, in <module>\nModuleNotFoundError: No module named 'foo'";
        assert!(!looks_like_windows_apps_python_stub(traceback));

        // An unrelated "Microsoft Store" string with no Python anchor must
        // not match either — we require both phrases.
        assert!(!looks_like_windows_apps_python_stub(
            "Some other tool referenced the Microsoft Store."
        ));

        assert!(!looks_like_windows_apps_python_stub(""));
    }

    /// GH #1908: token-boundary safety. The retry rewrite must replace
    /// `python` only when it's the actual invocation, and never when it's
    /// part of a longer word, a versioned binary, a path component, or
    /// `python3`. Each assertion here corresponds to a real shell pattern
    /// seen in production skill commands.
    #[test]
    fn translate_python_to_py_launcher_respects_token_boundaries() {
        // Start-of-command and chained command — both must rewrite.
        assert_eq!(
            translate_python_to_py_launcher("python scripts/agent.py").as_deref(),
            Some("py -3 scripts/agent.py")
        );
        assert_eq!(
            translate_python_to_py_launcher(
                "cd ~/.config/seren/skills/prophet-arb-bot && python scripts/agent.py"
            )
            .as_deref(),
            Some("cd ~/.config/seren/skills/prophet-arb-bot && py -3 scripts/agent.py")
        );

        // Command-only invocation with no args — boundary at end-of-string.
        assert_eq!(
            translate_python_to_py_launcher("python").as_deref(),
            Some("py -3")
        );

        // `python3` keeps `python` as a prefix but is not a bare token —
        // it must not be rewritten because the python.org `py -3` launcher
        // is for users who only have the Microsoft Store stub installed;
        // `python3` already resolves to a real interpreter when present.
        assert!(translate_python_to_py_launcher("python3 scripts/agent.py").is_none());

        // `python.exe`, path-prefixed `python`, and longer words must all
        // be left alone.
        assert!(translate_python_to_py_launcher("python.exe scripts/agent.py").is_none());
        assert!(translate_python_to_py_launcher("/usr/bin/python scripts/agent.py").is_none());
        assert!(translate_python_to_py_launcher("pythonista --help").is_none());

        // No-python commands return None so the retry path stays inert.
        assert!(translate_python_to_py_launcher("ls -la").is_none());
        assert!(translate_python_to_py_launcher("").is_none());
    }
}
