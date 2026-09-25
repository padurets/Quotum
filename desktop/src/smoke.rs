//! `--smoke`: the app started as a person starts it, checked end to end and quit, for CI.
//! It runs with its own data (`QUOTUM_APP_DATA_DIR`, the web view's profile included) and
//! passes when the hub is ready, the window shows the board, and the window closed and
//! opened again the way the tray opens it shows the board again; then it quits, exit 0.
//! `--smoke=crash` aborts once the hub is ready: CI then checks the hub went by itself.
//! Anything else, or no end within two minutes, is exit 1 with the reason on stderr.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{Manager, Url};

use crate::hub::{HubState, Ready};
use crate::shell::{self, Shell};
use crate::window;

const LIMIT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Normal,
    Crash,
}

/// Which of the checks passed so far.
#[derive(Debug, Default)]
struct Progress {
    ready: bool,
    /// Times the window finished loading the board.
    loaded: u32,
    done: bool,
}

pub struct Smoke {
    pub mode: Mode,
    /// Off where the runner cannot show a window (`QUOTUM_SMOKE_WINDOW=off`).
    window: bool,
    progress: Mutex<Progress>,
}

impl Smoke {
    pub fn new(mode: Mode) -> Smoke {
        let window = std::env::var("QUOTUM_SMOKE_WINDOW").map_or(true, |v| v != "off");
        Smoke { mode, window, progress: Mutex::new(Progress::default()) }
    }

    fn progress(&self) -> std::sync::MutexGuard<'_, Progress> {
        self.progress.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ends the app with exit 1 if the checks have not all passed in time. A thread of its
    /// own: it must not depend on an event loop that may be what hangs.
    pub fn watch(shell: &Arc<Shell>) {
        let shell = shell.clone();
        thread::spawn(move || {
            thread::sleep(LIMIT);
            let Some(smoke) = &shell.smoke else { return };
            let progress = smoke.progress();
            if !progress.done {
                fail(&format!("not done within {} s: {progress:?}", LIMIT.as_secs()));
            }
        });
    }

    pub fn hub_ready(&self, shell: &Arc<Shell>, _ready: &Ready) {
        self.progress().ready = true;
        eprintln!("smoke: the hub is ready");
        if self.mode == Mode::Crash {
            eprintln!("smoke: crashing on purpose");
            std::process::abort();
        }
        if !self.window {
            self.pass(shell);
        }
    }

    /// Called on the main thread when a page finished loading: the board of the running hub
    /// counts. The first time the window is closed and opened again, as the tray does.
    pub fn page_loaded(&self, shell: &Arc<Shell>, url: &Url) {
        let (state, _) = shell.hub();
        // `/local?key=…` leads to `/` at once: only the board itself counts.
        let board = matches!(&state, HubState::Ready(ready) if url.as_str() == format!("{}/", ready.origin()));
        if !board || !self.window {
            return;
        }
        let loaded = {
            let mut progress = self.progress();
            progress.loaded += 1;
            progress.loaded
        };
        eprintln!("smoke: the window shows the board ({loaded})");
        let shell = shell.clone();
        thread::spawn(move || match loaded {
            1 => {
                if let Some(window) = shell.app().get_webview_window(window::LABEL) {
                    let _ = window.destroy();
                }
                thread::sleep(Duration::from_millis(500));
                window::open(&shell);
            }
            _ => {
                if let Some(smoke) = &shell.smoke {
                    smoke.pass(&shell);
                }
            }
        });
    }

    fn pass(&self, shell: &Arc<Shell>) {
        {
            let mut progress = self.progress();
            if progress.done {
                return;
            }
            progress.done = true;
        }
        eprintln!("smoke: passed; quitting");
        shell::quit(shell);
    }
}

pub fn fail(why: &str) -> ! {
    eprintln!("smoke: FAILED: {why}");
    std::process::exit(1);
}
