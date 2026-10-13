// No console window on Windows, except in development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by git to answer a prompt for the GitHub token: answer and exit, before any window.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if gh_writer_desktop::askpass::is_prompt(&args) {
        gh_writer_desktop::askpass::run(&args[0]);
    }
    gh_writer_desktop::run();
}
