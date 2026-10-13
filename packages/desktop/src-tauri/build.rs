fn main() {
    // The app's own commands, declared so a capability can grant them to the server's pages.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["flushed"])))
        .expect("the app couldn't be set up for building");
}
