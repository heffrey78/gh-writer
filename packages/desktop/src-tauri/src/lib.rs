//! gh-writer's desktop app (D2, D9): a window on the same server and web app as `gh-writer serve`,
//! with the server run beside it on the app's own Node and git. The app starts the server, opens its
//! window there once it's listening, keeps the window to the server's pages (anything else opens in
//! the writer's browser), and on closing a window or quitting has each page save what's typed, then
//! stops the server, which commits waiting work.

pub mod askpass;
mod sidecar;

use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use sidecar::{Resources, Sidecar};

/// How long a page has to save what's typed when its window closes or the app quits.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the app checks the server is still running.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Shell {
    sidecar: Mutex<Option<Sidecar>>,
    /// The server's address once it's up: the one place the app's windows may go.
    server: Mutex<Option<Url>>,
    /// Windows waiting for their page to say it has saved, by label.
    flushing: Mutex<HashMap<String, Sender<()>>>,
    quitting: AtomicBool,
}

/// The page has saved everything: window.ghWriter.flushAll() has settled.
#[tauri::command]
fn flushed(window: WebviewWindow, shell: tauri::State<'_, Shell>) {
    if let Some(done) = shell.flushing.lock().unwrap().remove(window.label()) {
        let _ = done.send(());
    }
}

/// Ask a window's page to save what's typed, and wait for it (at most FLUSH_TIMEOUT). Never on the
/// main thread: the page's answer arrives there.
fn flush(window: &WebviewWindow) {
    let shell = window.state::<Shell>();
    let (done, saved) = mpsc::channel();
    shell.flushing.lock().unwrap().insert(window.label().to_string(), done);
    let script = "Promise.resolve(window.ghWriter && window.ghWriter.flushAll()).finally(() => window.__TAURI__.core.invoke('flushed'))";
    let answered = window.eval(script).is_ok() && saved.recv_timeout(FLUSH_TIMEOUT).is_ok();
    shell.flushing.lock().unwrap().remove(window.label());
    if !answered {
        eprintln!("gh-writer: the page in window {:?} didn't say it had saved within {} s", window.label(), FLUSH_TIMEOUT.as_secs());
    }
}

/// Quit, once: every page saves, then the server stops and commits, then the app exits.
fn quit(app: &AppHandle) {
    if app.state::<Shell>().quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let started = Instant::now();
        for window in app.webview_windows().values() {
            flush(window);
        }
        let saved = started.elapsed();
        if let Some(sidecar) = app.state::<Shell>().sidecar.lock().unwrap().take() {
            sidecar.stop();
        }
        eprintln!("gh-writer: pages saved in {} ms, server stopped in {} ms", saved.as_millis(), (started.elapsed() - saved).as_millis());
        app.exit(0);
    });
}

/// Quit the same way when the system asks: logging out sends SIGTERM (and a terminal SIGINT or SIGHUP).
#[cfg(unix)]
fn quit_on_signals(app: &AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    for kind in [SignalKind::terminate(), SignalKind::interrupt(), SignalKind::hangup()] {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(mut signals) = signal(kind) {
                signals.recv().await;
                quit(&app);
            }
        });
    }
}

/// Whether a window may go to `url`: the loading page, or the server's own pages. Anything else (a
/// link to GitHub, say) opens in the writer's browser instead.
fn may_navigate(app: &AppHandle, url: &Url) -> bool {
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    let server = app.state::<Shell>().server.lock().unwrap().clone();
    if server.is_some_and(|server| server.origin() == url.origin()) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/// Start the server and send the main window to it; if it can't start, say why and quit.
fn start_server(app: &AppHandle) {
    let starting = Instant::now();
    let started = (|| {
        let resources = Resources::in_dir(&app.path().resource_dir().map_err(|e| e.to_string())?);
        let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&logs).map_err(|e| format!("Couldn't make the log folder ({}): {e}", logs.display()))?;
        // The app's own executable answers git's prompts for the GitHub token (askpass mode, in main).
        let askpass = std::env::current_exe().map_err(|e| e.to_string())?;
        let sidecar = Sidecar::start(&resources, &askpass, &logs.join("server.log"))?;
        let server: Url = sidecar.url.parse().map_err(|e| format!("The server gave a bad address: {e}"))?;
        let launch: Url = sidecar.launch_url.parse().map_err(|e| format!("The server gave a bad address: {e}"))?;
        Ok::<_, String>((sidecar, server, launch))
    })();
    match started {
        Ok((sidecar, server, launch)) => {
            eprintln!("gh-writer: server listening at {server} after {} ms", starting.elapsed().as_millis());
            let shell = app.state::<Shell>();
            *shell.server.lock().unwrap() = Some(server);
            *shell.sidecar.lock().unwrap() = Some(sidecar);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(launch);
            }
        }
        Err(message) => {
            app.dialog()
                .message(format!("gh-writer couldn't start.\n\n{message}"))
                .title("gh-writer")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            app.state::<Shell>().quitting.store(true, Ordering::SeqCst);
            app.exit(1);
        }
    }
}

/// Watch the server: if it stops while the app is open, say so and offer to start it again.
fn watch_server(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(WATCH_INTERVAL);
        let shell = app.state::<Shell>();
        if shell.quitting.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut sidecar = shell.sidecar.lock().unwrap();
            if sidecar.as_mut().is_none_or(|s| s.running()) {
                continue;
            }
            sidecar.take();
        }
        let log = app.path().app_log_dir().map(|dir| dir.join("server.log").display().to_string()).unwrap_or_default();
        let restart = app
            .dialog()
            .message(format!("gh-writer's server stopped unexpectedly. Your saved work is safe; anything typed in the last few seconds comes back when the page reopens.\n\nWhat it said is in {log}."))
            .title("gh-writer")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Quit".into()))
            .blocking_show();
        if restart {
            start_server(&app);
        } else {
            app.exit(0);
            return;
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![flushed])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("gh-writer")
                .inner_size(1280.0, 860.0)
                .min_inner_size(640.0, 480.0)
                .on_navigation(move |url| may_navigate(&handle, url))
                .build()?;
            #[cfg(unix)]
            quit_on_signals(app.handle());
            let handle = app.handle().clone();
            thread::spawn(move || {
                start_server(&handle);
                watch_server(handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing a window: its page saves first, then it closes (destroy() doesn't ask again).
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    api.prevent_close();
                    thread::spawn(move || {
                        flush(&webview);
                        let _ = webview.destroy();
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("gh-writer's window couldn't be set up")
        .run(|app, event| match event {
            // Quitting, or the last window closed: quit() saves and stops the server first, then
            // exits through app.exit(), which asks again and is let through.
            RunEvent::ExitRequested { api, .. } => {
                if !app.state::<Shell>().quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app);
                }
            }
            // However the app ends, the server goes with it.
            RunEvent::Exit => {
                if let Some(sidecar) = app.state::<Shell>().sidecar.lock().unwrap().take() {
                    sidecar.stop();
                }
            }
            _ => {}
        });
}
