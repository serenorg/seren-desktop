//! ACP Agent binary (acp_agent)
//!
//! This binary wraps claude-code-acp-rs to provide an ACP-compatible agent
//! that can be spawned by the Seren desktop app.
//!
//! It communicates via stdin/stdout using the ACP protocol and connects
//! to Claude's API to provide AI coding assistance.

use claude_code_acp::run_acp;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run_acp().await?;
    Ok(())
}
