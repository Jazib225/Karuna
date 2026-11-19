// Connection to the Karuna Gatekeeper's event pipe: `\\.\pipe\karuna`, newline-delimited JSON.
//
// Inbound events are forwarded to the island as `gk-event`; connection changes as `gk-status`.
// We keep our own copy of what's pending (id -> payload hash) so a response is only ever written
// for a request that is still pending, with exactly its hash: stale or mismatched clicks are
// dropped here, and the Gatekeeper checks again (plus the member's signature) on its side.
// If the Gatekeeper isn't running we retry quietly; nothing here can take the app down.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub const PIPE_NAME: &str = r"\\.\pipe\karuna";
const RETRY: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub struct Gatekeeper {
    /// Pending approvals the Gatekeeper told us about: id -> payload hash (lowercase hex, no 0x).
    pub pending: Mutex<HashMap<String, String>>,
    /// The full approval_requested events, so an island page that loads late can catch up.
    pub pending_events: Mutex<HashMap<String, Value>>,
    /// Open Dharma votes (vote_requested), so a late island page can catch up too.
    pub open_votes: Mutex<HashMap<String, Value>>,
    pub connected: AtomicBool,
    pub paused: AtomicBool,
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Gatekeeper {
    /// Queue one JSON line for the Gatekeeper. False when not connected.
    pub fn send(&self, msg: &Value) -> bool {
        let line = format!("{}\n", msg);
        match self.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(line).is_ok(),
            None => false,
        }
    }

    /// The pending request's hash, if `id` is still pending.
    pub fn pending_hash(&self, id: &str) -> Option<String> {
        self.pending.lock().unwrap().get(id).cloned()
    }
}

pub fn norm_hash(h: &str) -> String {
    h.trim().trim_start_matches("0x").to_ascii_lowercase()
}

fn track(gk: &Gatekeeper, ev: &Value) {
    match ev.get("type").and_then(Value::as_str) {
        Some("approval_requested") => {
            if let (Some(id), Some(h)) = (ev.get("id").and_then(Value::as_str), ev.get("payload_hash").and_then(Value::as_str)) {
                gk.pending.lock().unwrap().insert(id.to_string(), norm_hash(h));
                gk.pending_events.lock().unwrap().insert(id.to_string(), ev.clone());
            }
        }
        Some("approval_resolved") => {
            if let Some(id) = ev.get("id").and_then(Value::as_str) {
                gk.pending.lock().unwrap().remove(id);
                gk.pending_events.lock().unwrap().remove(id);
            }
        }
        Some("vote_requested") => {
            if let Some(id) = ev.get("id").map(|v| v.to_string()) {
                gk.open_votes.lock().unwrap().insert(id, ev.clone());
            }
        }
        Some("vote_resolved") => {
            if let Some(id) = ev.get("id").map(|v| v.to_string()) {
                gk.open_votes.lock().unwrap().remove(&id);
            }
        }
        Some("agent_paused") => gk.paused.store(true, Ordering::SeqCst),
        Some("agent_resumed") => gk.paused.store(false, Ordering::SeqCst),
        _ => {}
    }
}

fn set_connected(app: &AppHandle, gk: &Gatekeeper, on: bool) {
    if gk.connected.swap(on, Ordering::SeqCst) != on {
        if !on {
            // Whatever was pending can't be answered over a dead connection; the island clears it.
            gk.pending.lock().unwrap().clear();
            gk.pending_events.lock().unwrap().clear();
            gk.open_votes.lock().unwrap().clear();
            // The Gatekeeper sends its pause state again on connect; don't keep a stale one.
            gk.paused.store(false, Ordering::SeqCst);
        }
        let _ = app.emit("gk-status", json!({ "connected": on }));
        crate::tray::refresh(app);
    }
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    use tokio::net::windows::named_pipe::ClientOptions;
    tauri::async_runtime::spawn(async move {
        loop {
            let client = match ClientOptions::new().open(PIPE_NAME) {
                Ok(c) => c,
                Err(_) => {
                    let gk = app.state::<Gatekeeper>();
                    set_connected(&app, &gk, false);
                    tokio::time::sleep(RETRY).await;
                    continue;
                }
            };
            let (read, mut write) = tokio::io::split(client);
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            {
                let gk = app.state::<Gatekeeper>();
                *gk.tx.lock().unwrap() = Some(tx);
                set_connected(&app, &gk, true);
            }
            let writer = tauri::async_runtime::spawn(async move {
                while let Some(line) = rx.recv().await {
                    if write.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
            let mut lines = BufReader::new(read).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.len() > 256 * 1024 {
                            continue;
                        }
                        let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
                        let gk = app.state::<Gatekeeper>();
                        track(&gk, &ev);
                        if ev.get("type").and_then(Value::as_str).is_some_and(|t| t.starts_with("agent_")) {
                            crate::tray::refresh(&app);
                        }
                        let _ = app.emit("gk-event", ev);
                    }
                    _ => break,
                }
            }
            writer.abort();
            let gk = app.state::<Gatekeeper>();
            *gk.tx.lock().unwrap() = None;
            set_connected(&app, &gk, false);
            tokio::time::sleep(RETRY).await;
        }
    });
}

#[cfg(not(windows))]
pub fn start(_app: AppHandle) {
    // Windows first. (The Gatekeeper also serves $TMPDIR/karuna.sock for a later macOS/Linux build.)
}
