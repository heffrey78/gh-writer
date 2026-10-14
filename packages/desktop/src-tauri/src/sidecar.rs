//! The server, run beside the app (D9): Node's official binary running the bundled server with
//! `gh-writer serve --sidecar`. It prints one JSON line once it's listening, and stops when its stdin
//! closes, so it goes with the app however the app goes, crashes included.

use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// How long the server has to start.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long it has to stop once asked: its own shutdown timeout (10 s), then committing waiting work.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the app's own Node, server and git are, in its resources.
pub struct Resources {
    pub node: PathBuf,
    pub server: PathBuf,
    /// The portable git, if the app has one; otherwise the server uses the system's.
    pub git: Option<PathBuf>,
    /// The licence texts of what the app ships, for About.
    pub licenses: PathBuf,
}

impl Resources {
    /// The resources in `dir`; with `system_git`, the server uses the computer's own git.
    pub fn in_dir(dir: &Path, system_git: bool) -> Self {
        let git = dir.join("runtime/git");
        Self {
            node: dir.join("runtime/node").join(if cfg!(windows) { "node.exe" } else { "node" }),
            server: dir.join("server/gh-writer.mjs"),
            git: (git.is_dir() && !system_git).then_some(git),
            licenses: dir.join("licenses"),
        }
    }
}

pub struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    /// http://127.0.0.1:<port>
    pub url: String,
    /// The secret a launch URL carries, which signs a window in.
    pub token: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Line {
    Ready {
        url: String,
        token: String,
    },
    Failed {
        error: String,
    },
}

/// The server's first line: its address and launch token, or why it couldn't start.
pub fn parse_line(line: &str) -> Result<(String, String), String> {
    if line.trim().is_empty() {
        return Err("The server stopped before it started.".into());
    }
    match serde_json::from_str::<Line>(line.trim()) {
        Ok(Line::Ready { url, token }) => Ok((url, token)),
        Ok(Line::Failed { error }) => Err(error),
        Err(_) => Err(format!("The server said something unexpected: {}", line.trim())),
    }
}

impl Sidecar {
    /// Start the server and wait until it's listening. Its messages go to `log` (the last run's are
    /// kept beside it, as .previous.log). `askpass` answers git's prompts for GitHub tokens; `version`
    /// is the app's, for About and the update check.
    pub fn start(resources: &Resources, askpass: &Path, log: &Path, version: &str) -> Result<Sidecar, String> {
        if log.exists() {
            let _ = fs::rename(log, log.with_extension("previous.log"));
        }
        let log_file = File::create(log).map_err(|e| format!("Couldn't write the server's log ({}): {e}", log.display()))?;
        let mut command = Command::new(&resources.node);
        command
            .arg(&resources.server)
            .args(["serve", "--sidecar"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log_file)
            .env("GH_WRITER_APP_VERSION", version)
            .env("GH_WRITER_LICENSES", &resources.licenses);
        if let Some(git) = &resources.git {
            command.env("GH_WRITER_GIT", git).env("GH_WRITER_ASKPASS", askpass);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Couldn't start the server ({}): {e}", resources.node.display()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout is piped");

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let _ = tx.send(reader.read_line(&mut line).map(|_| line));
            // Nothing more is expected on stdout; keep reading so a stray write never fails.
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let first = match rx.recv_timeout(START_TIMEOUT) {
            Ok(Ok(line)) => parse_line(&line),
            Ok(Err(e)) => Err(format!("Couldn't read from the server: {e}")),
            Err(_) => Err(format!("The server didn't start within {} seconds.", START_TIMEOUT.as_secs())),
        };
        let mut sidecar = Sidecar { child, stdin, url: String::new(), token: String::new() };
        match first {
            Ok((url, token)) => {
                sidecar.url = url;
                sidecar.token = token;
                Ok(sidecar)
            }
            Err(e) => {
                sidecar.stop();
                Err(e)
            }
        }
    }

    /// Whether the server is still running.
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Stop the server: close its stdin, which it takes as the sign to finish its work (in-flight
    /// saves, then commits) and exit, and kill it if it hasn't within STOP_TIMEOUT.
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_line;

    #[test]
    fn reads_the_address_and_token() {
        let line = r#"{"url":"http://127.0.0.1:4000","token":"t","launchUrl":"http://127.0.0.1:4000/?token=t"}"#;
        assert_eq!(parse_line(line), Ok(("http://127.0.0.1:4000".into(), "t".into())));
    }

    #[test]
    fn reads_why_it_failed() {
        assert_eq!(parse_line("{\"error\":\"That folder isn't a git repository.\"}\n"), Err("That folder isn't a git repository.".into()));
    }

    #[test]
    fn says_when_it_stopped_or_said_something_else() {
        assert_eq!(parse_line(""), Err("The server stopped before it started.".into()));
        assert!(parse_line("Error: Cannot find module").unwrap_err().contains("Cannot find module"));
    }
}
