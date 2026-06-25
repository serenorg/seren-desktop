// ABOUTME: Headless entrypoint that flushes pending Claude memory files into
// ABOUTME: SerenDB and re-renders MEMORY.md without launching the desktop app.
//
// Runs the AppHandle-free sync core (#2639). Credentials and the SerenDB
// destination are supplied via env so this never reads the app's secure store:
//
//   SEREN_API_KEY                     SerenDB data-plane API key (required)
//   SEREN_CLAUDE_MEMORY_PROJECT_ID    claude-agent-prefs project UUID (required)
//   SEREN_CLAUDE_MEMORY_BRANCH_ID     branch UUID (required)
//   SEREN_CLAUDE_MEMORY_DATABASE      database name, e.g. claude_agent_prefs (required)
//   SEREN_CLAUDE_MEMORY_PROJECT_CWD   optional: sync just this repo's memory
//
// Usage:
//   SEREN_API_KEY=... SEREN_CLAUDE_MEMORY_PROJECT_ID=... \
//   SEREN_CLAUDE_MEMORY_BRANCH_ID=... SEREN_CLAUDE_MEMORY_DATABASE=claude_agent_prefs \
//   cargo run --example claude_memory_sync

use std::path::PathBuf;
use std::process::ExitCode;

use seren_desktop_lib::claude_memory::{
    SerenDbConfig, SerenDbSqlClient, sync_all_projects, sync_project,
};

fn require_env(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("missing required env var {name}")),
    }
}

fn main() -> ExitCode {
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("failed to start tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    match rt.block_on(run()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("claude_memory_sync failed: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let api_key = require_env("SEREN_API_KEY")?;
    let config = SerenDbConfig {
        project_id: require_env("SEREN_CLAUDE_MEMORY_PROJECT_ID")?,
        branch_id: require_env("SEREN_CLAUDE_MEMORY_BRANCH_ID")?,
        database_name: require_env("SEREN_CLAUDE_MEMORY_DATABASE")?,
    };
    let client = SerenDbSqlClient::new(api_key);

    let report = match std::env::var("SEREN_CLAUDE_MEMORY_PROJECT_CWD") {
        Ok(cwd) if !cwd.trim().is_empty() => {
            println!("Syncing single project: {cwd}");
            sync_project(&client, &config, &PathBuf::from(cwd)).await?
        }
        _ => {
            println!("Syncing all projects under ~/.claude/projects");
            sync_all_projects(&client, &config).await?
        }
    };

    println!(
        "Done: persisted={} failures={} rendered={} render_failures={}",
        report.persisted, report.failures, report.rendered, report.render_failures
    );
    Ok(())
}
