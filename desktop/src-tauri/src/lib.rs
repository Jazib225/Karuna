// Karuna desktop app.
//   main    the console (the `web/` app), a normal window
//   island  a top-of-screen overlay that takes over while `main` is minimized
//
// Approvals from the island are never sent on the island's say-so: the decision goes to the
// console window, which signs it with this member's key; only that signed decision, still
// matching the pending request's id and payload hash, is written to the Gatekeeper's pipe.

mod services;
mod island;
mod pipe;
mod tray;
mod voice;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, WindowEvent};

use island::{IslandState, Rect};
use pipe::{norm_hash, Gatekeeper};

/// Decisions sent to the console for signing: id -> (payload hash, "approve" | "deny").
#[derive(Default)]
/// Asked-for signatures by request id: (payload hash, decision, attempt). The attempt number lets a
/// timer from an earlier click leave a retry's entry alone.
struct Signing(Mutex<HashMap<String, (String, String, u64)>>);
static SIGN_ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const SIGN_TIMEOUT: Duration = Duration::from_secs(12);

pub fn open_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    island::hide(app);
}

/// The console's close button: Karuna keeps running (the island takes over, the tray stays).
fn hide_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        // Place the island on the console's monitor before the console disappears.
        island::show(app);
        let _ = main.hide();
    }
}

fn island_error(app: &AppHandle, id: &str, error: &str) {
    let _ = app.emit_to(island::LABEL, "gk-event", json!({ "type": "error", "id": id, "error": error }));
}

/// Sites the console may open in the default browser: the Arc block explorers, Circle, and where the
/// drafting key comes from (Groq's and Google AI Studio's key pages), and ElevenLabs' key page for voice.
const EXTERNAL_HOSTS: &[&str] = &["arcscan.app", "arc.io", "arc.network", "circle.com", "console.groq.com", "aistudio.google.com", "elevenlabs.io"];

/// An https link to one of EXTERNAL_HOSTS (or a subdomain), with nothing a shell could misread.
fn external_link_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    if url.len() > 2048 || url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '<' | '>' | '`' | '^' | '|' | '\\')) {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if host.contains('@') || host.contains(':') {
        return false;
    }
    EXTERNAL_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn open_in_browser(url: &str) {
    #[cfg(windows)]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = r {
        eprintln!("karuna-desktop: couldn't open {url}: {e}");
    }
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

/// The wake phrase was heard: bring the island on screen (like the hotkey) so its panel shows.
#[tauri::command]
fn island_show(app: AppHandle, state: tauri::State<'_, Arc<IslandState>>) {
    if !state.visible.load(Ordering::SeqCst) {
        island::show(&app);
    }
}

#[tauri::command]
fn gk_status(gk: tauri::State<'_, Gatekeeper>) -> Value {
    json!({
        "connected": gk.connected.load(Ordering::SeqCst),
        "paused": gk.paused.load(Ordering::SeqCst),
        "pending": gk.pending_events.lock().unwrap().values().cloned().collect::<Vec<_>>(),
        "votes": gk.open_votes.lock().unwrap().values().cloned().collect::<Vec<_>>(),
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
    let attempt = SIGN_ATTEMPT.fetch_add(1, Ordering::SeqCst);
    signing.0.lock().unwrap().insert(id.clone(), (hash.clone(), decision.clone(), attempt));
    app.emit_to("main", "karuna://sign-request", json!({ "id": id, "payload_hash": hash, "decision": decision }))
        .map_err(|e| e.to_string())?;
    // If the console never answers (not loaded, or not this org's member), say so on the card.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SIGN_TIMEOUT).await;
        let still = {
            let signing = app2.state::<Signing>();
            let mut map = signing.0.lock().unwrap();
            // Only this click's entry: a later click on the same card has its own timer.
            let mine = map.get(&id).is_some_and(|e| e.2 == attempt);
            if mine {
                map.remove(&id);
            }
            mine
        };
        if still {
            island_error(&app2, &id, "The console didn't sign this. Is it open and connected to your organization?");
        }
    });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // First: a second launch hands over to this copy (and its services) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_main(app)))
        .manage(Gatekeeper::default())
        .manage(tray::TrayItems::default())
        .manage(Signing::default())
        .manage(Arc::new(IslandState::default()))
        .manage(services::Services::default())
        .invoke_handler(tauri::generate_handler![island_rects, island_drag, island_open_main, island_show, gk_status, approval_decision, services::services_status])
        .setup(|app| {
            let handle = app.handle().clone();
            // The installed app runs Karuna's own services (a development build doesn't).
            services::start(&handle);
            tray::build(&handle)?;
            pipe::start(handle.clone());
            island::start_cursor_poll(handle.clone());
            voice::start_hotkey(handle.clone());
            voice::allow_island_microphone(&handle);

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
                    (Some((ah, ad, _)), Some(ph)) if ah == hash && ph == hash && ad == decision => {
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

            // The console asks to open a link in the default browser (its window can't open tabs).
            // Only the EXTERNAL_HOSTS pages: nothing the console shows can open anything else.
            app.listen_any("karuna://open-url", move |event| {
                let Ok(msg) = serde_json::from_str::<Value>(event.payload()) else { return };
                if let Some(url) = msg.get("url").and_then(Value::as_str).filter(|u| external_link_allowed(u)) {
                    open_in_browser(url);
                }
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
                    WindowEvent::CloseRequested { api, .. } => {
                        // X hides to the tray instead of quitting. Quit is in the tray menu.
                        api.prevent_close();
                        hide_main(&h);
                    }
                    _ => {}
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Karuna desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                services::stop(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::external_link_allowed as ok;

    #[test]
    fn opens_only_arc_explorer_and_circle_links() {
        assert!(ok("https://testnet.arcscan.app/tx/0xc2b5a637eb5b55b242fb303c7b02ac1d2bcabd642cb4bbda327f2d9c2c278815"));
        assert!(ok("https://testnet.arcscan.app/address/0xe49fb1e8bbd7f8154e5a90c4275128965b7defe8"));
        assert!(ok("https://explorer.testnet.arc.io/tx/0xabc"));
        assert!(ok("https://faucet.circle.com"));
        assert!(ok("https://console.groq.com")); // drafting key pages
        assert!(ok("https://aistudio.google.com"));
        assert!(!ok("https://google.com")); // only AI Studio, not every Google site
        assert!(!ok("https://evil.groq.com.example/"));
        assert!(!ok("http://testnet.arcscan.app/tx/0xabc")); // https only
        assert!(!ok("https://evil.example/tx/0xabc"));
        assert!(!ok("https://arcscan.app.evil.example/"));
        assert!(!ok("https://evilarcscan.app/"));
        assert!(!ok("https://user@evil.example/"));
        assert!(!ok("https://testnet.arcscan.app/\" & calc"));
        assert!(!ok("file:///C:/Windows/System32/calc.exe"));
    }
}
