//! Seren Claude ACP Agent
//!
//! This binary provides Claude Code integration via the Agent Client Protocol.

use claude_code_acp::run_acp;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run_acp().await?;
    Ok(())
}
