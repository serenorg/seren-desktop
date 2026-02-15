// ABOUTME: Polymarket WebSocket client for real-time market data and order updates.
// ABOUTME: Connects to wss://ws-subscriptions-clob.polymarket.com/ws/ for live price feeds.

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::RwLock;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// WebSocket endpoint for Polymarket CLOB subscriptions
const WS_ENDPOINT: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/";

/// WebSocket message types from Polymarket
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum PolymarketWsMessage {
    /// Market price update
    Market {
        event: String,
        market: String,
        data: serde_json::Value,
    },
    /// User order status update (authenticated)
    User {
        event: String,
        data: serde_json::Value,
    },
    /// Subscription confirmation
    Subscribed {
        channel: String,
    },
    /// Unsubscription confirmation
    Unsubscribed {
        channel: String,
    },
    /// Error message
    Error {
        message: String,
    },
}

/// Subscription channel types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// Market price/orderbook updates (public)
    Market { market_id: String },
    /// User order status updates (authenticated)
    User { api_key: String },
}

/// WebSocket client state
pub struct PolymarketWebSocket<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    subscriptions: Arc<RwLock<Vec<Channel>>>,
}

impl<R: Runtime> PolymarketWebSocket<R> {
    /// Create a new WebSocket client
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            subscriptions: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Connect to Polymarket WebSocket and start listening
    pub async fn connect(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        log::info!("Connecting to Polymarket WebSocket: {}", WS_ENDPOINT);

        let (ws_stream, response) = connect_async(WS_ENDPOINT).await?;
        log::info!(
            "WebSocket handshake successful. Response status: {}",
            response.status()
        );

        let (mut write, mut read) = ws_stream.split();

        // Subscribe to initial channels
        let subs = self.subscriptions.read().await.clone();
        for channel in subs {
            let subscribe_msg = self.build_subscribe_message(&channel);
            write.send(Message::Text(subscribe_msg.into())).await?;
            log::info!("Subscribed to channel: {:?}", channel);
        }

        // Spawn message listener task
        let app = self.app.clone();
        let subscriptions = self.subscriptions.clone();

        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Err(e) = Self::handle_message(&app, &text).await {
                            log::error!("Error handling WebSocket message: {}", e);
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        log::info!("WebSocket connection closed: {:?}", frame);
                        break;
                    }
                    Ok(Message::Ping(data)) => {
                        log::debug!("Received ping: {:?}", data);
                    }
                    Ok(Message::Pong(_)) => {
                        log::debug!("Received pong");
                    }
                    Err(e) => {
                        log::error!("WebSocket error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }

            // Connection closed - emit event
            let _ = app.emit("polymarket-ws-disconnected", ());
            log::warn!("Polymarket WebSocket disconnected");
        });

        Ok(())
    }

    /// Subscribe to a channel
    pub async fn subscribe(&self, channel: Channel) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        log::info!("Adding subscription: {:?}", channel);
        self.subscriptions.write().await.push(channel);
        Ok(())
    }

    /// Unsubscribe from a channel
    pub async fn unsubscribe(&self, channel: &Channel) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        log::info!("Removing subscription: {:?}", channel);
        let mut subs = self.subscriptions.write().await;
        subs.retain(|c| !channels_equal(c, channel));
        Ok(())
    }

    /// Build subscribe message for a channel
    fn build_subscribe_message(&self, channel: &Channel) -> String {
        match channel {
            Channel::Market { market_id } => {
                json!({
                    "type": "subscribe",
                    "channel": "market",
                    "market_id": market_id
                })
                .to_string()
            }
            Channel::User { api_key } => {
                json!({
                    "type": "subscribe",
                    "channel": "user",
                    "api_key": api_key
                })
                .to_string()
            }
        }
    }

    /// Handle incoming WebSocket message
    async fn handle_message(
        app: &AppHandle<R>,
        text: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        log::debug!("Received WebSocket message: {}", text);

        // Parse message
        let msg: PolymarketWsMessage = serde_json::from_str(text)?;

        // Emit Tauri event based on message type
        match msg {
            PolymarketWsMessage::Market { event, market, data } => {
                app.emit(
                    "polymarket-market-update",
                    json!({
                        "event": event,
                        "market": market,
                        "data": data
                    }),
                )?;
            }
            PolymarketWsMessage::User { event, data } => {
                app.emit(
                    "polymarket-user-update",
                    json!({
                        "event": event,
                        "data": data
                    }),
                )?;
            }
            PolymarketWsMessage::Subscribed { channel } => {
                log::info!("Subscription confirmed: {}", channel);
                app.emit("polymarket-ws-subscribed", json!({ "channel": channel }))?;
            }
            PolymarketWsMessage::Unsubscribed { channel } => {
                log::info!("Unsubscription confirmed: {}", channel);
                app.emit("polymarket-ws-unsubscribed", json!({ "channel": channel }))?;
            }
            PolymarketWsMessage::Error { message } => {
                log::error!("WebSocket error from server: {}", message);
                app.emit("polymarket-ws-error", json!({ "error": message }))?;
            }
        }

        Ok(())
    }
}

/// Helper to compare channels for equality
fn channels_equal(a: &Channel, b: &Channel) -> bool {
    match (a, b) {
        (Channel::Market { market_id: a }, Channel::Market { market_id: b }) => a == b,
        (Channel::User { api_key: a }, Channel::User { api_key: b }) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_channels_equal() {
        let market1 = Channel::Market {
            market_id: "123".to_string(),
        };
        let market2 = Channel::Market {
            market_id: "123".to_string(),
        };
        let market3 = Channel::Market {
            market_id: "456".to_string(),
        };

        assert!(channels_equal(&market1, &market2));
        assert!(!channels_equal(&market1, &market3));
    }
}
