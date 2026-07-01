// ABOUTME: Validation-isolated launch mode helpers and command bridge.
// ABOUTME: Keeps production builds free of the validation control server.

use serde::{Deserialize, Serialize};
#[cfg(feature = "validation")]
use tauri::Manager;
use tauri::{AppHandle, State};

#[cfg(feature = "validation")]
mod control_server;

pub const VALIDATION_IDENTIFIER_SUFFIX: &str = ".validation";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRuntimeInfo {
    pub is_validation: bool,
    pub control_enabled: bool,
    pub identifier: String,
    pub oauth_callback_port: u16,
    pub process_id: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ValidationControlReplyPayload {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn is_validation_identifier(identifier: &str) -> bool {
    identifier.ends_with(VALIDATION_IDENTIFIER_SUFFIX)
}

#[cfg(feature = "validation")]
pub fn assert_feature_identity(identifier: &str) -> Result<(), String> {
    if is_validation_identifier(identifier) {
        return Ok(());
    }

    Err(format!(
        "validation feature cannot run with non-validation identifier `{identifier}`"
    ))
}

#[cfg(feature = "validation")]
pub fn configure_isolated_environment(app: &tauri::App) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve validation app data dir: {err}"))?;
    let config_home = data_dir.join("config-home");
    let project_home = data_dir.join("projects");
    let claude_home = data_dir.join("claude-home");

    std::fs::create_dir_all(&config_home)
        .map_err(|err| format!("failed to create validation config dir: {err}"))?;
    std::fs::create_dir_all(&project_home)
        .map_err(|err| format!("failed to create validation project dir: {err}"))?;
    std::fs::create_dir_all(&claude_home)
        .map_err(|err| format!("failed to create validation Claude dir: {err}"))?;

    // SAFETY: setup runs before child processes are spawned. These vars scope
    // skill roots and inherited subprocess config to the validation identity.
    unsafe {
        std::env::set_var("SEREN_VALIDATION_INSTANCE", "1");
        std::env::set_var("SEREN_VALIDATION_CONFIG_HOME", &config_home);
        std::env::set_var("XDG_CONFIG_HOME", &config_home);
        std::env::set_var("SEREN_VALIDATION_PROJECT_DIR", &project_home);
        std::env::set_var("SEREN_VALIDATION_CLAUDE_HOME", &claude_home);
    }

    Ok(())
}

pub fn runtime_info(app: AppHandle) -> ValidationRuntimeInfo {
    let identifier = app.config().identifier.clone();
    ValidationRuntimeInfo {
        is_validation: is_validation_identifier(&identifier),
        control_enabled: cfg!(feature = "validation") && is_validation_identifier(&identifier),
        identifier,
        oauth_callback_port: crate::oauth_callback_server::active_callback_port(),
        process_id: std::process::id(),
    }
}

#[tauri::command]
pub fn get_validation_runtime_info(app: AppHandle) -> ValidationRuntimeInfo {
    runtime_info(app)
}

#[cfg(feature = "validation")]
pub use control_server::ValidationControlState;

#[cfg(not(feature = "validation"))]
#[derive(Default)]
pub struct ValidationControlState;

#[cfg(feature = "validation")]
pub fn start_control_server(
    app: AppHandle,
) -> Result<control_server::ValidationControlHandle, String> {
    control_server::start(app)
}

#[cfg(feature = "validation")]
#[tauri::command]
pub fn validation_control_frontend_ready(
    state: State<'_, ValidationControlState>,
) -> Result<(), String> {
    state.mark_frontend_ready();
    Ok(())
}

#[cfg(not(feature = "validation"))]
#[tauri::command]
pub fn validation_control_frontend_ready(
    _state: State<'_, ValidationControlState>,
) -> Result<(), String> {
    Err("validation control is not available in this build".to_string())
}

#[cfg(feature = "validation")]
#[tauri::command]
pub fn validation_control_reply(
    state: State<'_, ValidationControlState>,
    reply: ValidationControlReplyPayload,
) -> Result<(), String> {
    state.resolve(reply)
}

#[cfg(not(feature = "validation"))]
#[tauri::command]
pub fn validation_control_reply(
    _state: State<'_, ValidationControlState>,
    _reply: ValidationControlReplyPayload,
) -> Result<(), String> {
    Err("validation control is not available in this build".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_identity_requires_suffix() {
        assert!(is_validation_identifier("com.serendb.desktop.validation"));
        assert!(!is_validation_identifier("com.serendb.desktop"));
    }

    #[cfg(feature = "validation")]
    #[test]
    fn validation_feature_rejects_production_identifier() {
        assert!(assert_feature_identity("com.serendb.desktop.validation").is_ok());
        assert!(assert_feature_identity("com.serendb.desktop").is_err());
    }
}
