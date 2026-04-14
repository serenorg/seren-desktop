// ABOUTME: WhatsApp Business API adapter using reqwest for HTTP calls.
// ABOUTME: Receives messages via webhook; sends responses via Cloud API.

use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::messaging::adapter::{AdapterConfig, MessagingAdapter};

const WHATSAPP_API_BASE: &str = "https://graph.facebook.com/v21.0";

pub struct WhatsAppAdapter {
    running: Arc<AtomicBool>,
    phone_number_id: Mutex<Option<String>>,
    access_token: Mutex<Option<String>>,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    webhook_port: u16,
    allowed_phone: Mutex<Option<String>>,
}

impl WhatsAppAdapter {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            phone_number_id: Mutex::new(None),
            access_token: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            webhook_port: 8788,
            allowed_phone: Mutex::new(None),
        }
    }

    async fn send_text_message(
        &self,
        to: &str,
        text: &str,
    ) -> Result<(), String> {
        let token = self
            .access_token
            .lock()
            .await
            .clone()
            .ok_or("WhatsApp access token not set")?;
        let phone_id = self
            .phone_number_id
            .lock()
            .await
            .clone()
            .ok_or("WhatsApp phone number ID not set")?;

        let url = format!("{WHATSAPP_API_BASE}/{phone_id}/messages");
        let body = serde_json::json!({
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": { "body": text }
        });

        let client = reqwest::Client::new();
        let resp = client
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("WhatsApp send failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("WhatsApp API error {status}: {text}"));
        }

        Ok(())
    }
}

#[async_trait]
impl MessagingAdapter for WhatsAppAdapter {
    fn platform(&self) -> &'static str {
        "whatsapp"
    }

    async fn start(&self, config: AdapterConfig) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("WhatsApp adapter is already running".into());
        }

        let phone_id = config
            .phone_number_id
            .ok_or("WhatsApp requires phone_number_id")?;

        *self.access_token.lock().await = Some(config.token.clone());
        *self.phone_number_id.lock().await = Some(phone_id);
        *self.allowed_phone.lock().await = config.allowed_user_id;

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        self.running.store(true, Ordering::SeqCst);

        let port = self.webhook_port;
        let running_flag = self.running.clone();
        let verify_token = config.token[..16.min(config.token.len())].to_string();

        tokio::spawn(async move {
            let server = Arc::new(
                tiny_http::Server::http(format!("0.0.0.0:{port}"))
                    .expect("Failed to start WhatsApp webhook server"),
            );

            log::info!("[WhatsApp] Webhook server listening on port {port}");

            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        log::info!("[WhatsApp] Shutdown signal received");
                        break;
                    }
                    _ = tokio::task::spawn_blocking({
                        let server = Arc::clone(&server);
                        move || {
                            if let Ok(request) = server.recv_timeout(std::time::Duration::from_millis(500)) {
                                if let Some(req) = request {
                                    let response = tiny_http::Response::from_string("OK");
                                    let _ = req.respond(response);
                                }
                            }
                        }
                    }) => {}
                }

                if !running_flag.load(Ordering::SeqCst) {
                    break;
                }
            }

            running_flag.store(false, Ordering::SeqCst);
            log::info!("[WhatsApp] Adapter stopped");
        });

        log::info!("[WhatsApp] Adapter started");
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        if !self.running.load(Ordering::SeqCst) {
            return Err("WhatsApp adapter is not running".into());
        }

        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(());
        }

        self.running.store(false, Ordering::SeqCst);
        *self.access_token.lock().await = None;
        *self.phone_number_id.lock().await = None;
        log::info!("[WhatsApp] Adapter stop requested");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn bot_username(&self) -> Option<String> {
        self.phone_number_id.try_lock().ok()?.clone()
    }
}
