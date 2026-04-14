// ABOUTME: Discord bot adapter using serenity with WebSocket gateway.
// ABOUTME: No public URL needed — connects outbound to Discord's gateway.

use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use serenity::async_trait as serenity_async_trait;
use serenity::client::{Client, Context, EventHandler};
use serenity::model::channel::Message;
use serenity::model::gateway::Ready;
use serenity::prelude::GatewayIntents;

use crate::messaging::adapter::{AdapterConfig, MessagingAdapter};

struct Handler {
    allowed_user_id: Option<u64>,
}

#[serenity_async_trait]
impl EventHandler for Handler {
    async fn message(&self, ctx: Context, msg: Message) {
        if msg.author.bot {
            return;
        }

        if let Some(allowed_id) = self.allowed_user_id {
            if msg.author.id.get() != allowed_id {
                let _ = msg
                    .reply(&ctx.http, "This is a personal Seren bot.")
                    .await;
                return;
            }
        }

        let content = &msg.content;
        let response = match content.as_str() {
            "!help" | "!start" => {
                "Welcome to Seren! Commands:\n\
                 `!new` — Start new conversation\n\
                 `!model` — Change AI model\n\
                 `!balance` — Check SerenBucks balance\n\
                 `!tools` — List available tools\n\
                 `!stop` — Cancel current request\n\
                 `!help` — Show this help\n\n\
                 Send any message to chat with Seren AI."
                    .to_string()
            }
            "!new" => "Started a new conversation.".to_string(),
            _ => {
                if content.starts_with('!') {
                    return;
                }
                // Placeholder: will be wired to orchestrator
                format!("Received: {content}\n\n(Orchestrator integration pending — this bot is connected and listening.)")
            }
        };

        if let Err(e) = msg.channel_id.say(&ctx.http, &response).await {
            log::warn!("[Discord] Failed to send message: {e}");
        }
    }

    async fn ready(&self, _ctx: Context, ready: Ready) {
        log::info!("[Discord] Connected as {}", ready.user.name);
    }
}

pub struct DiscordAdapter {
    running: Arc<AtomicBool>,
    bot_username: Mutex<Option<String>>,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    allowed_user_id: Mutex<Option<u64>>,
}

impl DiscordAdapter {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            bot_username: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            allowed_user_id: Mutex::new(None),
        }
    }
}

#[async_trait]
impl MessagingAdapter for DiscordAdapter {
    fn platform(&self) -> &'static str {
        "discord"
    }

    async fn start(&self, config: AdapterConfig) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("Discord bot is already running".into());
        }

        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT;

        let allowed_user = config
            .allowed_user_id
            .as_ref()
            .and_then(|id| id.parse::<u64>().ok());

        *self.allowed_user_id.lock().await = allowed_user;

        let handler = Handler {
            allowed_user_id: allowed_user,
        };

        let mut client = Client::builder(&config.token, intents)
            .event_handler(handler)
            .await
            .map_err(|e| format!("Failed to create Discord client: {e}"))?;

        let http = client.http.clone();
        let me = http
            .get_current_user()
            .await
            .map_err(|e| format!("Failed to get Discord bot info: {e}"))?;

        let username = me.name.clone();
        *self.bot_username.lock().await = Some(username.clone());

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        self.running.store(true, Ordering::SeqCst);

        let running_flag = self.running.clone();
        let shard_manager = client.shard_manager.clone();

        tokio::spawn(async move {
            tokio::select! {
                result = client.start() => {
                    if let Err(e) = result {
                        log::error!("[Discord] Client error: {e}");
                    }
                }
                _ = &mut shutdown_rx => {
                    log::info!("[Discord] Shutdown signal received");
                    shard_manager.shutdown_all().await;
                }
            }
            running_flag.store(false, Ordering::SeqCst);
            log::info!("[Discord] Bot stopped");
        });

        log::info!("[Discord] Bot started as {}", username);
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("Discord bot is not running".into());
        }

        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }

        self.running.store(false, Ordering::SeqCst);
        *self.bot_username.lock().await = None;
        log::info!("[Discord] Bot stop requested");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn bot_username(&self) -> Option<String> {
        self.bot_username.try_lock().ok()?.clone()
    }
}
