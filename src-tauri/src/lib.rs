// KAIRO — Tauri shell
// Spawns the bundled Node.js binary running server/server.js.
// Dev mode: uses system node (beforeDevCommand starts it externally).
// Production: uses the node binary bundled via externalBin.

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};
#[cfg(not(debug_assertions))]
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

struct ServerProcess(Arc<Mutex<Option<Child>>>);

// ── Node.js binary resolution ─────────────────────────────────────────────

/// In dev, search common system paths for Node.js.
fn find_system_node() -> Option<std::path::PathBuf> {
    let candidates = [
        "node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        "/usr/local/bin/node",
    ];
    for c in &candidates {
        if Command::new(c).arg("--version").output().is_ok() {
            return Some(std::path::PathBuf::from(c));
        }
    }
    None
}

/// In production, Node is bundled alongside the app binary via externalBin.
#[allow(dead_code)]
/// Tauri strips the target-triple suffix at bundle time, so at runtime it's
/// just "node" (or "node.exe" on Windows) next to the main executable.
fn find_bundled_node() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

    #[cfg(target_os = "windows")]
    let name = "node.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "node";

    let path = exe_dir.join(name);
    if path.exists() { Some(path) } else { None }
}

// ── Server launcher ───────────────────────────────────────────────────────

fn start_server(app: &AppHandle) -> Option<Child> {
    // Resolve Node.js binary
    #[cfg(debug_assertions)]
    let node_bin = find_system_node();

    #[cfg(not(debug_assertions))]
    let node_bin = find_bundled_node().or_else(|| find_system_node());

    let node_bin = match node_bin {
        Some(p) => p,
        None => {
            eprintln!("[KAIRO] ERROR: Node.js not found — cannot start server.");
            return None;
        }
    };

    // Resolve server.js
    let resource_dir = app
        .path()
        .resource_dir()
        .expect("Tauri resource dir unavailable");

    let server_js = {
        // Production: bundled at resource_dir/server/server.js
        let bundled = resource_dir.join("server").join("server.js");
        if bundled.exists() {
            bundled
        } else {
            // Dev: relative to project root
            std::env::current_dir()
                .unwrap()
                .join("server")
                .join("server.js")
        }
    };

    // Database dir — bundled map.json lives at resource_dir/databases/logos/
    let db_dir = {
        let bundled = resource_dir.join("databases").join("logos");
        if bundled.exists() {
            bundled
        } else {
            // Dev: project root databases/logos
            std::env::current_dir()
                .unwrap()
                .join("databases")
                .join("logos")
        }
    };

    println!("[KAIRO] node:       {}", node_bin.display());
    println!("[KAIRO] server.js:  {}", server_js.display());
    println!("[KAIRO] databases:  {}", db_dir.display());

    let working_dir = server_js.parent().unwrap().to_path_buf();

    // App-data dir — writable by the user; settings.json lives here in production.
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kairo"));
    std::fs::create_dir_all(&app_data_dir).ok();

    match Command::new(&node_bin)
        .arg(&server_js)
        .current_dir(&working_dir)
        // Pass resource dir so server.js can resolve bundled database files
        .env("KAIRO_RESOURCE_DIR", resource_dir.to_str().unwrap_or(""))
        .env("KAIRO_DB_DIR", db_dir.to_str().unwrap_or(""))
        // Writable dir for settings.json (read-only bundle path won't work in production)
        .env("KAIRO_APP_DATA_DIR", app_data_dir.to_str().unwrap_or(""))
        .spawn()
    {
        Ok(child) => {
            println!("[KAIRO] Server started (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[KAIRO] Failed to start server: {}", e);
            None
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_server_port() -> u16 {
    7777
}

/// Called from the frontend when the user clicks "Update & Restart".
/// Re-fetches the update (already confirmed available) and installs it.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(update) = update {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

// ── App entry ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![get_server_port, install_update])
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the bundled Node.js server.
            let child = start_server(&handle);
            *app.state::<ServerProcess>().0.lock().unwrap() = child;

            // Poll /health until the server responds, then show the window.
            // Max wait: 15 seconds (30 × 500ms).
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(1))
                    .build()
                    .unwrap_or_default();

                for attempt in 0..30 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if client.get("http://localhost:7777/health").send().is_ok() {
                        println!("[KAIRO] Server ready after ~{}ms", attempt * 500);
                        break;
                    }
                }

                if let Some(win) = handle2.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }

                // Check for updates in the background after the window is visible.
                // Only runs in release builds — updater endpoint won't resolve in dev.
                #[cfg(not(debug_assertions))]
                {
                    let handle3 = handle2.clone();
                    tauri::async_runtime::spawn(async move {
                        // Small delay so the UI settles before we show a banner.
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        match handle3.updater() {
                            Ok(updater) => match updater.check().await {
                                Ok(Some(update)) => {
                                    println!("[KAIRO] Update available: {}", update.version);
                                    let _ = handle3.emit(
                                        "update-available",
                                        serde_json::json!({
                                            "version": update.version,
                                            "notes":   update.body.unwrap_or_default(),
                                        }),
                                    );
                                }
                                Ok(None) => println!("[KAIRO] App is up to date."),
                                Err(e)   => eprintln!("[KAIRO] Update check error: {e}"),
                            },
                            Err(e) => eprintln!("[KAIRO] Updater unavailable: {e}"),
                        }
                    });
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building KAIRO")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                if let Some(mut child) = app
                    .state::<ServerProcess>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    println!("[KAIRO] Server stopped.");
                }
            }
        });
}
