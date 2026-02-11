// ABOUTME: Worker trait that all worker adapters implement.
// ABOUTME: Workers receive prompts and stream events back through a channel.

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::types::{ImageAttachment, RoutingDecision, WorkerEvent};

/// The Worker trait that all worker adapters implement.
/// Each worker receives a prompt + context and streams events back.
#[allow(dead_code)]
#[async_trait]
pub trait Worker: Send + Sync {
    /// Worker identifier (e.g. "chat_model", "claude-code", "codex")
    fn id(&self) -> &str;

    /// Send a prompt and stream events back through the channel.
    ///
    /// `skill_content` is pre-loaded Markdown from the selected SKILL.md files
    /// (concatenated, ready to inject into system prompt). Empty if no skills selected.
    /// `app` provides access to the token store for authenticated Gateway requests.
    /// `images` contains base64-encoded image attachments from the user.
    async fn execute(
        &self,
        prompt: &str,
        conversation_context: &[serde_json::Value],
        routing: &RoutingDecision,
        skill_content: &str,
        app: &tauri::AppHandle,
        images: &[ImageAttachment],
        event_tx: mpsc::Sender<WorkerEvent>,
    ) -> Result<(), String>;

    /// Cancel an in-progress execution.
    async fn cancel(&self) -> Result<(), String>;
}
