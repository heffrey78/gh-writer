//! gh-writer's desktop app (D2, D9): windows on the same server and web app as `gh-writer serve`, with
//! the server run beside it on the app's own Node and git. The library has a window of its own, and
//! each novel opens in one of its own. The app starts the server, sends its windows there once it's
//! listening, keeps them to the server's pages (anything else opens in the writer's browser), and on
//! closing a window or quitting has each page save what's typed, then stops the server, which commits
//! waiting work. One copy runs at a time: opening it again (with a novel's folder, say) goes to it.

pub mod askpass;
mod settings;
mod sidecar;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::webview::cookie::{Cookie, SameSite};
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use settings::Settings;
use sidecar::{Resources, Sidecar};

/// How long a page has to save what's typed when its window closes or the app quits.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the app checks the server is still running.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);
/// The library's window. A novel's is "novel-<its library id>".
const LIBRARY: &str = "main";

/// Where the server is, and the secret that signs a window in.
#[derive(Clone)]
struct Server {
    url: Url,
    token: String,
}

impl Server {
    /// The address of `path` (with its query, if any) on the server.
    fn page(&self, path: &str) -> Url {
        self.url.join(path).unwrap_or_else(|_| self.url.clone())
    }

    /// The session cookie the server sets at its sign-in address (`?token=`, in
    /// packages/server/src/security.ts), set by the app itself, and SameSite=Lax where the server's
    /// is Strict. A window is sent to the server from the loading page (tauri://), and WebKitGTK
    /// counts that navigation as cross-site, so it withholds a Strict cookie and the window opens
    /// signed out (unless the navigation wins a race with the loading page). Lax is still sent on it.
    /// Only the app's own windows share this cookie store, and the server's other checks (Host,
    /// fetch metadata, Origin on every change) stand.
    fn session(&self) -> Cookie<'static> {
        Cookie::build((format!("ghw_session_{}", self.url.port().unwrap_or(80)), self.token.clone()))
            .domain(self.url.host_str().unwrap_or("127.0.0.1").to_string())
            .path("/")
            .http_only(true)
            .same_site(SameSite::Lax)
            .build()
    }

    /// Sign a window in and send it to `path`.
    fn show(&self, window: &WebviewWindow, path: &str) -> tauri::Result<()> {
        window.set_cookie(self.session())?;
        window.navigate(self.page(path))
    }
}

/// A command for a page to run: "go" to a path in the app, or "about".
#[derive(Clone, Serialize)]
struct PageCommand {
    name: &'static str,
    arg: Option<String>,
}

#[derive(Clone, Deserialize)]
struct RecentNovel {
    id: String,
    title: String,
}

#[derive(Default)]
struct Shell {
    sidecar: Mutex<Option<Sidecar>>,
    server: Mutex<Option<Server>>,
    /// Windows waiting for their page to say it has saved, by label.
    flushing: Mutex<HashMap<String, Sender<()>>>,
    quitting: AtomicBool,
    /// Windows whose page is loaded and running commands, by label.
    ready: Mutex<HashSet<String>>,
    /// Commands kept for a window until its page is ready, by label.
    pending: Mutex<HashMap<String, Vec<PageCommand>>>,
    /// Where each window was asked to go before the server was up, by label.
    wanted: Mutex<HashMap<String, String>>,
    settings: Mutex<Settings>,
    recent_menu: Mutex<Option<Submenu<Wry>>>,
    system_git_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

fn novel_label(id: &str) -> Option<String> {
    // Library ids are lib_ and six letters or digits; anything else isn't a novel to open.
    (!id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| format!("novel-{id}"))
}

// Commands the server's pages may call (capabilities/default.json grants exactly these).

/// The page has saved everything: window.ghWriter.flushAll() has settled.
#[tauri::command]
fn flushed(window: WebviewWindow, shell: tauri::State<'_, Shell>) {
    if let Some(done) = shell.flushing.lock().unwrap().remove(window.label()) {
        let _ = done.send(());
    }
}

/// The page is loaded: from now on commands go straight to it. Answers with those kept for it.
#[tauri::command]
fn page_ready(window: WebviewWindow, shell: tauri::State<'_, Shell>) -> Vec<PageCommand> {
    shell.ready.lock().unwrap().insert(window.label().to_string());
    shell.pending.lock().unwrap().remove(window.label()).unwrap_or_default()
}

/// The folder the writer chooses in the system's dialog, or None if they cancel.
#[tauri::command]
async fn pick_folder(window: WebviewWindow, title: String) -> Option<String> {
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title(title).set_parent(&window).blocking_pick_folder())
        .await
        .ok()
        .flatten()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.display().to_string())
}

/// Open a novel in its own window, or bring that window forward.
#[tauri::command]
fn open_novel(app: AppHandle, id: String) {
    if let Some(label) = novel_label(&id) {
        let _ = open_window(&app, &label, &format!("/novels/{id}"));
    }
}

/// Bring the library forward, at `path` if given. Answers false when asked from the library's own
/// window, which then goes there itself.
#[tauri::command]
fn show_library(window: WebviewWindow, path: Option<String>) -> bool {
    if window.label() == LIBRARY {
        return false;
    }
    let app = window.app_handle();
    let _ = open_window(app, LIBRARY, "/");
    if let Some(path) = path.filter(|p| p != "/") {
        deliver(app, LIBRARY, PageCommand { name: "go", arg: Some(path) });
    }
    true
}

/// The novels most recently opened, for Open Recent.
#[tauri::command]
fn set_recent(app: AppHandle, novels: Vec<RecentNovel>) {
    let Some(menu) = app.state::<Shell>().recent_menu.lock().unwrap().clone() else { return };
    while let Ok(Some(_)) = menu.remove_at(0) {}
    if novels.is_empty() {
        if let Ok(none) = MenuItemBuilder::with_id("recent-none", "No novels yet").enabled(false).build(&app) {
            let _ = menu.append(&none);
        }
    }
    for novel in novels.iter().take(10) {
        if let Ok(item) = MenuItemBuilder::with_id(format!("recent:{}", novel.id), &novel.title).build(&app) {
            let _ = menu.append(&item);
        }
    }
}

/// Run the webview's own editing command (cut, copy, paste or select_all) on what has the focus in the
/// window, as its Edit menu does: the app's right-click menu. Answers false where the shell can't (on
/// macOS and Windows for now), and the page does it itself, pasting the clipboard's text.
#[tauri::command]
fn edit(window: WebviewWindow, action: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        let command = match action.as_str() {
            "cut" => "Cut",
            "copy" => "Copy",
            "paste" => "Paste",
            "select_all" => "SelectAll",
            _ => return false,
        };
        window
            .with_webview(move |webview| {
                use webkit2gtk::WebViewExt;
                webview.inner().execute_editing_command(command);
            })
            .is_ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, action);
        false
    }
}

/// The clipboard's text, if it holds any: whether the right-click menu's Paste can paste, and what it
/// pastes where the shell can't paste itself. The page can't read the clipboard on its own.
#[tauri::command]
fn clipboard_text(app: AppHandle) -> Option<String> {
    app.clipboard().read_text().ok().filter(|text| !text.is_empty())
}

/// Whether the inspector can be opened: in a debug build only.
#[tauri::command]
fn can_inspect() -> bool {
    cfg!(debug_assertions)
}

/// Open the inspector on the window's page (a debug build; nothing otherwise).
#[tauri::command]
fn inspect(window: WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window;
}

/// Run `command` in a window's page now if it's ready, or once it is.
fn deliver(app: &AppHandle, label: &str, command: PageCommand) {
    let shell = app.state::<Shell>();
    let ready = shell.ready.lock().unwrap().contains(label);
    match app.get_webview_window(label) {
        Some(window) if ready => {
            let json = serde_json::to_string(&command).unwrap_or_default();
            let _ = window.eval(format!("window.ghWriter && window.ghWriter.run({json})"));
        }
        _ => shell.pending.lock().unwrap().entry(label.to_string()).or_default().push(command),
    }
}

/// Open the library at `path` (one of its dialogs, say) in its window.
fn library_at(app: &AppHandle, path: String) {
    let _ = open_window(app, LIBRARY, "/");
    deliver(app, LIBRARY, PageCommand { name: "go", arg: Some(path) });
}

/// Open a novel's folder: added to the library and opened, or the library says why it can't be.
fn open_folder(app: &AppHandle, folder: &Path) {
    let mut query = Url::parse("http://x/?add=open").expect("a fixed URL");
    query.query_pairs_mut().append_pair("path", &folder.display().to_string());
    library_at(app, format!("/?{}", query.query().unwrap_or_default()));
}

/// The app was opened with these arguments (at launch, or again while running): a folder opens as a
/// novel; otherwise the library comes forward.
fn handle_args(app: &AppHandle, args: &[String], cwd: &Path) {
    match args.iter().find(|a| !a.starts_with('-')) {
        Some(arg) => {
            let folder = cwd.join(arg);
            open_folder(app, &fs::canonicalize(&folder).unwrap_or(folder));
        }
        None => {
            let _ = open_window(app, LIBRARY, "/");
        }
    }
}

/// A window on the server at `path`, or the window with that label brought forward if it's open.
fn open_window(app: &AppHandle, label: &str, path: &str) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(window);
    }
    let (navigating, opening) = (app.clone(), app.clone());
    let own = label.to_string();
    // Every window starts on the loading page and is then sent to the server. Opened straight at the
    // server's sign-in address, WebKitGTK doesn't keep the session cookie that address sets.
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("gh-writer")
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |url| {
            let allowed = may_navigate(&navigating, url);
            // A new page: commands wait until it says it's ready.
            if allowed {
                navigating.state::<Shell>().ready.lock().unwrap().remove(&own);
            }
            allowed
        })
        // Links that open a new window (target=_blank: GitHub's sign-in page, an issue, a release)
        // go to the browser.
        .on_new_window(move |url, _| {
            open_outside(&opening, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    // Folders dropped on the library open as novels. A novel's window leaves drops to its page
    // (pictures dropped on a portrait), which the app's own drop handling would take from it.
    let builder = if label == LIBRARY { builder } else { builder.disable_drag_drop_handler() };
    let window = builder.build()?;
    let shell = app.state::<Shell>();
    match shell.server.lock().unwrap().clone() {
        Some(server) => server.show(&window, path)?,
        // Not up yet: start_server sends it there.
        None => drop(shell.wanted.lock().unwrap().insert(label.to_string(), path.to_string())),
    }
    Ok(window)
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

/// Every window's page saves what's typed.
fn flush_all(app: &AppHandle) {
    for window in app.webview_windows().values() {
        flush(window);
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
        flush_all(&app);
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
    if server.is_some_and(|server| server.url.origin() == url.origin()) {
        return true;
    }
    open_outside(app, url);
    false
}

/// A link for the writer's browser (or mail app): never a window of the app's own.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// Start the server and send every window to it, each where it was (or was asked to go); if it can't
/// start, say why and quit.
fn start_server(app: &AppHandle) {
    let starting = Instant::now();
    let system_git = app.state::<Shell>().settings.lock().unwrap().system_git;
    let started = (|| {
        let resources = Resources::in_dir(&app.path().resource_dir().map_err(|e| e.to_string())?, system_git);
        let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&logs).map_err(|e| format!("Couldn't make the log folder ({}): {e}", logs.display()))?;
        // The app's own executable answers git's prompts for the GitHub token (askpass mode, in main).
        let askpass = std::env::current_exe().map_err(|e| e.to_string())?;
        let version = app.package_info().version.to_string();
        let sidecar = Sidecar::start(&resources, &askpass, &logs.join("server.log"), &version)?;
        let url: Url = sidecar.url.parse().map_err(|e| format!("The server gave a bad address: {e}"))?;
        let server = Server { url, token: sidecar.token.clone() };
        Ok::<_, String>((sidecar, server))
    })();
    match started {
        Ok((sidecar, server)) => {
            eprintln!("gh-writer: server listening at {} after {} ms", server.url, starting.elapsed().as_millis());
            let shell = app.state::<Shell>();
            let previous = shell.server.lock().unwrap().replace(server.clone());
            *shell.sidecar.lock().unwrap() = Some(sidecar);
            let mut wanted = shell.wanted.lock().unwrap();
            for (label, window) in app.webview_windows() {
                // Where it is on the previous server, or where it was asked to go.
                let here = window.url().ok().filter(|url| previous.as_ref().is_some_and(|p| p.url.origin() == url.origin()));
                let path = match (here, wanted.remove(&label)) {
                    (Some(url), _) => format!("{}{}", url.path(), url.query().map(|q| format!("?{q}")).unwrap_or_default()),
                    (None, Some(path)) => path,
                    (None, None) => "/".into(),
                };
                let _ = server.show(&window, &path);
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

/// Stop the server (after every page has saved) and start it again: after a change of git.
fn restart_server(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        flush_all(&app);
        if let Some(sidecar) = app.state::<Shell>().sidecar.lock().unwrap().take() {
            sidecar.stop();
        }
        start_server(&app);
    });
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
            quit(&app);
            return;
        }
    });
}

/// The app's menu: novels in and out of the library, the novels most recently opened, the choice of
/// git, and About. Its New Novel…, Open Folder… and Clone… open the library's own dialogs.
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let shell = app.state::<Shell>();
    let recent = SubmenuBuilder::new(app, "Open Recent").build()?;
    let system_git = CheckMenuItemBuilder::with_id("system-git", "Use This Computer's git").checked(shell.settings.lock().unwrap().system_git).build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new-novel", "New Novel…").build(app)?)
        .item(&MenuItemBuilder::with_id("open-folder", "Open Folder…").build(app)?)
        .item(&MenuItemBuilder::with_id("clone", "Clone from GitHub…").build(app)?)
        .item(&recent)
        .separator()
        .item(&MenuItemBuilder::with_id("library", "Your Novels").build(app)?)
        .separator()
        .item(&system_git)
        .separator()
        .item(&MenuItemBuilder::with_id("close-window", "Close Window").build(app)?)
        .item(&MenuItemBuilder::with_id("quit", "Quit").accelerator("CmdOrCtrl+Q").build(app)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help").item(&MenuItemBuilder::with_id("about", "About gh-writer").build(app)?).build()?;
    app.set_menu(MenuBuilder::new(app).items(&[&file, &edit, &help]).build()?)?;
    *shell.recent_menu.lock().unwrap() = Some(recent);
    *shell.system_git_item.lock().unwrap() = Some(system_git);
    set_recent(app.clone(), Vec::new());
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    let focused = || app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    match id {
        "new-novel" => library_at(app, "/?add=new".into()),
        "open-folder" => library_at(app, "/?add=open".into()),
        "clone" => library_at(app, "/?add=clone".into()),
        "library" => {
            let _ = open_window(app, LIBRARY, "/");
        }
        "about" => {
            let label = focused().map(|w| w.label().to_string()).unwrap_or_else(|| LIBRARY.into());
            if label == LIBRARY {
                let _ = open_window(app, LIBRARY, "/");
            }
            deliver(app, &label, PageCommand { name: "about", arg: None });
        }
        "system-git" => {
            let shell = app.state::<Shell>();
            let settings = {
                let mut settings = shell.settings.lock().unwrap();
                settings.system_git = !settings.system_git;
                settings.clone()
            };
            if let Some(item) = shell.system_git_item.lock().unwrap().as_ref() {
                let _ = item.set_checked(settings.system_git);
            }
            if let Ok(dir) = app.path().app_config_dir() {
                if let Err(e) = settings.save(&dir) {
                    eprintln!("gh-writer: {e}");
                }
            }
            restart_server(app);
        }
        "close-window" => {
            if let Some(window) = focused() {
                let _ = window.close();
            }
        }
        "quit" => quit(app),
        _ => {
            if let Some(id) = id.strip_prefix("recent:") {
                open_novel(app.clone(), id.to_string());
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        // First: a second copy hands its arguments to this one and exits, before anything starts.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| handle_args(app, args.get(1..).unwrap_or_default(), Path::new(&cwd))))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shell::default())
        .invoke_handler(tauri::generate_handler![flushed, page_ready, pick_folder, open_novel, show_library, set_recent, edit, clipboard_text, can_inspect, inspect])
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle();
            if let Ok(dir) = handle.path().app_config_dir() {
                *app.state::<Shell>().settings.lock().unwrap() = Settings::load(&dir);
            }
            #[cfg(unix)]
            quit_on_signals(handle);
            let args: Vec<String> = std::env::args().skip(1).collect();
            handle_args(handle, &args, &std::env::current_dir().unwrap_or_default());
            build_menu(handle)?;
            let handle = handle.clone();
            thread::spawn(move || {
                start_server(&handle);
                watch_server(handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing a window: its page saves first, then it closes (destroy() doesn't ask again).
            WindowEvent::CloseRequested { api, .. } => {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    api.prevent_close();
                    thread::spawn(move || {
                        flush(&webview);
                        let _ = webview.destroy();
                    });
                }
            }
            WindowEvent::Destroyed => {
                let shell = window.state::<Shell>();
                shell.ready.lock().unwrap().remove(window.label());
                shell.pending.lock().unwrap().remove(window.label());
            }
            // A folder dropped on the library opens as a novel (only the library takes drops).
            WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                if let Some(path) = paths.first() {
                    open_folder(window.app_handle(), path);
                }
            }
            _ => {}
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

#[cfg(test)]
mod tests {
    use super::{novel_label, Server};
    use tauri::Url;

    #[test]
    fn opens_windows_only_for_library_ids() {
        assert_eq!(novel_label("lib_4k8h2c"), Some("novel-lib_4k8h2c".into()));
        assert_eq!(novel_label("../etc"), None);
        assert_eq!(novel_label("lib 1"), None);
        assert_eq!(novel_label(""), None);
    }

    #[test]
    fn pages_keep_their_path_and_query_and_the_session_is_the_servers_cookie() {
        let server = Server { url: Url::parse("http://127.0.0.1:4000").unwrap(), token: "t-1".into() };
        assert_eq!(server.page("/").as_str(), "http://127.0.0.1:4000/");
        assert_eq!(server.page("/novels/lib_4k8h2c").as_str(), "http://127.0.0.1:4000/novels/lib_4k8h2c");
        assert_eq!(server.page("/?add=open&path=%2Fhome%2Fada%2Fvarn").as_str(), "http://127.0.0.1:4000/?add=open&path=%2Fhome%2Fada%2Fvarn");
        let cookie = server.session();
        assert_eq!((cookie.name(), cookie.value(), cookie.domain(), cookie.path()), ("ghw_session_4000", "t-1", Some("127.0.0.1"), Some("/")));
        assert_eq!((cookie.http_only(), cookie.same_site()), (Some(true), Some(super::SameSite::Lax)));
    }
}
