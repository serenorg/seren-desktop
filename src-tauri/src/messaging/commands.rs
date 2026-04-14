// ABOUTME: Tauri IPC commands for controlling messaging adapters from the frontend.
// ABOUTME: Start/stop/status per platform, exposed via invoke_handler.

use std::sync::Arc;
use tauri::State;

use crate::messaging::adapter::AdapterConfig;
use crate::messaging::{MessagingState, PlatformStatus};

#[tauri::command]
pub async fn messaging_start(
    state: State<'_, MessagingState>,
    platform: String,
    token: String,
    allowed_user_id: Option<String>,
    phone_number_id: Option<String>,
) -> Result<String, String> {
    if let Some(existing) = state.get(&platform).await {
        if existing.is_running() {
            return Err(format!("{platform} is already running"));
        }
    }

    let make_adapter = |p: &str| -> Result<Arc<dyn crate::messaging::adapter::MessagingAdapter>, String> {
        match p {
            #[cfg(feature = "telegram")]
            "telegram" => Ok(Arc::new(crate::messaging::telegram::TelegramAdapter::new())),
            #[cfg(feature = "discord")]
            "discord" => Ok(Arc::new(crate::messaging::discord::DiscordAdapter::new())),
            #[cfg(feature = "whatsapp")]
            "whatsapp" => Ok(Arc::new(crate::messaging::whatsapp::WhatsAppAdapter::new())),
            other => Err(format!("Unknown or disabled platform: {other}")),
        }
    };

    let adapter = make_adapter(&platform)?;

    let config = AdapterConfig {
        token,
        allowed_user_id,
        phone_number_id,
    };
    adapter.start(config).await?;

    let username = adapter.bot_username().unwrap_or_default();
    state.register(platform.clone(), adapter).await;

    Ok(username)
}

#[tauri::command]
pub async fn messaging_stop(
    state: State<'_, MessagingState>,
    platform: String,
) -> Result<(), String> {
    let adapter = state
        .get(&platform)
        .await
        .ok_or(format!("{platform} is not configured"))?;

    adapter.stop().await?;
    state.remove(&platform).await;
    Ok(())
}

#[tauri::command]
pub async fn messaging_status(
    state: State<'_, MessagingState>,
    platform: String,
) -> Result<PlatformStatus, String> {
    let adapter = state.get(&platform).await;
    match adapter {
        Some(a) => Ok(PlatformStatus {
            platform,
            running: a.is_running(),
            bot_username: a.bot_username(),
        }),
        None => Ok(PlatformStatus {
            platform,
            running: false,
            bot_username: None,
        }),
    }
}

#[tauri::command]
pub async fn messaging_status_all(
    state: State<'_, MessagingState>,
) -> Result<Vec<PlatformStatus>, String> {
    Ok(state.status_all().await)
}

#[cfg(feature = "whatsapp")]
#[tauri::command]
pub async fn messaging_whatsapp_qr(
    state: State<'_, MessagingState>,
) -> Result<Option<String>, String> {
    let adapter = state
        .get("whatsapp")
        .await
        .ok_or("WhatsApp adapter not started")?;

    let wa = adapter
        .as_any()
        .downcast_ref::<crate::messaging::whatsapp::WhatsAppAdapter>()
        .ok_or("Failed to downcast WhatsApp adapter")?;

    let rx = wa.subscribe_qr();
    Ok(rx.borrow().clone())
}

#[cfg(not(feature = "whatsapp"))]
#[tauri::command]
pub async fn messaging_whatsapp_qr() -> Result<Option<String>, String> {
    Err("WhatsApp feature not enabled".into())
}
