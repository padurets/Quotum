//! The browser processes of WebView2 that the app's windows started: a window's web view
//! starts one as a child of the app, and its renderers and helpers are that one's children.

use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, GetLastError, HANDLE, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

/// A browser process, held by a handle: while it is open, its pid goes to no other process.
pub struct Browser {
    pub pid: u32,
    handle: HANDLE,
    /// When it started, as a FILETIME: 100 ns since 1601.
    created: u64,
}

impl Drop for Browser {
    fn drop(&mut self) {
        // SAFETY: the handle was opened in `children` and is closed only here.
        unsafe { CloseHandle(self.handle) };
    }
}

impl Browser {
    /// Whether it still runs: one that ended may still be in the list of processes.
    pub fn alive(&self) -> bool {
        // SAFETY: an open handle, polled without waiting.
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }
}

/// Now as a FILETIME, to compare with the start of a process.
fn now() -> u64 {
    const FROM_1601_TO_1970: u64 = 116_444_736_000_000_000;
    FROM_1601_TO_1970 + SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| (d.as_nanos() / 100) as u64)
}

fn started(process: HANDLE) -> Option<u64> {
    let mut times = [FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 }; 4];
    let [created, exited, kernel, user] = &mut times;
    // SAFETY: an open handle and plain structs to write into.
    let read = unsafe { GetProcessTimes(process, created, exited, kernel, user) } != 0;
    read.then_some((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
}

/// The app's children named `msedgewebview2.exe`, each opened at once, and a line for each
/// that could not be (it ended meanwhile, or is not the app's to open).
fn children() -> (Vec<Browser>, Vec<String>) {
    let own = std::process::id();
    let mut browsers = Vec::new();
    let mut problems = Vec::new();
    for proc in quotum_core::activity::processes() {
        if proc.parent != own || !proc.name.eq_ignore_ascii_case("msedgewebview2.exe") {
            continue;
        }
        // SAFETY: a plain call; the handle is closed when its `Browser` is dropped.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, proc.pid) };
        if handle.is_null() {
            // SAFETY: a plain call.
            problems.push(format!("{} cannot be opened (error {})", proc.pid, unsafe { GetLastError() }));
            continue;
        }
        let mut browser = Browser { pid: proc.pid, handle, created: 0 };
        match started(handle) {
            Some(created) => {
                browser.created = created;
                browsers.push(browser);
            }
            // SAFETY: a plain call.
            None => problems.push(format!("{} has no start time (error {})", proc.pid, unsafe { GetLastError() })),
        }
    }
    (browsers, problems)
}

/// The browser processes as a line of the log: each one's pid, whether it runs, and its age.
pub fn describe() -> String {
    let at = now();
    let (browsers, problems) = children();
    let mut parts: Vec<String> = browsers
        .iter()
        .map(|b| {
            let state = if b.alive() { "running" } else { "ended" };
            format!("{} {state}, {} ms old", b.pid, at.saturating_sub(b.created) / 10_000)
        })
        .collect();
    parts.extend(problems);
    if parts.is_empty() { "none".into() } else { parts.join("; ") }
}
