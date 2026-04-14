// ABOUTME: WhatsApp adapter using whatsapp-rust for QR code pairing via WhatsApp Web protocol.
// ABOUTME: Scan a QR code from your phone to link — no Meta Business account needed.

use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

use wacore::store::in_memory::InMemoryBackend;
use wacore::types::events::Event;
use whatsapp_rust::bot::Bot;
use whatsapp_rust::transport::{TokioWebSocketTransportFactory, UreqHttpClient};
use whatsapp_rust::TokioRuntime;

use crate::messaging::adapter::{AdapterConfig, MessagingAdapter};

pub struct WhatsAppAdapter {
    running: Arc<AtomicBool>,
    phone_display: Arc<Mutex<Option<String>>>,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    qr_tx: Arc<Mutex<Option<tokio::sync::watch::Sender<Option<String>>>>>,
    qr_rx: tokio::sync::watch::Receiver<Option<String>>,
}

impl WhatsAppAdapter {
    pub fn new() -> Self {
        let (qr_tx, qr_rx) = tokio::sync::watch::channel(None);
        Self {
            running: Arc::new(AtomicBool::new(false)),
            phone_display: Arc::new(Mutex::new(None)),
            shutdown_tx: Mutex::new(None),
            qr_tx: Arc::new(Mutex::new(Some(qr_tx))),
            qr_rx,
        }
    }

    pub fn subscribe_qr(&self) -> tokio::sync::watch::Receiver<Option<String>> {
        self.qr_rx.clone()
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

        // In-memory backend: sessions don't persist across restarts.
        // TODO: implement Backend trait with rusqlite for persistence (#1566)
        let backend = Arc::new(InMemoryBackend::new());

        let qr_sender = self.qr_tx.clone();
        let running_flag = self.running.clone();
        let phone_display = self.phone_display.clone();

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        self.running.store(true, Ordering::SeqCst);

        tokio::spawn(async move {
            let qr_sender_event = qr_sender.clone();

            let bot_result = Bot::builder()
                .with_backend(backend)
                .with_transport_factory(TokioWebSocketTransportFactory::new())
                .with_http_client(UreqHttpClient::new())
                .with_runtime(TokioRuntime)
                .on_event(move |event, _client| {
                    let qr_tx = qr_sender_event.clone();
                    let phone = phone_display.clone();
                    async move {
                        match event {
                            Event::PairingQrCode { code, .. } => {
                                log::info!("[WhatsApp] QR code received, waiting for scan...");
                                if let Some(tx) = qr_tx.lock().await.as_ref() {
                                    let _ = tx.send(Some(code));
                                }
                            }
                            Event::Connected(_) => {
                                log::info!("[WhatsApp] Connected and authenticated");
                                if let Some(tx) = qr_tx.lock().await.as_ref() {
                                    let _ = tx.send(None);
                                }
                            }
                            Event::Message(msg, info) => {
                                let sender = format!("{}", info.source.sender);
                                log::info!("[WhatsApp] Message from {sender}");
                            }
                            _ => {}
                        }
                    }
                })
                .build()
                .await;

            let mut bot = match bot_result {
                Ok(b) => b,
                Err(e) => {
                    log::error!("[WhatsApp] Failed to build bot: {e}");
                    running_flag.store(false, Ordering::SeqCst);
                    return;
                }
            };

            let handle = match bot.run().await {
                Ok(h) => h,
                Err(e) => {
                    log::error!("[WhatsApp] Failed to start bot: {e}");
                    running_flag.store(false, Ordering::SeqCst);
                    return;
                }
            };

            log::info!("[WhatsApp] Bot running, waiting for QR scan or existing session...");

            tokio::spawn(async move {
                let _ = shutdown_rx.await;
                log::info!("[WhatsApp] Shutdown signal received");
                drop(handle);
            });
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
        *self.phone_display.lock().await = None;

        if let Some(tx) = self.qr_tx.lock().await.as_ref() {
            let _ = tx.send(None);
        }

        log::info!("[WhatsApp] Adapter stop requested");
        Ok(())
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    fn bot_username(&self) -> Option<String> {
        self.phone_display.try_lock().ok()?.clone()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}
