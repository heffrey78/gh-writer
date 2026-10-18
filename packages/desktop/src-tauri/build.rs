fn main() {
    // The app's own commands, declared so a capability can grant them to the server's pages.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["flushed", "page_ready", "pick_folder", "open_novel", "show_library", "set_recent", "edit", "clipboard_text", "can_inspect", "inspect"])))
        .expect("the app couldn't be set up for building");
}
