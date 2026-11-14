// The island window: a transparent, always-on-top overlay covering the monitor `main` was on.
//
// It is click-through everywhere except the rectangles the page reports (pill, card, floating
// lotus): a poll reads the cursor ~60 times a second while the island is visible, turns input on
// only while the cursor is over one of them, and tells the page (`island-hover`), since a
// click-through page gets no mouse events of its own. While the lotus is being dragged, input
// stays on. The window never takes focus (WS_EX_NOACTIVATE) and stays out of Alt-Tab and the
// taskbar (WS_EX_TOOLWINDOW).
//
// The cursor-poll + click-through approach is adapted from an MIT-licensed project; see
// THIRD_PARTY_NOTICES.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const LABEL: &str = "island";

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Default)]
pub struct IslandState {
    /// Interactive areas in CSS pixels, relative to the island window.
    pub rects: Mutex<Vec<Rect>>,
    pub dragging: AtomicBool,
    pub visible: AtomicBool,
    hovering: AtomicBool,
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Cover the monitor `main` is on, show without focus, start click-through.
pub fn show(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let _ = win.set_position(PhysicalPosition::new(m.position().x, m.position().y));
        let _ = win.set_size(PhysicalSize::new(m.size().width, m.size().height));
    }
    let state = app.state::<Arc<IslandState>>();
    state.hovering.store(false, Ordering::SeqCst);
    set_click_through(&win, true);
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    platform::make_overlay(&win);
    state.visible.store(true, Ordering::SeqCst);
    let _ = win.emit("island-visible", json!({ "visible": true }));
}

pub fn hide(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let state = app.state::<Arc<IslandState>>();
    state.visible.store(false, Ordering::SeqCst);
    state.dragging.store(false, Ordering::SeqCst);
    let _ = win.emit("island-visible", json!({ "visible": false }));
    let _ = win.hide();
}

pub fn set_click_through(win: &WebviewWindow, ignore: bool) {
    let _ = win.set_ignore_cursor_events(ignore);
    // The windowing layer rebuilds the extended style when it does this; put the overlay bits back.
    let w = win.clone();
    let _ = win.run_on_main_thread(move || platform::make_overlay(&w));
}

/// ~60 Hz while visible; idle (cheap sleep) while hidden.
pub fn start_cursor_poll(app: AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<Arc<IslandState>>().inner().clone();
        if !state.visible.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(120));
            continue;
        }
        std::thread::sleep(Duration::from_millis(16));
        let Some(win) = window(&app) else { continue };
        let inside = state.dragging.load(Ordering::SeqCst) || cursor_over_rects(&win, &state);
        if state.hovering.swap(inside, Ordering::SeqCst) != inside {
            set_click_through(&win, !inside);
            let _ = win.emit("island-hover", json!({ "inside": inside }));
        }
    });
}

fn cursor_over_rects(win: &WebviewWindow, state: &IslandState) -> bool {
    let Some((cx, cy)) = platform::cursor_physical() else { return false };
    let Ok(origin) = win.outer_position() else { return false };
    let scale = win.scale_factor().unwrap_or(1.0);
    let (x, y) = ((cx - origin.x as f64) / scale, (cy - origin.y as f64) / scale);
    state.rects.lock().unwrap().iter().any(|r| x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

#[cfg(windows)]
mod platform {
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    pub fn cursor_physical() -> Option<(f64, f64)> {
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p).ok()? };
        Some((p.x as f64, p.y as f64))
    }

    /// Never activates on click, never in Alt-Tab or the taskbar.
    pub fn make_overlay(win: &WebviewWindow) {
        let Ok(h) = win.hwnd() else { return };
        let hwnd = HWND(h.0 as *mut _);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = (ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::WebviewWindow;
    pub fn cursor_physical() -> Option<(f64, f64)> {
        None
    }
    pub fn make_overlay(_win: &WebviewWindow) {}
}
