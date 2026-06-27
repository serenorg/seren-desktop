// ABOUTME: System tray icon for Seren Desktop reflecting live meeting-capture state.
// ABOUTME: Builds the tray + menu and exposes a command to flip idle/recording.

use tauri::{
    Emitter, Manager, Runtime,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconId},
};

const TRAY_ID: &str = "seren-tray";
const MENU_TOGGLE_CAPTURE: &str = "tray-toggle-capture";
const MENU_SHOW_HIDE: &str = "tray-show-hide";

const TOOLTIP_IDLE: &str = "Seren";
const TOOLTIP_RECORDING: &str = "Seren — recording";

// Menu-bar text badge shown beside the tray icon while recording. On macOS this
// keeps the recording state visible even when the Seren window is hidden or
// behind another app — the "never silent" guarantee. A no-op where tray titles
// aren't supported (Windows/Linux fall back to the tooltip).
const TRAY_TITLE_RECORDING: &str = "● Rec";

/// Build the system tray and attach its menu. Called once from `setup`. The
/// tray reflects capture state through its tooltip (idle vs recording) so we
/// never reference a second icon asset that might not ship.
pub fn setup_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show_hide = MenuItem::with_id(
        app,
        MENU_SHOW_HIDE,
        "Show / Hide Seren",
        true,
        None::<&str>,
    )?;
    let toggle_capture = MenuItem::with_id(
        app,
        MENU_TOGGLE_CAPTURE,
        "Start / Stop meeting capture",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Seren"))?;

    let menu = Menu::with_items(app, &[&show_hide, &separator, &toggle_capture, &separator, &quit])?;

    // Reuse the bundled application icon so the tray never points at a missing
    // asset. `app.default_window_icon()` returns the icon Tauri already loaded
    // from `bundle.icon`.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TOOLTIP_IDLE)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW_HIDE => toggle_main_window(app),
            MENU_TOGGLE_CAPTURE => {
                // The capture flow lives in the frontend store; ask it to toggle.
                let _ = app.emit("tray://toggle-capture", ());
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

/// Show the main window if hidden/minimized, otherwise hide it.
fn toggle_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

/// Reflect whether a meeting capture is recording in the tray: tooltip plus a
/// menu-bar title badge so the state is visible even when the window is hidden
/// or backgrounded. Called from the frontend on capture start/stop. No-op if the
/// tray hasn't been created (e.g. mobile).
#[tauri::command]
pub fn set_tray_recording(app: tauri::AppHandle, recording: bool) {
    if let Some(tray) = app.tray_by_id(&TrayIconId::new(TRAY_ID)) {
        let tooltip = if recording {
            TOOLTIP_RECORDING
        } else {
            TOOLTIP_IDLE
        };
        let _ = tray.set_tooltip(Some(tooltip));
        if recording {
            let _ = tray.set_title(Some(TRAY_TITLE_RECORDING));
        } else {
            let _ = tray.set_title(None::<&str>);
        }
    }
}
