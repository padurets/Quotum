//! Running an agent's own command-line client for one measurement: found on PATH or
//! where installers put it, started at low priority in a neutral working directory,
//! bounded by a deadline and killed together with its children when done.

use std::cmp::Reverse;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::config::home;
use crate::stop::Stop;

/// How often a wait for output looks whether the agent is stopping.
const STOP_CHECK: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub enum ProcError {
    NotFound,
    Timeout,
    /// The run is stopping (see `stop`).
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
    dirs.iter()
        .chain(extra)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .filter(|path| !(cfg!(windows) && is_app_alias(path)))
        .find(|path| is_executable(path))
}

/// An app execution alias of Windows (`…\Microsoft\WindowsApps\claude.exe`): it passes for a
/// program, but it opens the app it stands for, Claude Desktop's window for `claude`.
fn is_app_alias(path: &Path) -> bool {
    let path = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    path.contains("\\microsoft\\windowsapps\\")
}

/// Where installers and package managers put programs: a service's PATH (launchd,
/// systemd, a scheduled task) often lacks them.
pub fn usual_dirs(home: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = [
        ".local/bin",
        ".npm-global/bin",
        ".bun/bin",
        ".volta/bin",
        ".yarn/bin",
        ".local/share/pnpm",
        ".local/share/fnm/aliases/default/bin",
    ]
    .iter()
    .map(|dir| home.join(dir))
    .collect();
    // nvm keeps a directory per Node version, the newest first here.
    if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
        let version = |dir: &PathBuf| -> Vec<u32> {
            let name = dir.file_name().and_then(OsStr::to_str).unwrap_or_default();
            name.trim_start_matches('v').split('.').map(|part| part.parse().unwrap_or(0)).collect()
        };
        let mut versions: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
        versions.sort_by_key(|dir| Reverse(version(dir)));
        found.extend(versions.into_iter().map(|dir| dir.join("bin")));
    }
    #[cfg(target_os = "macos")]
    found.extend([
        home.join("Library/pnpm"),
        home.join("Library/Application Support/fnm/aliases/default/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    #[cfg(all(unix, not(target_os = "macos")))]
    found.extend([PathBuf::from("/usr/local/bin"), PathBuf::from("/home/linuxbrew/.linuxbrew/bin")]);
    #[cfg(windows)]
    found.extend(dirs::data_dir().map(|roaming| roaming.join("npm")));
    found
}

/// PATH for a client: its own directory first, so an npm shim (`#!/usr/bin/env node`)
/// finds the runtime installed next to it, then the PATH it is given, then the usual
/// directories that PATH lacks.
fn client_path(program: &Path, current: Option<&OsStr>, home: &Path) -> Option<OsString> {
    let own = program.parent().filter(|dir| !dir.as_os_str().is_empty()).map(Path::to_path_buf);
    let current: Vec<PathBuf> = current.map(|p| env::split_paths(p).collect()).unwrap_or_default();
    let usual = usual_dirs(home).into_iter().filter(|dir| dir.is_dir() && !current.contains(dir));
    env::join_paths(own.into_iter().chain(current.iter().cloned()).chain(usual)).ok()
}

/// What an AppImage sets for itself (its AppRun and GTK hook): its libraries, Python, GTK
/// and GStreamer modules. A client and whatever it starts (git, curl, Node) must not load them.
const APPIMAGE_VARIABLES: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "GSETTINGS_SCHEMA_DIR",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];
const APPIMAGE_PREFIXES: &[&str] = &["GST_PLUGIN_", "GTK_", "GDK_", "GIO_"];

/// The environment of a client: this process's, with its PATH (see [`client_path`]), and
/// without what an AppImage the agent runs in set for itself, inside it (`$APPDIR`) or
/// not. Names are one variable whatever their case on Windows (`Path` and `PATH`).
pub fn client_env(
    program: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    windows: bool,
    home: &Path,
) -> Vec<(OsString, OsString)> {
    let is = |name: &OsStr, wanted: &str| match name.to_str() {
        Some(name) if windows => name.eq_ignore_ascii_case(wanted),
        Some(name) => name == wanted,
        None => false,
    };
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    for (name, value) in inherited {
        // The first of a name wins, as a lookup of it would.
        if !env.iter().any(|(n, _)| name.to_str().is_some_and(|text| is(n, text))) {
            env.push((name, value));
        }
    }
    let appdir = env
        .iter()
        .find(|(n, _)| is(n, "APPDIR"))
        .map(|(_, v)| PathBuf::from(v))
        .or_else(|| env.iter().any(|(n, _)| is(n, "APPIMAGE")).then(PathBuf::new));
    if let Some(appdir) = appdir {
        let inside = |dir: &Path| !appdir.as_os_str().is_empty() && dir.starts_with(&appdir);
        env.retain(|(name, _)| {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            !APPIMAGE_VARIABLES.iter().any(|v| is(name, v)) && !APPIMAGE_PREFIXES.iter().any(|p| upper.starts_with(p))
        });
        for (name, value) in env.iter_mut() {
            if is(name, "PATH") || is(name, "XDG_DATA_DIRS") {
                let kept: Vec<PathBuf> = env::split_paths(value).filter(|dir| !inside(dir)).collect();
                *value = env::join_paths(kept).unwrap_or_default();
            }
        }
        env.retain(|(name, value)| !(is(name, "XDG_DATA_DIRS") && value.is_empty()));
    }
    let current = env.iter().position(|(n, _)| is(n, "PATH"));
    let path = client_path(program, current.map(|i| env[i].1.as_os_str()), home);
    match (current, path) {
        (Some(i), Some(path)) => env[i].1 = path,
        (None, Some(path)) => env.push(("PATH".into(), path)),
        (_, None) => {}
    }
    env
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
    /// The stop of the run that started it.
    stop: Stop,
    /// Holds the client and everything it starts (Windows has no process groups).
    #[cfg(windows)]
    job: Option<job::Job>,
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
        stop: &Stop,
    ) -> Result<Client, ProcError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .envs(client_env(program, env::vars_os(), cfg!(windows), &home()))
            .env("NO_COLOR", "1");
        for (key, value) in env {
            command.env(key, value);
        }
        lower_priority(&mut command);

        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ProcError::NotFound,
            _ => ProcError::Io(e),
        })?;
        // At once, before the client starts children of its own (an npm .cmd shim starts node).
        #[cfg(windows)]
        let job = job::Job::holding(&child);
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
        Ok(Client {
            child,
            stop: stop.clone(),
            #[cfg(windows)]
            job,
            stdin,
            lines,
            deadline: Instant::now() + timeout,
        })
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
            if self.stop.requested() {
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
        self.kill_tree();
        let _ = self.child.wait();
    }
}

impl Client {
    #[cfg(unix)]
    fn kill_tree(&mut self) {
        // SAFETY: plain kill(2) on the process group created in `lower_priority`.
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    fn kill_tree(&mut self) {
        match &self.job {
            Some(job) => job.kill(),
            // No job object (refused by the system): taskkill follows the tree by parent ids.
            None => {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &self.child.id().to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
                let _ = self.child.kill();
            }
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn kill_tree(&mut self) {
        let _ = self.child.kill();
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
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Takes a process started with `command` out of this terminal's session, so closing the
/// terminal does not end it (`quotum start`).
#[cfg(unix)]
pub fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: setsid(2) is async-signal-safe and touches nothing of the parent.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// Starts it without a console, in a process group of its own, so closing the window
/// does not end it.
#[cfg(windows)]
pub fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
pub fn detach(_: &mut Command) {}

/// Ends a process outright, with whatever it started (`quotum stop`, when asking was not enough).
#[cfg(unix)]
pub fn kill(pid: u32) {
    // SAFETY: plain kill(2) of a process id.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(windows)]
pub fn kill(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(any(unix, windows)))]
pub fn kill(_: u32) {}

#[cfg(windows)]
fn lower_priority(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn lower_priority(_: &mut Command) {}

/// A Windows job object: every process started inside it belongs to it, and it kills
/// them all at once, also when its last handle closes (the agent itself crashed).
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::{mem, ptr};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject,
    };

    pub struct Job(HANDLE);

    impl Job {
        /// A new job holding `child`, or `None` when the system refuses one.
        pub fn holding(child: &Child) -> Option<Job> {
            // SAFETY: the job handle is owned by the returned `Job` (closed on drop, also on
            // the early returns); the child's handle stays open while `child` lives.
            unsafe {
                let handle = CreateJobObjectW(ptr::null(), ptr::null());
                if handle.is_null() {
                    return None;
                }
                let job = Job(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let (info, size) = ((&raw const limits).cast(), mem::size_of_val(&limits) as u32);
                if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, info, size) == 0 {
                    return None;
                }
                if AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                    return None;
                }
                Some(job)
            }
        }

        pub fn kill(&self) {
            // SAFETY: the handle is open until drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed exactly once, here.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(n, v)| (OsString::from(n), OsString::from(v))).collect()
    }

    #[cfg(unix)]
    fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
        env.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_os_str())
    }

    #[cfg(unix)]
    #[test]
    fn reads_json_lines_and_enforces_the_deadline() {
        let sh = Path::new("/bin/sh");
        let dir = env::temp_dir();
        let mut client = Client::spawn(
            sh,
            &["-c", "echo noise; echo '{\"id\":2}'; sleep 5"],
            &[],
            &dir,
            Duration::from_millis(500),
            &Stop::new(),
        )
        .unwrap();
        assert_eq!(client.wait_for(|v| v["id"] == 2).unwrap()["id"], 2);
        let started = Instant::now();
        assert!(matches!(client.line(), Err(ProcError::Timeout)));
        drop(client);
        assert!(started.elapsed() < Duration::from_secs(2), "killed instead of waiting for sleep");
    }

    #[cfg(unix)]
    #[test]
    fn a_stopped_run_stops_waiting_for_its_client_and_kills_it() {
        let stop = Stop::new();
        let mut client = Client::spawn(
            Path::new("/bin/sh"),
            &["-c", "sleep 30"],
            &[],
            &env::temp_dir(),
            Duration::from_secs(20),
            &stop,
        )
        .unwrap();
        let pid = client.child.id() as libc::pid_t;
        let asked = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            asked.request(crate::stop::How::Exit);
        });
        let started = Instant::now();
        assert!(matches!(client.line(), Err(ProcError::Stopped)));
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(client);
        // SAFETY: signal 0 only checks that the process exists.
        assert!(unsafe { libc::kill(pid, 0) } != 0, "the client is gone");
    }

    #[cfg(unix)]
    #[test]
    fn what_a_client_leaves_running_is_killed_with_it() {
        let sh = Path::new("/bin/sh");
        let dir = env::temp_dir();
        let mut client = Client::spawn(
            sh,
            &["-c", "sleep 30 & echo \"{\\\"pid\\\": $!}\""],
            &[],
            &dir,
            Duration::from_secs(5),
            &Stop::new(),
        )
        .unwrap();
        let pid = client.wait_for(|v| v["pid"].is_u64()).unwrap()["pid"].as_u64().unwrap() as libc::pid_t;
        client.finish();
        // No /proc on macOS: kill(pid, 0) fails with ESRCH once the process is gone and reaped.
        // SAFETY: signal 0 only checks that the process exists.
        let gone = || {
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        };
        let until = Instant::now() + Duration::from_secs(2);
        while !gone() && Instant::now() < until {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(gone(), "the background sleep outlived its client");
    }

    #[cfg(unix)]
    #[test]
    fn a_client_finds_what_is_installed_next_to_it() {
        let home = Path::new("/home/u");
        let path = client_path(Path::new("/opt/node/bin/claude"), Some(OsStr::new("/usr/bin")), home).unwrap();
        let dirs: Vec<PathBuf> = env::split_paths(&path).collect();
        assert_eq!(dirs[..2], [PathBuf::from("/opt/node/bin"), PathBuf::from("/usr/bin")]);
        assert!(usual_dirs(home).contains(&home.join(".npm-global/bin")));
    }

    #[cfg(unix)]
    #[test]
    fn a_client_started_from_an_appimage_gets_none_of_it() {
        let inherited = os(&[
            ("HOME", "/home/ann"),
            ("APPDIR", "/tmp/.mount_QuotumX"),
            ("APPIMAGE", "/home/ann/Applications/Quotum.AppImage"),
            ("PATH", "/tmp/.mount_QuotumX/usr/bin:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_QuotumX/usr/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_QuotumX/usr/share:/usr/share"),
            ("GTK_PATH", "/tmp/.mount_QuotumX/usr/lib/gtk-3.0"),
            ("GIO_MODULE_DIR", "/tmp/.mount_QuotumX/usr/lib/gio/modules"),
            ("GST_PLUGIN_SYSTEM_PATH", "/tmp/.mount_QuotumX/usr/lib/gstreamer"),
            ("PYTHONHOME", "/tmp/.mount_QuotumX/usr"),
            ("OWD", "/home/ann"),
            ("LANG", "ru_RU.UTF-8"),
        ]);
        let env = client_env(Path::new("/home/ann/.local/bin/claude"), inherited, false, Path::new("/nonexistent"));
        let names: Vec<_> = env.iter().map(|(n, _)| n.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["HOME", "PATH", "XDG_DATA_DIRS", "LANG"]);
        // Then the usual directories this machine has, which differ from runner to runner.
        let path = get(&env, "PATH").unwrap().to_string_lossy();
        assert!(path.starts_with("/home/ann/.local/bin:/usr/local/bin:/usr/bin"), "{path}");
        assert!(!path.contains(".mount_"), "{path}");
        assert_eq!(get(&env, "XDG_DATA_DIRS").unwrap(), "/usr/share");

        let plain = os(&[("HOME", "/home/ann"), ("PATH", "/bin"), ("GTK_THEME", "Adwaita:dark")]);
        let env = client_env(Path::new("/opt/codex/codex"), plain, false, Path::new("/nonexistent"));
        let names: Vec<_> = env.iter().map(|(n, _)| n.to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["HOME", "PATH", "GTK_THEME"], "outside an AppImage all stays");
        assert!(get(&env, "PATH").unwrap().to_string_lossy().starts_with("/opt/codex:/bin"));
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_path_is_one_variable_whatever_its_case() {
        let inherited = os(&[("Path", "C:\\Windows\\system32"), ("PATH", "C:\\other"), ("SystemRoot", "C:\\Windows")]);
        let env = client_env(Path::new("C:\\tools\\codex.exe"), inherited, true, Path::new("C:\\nonexistent"));
        let paths: Vec<_> = env.iter().filter(|(n, _)| n.eq_ignore_ascii_case("path")).collect();
        assert_eq!(paths.len(), 1);
        let dirs: Vec<PathBuf> = env::split_paths(&paths[0].1).collect();
        assert_eq!(dirs[..2], [PathBuf::from("C:\\tools"), PathBuf::from("C:\\Windows\\system32")]);
    }

    #[test]
    fn an_app_alias_of_windows_is_no_client() {
        assert!(is_app_alias(Path::new("C:\\Users\\ann\\AppData\\Local\\Microsoft\\WindowsApps\\claude.exe")));
        assert!(is_app_alias(Path::new(
            "C:/Users/ann/AppData/Local/Microsoft/WindowsApps/Claude_pzs8sxrjxfjjc/claude.exe"
        )));
        assert!(!is_app_alias(Path::new("C:\\Users\\ann\\AppData\\Roaming\\npm\\claude.cmd")));
        assert!(!is_app_alias(Path::new("C:\\Users\\ann\\.local\\bin\\claude.exe")));
    }

    #[test]
    fn a_missing_program_is_reported_as_such() {
        let missing = Path::new("/nonexistent/quotum-test");
        assert!(matches!(
            Client::spawn::<&str>(missing, &[], &[], &env::temp_dir(), Duration::from_secs(1), &Stop::new()),
            Err(ProcError::NotFound)
        ));
        assert!(find_program("quotum-surely-missing", &[]).is_none());
        #[cfg(unix)]
        assert!(find_program("sh", &[]).is_some());
    }
}
