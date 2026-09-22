//! Running an agent's own command-line client for one measurement: found on PATH,
//! started at low priority in a neutral working directory, bounded by a deadline and
//! killed together with its children when done.

use std::env;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::stop;

/// How often a wait for output looks whether the agent is stopping.
const STOP_CHECK: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub enum ProcError {
    NotFound,
    Timeout,
    /// The agent is stopping (see `stop`).
    Stopped,
    /// Output ended (the process exited) before the expected message.
    Closed,
    Io(std::io::Error),
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcError::NotFound => f.write_str("not found"),
            ProcError::Timeout => f.write_str("timed out"),
            ProcError::Stopped => f.write_str("stopped"),
            ProcError::Closed => f.write_str("exited early"),
            ProcError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// An executable named `name` on PATH or in one of `extra` directories.
pub fn find_program(name: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|ext| format!("{name}.{ext}")).collect()
    } else {
        vec![name.to_string()]
    };
    let dirs = env::var_os("PATH").map(|p| env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    dirs.iter().chain(extra).flat_map(|dir| names.iter().map(move |n| dir.join(n))).find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// A running client. Its stdout is read line by line on a helper thread so every read
/// can respect the deadline and a stop. Dropping it kills the process tree.
pub struct Client {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    deadline: Instant,
}

impl Client {
    pub fn spawn<S: AsRef<OsStr>>(
        program: &Path,
        args: &[S],
        env: &[(&str, &str)],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Client, ProcError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env("NO_COLOR", "1");
        for (key, value) in env {
            command.env(key, value);
        }
        lower_priority(&mut command);

        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ProcError::NotFound,
            _ => ProcError::Io(e),
        })?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or(ProcError::Closed)?;
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Client { child, stdin, lines, deadline: Instant::now() + timeout })
    }

    /// Writes one JSON message as a line.
    pub fn send(&mut self, message: &Value) -> Result<(), ProcError> {
        let stdin = self.stdin.as_mut().ok_or(ProcError::Closed)?;
        let mut line = message.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(ProcError::Io)
    }

    /// The next line of output, or `None` when the output has ended.
    pub fn line(&mut self) -> Result<Option<String>, ProcError> {
        loop {
            if stop::requested() {
                return Err(ProcError::Stopped);
            }
            let left = self.deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ProcError::Timeout);
            }
            match self.lines.recv_timeout(left.min(STOP_CHECK)) {
                Ok(line) => return Ok(Some(line)),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }

    /// The first JSON message on stdout that satisfies `wanted`; other lines are skipped.
    pub fn wait_for(&mut self, wanted: impl Fn(&Value) -> bool) -> Result<Value, ProcError> {
        while let Some(line) = self.line()? {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if wanted(&value) {
                    return Ok(value);
                }
            }
        }
        Err(ProcError::Closed)
    }

    /// Everything the process prints until it exits.
    pub fn output(&mut self) -> Result<String, ProcError> {
        self.stdin = None;
        let mut out = String::new();
        while let Some(line) = self.line()? {
            out.push_str(&line);
            out.push('\n');
        }
        Ok(out)
    }

    /// Closes stdin and gives the client a moment to exit on its own.
    pub fn finish(mut self) {
        self.stdin = None;
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Client {
    /// Kills the whole tree, even when the client itself has exited: whatever it
    /// started in the background must not outlive the measurement.
    fn drop(&mut self) {
        self.stdin = None;
        kill_tree(&mut self.child);
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
fn lower_priority(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Its own process group, so the whole tree can be killed at once.
    command.process_group(0);
    // SAFETY: setpriority is async-signal-safe and touches only the new process.
    unsafe {
        command.pre_exec(|| {
            libc::setpriority(libc::PRIO_PROCESS as _, 0, 10);
            Ok(())
        });
    }
}

#[cfg(windows)]
fn lower_priority(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn lower_priority(_: &mut Command) {}

#[cfg(unix)]
fn kill_tree(child: &mut Child) {
    // SAFETY: plain kill(2) on the process group created in `lower_priority`.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_tree(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn reads_json_lines_and_enforces_the_deadline() {
        let sh = Path::new("/bin/sh");
        let dir = env::temp_dir();
        let mut client =
            Client::spawn(sh, &["-c", "echo noise; echo '{\"id\":2}'; sleep 5"], &[], &dir, Duration::from_millis(500))
                .unwrap();
        assert_eq!(client.wait_for(|v| v["id"] == 2).unwrap()["id"], 2);
        let started = Instant::now();
        assert!(matches!(client.line(), Err(ProcError::Timeout)));
        drop(client);
        assert!(started.elapsed() < Duration::from_secs(2), "killed instead of waiting for sleep");
    }

    #[test]
    fn what_a_client_leaves_running_is_killed_with_it() {
        let sh = Path::new("/bin/sh");
        let dir = env::temp_dir();
        let mut client =
            Client::spawn(sh, &["-c", "sleep 30 & echo \"{\\\"pid\\\": $!}\""], &[], &dir, Duration::from_secs(5))
                .unwrap();
        let pid = client.wait_for(|v| v["pid"].is_u64()).unwrap()["pid"].as_u64().unwrap();
        client.finish();
        thread::sleep(Duration::from_millis(100));
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "the background sleep outlived its client");
    }

    #[test]
    fn a_missing_program_is_reported_as_such() {
        let missing = Path::new("/nonexistent/quotum-test");
        assert!(matches!(
            Client::spawn::<&str>(missing, &[], &[], &env::temp_dir(), Duration::from_secs(1)),
            Err(ProcError::NotFound)
        ));
        assert!(find_program("quotum-surely-missing", &[]).is_none());
        assert!(find_program("sh", &[]).is_some());
    }
}
