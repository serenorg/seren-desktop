// ABOUTME: Telegram bot adapter using teloxide with long-polling.
// ABOUTME: No public URL needed — works behind NAT on any laptop.

use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use teloxide::prelude::*;
use teloxide::respond;

use crate::messaging::adapter::{AdapterConfig, MessagingAdapter};

pub struct TelegramAdapter {
    running: Arc<AtomicBool>,
    bot_username: Mutex<Option<String>>,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    allowed_user_id: Mutex<Option<i64>>,
}

impl TelegramAdapter {
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
impl MessagingAdapter for TelegramAdapter {
    fn platform(&self) -> &'static str {
        "telegram"
    }

    async fn start(&self, config: AdapterConfig) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("Telegram bot is already running".into());
        }

        let bot = Bot::new(&config.token);

        let me = bot
            .get_me()
            .await
            .map_err(|e| format!("Failed to connect to Telegram: {e}"))?;

        let username = me.username().to_string();
        *self.bot_username.lock().await = Some(username.clone());

        if let Some(ref id_str) = config.allowed_user_id {
            if let Ok(id) = id_str.parse::<i64>() {
                *self.allowed_user_id.lock().await = Some(id);
            }
        }

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        self.running.store(true, Ordering::SeqCst);

        let allowed_user = *self.allowed_user_id.lock().await;
        let running_flag = self.running.clone();

        tokio::spawn(async move {
            let handler = Update::filter_message().endpoint(
                move |bot: Bot, msg: Message| {
                    let allowed = allowed_user;
                    async move {
                        if let Some(allowed_id) = allowed {
                            if msg.from.as_ref().map(|u| u.id.0 as i64) != Some(allowed_id) {
                                bot.send_message(msg.chat.id, "This is a personal Seren bot.")
                                    .await?;
                                return respond(());
                            }
                        }

                        if let Some(text) = msg.text() {
                            let response = match text {
                                "/start" | "/help" => {
                                    "Welcome to Seren! Commands:\n\
                                     /new — Start new conversation\n\
                                     /model — Change AI model\n\
                                     /balance — Check SerenBucks balance\n\
                                     /tools — List available tools\n\
                                     /stop — Cancel current request\n\
                                     /help — Show this help\n\n\
                                     Send any message to chat with Seren AI."
                                        .to_string()
                                }
                                "/new" => {
                                    "Started a new conversation.".to_string()
                                }
                                _ => {
                                    format!("Received: {text}\n\n(Orchestrator integration pending — this bot is connected and listening.)")
                                }
                            };

                            bot.send_message(msg.chat.id, response).await?;
                        }
                        respond(())
                    }
                },
            );

            let mut dispatcher = Dispatcher::builder(bot, handler)
                .enable_ctrlc_handler()
                .build();

            let shutdown_token = dispatcher.shutdown_token();

            tokio::spawn(async move {
                let _ = shutdown_rx.await;
                log::info!("[Telegram] Shutdown signal received");
                let _ = shutdown_token.shutdown();
            });

            dispatcher.dispatch().await;

            running_flag.store(false, Ordering::SeqCst);
            log::info!("[Telegram] Bot stopped");
        });

        log::info!("[Telegram] Bot started as @{}", username);
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("Telegram bot is not running".into());
        }

        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }

        self.running.store(false, Ordering::SeqCst);
        *self.bot_username.lock().await = None;
        log::info!("[Telegram] Bot stop requested");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn bot_username(&self) -> Option<String> {
        self.bot_username.try_lock().ok()?.clone()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
