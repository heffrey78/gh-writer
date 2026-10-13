// No console window on Windows, except in development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gh_writer_desktop::run();
}
