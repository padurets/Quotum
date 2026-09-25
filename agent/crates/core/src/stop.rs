//! Stopping on request. Every run of the agent has its own `Stop`: whoever started the run
//! asks it to stop (the desktop app, to restart or quit its agent; `quotum run`, on a signal
//! or a stop file), and the schedule loop and every wait for a client check it, so a stop
//! ends a running measurement too. A stop asked of one run never reaches another.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

/// Why a run stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    /// For good: `quotum stop`, Ctrl-C, the app quitting.
    Exit,
    /// To make way for the desktop app, which measures the machine from now on:
    /// `quotum run` waits until the app quits and then measures again.
    Yield,
}

/// The stop of one run; clones share it.
#[derive(Clone, Debug, Default)]
pub struct Stop(Arc<AtomicU8>);

const RUNNING: u8 = 0;
const EXIT: u8 = 1;
const YIELD: u8 = 2;

impl Stop {
    pub fn new() -> Stop {
        Stop::default()
    }

    /// Asks the run to stop; the first reason given stays.
    pub fn request(&self, how: How) {
        let value = match how {
            How::Exit => EXIT,
            How::Yield => YIELD,
        };
        let _ = self.0.compare_exchange(RUNNING, value, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn requested(&self) -> bool {
        self.0.load(Ordering::SeqCst) != RUNNING
    }

    pub fn how(&self) -> Option<How> {
        match self.0.load(Ordering::SeqCst) {
            EXIT => Some(How::Exit),
            YIELD => Some(How::Yield),
            _ => None,
        }
    }
}

/// SIGINT or SIGTERM came to this process (see [`on_signals`]).
static SIGNALLED: AtomicBool = AtomicBool::new(false);

pub fn signalled() -> bool {
    SIGNALLED.load(Ordering::SeqCst)
}

/// From now on SIGINT and SIGTERM ask this process to stop instead of killing it outright:
/// [`relay`] passes that on to the run of the moment.
pub fn on_signals() {
    #[cfg(unix)]
    {
        extern "C" fn handle(_: libc::c_int) {
            SIGNALLED.store(true, Ordering::SeqCst);
        }
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe {
            libc::signal(libc::SIGINT, handle as *const () as libc::sighandler_t);
            libc::signal(libc::SIGTERM, handle as *const () as libc::sighandler_t);
        }
    }
}

/// What a stop file asks for, once it appears; the file is removed. Empty, it asks to
/// stop (`quotum stop`); `yield`, to make way for the app. It is always written whole
/// (to a new file that replaces it), so a half-written `yield` never reads as a stop.
pub fn take_stop_file(file: &Path) -> Option<How> {
    let text = fs::read_to_string(file).ok()?;
    fs::remove_file(file).ok()?;
    Some(if text.trim() == "yield" { How::Yield } else { How::Exit })
}

/// One look at the signals of this process and at the run's stop file: what they ask is
/// asked of `stop`. Whether the run is asked to stop now.
pub fn relay(stop: &Stop, file: &Path) -> bool {
    if signalled() {
        stop.request(How::Exit);
    } else if let Some(how) = take_stop_file(file) {
        stop.request(how);
    }
    stop.requested()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_is_its_runs_own_and_keeps_its_first_reason() {
        let stop = Stop::new();
        let clone = stop.clone();
        assert!(!stop.requested() && stop.how().is_none());
        clone.request(How::Yield);
        clone.request(How::Exit);
        assert_eq!(stop.how(), Some(How::Yield), "asked through a clone, seen by all");
        assert!(!Stop::new().requested(), "a new run does not inherit the request");
    }

    #[test]
    fn a_stop_file_says_whether_to_stop_or_to_make_way() {
        let dir = std::env::temp_dir().join(format!("quotum-stop-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("run.stop");
        let stop = Stop::new();
        assert!(!relay(&stop, &file));
        fs::write(&file, "yield").unwrap();
        assert!(relay(&stop, &file));
        assert_eq!(stop.how(), Some(How::Yield));
        assert!(!file.exists(), "taken");
        fs::write(&file, "").unwrap();
        assert_eq!(take_stop_file(&file), Some(How::Exit));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_signal_stops_the_run_it_is_relayed_to_and_no_other() {
        let app = Stop::new();
        let cli = Stop::new();
        SIGNALLED.store(true, Ordering::SeqCst);
        let relayed = relay(&cli, Path::new("/nonexistent/run.stop"));
        SIGNALLED.store(false, Ordering::SeqCst);
        assert!(relayed && cli.how() == Some(How::Exit));
        assert!(!app.requested(), "a signal of the process does not stop a run nobody relays it to");
        assert!(!Stop::new().requested());
    }
}
