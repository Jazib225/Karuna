// Karuna Voice (docs/VOICE_PLAN.md), the app's side:
//   - Ctrl+Shift+Space anywhere starts or ends a conversation in the island (`voice-hotkey`).
//   - The island's webview may use the microphone and autoplay sound without WebView2's own prompt
//     (which would land on a transparent, click-through, full-screen window). Only the island.
// The island still holds no key: everything it signs goes through the console window, as before.

use tauri::{AppHandle, Emitter};

#[cfg(windows)]
pub fn start_hotkey(app: AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_SPACE};
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    // RegisterHotKey delivers WM_HOTKEY to the thread that registered it: give it its own loop.
    std::thread::spawn(move || unsafe {
        if RegisterHotKey(None, 1, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_SPACE.0 as u32).is_err() {
            eprintln!("karuna-desktop: Ctrl+Shift+Space is taken by another app; use the island's mic button to talk.");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                let state = tauri::Manager::state::<std::sync::Arc<crate::island::IslandState>>(&app);
                if !state.visible.load(std::sync::atomic::Ordering::SeqCst) {
                    crate::island::show(&app);
                }
                let _ = app.emit_to(crate::island::LABEL, "voice-hotkey", serde_json::json!({}));
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start_hotkey(_app: AppHandle) {}

/// Let the island's page use the microphone and play sound (nothing else) without a WebView2 prompt.
#[cfg(windows)]
pub fn allow_island_microphone(app: &AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let Some(win) = tauri::Manager::get_webview_window(app, crate::island::LABEL) else { return };
    let _ = win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = Default::default();
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            // The mic for conversations; autoplay so a spoken alert can play without a click first.
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        if core.add_PermissionRequested(&handler, &mut token).is_err() {
            eprintln!("karuna-desktop: couldn't set the island's microphone permission; Windows may ask instead.");
        }
    });
}

#[cfg(not(windows))]
pub fn allow_island_microphone(_app: &AppHandle) {}
