//! The hub the app carries: Node running the hub of this commit in its local mode, as a
//! child process on 127.0.0.1. Each start of it gets a new key for the window and a new
//! token for the agent; they live only in this process and in the child's environment.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::files::Log;

/// Where the hub is: the window, the agent and the commands use only a `Ready` one.
#[derive(Clone, Debug, PartialEq)]
pub enum HubState {
    /// Starting for the first time or again, including the pause before a new attempt.
    Starting,
    Ready(Ready),
    /// For good: the attempts are used up, or the app is quitting.
    Down,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ready {
    pub port: u16,
    /// Opens the board for the window: `/local?key=…`.
    pub key: String,
    /// The machine token of the app's agent.
    pub token: String,
}

impl Ready {
    pub fn origin(&self) -> String {
        origin(self.port)
    }
}

/// Always the IPv4 address, never `localhost`: another user of the machine could listen on
/// the same port of `[::1]`.
pub fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// A new key and token for one start of the hub, from the system's random source.
pub struct Secrets {
    pub key: String,
    pub token: String,
}

impl Secrets {
    pub fn new() -> Secrets {
        let random = |n: usize| {
            let mut bytes = vec![0u8; n];
            getrandom::fill(&mut bytes).expect("the system's random source");
            base64url(&bytes)
        };
        Secrets { key: random(32), token: format!("qt_m_{}", random(24)) }
    }
}

/// Base64 in its URL form without padding, as the hub writes its own secrets.
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// A line the hub prints on stdout about itself.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Start {
        port: u16,
        local: bool,
    },
    /// It stopped listening (its stdin closed, or a signal): this start of it is over.
    Stop {
        reason: String,
    },
    Error {
        code: String,
    },
}

/// Only whole lines of JSON with an `event` are events; anything else is only logged.
pub fn parse_event(line: &str) -> Option<Event> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    match value.get("event")?.as_str()? {
        "start" => Some(Event::Start {
            port: value.get("port")?.as_u64().and_then(|p| u16::try_from(p).ok())?,
            local: value.get("local").and_then(Value::as_bool).unwrap_or(false),
        }),
        "stop" => Some(Event::Stop { reason: value.get("reason").and_then(Value::as_str).unwrap_or("").into() }),
        "error" => Some(Event::Error { code: value.get("code").and_then(Value::as_str).unwrap_or("").into() }),
        _ => None,
    }
}

/// What the hub gets of the app's environment: what Node and the system need, and the
/// hub's own settings. No `NODE_OPTIONS` or any other `NODE_*` of the person's reaches it.
pub fn environment(
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    windows: bool,
    own: &[(&str, &str)],
) -> Vec<(OsString, OsString)> {
    const WINDOWS: &[&str] = &[
        "SystemRoot",
        "SystemDrive",
        "windir",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "USERNAME",
        "LOCALAPPDATA",
        "APPDATA",
        "PATH",
    ];
    const UNIX: &[&str] = &["HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR", "PATH"];
    // Names on Windows are one variable whatever their case (Path and PATH).
    let same = |a: &str, b: &str| if windows { a.eq_ignore_ascii_case(b) } else { a == b };
    let wanted = |name: &str| {
        let list = if windows { WINDOWS } else { UNIX };
        list.iter().any(|w| same(w, name)) || (!windows && name.starts_with("LC_")) || same(name, "QUOTUM_RESETS")
    };
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    for (name, value) in inherited {
        let Some(text) = name.to_str() else { continue };
        if wanted(text) && !env.iter().any(|(n, _)| n.to_str().is_some_and(|n| same(n, text))) {
            env.push((name, value));
        }
    }
    env.retain(|(name, _)| !own.iter().any(|(own, _)| name.to_str().is_some_and(|n| same(n, own))));
    env.extend(own.iter().map(|(name, value)| (OsString::from(name), OsString::from(value))));
    env
}

/// At most this many starts again within `RESTART_WINDOW`; after that the hub stays down.
const RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(300);

/// When the hub may be started again after an end nobody asked for.
#[derive(Default)]
pub struct Restarts {
    at: VecDeque<Instant>,
}

impl Restarts {
    /// Counts one; false when the attempts of the last five minutes are used up.
    pub fn allow(&mut self, now: Instant) -> bool {
        while self.at.front().is_some_and(|t| now.duration_since(*t) >= RESTART_WINDOW) {
            self.at.pop_front();
        }
        if self.at.len() >= RESTARTS {
            return false;
        }
        self.at.push_back(now);
        true
    }
}

/// What the threads around one start of the hub report.
#[derive(Debug)]
pub enum Signal {
    Event(Event),
    /// Its stdout ended.
    Eof,
    /// The process exited.
    Exited(Option<ExitStatus>),
}

/// The running hub process: its stdin stays open, unwritten, for as long as it should live.
pub struct Proc {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pub pid: u32,
}

impl Proc {
    /// Starts `node --disable-sigusr1 <script>` in `cwd` with exactly `env`. Its stdout and
    /// stderr go to the log line by line; events come from stdout only, and the end of its
    /// output and its exit are reported apart, each on a thread of its own.
    pub fn start(
        node: &Path,
        script: &Path,
        cwd: &Path,
        env: Vec<(OsString, OsString)>,
        log: Arc<Log>,
        signals: Sender<Signal>,
    ) -> std::io::Result<Arc<Proc>> {
        let mut command = Command::new(node);
        // SIGUSR1 would otherwise open Node's inspector on loopback, readable by any local user.
        command.arg("--disable-sigusr1").arg(script).current_dir(cwd).env_clear().envs(env);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let proc = Arc::new(Proc { pid: child.id(), child: Mutex::new(child), stdin: Mutex::new(stdin) });

        if let Some(stdout) = stdout {
            let (log, signals) = (log.clone(), signals.clone());
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    log.raw(&line);
                    if let Some(event) = parse_event(&line) {
                        let _ = signals.send(Signal::Event(event));
                    }
                }
                let _ = signals.send(Signal::Eof);
            });
        }
        if let Some(stderr) = stderr {
            let log = log.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log.raw(&line);
                }
            });
        }
        let waited = proc.clone();
        thread::spawn(move || {
            loop {
                if let Some(status) = waited.try_wait() {
                    let _ = signals.send(Signal::Exited(status));
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(proc)
    }

    /// `Some` once it exited (with its status, when known).
    pub fn try_wait(&self) -> Option<Option<ExitStatus>> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        match child.try_wait() {
            Ok(Some(status)) => Some(Some(status)),
            Ok(None) => None,
            Err(_) => Some(None),
        }
    }

    /// The hub's cue to stop: it ends by itself when its stdin closes (and when this
    /// process dies, the system closes it).
    pub fn close_stdin(&self) {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Waits up to `limit` for the exit; ends it outright after that. True only for a
    /// successful exit without forced termination.
    pub fn finish(&self, limit: Duration) -> bool {
        let until = Instant::now() + limit;
        while Instant::now() < until {
            if let Some(status) = self.try_wait() {
                return status.is_some_and(|status| status.success());
            }
            thread::sleep(Duration::from_millis(50));
        }
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
        false
    }
}

/// The hub's script in the app's resources, and its working directory.
pub fn script(resources: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (resources.join("dist/app/server.mjs"), resources.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(n, v)| (OsString::from(n), OsString::from(v))).collect()
    }

    fn names(env: &[(OsString, OsString)]) -> Vec<String> {
        env.iter().map(|(n, _)| n.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn closing_stdin_lets_the_hub_child_exit_without_being_killed() {
        let root =
            std::env::temp_dir().join(format!("quotum-hub-{}-{}", std::process::id(), crate::shell::random_u32()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("stand-in.cjs");
        std::fs::write(&script, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));").unwrap();
        let executable = if cfg!(windows) {
            "quotum-node-x86_64-pc-windows-msvc.exe"
        } else {
            "quotum-node-x86_64-unknown-linux-gnu"
        };
        let node = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(executable);
        let (signals, _received) = std::sync::mpsc::channel();
        let log = Arc::new(Log::new(root.join("hub.log")));
        let child =
            Proc::start(&node, &script, &root, environment(std::env::vars_os(), cfg!(windows), &[]), log, signals)
                .unwrap();
        child.close_stdin();
        assert!(child.finish(Duration::from_secs(5)), "the stand-in must exit after EOF, without a kill");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_hub_gets_the_system_it_needs_and_none_of_nodes_options() {
        let inherited = os(&[
            ("HOME", "/home/ann"),
            ("PATH", "/usr/bin"),
            ("LC_TIME", "ru_RU.UTF-8"),
            ("NODE_OPTIONS", "--inspect"),
            ("NODE_EXTRA_CA_CERTS", "/x"),
            ("LD_LIBRARY_PATH", "/tmp/.mount/usr/lib"),
            ("QUOTUM_HUB_TOKEN", "qt_m_secret"),
            ("QUOTUM_RESETS", "off"),
        ]);
        let own = [("QUOTUM_PORT", "23456"), ("NODE_ENV", "production")];
        let env = environment(inherited, false, &own);
        assert_eq!(names(&env), ["HOME", "PATH", "LC_TIME", "QUOTUM_RESETS", "QUOTUM_PORT", "NODE_ENV"]);
        assert!(!names(&env).iter().any(|n| n.starts_with("NODE_") && n != "NODE_ENV"));
    }

    #[test]
    fn on_windows_a_name_in_any_case_is_one_variable() {
        let inherited =
            os(&[("Path", "C:\\Windows"), ("PATH", "C:\\other"), ("SYSTEMROOT", "C:\\Windows"), ("node_env", "dev")]);
        let env = environment(inherited, true, &[("NODE_ENV", "production")]);
        assert_eq!(names(&env), ["Path", "SYSTEMROOT", "NODE_ENV"]);
        assert_eq!(env[0].1, OsString::from("C:\\Windows"), "the first of the two is kept");
    }

    #[test]
    fn events_are_whole_json_lines_with_an_event() {
        assert_eq!(
            parse_event(r#"{"event":"start","users":1,"port":23456,"local":true}"#),
            Some(Event::Start { port: 23456, local: true })
        );
        assert_eq!(parse_event(r#"{"event":"stop","reason":"stdin"}"#), Some(Event::Stop { reason: "stdin".into() }));
        assert_eq!(parse_event(r#"{"event":"stop","reason":"signal"}"#), Some(Event::Stop { reason: "signal".into() }));
        assert_eq!(
            parse_event(r#"{"event":"error","code":"port_in_use"}"#),
            Some(Event::Error { code: "port_in_use".into() })
        );
        assert_eq!(parse_event("Quotum has no account yet."), None);
        assert_eq!(parse_event(r#"{"event":"start"}"#), None, "a start without its port");
        assert_eq!(parse_event(r#"note {"event":"stop"}"#), None, "only a whole line");
    }

    #[test]
    fn three_restarts_in_five_minutes_and_no_more() {
        let mut restarts = Restarts::default();
        let t = Instant::now();
        assert!(restarts.allow(t) && restarts.allow(t) && restarts.allow(t));
        assert!(!restarts.allow(t + Duration::from_secs(10)));
        assert!(restarts.allow(t + RESTART_WINDOW), "the oldest are forgotten after five minutes");
    }

    #[test]
    fn secrets_are_new_each_time_and_shaped_as_the_hub_wants() {
        let (a, b) = (Secrets::new(), Secrets::new());
        assert_ne!(a.key, b.key);
        assert_eq!(a.key.len(), 43);
        assert!(a.token.starts_with("qt_m_") && a.token.len() == 5 + 32);
        assert_eq!(base64url(b"\xfb\xff"), "-_8");
        assert_eq!(base64url(b"Man"), "TWFu");
    }
}
