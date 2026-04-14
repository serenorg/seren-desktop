// ABOUTME: Messaging transport module — Telegram, Discord, WhatsApp adapters.
// ABOUTME: Each platform implements MessagingAdapter; shared handler routes through the orchestrator.

pub mod adapter;
pub mod commands;
pub mod formatter;
pub mod store;

#[cfg(feature = "telegram")]
pub mod telegram;

#[cfg(feature = "discord")]
pub mod discord;

#[cfg(feature = "whatsapp")]
pub mod whatsapp;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::messaging::adapter::MessagingAdapter;

pub struct MessagingState {
    adapters: Mutex<HashMap<String, Arc<dyn MessagingAdapter>>>,
}

impl MessagingState {
    pub fn new() -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
        }
    }

    pub async fn register(&self, platform: String, adapter: Arc<dyn MessagingAdapter>) {
        self.adapters.lock().await.insert(platform, adapter);
    }

    pub async fn get(&self, platform: &str) -> Option<Arc<dyn MessagingAdapter>> {
        self.adapters.lock().await.get(platform).cloned()
    }

    pub async fn remove(&self, platform: &str) -> Option<Arc<dyn MessagingAdapter>> {
        self.adapters.lock().await.remove(platform)
    }

    pub async fn status_all(&self) -> Vec<PlatformStatus> {
        let adapters = self.adapters.lock().await;
        let mut statuses = Vec::new();
        for (platform, adapter) in adapters.iter() {
            statuses.push(PlatformStatus {
                platform: platform.clone(),
                running: adapter.is_running(),
                bot_username: adapter.bot_username(),
            });
        }
        statuses
    }
}

#[derive(serde::Serialize, Clone)]
pub struct PlatformStatus {
    pub platform: String,
    pub running: bool,
    pub bot_username: Option<String>,
}
