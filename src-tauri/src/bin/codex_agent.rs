//! Seren Codex ACP Agent
//!
//! This binary provides OpenAI Codex integration via the Agent Client Protocol.

use seren_acp_codex::acp::run_acp_server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run_acp_server("stdio").await?;
    Ok(())
}
