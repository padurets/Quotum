//! `--smoke`: the app started as a person starts it, checked end to end and quit, for CI.
//! It runs with data of its own (`QUOTUM_APP_DATA_DIR`, the web view's profile included,
//! and the agent's `QUOTUM_CONFIG` and `QUOTUM_STATE_DIR`) and passes when:
//! - the hub is ready and the agent delivered a measurement to it;
//! - entering with the key gives a session whose board shows the measured subscription;
//! - the window shows the board, and does again after it is closed and opened the way the
//!   tray opens it, and the board asks the app for its state through the bridge (not where
//!   the runner can show no window: `QUOTUM_SMOKE_WINDOW=off`).
//!
//! Then it quits, exit 0. `--smoke=crash` aborts once the hub is ready: CI then checks the
//! hub went by itself. Anything else, or no end within two minutes, is exit 1 with the
//! reason on stderr.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use url::Url;

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
    measured: bool,
    /// The board, entered as the window enters it, shows what the agent measured.
    board: bool,
    /// Times the window finished loading the board.
    loaded: u32,
    /// The board called `app_state`: the bridge reaches the hub's page and lets it in.
    asked: bool,
    done: bool,
}

pub struct Smoke {
    pub mode: Mode,
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

    pub fn hub_ready(&self, _shell: &Arc<Shell>, _ready: &Ready) {
        self.progress().ready = true;
        eprintln!("smoke: the hub is ready");
        if self.mode == Mode::Crash {
            eprintln!("smoke: crashing on purpose");
            std::process::abort();
        }
    }

    /// The agent delivered a measurement: the board, entered with the key as the window
    /// enters it, must show it.
    pub fn measured(&self, shell: &Arc<Shell>) {
        if std::mem::replace(&mut self.progress().measured, true) {
            return;
        }
        eprintln!("smoke: the agent measured and delivered");
        let shell = shell.clone();
        thread::spawn(move || {
            let HubState::Ready(ready) = shell.hub().0 else { fail("the hub went away") };
            match board_shows_a_source(&ready) {
                Ok(()) => {
                    eprintln!("smoke: the board shows the measured subscription");
                    if let Some(smoke) = &shell.smoke {
                        smoke.progress().board = true;
                        smoke.pass_if_done(&shell);
                    }
                }
                Err(e) => fail(&format!("the board: {e}")),
            }
        });
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
                window::close(&shell);
                thread::sleep(Duration::from_millis(500));
                window::open(&shell);
            }
            _ => {
                if let Some(smoke) = &shell.smoke {
                    smoke.pass_if_done(&shell);
                }
            }
        });
    }

    /// The board in the window asked the app for its state.
    pub fn board_asked(&self, shell: &Arc<Shell>) {
        if std::mem::replace(&mut self.progress().asked, true) {
            return;
        }
        eprintln!("smoke: the board asked the app through the bridge");
        self.pass_if_done(shell);
    }

    fn pass_if_done(&self, shell: &Arc<Shell>) {
        {
            let mut progress = self.progress();
            let window = !self.window || (progress.loaded >= 2 && progress.asked);
            if progress.done || !(progress.ready && progress.board && window) {
                return;
            }
            progress.done = true;
        }
        eprintln!("smoke: passed; quitting");
        shell::quit(shell);
    }
}

/// Enters as the window does (`/local?key=…`, no redirect followed) and reads the board.
fn board_shows_a_source(ready: &Ready) -> Result<(), String> {
    let origin = ready.origin();
    let http = quotum_core::sink::http_to(&origin);
    let entered = http.get(format!("{origin}/local?key={}", ready.key)).call().map_err(|e| e.to_string())?;
    let cookie = entered
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .ok_or_else(|| format!("no session after entering (HTTP {})", entered.status()))?
        .to_string();
    let mut overview =
        http.get(format!("{origin}/api/overview")).header("cookie", &cookie).call().map_err(|e| e.to_string())?;
    let text = overview.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("not JSON: {text}"))?;
    let providers: Vec<&str> =
        value["sources"].as_array().into_iter().flatten().filter_map(|s| s["provider"].as_str()).collect();
    if providers.is_empty() { Err(format!("no source on the board: {text}")) } else { Ok(()) }
}

pub fn fail(why: &str) -> ! {
    eprintln!("smoke: FAILED: {why}");
    std::process::exit(1);
}
