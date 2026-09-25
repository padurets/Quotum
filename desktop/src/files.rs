//! The app's own files: where they live, what `app.json` remembers, and the logs.

use std::fs;
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Ports the hub is given: a fixed range, not the one the system picks for port 0, where on
/// Windows Hyper-V, WSL and Docker reserve theirs.
pub const PORTS: std::ops::RangeInclusive<u16> = 20000..=39999;

/// Where the app keeps its data and logs.
#[derive(Clone, Debug)]
pub struct Dirs {
    /// `app.json`, `app.lock`, the hub's database (`hub/`), and on Linux the web view's data.
    pub data: PathBuf,
    pub logs: PathBuf,
    /// The web view's profile, in the smoke run only (elsewhere it is the system's choice).
    pub webview: Option<PathBuf>,
}

impl Dirs {
    /// `QUOTUM_APP_DATA_DIR` moves everything, for the smoke run and for tests.
    pub fn new(data: PathBuf, logs: PathBuf, smoke: bool) -> Dirs {
        match std::env::var_os("QUOTUM_APP_DATA_DIR").filter(|d| !d.is_empty()) {
            Some(dir) => {
                let dir = PathBuf::from(dir);
                Dirs { logs: dir.join("logs"), webview: smoke.then(|| dir.join("webview")), data: dir }
            }
            None => Dirs { data, logs, webview: None },
        }
    }

    pub fn hub_data(&self) -> PathBuf {
        self.data.join("hub")
    }

    pub fn app_json(&self) -> PathBuf {
        self.data.join("app.json")
    }

    pub fn app_lock(&self) -> PathBuf {
        self.data.join("app.lock")
    }

    pub fn hub_log(&self) -> PathBuf {
        self.logs.join("hub.log")
    }

    pub fn agent_log(&self) -> PathBuf {
        self.logs.join("agent.log")
    }

    /// Creates the directories; on Linux only this user may enter the data directory, which
    /// holds the web view's data and the logs as well.
    pub fn ensure(&self) -> io::Result<()> {
        fs::create_dir_all(&self.data)?;
        fs::create_dir_all(&self.logs)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.data, fs::Permissions::from_mode(0o700))?;
            fs::set_permissions(&self.logs, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

/// What the app remembers between runs.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppJson {
    /// The hub's port: the origin of the board, and with it the board's local storage.
    pub port: Option<u16>,
    /// Start at login was turned on once by the app itself (or set by hand): never again.
    pub autostart_defaulted: bool,
    /// The person agreed that the app takes the machine over from `quotum`.
    pub take_over_confirmed: bool,
}

impl AppJson {
    /// A missing or unreadable file is a first run.
    pub fn load(file: &Path) -> AppJson {
        fs::read(file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    /// Written to a new file that then replaces the old one.
    pub fn save(&self, file: &Path) -> io::Result<()> {
        let next = file.with_extension("json.new");
        fs::write(&next, serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        fs::rename(next, file)
    }
}

/// A port of the range nothing listens on now, tried in random order.
pub fn free_port(random: impl Fn() -> u32) -> Option<u16> {
    let span = u32::from(PORTS.end() - PORTS.start()) + 1;
    (0..200).map(|_| PORTS.start() + (random() % span) as u16).find(|&port| port_is_free(port))
}

pub fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// A log file of lines, moved to `<name>.1` (replacing the one before) past 1 MiB, as the
/// command-line agent does with its own.
pub struct Log {
    file: PathBuf,
    lock: Mutex<()>,
}

const LOG_LIMIT: u64 = 1 << 20;

impl Log {
    pub fn new(file: PathBuf) -> Log {
        Log { file, lock: Mutex::new(()) }
    }

    /// Appends one line as it is; nothing is lost to the caller if the file cannot be written.
    pub fn raw(&self, line: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if fs::metadata(&self.file).is_ok_and(|m| m.len() > LOG_LIMIT) {
            let _ = fs::rename(&self.file, self.file.with_extension("log.1"));
        }
        let written =
            fs::OpenOptions::new().create(true).append(true).open(&self.file).and_then(|mut f| writeln!(f, "{line}"));
        if written.is_err() {
            eprintln!("{line}");
        }
    }

    /// A line with the time in front, as in the agent's log: UTC, RFC 3339, to the second.
    pub fn line(&self, text: &str) {
        let now = quotum_core::model::now_ms();
        self.raw(&format!("{} {text}", quotum_core::model::ts::format(now - now.rem_euclid(1000))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("quotum-desktop-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn app_json_is_remembered_and_a_broken_one_is_a_first_run() {
        let dir = temp("app-json");
        let file = dir.join("app.json");
        assert_eq!(AppJson::load(&file), AppJson::default());
        let saved = AppJson { port: Some(23456), autostart_defaulted: true, take_over_confirmed: false };
        saved.save(&file).unwrap();
        assert_eq!(AppJson::load(&file), saved);
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"autostartDefaulted\": true") && text.contains("\"takeOverConfirmed\""), "{text}");
        fs::write(&file, "{").unwrap();
        assert_eq!(AppJson::load(&file), AppJson::default());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_port_comes_from_the_range_and_a_taken_one_is_passed_over() {
        let (busy, _taken) =
            PORTS.clone().find_map(|p| TcpListener::bind((Ipv4Addr::LOCALHOST, p)).ok().map(|l| (p, l))).unwrap();
        assert!(!port_is_free(busy));
        // The random numbers first lead to the taken port, then on.
        let offset = u32::from(busy - PORTS.start());
        let next = std::cell::Cell::new(offset);
        let port = free_port(|| {
            let value = next.get();
            next.set(value + 1);
            value
        })
        .unwrap();
        assert!(PORTS.contains(&port) && port != busy, "{port}");
    }

    #[test]
    fn a_log_is_moved_aside_when_it_grows_too_large() {
        let dir = temp("log");
        let log = Log::new(dir.join("hub.log"));
        fs::write(dir.join("hub.log"), vec![b'x'; LOG_LIMIT as usize + 1]).unwrap();
        log.line("started");
        assert!(fs::read_to_string(dir.join("hub.log")).unwrap().ends_with(" started\n"));
        assert!(dir.join("hub.log.1").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
