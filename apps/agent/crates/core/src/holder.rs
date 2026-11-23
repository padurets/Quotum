//! Who measures this machine: one agent at a time, `quotum run` or the desktop app. They
//! share the settings, the state directory and the machine's identity. Whichever measures
//! holds `run.lock` in the state directory and names itself in `run.pid` (the app as
//! `app <pid>`). The command-line agent also writes `run.info` (its pid, version and hub),
//! which tells that it knows how to make way: asked with `yield` in `run.stop`, it lets
//! the machine go at once and waits in `run.wait.lock` until the app quits, then measures
//! again. `quotum stop` stops such a waiting agent through `run.wait.stop`; it never stops
//! the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::{Paths, lock_file};
use crate::process;
use crate::stop::How;

/// Who takes the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Holder {
    Cli,
    App,
}

/// The agent holding the machine (or waiting for it): its process, when it said which.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Running {
    pub pid: Option<u32>,
    pub app: bool,
}

#[derive(Debug)]
pub enum LockError {
    /// Someone else holds it.
    Held(Running),
    Io(String),
}

/// What `quotum run` says about itself while it holds the machine (`run.info`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct RunInfo {
    pub pid: u32,
    pub version: String,
    /// Where it delivers, without its token; `None` without a hub.
    pub hub: Option<String>,
}

/// How a stop went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// Nothing ran (or waited).
    Nothing,
    /// It stopped (or made way) as asked.
    Asked(Option<u32>),
    /// It did not in time and was ended outright.
    Killed(u32),
}

/// How long a stop waits: for a stop, for making way, and after a kill; and how often it looks.
#[derive(Clone, Copy, Debug)]
pub struct Waits {
    pub exit: Duration,
    /// A `quotum run` that makes way lets the machine go at once; it is not ended before this.
    pub yielding: Duration,
    pub after_kill: Duration,
    pub step: Duration,
}

impl Waits {
    pub const REAL: Waits = Waits {
        exit: Duration::from_secs(15),
        yielding: Duration::from_secs(30),
        after_kill: Duration::from_secs(5),
        step: Duration::from_millis(100),
    };
}

/// A lock that is just being probed by someone else looks taken for a moment: looked at again.
const TRIES: usize = 3;
const RETRY: Duration = Duration::from_millis(200);

/// The machine held: `run.pid` and `run.info` go when it is dropped, before the lock itself.
#[derive(Debug)]
pub struct RunLock {
    _file: fs::File,
    pid: PathBuf,
    info: PathBuf,
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.info);
        let _ = fs::remove_file(&self.pid);
    }
}

/// The place of the one `quotum run` waiting for the app; `run.wait.pid` goes with it.
#[derive(Debug)]
pub struct WaitSlot {
    _file: fs::File,
    pid: PathBuf,
}

impl Drop for WaitSlot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.pid);
    }
}

/// Writes a new file next to `path` and puts it in its place: a reader never sees it half
/// written (an empty `run.stop` means stop, a half-written `yield` would read as one).
pub fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let next = path.with_file_name(format!(".{name}.{}.new", std::process::id()));
    fs::write(&next, contents)?;
    fs::rename(&next, path).inspect_err(|_| {
        let _ = fs::remove_file(&next);
    })
}

/// `run.pid`: "<pid>" for `quotum run` (as always), "app <pid>" for the app.
fn parse_pid(text: &str) -> Running {
    let text = text.trim();
    match text.strip_prefix("app ") {
        Some(pid) => Running { pid: pid.trim().parse().ok(), app: true },
        None => Running { pid: text.parse().ok(), app: false },
    }
}

/// Takes `lock` if free; if it is taken, says who holds it (from `pid`). A lock taken
/// with no name yet (just taken, or only probed) is tried again a few times.
fn take(lock: &Path, pid: &Path) -> Result<fs::File, LockError> {
    for attempt in 1..=TRIES {
        match lock_file(lock) {
            Ok(file) => return Ok(file),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                let held = fs::read_to_string(pid).map(|text| parse_pid(&text)).ok();
                match held {
                    Some(running) if running.pid.is_some() => return Err(LockError::Held(running)),
                    _ if attempt == TRIES => {
                        return Err(LockError::Held(held.unwrap_or(Running { pid: None, app: false })));
                    }
                    _ => thread::sleep(RETRY),
                }
            }
            Err(e) => return Err(LockError::Io(format!("{}: {e}", lock.display()))),
        }
    }
    unreachable!("the last try returns")
}

/// Who holds `lock`, if anyone: probed by taking it for a moment.
fn probe(lock: &Path, pid: &Path) -> Option<Running> {
    match take(lock, pid) {
        Ok(_) => None,
        Err(LockError::Held(running)) => Some(running),
        Err(LockError::Io(_)) => None,
    }
}

impl Paths {
    fn lock_path(&self) -> PathBuf {
        self.state.join("run.lock")
    }

    fn pid_path(&self) -> PathBuf {
        self.state.join("run.pid")
    }

    fn info_path(&self) -> PathBuf {
        self.state.join("run.info")
    }

    fn wait_lock(&self) -> PathBuf {
        self.state.join("run.wait.lock")
    }

    fn wait_pid(&self) -> PathBuf {
        self.state.join("run.wait.pid")
    }

    /// Asks the agent holding the machine to stop (empty) or to make way (`yield`).
    pub fn stop_file(&self) -> PathBuf {
        self.state.join("run.stop")
    }

    /// Asks the `quotum run` waiting for the app to stop waiting.
    pub fn wait_stop_file(&self) -> PathBuf {
        self.state.join("run.wait.stop")
    }

    /// Takes the machine: one agent at a time, the spool and the state are its alone. The
    /// lock lasts while the guard lives and ends with the process.
    pub fn lock_run(&self, holder: Holder) -> Result<RunLock, LockError> {
        let file = take(&self.lock_path(), &self.pid_path())?;
        // What was meant for an earlier holder is not for this one: gone before it is named.
        let _ = fs::remove_file(self.stop_file());
        let _ = fs::remove_file(self.info_path());
        let pid = std::process::id();
        let name = match holder {
            Holder::Cli => pid.to_string(),
            Holder::App => format!("app {pid}"),
        };
        write_atomic(&self.pid_path(), &name)
            .map_err(|e| LockError::Io(format!("{}: {e}", self.pid_path().display())))?;
        Ok(RunLock { _file: file, pid: self.pid_path(), info: self.info_path() })
    }

    /// The agent measuring this machine, if one does.
    pub fn running(&self) -> Option<Running> {
        probe(&self.lock_path(), &self.pid_path())
    }

    /// Written by `quotum run` once it holds the machine (see [`RunInfo`]).
    pub fn write_run_info(&self, info: &RunInfo) -> io::Result<()> {
        write_atomic(&self.info_path(), &serde_json::to_string(info).map_err(io::Error::other)?)
    }

    pub fn run_info(&self) -> Option<RunInfo> {
        serde_json::from_slice(&fs::read(self.info_path()).ok()?).ok()
    }

    /// Takes the place of the `quotum run` that waits for the app, if nobody has it.
    pub fn take_wait_slot(&self) -> Result<WaitSlot, LockError> {
        let file = take(&self.wait_lock(), &self.wait_pid())?;
        // A stop meant for an earlier waiter is not for this one.
        let _ = fs::remove_file(self.wait_stop_file());
        write_atomic(&self.wait_pid(), &std::process::id().to_string())
            .map_err(|e| LockError::Io(format!("{}: {e}", self.wait_pid().display())))?;
        Ok(WaitSlot { _file: file, pid: self.wait_pid() })
    }

    /// The `quotum run` waiting for the app, if one does: its process, when it said which.
    pub fn waiting(&self) -> Option<Option<u32>> {
        probe(&self.wait_lock(), &self.wait_pid()).map(|running| running.pid)
    }

    /// Asks the agent measuring this machine to stop or to make way, and ends it outright if
    /// it has not after a while. Never the app.
    pub fn stop_running(&self, how: How) -> Result<Stopped, String> {
        self.stop_running_with(how, &Waits::REAL, &process::kill)
    }

    pub fn stop_running_with(&self, how: How, waits: &Waits, kill: &dyn Fn(u32)) -> Result<Stopped, String> {
        let Some(running) = self.running() else { return Ok(Stopped::Nothing) };
        if running.app {
            return Err("the Quotum app measures this machine: quit the app to stop it".into());
        }
        // One that wrote run.info makes way by itself, at once; an older one only stops.
        let yields = how == How::Yield && self.run_info().is_some_and(|info| Some(info.pid) == running.pid);
        let file = self.stop_file();
        write_atomic(&file, if how == How::Yield { "yield" } else { "" })
            .map_err(|e| format!("{}: {e}", file.display()))?;
        let limit = if yields { waits.yielding } else { waits.exit };
        let gone = || self.running().is_none_or(|now| now.pid != running.pid || running.pid.is_none() && now.app);
        if until(limit, waits.step, gone) {
            return Ok(Stopped::Asked(running.pid));
        }
        let Some(pid) = running.pid else {
            return Err(format!(
                "the agent did not stop within {} s, and it did not say which process it is",
                limit.as_secs()
            ));
        };
        // Only what still holds the machine under the same name: it may have gone or changed.
        match self.running() {
            Some(now) if now.pid == Some(pid) && !now.app => kill(pid),
            _ => return Ok(Stopped::Asked(Some(pid))),
        }
        let _ = fs::remove_file(&file);
        if until(waits.after_kill, waits.step, gone) {
            Ok(Stopped::Killed(pid))
        } else {
            Err(format!("the agent (pid {pid}) does not stop"))
        }
    }

    /// Asks the `quotum run` waiting for the app to stop, and ends it outright if it has not
    /// after a while: only if it still waits under the same name, and never the app.
    pub fn stop_waiting(&self) -> Result<Stopped, String> {
        self.stop_waiting_with(&Waits::REAL, &process::kill)
    }

    pub fn stop_waiting_with(&self, waits: &Waits, kill: &dyn Fn(u32)) -> Result<Stopped, String> {
        let Some(pid) = self.waiting() else { return Ok(Stopped::Nothing) };
        let file = self.wait_stop_file();
        write_atomic(&file, "").map_err(|e| format!("{}: {e}", file.display()))?;
        let gone = || self.waiting().is_none_or(|now| now != pid || pid.is_none() && now.is_some());
        if until(waits.exit, waits.step, gone) {
            return Ok(Stopped::Asked(pid));
        }
        let Some(pid) = pid else {
            return Err("the waiting agent did not stop within 15 s, and it did not say which process it is".into());
        };
        let app = self.running().filter(|r| r.app).and_then(|r| r.pid);
        match self.waiting() {
            Some(Some(now)) if now == pid && app != Some(pid) => kill(pid),
            _ => return Ok(Stopped::Asked(Some(pid))),
        }
        let _ = fs::remove_file(&file);
        if until(waits.after_kill, waits.step, gone) {
            Ok(Stopped::Killed(pid))
        } else {
            Err(format!("the waiting agent (pid {pid}) does not stop"))
        }
    }
}

/// Whether `done` came true within `limit`, looked at every `step`.
fn until(limit: Duration, step: Duration, done: impl Fn() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        thread::sleep(step);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn state(name: &str) -> Paths {
        let state = std::env::temp_dir().join(format!("quotum-holder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&state);
        fs::create_dir_all(&state).unwrap();
        Paths { config: state.join("config.toml"), work: state.join("work"), state }
    }

    const QUICK: Waits = Waits {
        exit: Duration::from_millis(300),
        yielding: Duration::from_millis(300),
        after_kill: Duration::from_millis(100),
        step: Duration::from_millis(20),
    };

    #[test]
    fn one_agent_holds_the_machine_and_says_whether_it_is_the_app() {
        let paths = state("who");
        assert_eq!(paths.running(), None);
        let app = paths.lock_run(Holder::App).unwrap();
        let me = Some(std::process::id());
        assert_eq!(paths.running(), Some(Running { pid: me, app: true }));
        assert!(matches!(paths.lock_run(Holder::Cli), Err(LockError::Held(Running { app: true, .. }))));
        drop(app);
        let cli = paths.lock_run(Holder::Cli).unwrap();
        assert!(matches!(paths.lock_run(Holder::App), Err(LockError::Held(Running { app: false, pid })) if pid == me));
        drop(cli);
        assert_eq!(paths.running(), None, "the lock ends with its guard");
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn the_pid_file_of_older_versions_reads_as_before() {
        assert_eq!(parse_pid("4242\n"), Running { pid: Some(4242), app: false });
        assert_eq!(parse_pid("app 17"), Running { pid: Some(17), app: true });
        assert_eq!(parse_pid(""), Running { pid: None, app: false });
    }

    #[test]
    fn run_info_goes_with_the_lock_and_what_an_earlier_holder_left_is_cleared_first() {
        let paths = state("info");
        fs::write(paths.stop_file(), "").unwrap();
        fs::write(paths.state.join("run.info"), "{\"pid\":1}").unwrap();
        let lock = paths.lock_run(Holder::Cli).unwrap();
        assert!(!paths.stop_file().exists() && paths.run_info().is_none(), "cleared before the new holder is named");
        let info = RunInfo { pid: std::process::id(), version: "0.4.0".into(), hub: None };
        paths.write_run_info(&info).unwrap();
        assert_eq!(paths.run_info(), Some(info));
        let text = fs::read_to_string(paths.state.join("run.info")).unwrap();
        assert!(text.contains("\"hub\":null"), "{text}");
        drop(lock);
        assert!(paths.run_info().is_none() && !paths.state.join("run.pid").exists());
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn the_app_is_never_stopped_nor_killed() {
        let paths = state("app");
        let app = paths.lock_run(Holder::App).unwrap();
        let killed = Cell::new(None);
        let refused = paths.stop_running_with(How::Exit, &QUICK, &|pid| killed.set(Some(pid)));
        assert!(refused.unwrap_err().contains("the Quotum app"));
        assert!(!paths.stop_file().exists() && killed.get().is_none());
        // Windows removes no directory with a file open in it.
        drop(app);
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn an_agent_that_does_not_stop_is_killed_only_while_it_still_holds_the_machine() {
        let paths = state("kill");
        let lock = paths.lock_run(Holder::Cli).unwrap();
        let killed = Cell::new(None);
        // A kill that works: the lock goes with the "process".
        let lock = std::cell::RefCell::new(Some(lock));
        let result = paths.stop_running_with(How::Exit, &QUICK, &|pid| {
            killed.set(Some(pid));
            lock.borrow_mut().take();
        });
        assert_eq!(result, Ok(Stopped::Killed(std::process::id())));
        assert_eq!(fs::read_to_string(paths.stop_file()).ok(), None, "the stop file is taken away after a kill");
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn only_one_agent_waits_for_the_app_and_a_stale_pid_file_is_no_waiter() {
        let paths = state("slot");
        fs::write(paths.wait_pid(), "4242").unwrap();
        let killed = Cell::new(None);
        assert_eq!(paths.stop_waiting_with(&QUICK, &|pid| killed.set(Some(pid))), Ok(Stopped::Nothing));
        assert_eq!(killed.get(), None, "a leftover pid file names nobody to kill");
        fs::write(paths.wait_stop_file(), "").unwrap();
        let slot = paths.take_wait_slot().unwrap();
        assert!(!paths.wait_stop_file().exists(), "a stop meant for an earlier waiter is not this one's");
        assert_eq!(paths.waiting(), Some(Some(std::process::id())));
        assert!(matches!(paths.take_wait_slot(), Err(LockError::Held(_))), "a second waiter");
        drop(slot);
        assert_eq!(paths.waiting(), None);
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn written_whole_or_not_at_all() {
        let paths = state("atomic");
        let file = paths.stop_file();
        write_atomic(&file, "yield").unwrap();
        write_atomic(&file, "").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "");
        let names: Vec<_> = fs::read_dir(&paths.state).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
        assert_eq!(names, ["run.stop"], "no temporary file left");
        fs::remove_dir_all(&paths.state).unwrap();
    }
}
