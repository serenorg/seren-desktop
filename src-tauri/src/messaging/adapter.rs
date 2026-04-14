// ABOUTME: Shared trait for all messaging platform adapters.
// ABOUTME: Each platform (Telegram, Discord, WhatsApp) implements this interface.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::any::Any;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolApprovalRequest {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments_json: String,
}

#[async_trait]
pub trait MessagingAdapter: Send + Sync {
    fn platform(&self) -> &'static str;

    async fn start(&self, config: AdapterConfig) -> Result<(), String>;

    async fn stop(&self) -> Result<(), String>;

    fn is_running(&self) -> bool;

    fn bot_username(&self) -> Option<String>;

    fn as_any(&self) -> &dyn Any;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterConfig {
    pub token: String,
    /// Restrict to this user/channel ID. Messages from other users are ignored.
    pub allowed_user_id: Option<String>,
    /// WhatsApp-specific: phone number ID for sending messages.
    pub phone_number_id: Option<String>,
}
