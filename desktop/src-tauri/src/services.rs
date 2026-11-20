//! The installed app's backend: the Gatekeeper, relay, console and runner, bundled by
//! desktop/core/build.mjs into the app's resources (core/) with the Node that runs them. Started
//! with the app, stopped (with everything it started) when the app quits. Its data, its optional
//! .env and its log live in the app's data folder (%APPDATA%\dev.karunaprotocol.desktop).
//!
//! A development build has no core/ resources: run the Gatekeeper and console from the repo.

use std::fs::File;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct Services(Mutex<Option<Child>>);

/// For the launch screen: whether the services are running and, if they stopped, the end of their
/// log (its last line says why: "karuna · can't start: …").
#[tauri::command]
pub fn services_status(app: AppHandle) -> serde_json::Value {
    let state = app.state::<Services>();
    let mut guard = state.0.lock().unwrap();
    let Some(child) = guard.as_mut() else {
        return serde_json::json!({ "managed": false });
    };
    let exited = child.try_wait().ok().flatten();
    let mut log = String::new();
    if exited.is_some() {
        if let Some(text) = app.path().app_data_dir().ok().and_then(|d| std::fs::read_to_string(d.join("karuna.log")).ok()) {
            let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
            log = lines[lines.len().saturating_sub(12)..].join("\n");
        }
    }
    serde_json::json!({ "managed": true, "running": exited.is_none(), "code": exited.and_then(|s| s.code()), "log": log })
}

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW

pub fn start(app: &AppHandle) {
    // `tauri dev` copies the resources too, but development runs the repo's own services.
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(res) = app.path().resource_dir() else { return };
    let dir = res.join("core");
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = dir.join("karuna-core.mjs");
    if !node.exists() || !script.exists() {
        return;
    }
    let Ok(data) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(data.join("data"));

    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .current_dir(&dir)
        .env("KARUNA_DATA_DIR", data.join("data"))
        .env("KARUNA_ENV_FILE", data.join(".env"))
        .stdin(Stdio::null());
    // UTF-8 with a byte order mark, so Windows PowerShell's Get-Content shows "·" and "—" correctly.
    let log = File::create(data.join("karuna.log")).and_then(|mut f| {
        f.write_all(b"\xEF\xBB\xBF")?;
        Ok(f)
    });
    match log.and_then(|f| Ok((f.try_clone()?, f))) {
        Ok((out, err)) => {
            cmd.stdout(out).stderr(err);
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(child) => *app.state::<Services>().0.lock().unwrap() = Some(child),
        Err(e) => eprintln!("karuna-desktop: couldn't start Karuna's services: {e}"),
    }
}

/// Stop the backend and everything it started (agent runs, Circle CLI calls).
pub fn stop(app: &AppHandle) {
    let Some(mut child) = app.state::<Services>().0.lock().unwrap().take() else { return };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}
