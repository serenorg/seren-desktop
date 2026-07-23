// ABOUTME: Tauri commands for enabling, disabling, and inspecting Happy Remote Access.
// ABOUTME: Persists only the opt-in flag here; pairing credentials are handled separately.

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_store::StoreExt;

use crate::happy_bridge::{HappyBridgeManager, HappyBridgeState, HappyBridgeStatus};

pub(crate) const SETTINGS_STORE: &str = "settings.json";
const ENABLED_KEY: &str = "happy_bridge_enabled";
pub(crate) const ADVERTISED_ROOTS_KEY: &str = "happy_bridge_advertised_roots";

fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|err| err.to_string())?;
    store.set(ENABLED_KEY, serde_json::json!(enabled));
    store.save().map_err(|err| err.to_string())
}

pub(crate) fn is_enabled(app: &AppHandle) -> bool {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(ENABLED_KEY))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// The roots the user has explicitly consented to, unfiltered. This is the
/// authoritative record of consent: `happy_bridge_update_roots` advertises
/// exactly this set, so the spawn re-check must validate against it rather than
/// against the start-time intersection, which is narrower and drifts as soon as
/// the user edits their selection.
pub fn saved_advertised_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(ADVERTISED_ROOTS_KEY))
        .and_then(|value| {
            value.as_array().map(|saved| {
                saved
                    .iter()
                    .filter_map(|root| root.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// The subset of consented roots that still correspond to a known project, used
/// to decide what the bridge advertises at startup.
pub fn effective_advertised_roots<R: Runtime>(
    app: &AppHandle<R>,
    discovered: Vec<String>,
) -> Vec<String> {
    saved_advertised_roots(app)
        .into_iter()
        .filter(|root| discovered.iter().any(|candidate| candidate == root))
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
    if state.process_exists().await {
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
    // Any state other than Running means there is no usable pairing code: the
    // payload is consumed on first read, and a timed-out or failed pairing
    // leaves a bridge that will never emit another one. Restart so the user
    // always gets a fresh code instead of a dead one.
    if !matches!(state.status().await.state, HappyBridgeState::Running) {
        state.stop(&app).await?;
        state.start(&app).await?;
    }
    state.wait_for_pairing_payload().await
}

#[tauri::command]
pub async fn happy_bridge_cancel_pairing(
    state: State<'_, HappyBridgeManager>,
) -> Result<(), String> {
    state.cancel_pairing().await
}

/// Retires every relay session using the old identity, then clears its encrypted
/// bindings and pairing credential as one serialized reset operation.
#[tauri::command]
pub async fn happy_bridge_reset_identity(
    app: AppHandle,
    state: State<'_, HappyBridgeManager>,
) -> Result<(), String> {
    state.reset_identity(&app).await
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
