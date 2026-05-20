// KAIRO — Tauri shell
// Spawns the bundled Node.js binary running server/server.js.
// Dev mode: uses system node (beforeDevCommand starts it externally).
// Production: uses the node binary bundled via externalBin.

mod ndi;
#[cfg(target_os = "macos")]
mod syphon;

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use base64::Engine;
use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(debug_assertions))]
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

// Embedded splash HTML — baked into the binary so it can render INSTANTLY
// at launch, before the Node sidecar (and therefore Express) is up.
const SPLASH_HTML: &str = include_str!("splash.html");

/// Build a `data:` URL for the splash page so the splash window can load it
/// without any filesystem or HTTP dependency.
fn splash_data_url() -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(SPLASH_HTML);
    format!("data:text/html;charset=utf-8;base64,{}", encoded)
}

struct ServerProcess(Arc<Mutex<Option<Child>>>);

/// Holds the dynamically-allocated server port and auth token. Generated once
/// at startup, passed to the Node sidecar via env vars, and surfaced to the
/// frontend via Tauri IPC. Allows the server to bind to an OS-assigned free
/// loopback port (no hardcoded 7777, no `kill -9` on collision) and requires
/// a shared secret on every HTTP/WS request to prevent other local processes
/// from controlling the live display.
struct ServerConfig {
    port:  u16,
    token: String,
}

/// Prefer the historical port 7777 (so `frontendDist` in tauri.conf.json keeps
/// working in the common case and the existing dev workflow is untouched). If
/// 7777 is already in use, fall back to an OS-assigned free port. The window
/// is then navigated to the actual URL after the server comes up — see the
/// post-health-check navigation step in `setup`.
///
/// The probe listener is dropped immediately; Node re-binds a moment later.
/// There is a tiny race window (~ms) but no other process is realistically
/// going to grab that exact port in between.
fn pick_free_port() -> u16 {
    if std::net::TcpListener::bind("127.0.0.1:7777").is_ok() {
        return 7777;
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(7777)
}

/// 32 bytes of OS entropy → URL-safe base64. ~43 chars, ~256 bits of entropy.
fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fallback: never happens on supported platforms, but if the OS RNG
        // is unavailable we'd rather start with a weak token than refuse to boot.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((nanos >> (i % 16)) as u8) ^ (i as u8);
        }
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(target_os = "macos")]
struct SyphonState(Arc<Mutex<syphon::SyphonHandle>>);

/// Shared NDI sender state. The frontend manipulates this through the
/// ndi_* Tauri commands; the actual sender thread runs inside the ndi module.
struct NdiState(Arc<Mutex<ndi::NdiHandle>>);

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

#[cfg_attr(debug_assertions, allow(dead_code))]
fn start_server(app: &AppHandle, port: u16, token: &str) -> Option<Child> {
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
        // Dynamic port + shared-secret token. The Node server reads these and
        // binds to 127.0.0.1:<port>, rejecting any HTTP/WS request without
        // the matching token.
        .env("KAIRO_SERVER_PORT", port.to_string())
        .env("KAIRO_AUTH_TOKEN",  token)
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
fn get_server_port(state: tauri::State<'_, ServerConfig>) -> u16 {
    state.port
}

#[tauri::command]
fn get_server_token(state: tauri::State<'_, ServerConfig>) -> String {
    state.token.clone()
}

#[tauri::command]
fn get_server_config(state: tauri::State<'_, ServerConfig>) -> serde_json::Value {
    serde_json::json!({ "port": state.port, "token": state.token })
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

// ── NDI commands ──────────────────────────────────────────────────────────
// The frontend calls these to drive the native NDI sender. We don't bundle
// libndi; the user's NDI Tools install (or NDI SDK) provides it.

#[tauri::command]
fn ndi_available() -> bool {
    ndi::is_libndi_available()
}

#[tauri::command]
fn ndi_start(app: AppHandle, source_name: String) -> Result<(), String> {
    let state = app.state::<NdiState>();
    let h = state.0.lock().map_err(|e| e.to_string())?;
    if h.is_running() {
        return Ok(()); // idempotent — already broadcasting
    }
    drop(h);
    ndi::start(&source_name, state.0.clone())
}

#[tauri::command]
fn ndi_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<NdiState>();
    let mut h = state.0.lock().map_err(|e| e.to_string())?;
    h.stop();
    Ok(())
}

#[tauri::command]
fn ndi_update(app: AppHandle, verse: String, reference: String) -> Result<(), String> {
    let state = app.state::<NdiState>();
    let h = state.0.lock().map_err(|e| e.to_string())?;
    h.update(verse, reference);
    Ok(())
}

// ── Syphon commands (macOS only) ──────────────────────────────────────────
// Syphon.framework is bundled with the app, so unlike NDI there's no SDK to
// install. The framework requires a CGL context — the syphon module handles
// that internally.
#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_available() -> bool {
    syphon::is_syphon_available()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_start(app: AppHandle, source_name: String) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::start(&source_name, state.0.clone())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::stop(state.0.clone())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_update(app: AppHandle, verse: String, reference: String) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::update(&verse, &reference, state.0.clone())
}

// Stubs for non-macOS platforms — frontend calls these unconditionally and
// expects a clean `false` / no-op rather than an "unknown command" error.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_available() -> bool { false }
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_start(_source_name: String) -> Result<(), String> {
    Err("Syphon is macOS-only".into())
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_stop() -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_update(_verse: String, _reference: String) -> Result<(), String> { Ok(()) }

// ── App entry ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Allocate the server's port + auth token ONCE, up front, so the same
    // values are visible to the Node sidecar (via env) and to the frontend
    // (via the get_server_config IPC command).
    let server_config = ServerConfig {
        port:  pick_free_port(),
        token: generate_auth_token(),
    };
    println!("[KAIRO] Server will bind to 127.0.0.1:{}", server_config.port);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .manage(server_config)
        .manage(NdiState(Arc::new(Mutex::new(ndi::NdiHandle::default()))));

    #[cfg(target_os = "macos")]
    {
        builder = builder.manage(SyphonState(Arc::new(Mutex::new(syphon::SyphonHandle::default()))));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_server_token,
            get_server_config,
            install_update,
            ndi_available,
            ndi_start,
            ndi_stop,
            ndi_update,
            syphon_available,
            syphon_start,
            syphon_stop,
            syphon_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Splash window ─────────────────────────────────────────────
            // Show a branded loading screen IMMEDIATELY so the user gets
            // feedback while the Node sidecar boots (~2-4s cold start).
            // The HTML is baked into the binary as a data: URL — no
            // filesystem, no network, renders before anything else does.
            let splash_url = splash_data_url();
            let splash_built = WebviewWindowBuilder::new(
                app,
                "splash",
                WebviewUrl::External(splash_url.parse().expect("splash data url parses")),
            )
            .title("KAIRO")
            .inner_size(440.0, 300.0)
            .center()
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(false)
            // Set the native window + webview background to dark BEFORE HTML
            // paints, otherwise there's a brief white flash on launch while
            // the webview transitions from its default white to our gradient.
            .background_color(Color(13, 13, 13, 255))
            .visible(true)
            .build();
            if let Err(e) = &splash_built {
                eprintln!("[KAIRO] Failed to create splash window: {e}");
            }

            // Start the bundled Node.js server.
            // In dev, the server is started by `beforeDevCommand` in tauri.conf.json
            // so we don't spawn a second one (which would collide on the same port).
            #[cfg(not(debug_assertions))]
            {
                let cfg = app.state::<ServerConfig>();
                let child = start_server(&handle, cfg.port, &cfg.token);
                *app.state::<ServerProcess>().0.lock().unwrap() = child;
            }
            #[cfg(debug_assertions)]
            {
                println!("[KAIRO] Dev mode — server started externally via beforeDevCommand.");
                let _ = &handle; // keep handle alive for use below
            }

            // Poll /health until the server responds, then close splash and
            // show the main window. Max wait: 15 seconds (30 × 500ms).
            let handle2 = handle.clone();
            let health_url = {
                let cfg = handle.state::<ServerConfig>();
                format!("http://127.0.0.1:{}/health", cfg.port)
            };
            std::thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(1))
                    .build()
                    .unwrap_or_default();

                let mut server_ready = false;
                for attempt in 0..30 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if client.get(&health_url).send().is_ok() {
                        println!("[KAIRO] Server ready after ~{}ms", attempt * 500);
                        server_ready = true;
                        break;
                    }
                }
                if !server_ready {
                    eprintln!("[KAIRO] Server failed to come up within 15s — showing main window anyway so the user isn't stuck on the splash.");
                }

                // Show the main window FIRST so the focus transfer from splash
                // is seamless, THEN close the splash so there's no flash of
                // empty desktop between the two.
                if let Some(win) = handle2.get_webview_window("main") {
                    // If 7777 was taken and Tauri allocated a different port,
                    // the auto-loaded URL from `frontendDist` (localhost:7777)
                    // won't work — redirect the webview to the real port.
                    let cfg = handle2.state::<ServerConfig>();
                    if cfg.port != 7777 {
                        let _ = win.eval(&format!(
                            "window.location.replace('http://127.0.0.1:{}/');",
                            cfg.port
                        ));
                    }
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                if let Some(splash) = handle2.get_webview_window("splash") {
                    let _ = splash.close();
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
