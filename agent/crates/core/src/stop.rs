//! Stopping on request. SIGINT, SIGTERM and a stop file (`quotum stop`, the same on every
//! system) set a flag that the schedule loop and every wait for a client check, so a
//! stop ends a running measurement too.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

static STOP: AtomicBool = AtomicBool::new(false);

pub fn requested() -> bool {
    STOP.load(Ordering::Relaxed)
}

/// From now on the appearance of `file` asks the agent to stop; the file is removed.
pub fn on_file(file: PathBuf) {
    thread::spawn(move || {
        while !requested() {
            if fs::remove_file(&file).is_ok() {
                STOP.store(true, Ordering::Relaxed);
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

/// From now on SIGINT and SIGTERM ask the agent to stop instead of killing it outright.
pub fn on_signals() {
    #[cfg(unix)]
    {
        extern "C" fn handle(_: libc::c_int) {
            STOP.store(true, Ordering::Relaxed);
        }
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe {
            libc::signal(libc::SIGINT, handle as *const () as libc::sighandler_t);
            libc::signal(libc::SIGTERM, handle as *const () as libc::sighandler_t);
        }
    }
}
