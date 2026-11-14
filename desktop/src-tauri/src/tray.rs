// Tray icon: Open Karuna, Pause/Resume agents (the Gatekeeper's local pause, not the Dharma
// freeze), Quit. Closing the console window only hides it (the island takes over); Quit is the
// one way out of the app.
//
// The menu is built once and its items are updated in place (text, enabled), never swapped: a
// menu replaced while it's open on Windows drops the click. Clicks are handled by one app-wide
// menu handler.

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde_json::json;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::pipe::Gatekeeper;

const TRAY_ID: &str = "karuna";

/// The pause item, kept so its label and enabled state can follow the Gatekeeper.
pub struct TrayItems {
    pause: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for TrayItems {
    fn default() -> Self {
        Self { pause: Mutex::new(None) }
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "karuna-open", "Open Karuna", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "karuna-pause", "Pause agents", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "karuna-quit", "Quit Karuna", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    *app.state::<TrayItems>().pause.lock().unwrap() = Some(pause);

    app.on_menu_event(|app, e| {
        let id = e.id().as_ref().to_string();
        eprintln!("karuna-desktop · tray: {id}");
        match id.as_str() {
            "karuna-open" => crate::open_main(app),
            "karuna-pause" => {
                let gk = app.state::<Gatekeeper>();
                let paused = gk.paused.load(Ordering::SeqCst);
                let sent = gk.send(&json!({ "type": if paused { "resume" } else { "pause" }, "by": "desktop app" }));
                if !sent {
                    eprintln!("karuna-desktop · tray: not connected to the Gatekeeper");
                }
            }
            "karuna-quit" => app.exit(0),
            _ => {}
        }
    });

    TrayIconBuilder::with_id(TRAY_ID)
        // The tray gets its own mark: the lotus alone, white on transparent (no tile), for the dark tray.
        .icon(tray_icon(app)?)
        .tooltip("Karuna")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| match e {
            TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => crate::open_main(tray.app_handle()),
            _ => {}
        })
        .build(app)?;
    refresh(app);
    Ok(())
}

/// The tray lotus drawn for this display's scaling (16 px at 100% … 40 px at 250%): Windows would
/// otherwise shrink one big image to ~20 px and the thin petals break up.
fn tray_icon(app: &AppHandle) -> tauri::Result<tauri::image::Image<'static>> {
    let scale = app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0);
    let want = (16.0 * scale).round() as u32;
    let bytes: &'static [u8] = match want {
        0..=17 => include_bytes!("../icons/tray-16.png"),
        18..=21 => include_bytes!("../icons/tray-20.png"),
        22..=27 => include_bytes!("../icons/tray-24.png"),
        28..=35 => include_bytes!("../icons/tray-32.png"),
        36..=43 => include_bytes!("../icons/tray-40.png"),
        _ => include_bytes!("../icons/tray-48.png"),
    };
    tauri::image::Image::from_bytes(bytes)
}

/// Update the pause item after the connection or pause state changed.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let gk = handle.state::<Gatekeeper>();
        let connected = gk.connected.load(Ordering::SeqCst);
        let paused = gk.paused.load(Ordering::SeqCst);
        if let Some(item) = handle.state::<TrayItems>().pause.lock().unwrap().as_ref() {
            let _ = item.set_text(if !connected { "Pause agents (Gatekeeper offline)" } else if paused { "Resume agents" } else { "Pause agents" });
            let _ = item.set_enabled(connected);
        }
    });
}
