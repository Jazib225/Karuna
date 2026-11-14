// Tray icon: Open Karuna, Pause/Resume agents (the Gatekeeper's local pause, not the Dharma
// freeze), Quit. The pause item's label follows what the Gatekeeper reports.

use std::sync::atomic::Ordering;

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::pipe::Gatekeeper;

const TRAY_ID: &str = "karuna";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Karuna")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => crate::open_main(app),
            "pause" => {
                let gk = app.state::<Gatekeeper>();
                let msg = if gk.paused.load(Ordering::SeqCst) { json!({ "type": "resume", "by": "desktop app" }) } else { json!({ "type": "pause", "by": "desktop app" }) };
                gk.send(&msg);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                crate::open_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let gk = app.state::<Gatekeeper>();
    let connected = gk.connected.load(Ordering::SeqCst);
    let paused = gk.paused.load(Ordering::SeqCst);
    let open = MenuItem::with_id(app, "open", "Open Karuna", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", if paused { "Resume agents" } else { "Pause agents" }, connected, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])
}

/// Rebuild the menu after the connection or pause state changed.
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let (Some(tray), Ok(m)) = (app.tray_by_id(TRAY_ID), menu(&app)) {
            let _ = tray.set_menu(Some(m));
        }
    });
}
