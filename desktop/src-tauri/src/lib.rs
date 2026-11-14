// Karuna desktop app.
//   main    the console (the `web/` app), a normal window
//   island  a top-of-screen overlay that takes over while `main` is minimized
//
// Approvals from the island are never sent on the island's say-so: the decision goes to the
// console window, which signs it with this member's key; only that signed decision, still
// matching the pending request's id and payload hash, is written to the Gatekeeper's pipe.

mod island;
mod pipe;
mod tray;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager, WindowEvent};

use island::{IslandState, Rect};
use pipe::{norm_hash, Gatekeeper};

/// Decisions sent to the console for signing: id -> (payload hash, "approve" | "deny").
#[derive(Default)]
struct Signing(Mutex<HashMap<String, (String, String)>>);

const SIGN_TIMEOUT: Duration = Duration::from_secs(12);

pub fn open_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    island::hide(app);
}

fn island_error(app: &AppHandle, id: &str, error: &str) {
    let _ = app.emit_to(island::LABEL, "gk-event", json!({ "type": "error", "id": id, "error": error }));
}

#[tauri::command]
fn island_rects(state: tauri::State<'_, Arc<IslandState>>, rects: Vec<Rect>) {
    *state.rects.lock().unwrap() = rects.into_iter().take(8).collect();
}

#[tauri::command]
fn island_drag(state: tauri::State<'_, Arc<IslandState>>, active: bool) {
    state.dragging.store(active, Ordering::SeqCst);
}

#[tauri::command]
fn island_open_main(app: AppHandle) {
    open_main(&app);
}

#[tauri::command]
fn gk_status(gk: tauri::State<'_, Gatekeeper>) -> Value {
    json!({
        "connected": gk.connected.load(Ordering::SeqCst),
        "paused": gk.paused.load(Ordering::SeqCst),
        "pending": gk.pending_events.lock().unwrap().values().cloned().collect::<Vec<_>>(),
    })
}

/// Approve / Deny on the island card. Checked against what's pending, then signed by the console.
#[tauri::command]
fn approval_decision(app: AppHandle, gk: tauri::State<'_, Gatekeeper>, signing: tauri::State<'_, Signing>, id: String, payload_hash: String, decision: String) -> Result<(), String> {
    if decision != "approve" && decision != "deny" {
        return Err("decision must be approve or deny".into());
    }
    let hash = norm_hash(&payload_hash);
    match gk.pending_hash(&id) {
        None => return Err("That request is no longer pending.".into()),
        Some(h) if h != hash => return Err("That card no longer matches the pending request.".into()),
        _ => {}
    }
    if app.get_webview_window("main").is_none() {
        return Err("The console window isn't open, so nothing can sign this.".into());
    }
    signing.0.lock().unwrap().insert(id.clone(), (hash.clone(), decision.clone()));
    app.emit_to("main", "karuna://sign-request", json!({ "id": id, "payload_hash": hash, "decision": decision }))
        .map_err(|e| e.to_string())?;
    // If the console never answers (not loaded, or not this org's member), say so on the card.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SIGN_TIMEOUT).await;
        let still = app2.state::<Signing>().0.lock().unwrap().remove(&id).is_some();
        if still {
            island_error(&app2, &id, "The console didn't sign this. Is it open and connected to your organization?");
        }
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(Gatekeeper::default())
        .manage(Signing::default())
        .manage(Arc::new(IslandState::default()))
        .invoke_handler(tauri::generate_handler![island_rects, island_drag, island_open_main, gk_status, approval_decision])
        .setup(|app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            pipe::start(handle.clone());
            island::start_cursor_poll(handle.clone());

            // The console signed a decision: forward it only if it still matches what we asked for
            // and what's pending.
            let h = handle.clone();
            app.listen_any("karuna://signed", move |event| {
                let Ok(msg) = serde_json::from_str::<Value>(event.payload()) else { return };
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                let hash = norm_hash(msg.get("payload_hash").and_then(Value::as_str).unwrap_or_default());
                let decision = msg.get("decision").and_then(Value::as_str).unwrap_or_default().to_string();
                let asked = h.state::<Signing>().0.lock().unwrap().remove(&id);
                let gk = h.state::<Gatekeeper>();
                match (asked, gk.pending_hash(&id)) {
                    (Some((ah, ad)), Some(ph)) if ah == hash && ph == hash && ad == decision => {
                        let mut out = msg.clone();
                        out["type"] = json!("approval_response");
                        if !gk.send(&out) {
                            island_error(&h, &id, "Not connected to the Gatekeeper.");
                        }
                    }
                    _ => island_error(&h, &id, "Ignored a signed decision that didn't match the pending request."),
                }
            });
            let h = handle.clone();
            app.listen_any("karuna://sign-error", move |event| {
                let Ok(msg) = serde_json::from_str::<Value>(event.payload()) else { return };
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                h.state::<Signing>().0.lock().unwrap().remove(&id);
                island_error(&h, &id, msg.get("error").and_then(Value::as_str).unwrap_or("The console couldn't sign this."));
            });

            // Minimize -> island. Tauri has no reliable minimize event on Windows: check on resize.
            if let Some(main) = app.get_webview_window("main") {
                let h = handle.clone();
                let m = main.clone();
                main.on_window_event(move |e| match e {
                    WindowEvent::Resized(_) => {
                        let state = h.state::<Arc<IslandState>>();
                        if m.is_minimized().unwrap_or(false) {
                            if !state.visible.load(Ordering::SeqCst) {
                                island::show(&h);
                            }
                        } else if state.visible.load(Ordering::SeqCst) {
                            island::hide(&h);
                        }
                    }
                    WindowEvent::Focused(true) => island::hide(&h),
                    _ => {}
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Karuna desktop app");
}
