// ABOUTME: Tauri commands for enabling, disabling, and inspecting Happy Remote Access.
// ABOUTME: Persists only the opt-in flag here; pairing credentials are handled separately.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::happy_bridge::{HappyBridgeManager, HappyBridgeState, HappyBridgeStatus};

const SETTINGS_STORE: &str = "settings.json";
const ENABLED_KEY: &str = "happy_bridge_enabled";
const ADVERTISED_ROOTS_KEY: &str = "happy_bridge_advertised_roots";

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

pub fn effective_advertised_roots(app: &AppHandle, discovered: Vec<String>) -> Vec<String> {
    let Some(value) = app
        .store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(ADVERTISED_ROOTS_KEY))
    else {
        return discovered;
    };

    let Some(saved) = value.as_array() else {
        return discovered;
    };
    saved
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|root| discovered.iter().any(|candidate| candidate == root))
        .map(str::to_string)
        .collect()
}

fn save_advertised_roots(app: &AppHandle, roots: &[String]) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|err| err.to_string())?;
    store.set(ADVERTISED_ROOTS_KEY, serde_json::json!(roots));
    store.save().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn happy_bridge_get_advertised_roots(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    let value = app
        .store(SETTINGS_STORE)
        .map_err(|err| err.to_string())?
        .get(ADVERTISED_ROOTS_KEY);
    Ok(value.and_then(|value| {
        value.as_array().map(|roots| {
            roots
                .iter()
                .filter_map(|root| root.as_str().map(str::to_string))
                .collect()
        })
    }))
}

#[tauri::command]
pub async fn happy_bridge_update_roots(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
    roots: Vec<String>,
) -> Result<HappyBridgeStatus, String> {
    let mut normalized = Vec::new();
    for root in roots {
        let root = root.trim();
        if !root.is_empty() && !normalized.iter().any(|existing| existing == root) {
            normalized.push(root.to_string());
        }
    }
    save_advertised_roots(&app, &normalized)?;
    if matches!(state.status().await.state, HappyBridgeState::Running) {
        state.update_roots(normalized).await?;
    }
    Ok(state.status().await)
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
