// ABOUTME: Tauri commands for enabling, disabling, and inspecting Happy Remote Access.
// ABOUTME: Persists only the opt-in flag here; pairing credentials are handled separately.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::happy_bridge::{HappyBridgeManager, HappyBridgeState, HappyBridgeStatus};

const SETTINGS_STORE: &str = "settings.json";
const ENABLED_KEY: &str = "happy_bridge_enabled";

fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|err| err.to_string())?;
    store.set(ENABLED_KEY, serde_json::json!(enabled));
    store.save().map_err(|err| err.to_string())
}

fn is_enabled(app: &AppHandle) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(ENABLED_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn happy_bridge_enable(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
) -> Result<HappyBridgeStatus, String> {
    set_enabled(&app, true)?;
    if let Err(error) = state.start(&app).await {
        let _ = set_enabled(&app, false);
        return Err(error);
    }
    Ok(state.status().await)
}

#[tauri::command]
pub async fn happy_bridge_disable(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
) -> Result<HappyBridgeStatus, String> {
    set_enabled(&app, false)?;
    state.stop(&app).await?;
    Ok(state.status().await)
}

#[tauri::command]
pub async fn happy_bridge_status(
    state: State<'_, HappyBridgeManager>,
) -> Result<HappyBridgeStatus, String> {
    Ok(state.status().await)
}

#[tauri::command]
pub async fn happy_bridge_start_pairing(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
) -> Result<String, String> {
    if matches!(state.status().await.state, HappyBridgeState::Stopped) {
        state.start(&app).await?;
    }
    state.wait_for_pairing_payload().await
}

#[tauri::command]
pub fn happy_bridge_reset_identity(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
) -> Result<(), String> {
    state.delete_pairing_credential(&app)
}

pub async fn auto_start_if_enabled(app: AppHandle) {
    if !is_enabled(&app) {
        return;
    }
    let state = app.state::<HappyBridgeManager>();
    if let Err(error) = state.start(&app).await {
        log::error!("[HappyBridge] Auto-start failed: {error}");
    }
}
