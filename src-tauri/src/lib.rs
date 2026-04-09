// KAIRO — Tauri shell
// Spawns Node.js server as child process, shows WebView pointed at it.

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};

struct ServerProcess(Arc<Mutex<Option<Child>>>);

fn find_node() -> String {
    for candidate in &[
        "node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ] {
        if Command::new(candidate).arg("--version").output().is_ok() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn start_server(app: &AppHandle) -> Child {
    let resource_path = app
        .path()
        .resource_dir()
        .expect("resource dir")
        .join("server")
        .join("server.js");

    let server_path = if resource_path.exists() {
        resource_path
    } else {
        // Dev: resolve relative to project root
        std::env::current_dir()
            .unwrap()
            .join("server")
            .join("server.js")
    };

    println!("[KAIRO] Starting server: {}", server_path.display());

    Command::new(find_node())
        .arg(&server_path)
        .current_dir(server_path.parent().unwrap())
        .spawn()
        .expect("Failed to start KAIRO server — is Node.js installed?")
}

#[tauri::command]
fn get_server_port() -> u16 {
    7777
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![get_server_port])
        .setup(|app| {
            let handle = app.handle().clone();

            // In dev mode, beforeDevCommand already started the server.
            // Only spawn it here when running as a bundled production binary.
            #[cfg(not(debug_assertions))]
            {
                let child = start_server(&handle);
                *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
            }

            // Wait for server to be ready, then show window
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                // Poll until the server responds (max 10s)
                for _ in 0..20 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if reqwest::blocking::get("http://localhost:7777/health").is_ok() {
                        break;
                    }
                }
                if let Some(win) = handle2.get_webview_window("main") {
                    let _ = win.show();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building KAIRO")
        .run(|app, event| {
            match event {
                RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                    if let Some(mut child) = app
                        .state::<ServerProcess>()
                        .0
                        .lock()
                        .unwrap()
                        .take()
                    {
                        let _ = child.kill();
                        let _ = child.wait(); // reap process so no zombie
                        println!("[KAIRO] Server stopped.");
                    }
                }
                _ => {}
            }
        });
}
