//! The one window: the board of the running hub, or the app's own page while the hub
//! starts ("Starting…") or when it is down ("Error"). Windows are created on worker threads
//! only: on Windows, creating one from an event handler or a command deadlocks WebView2.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use url::Url;

use crate::hub::HubState;
use crate::{
    agent,
    shell::{self, Shell},
};

/// An explicit request counts as foreground while its native window is being created.
#[derive(Default)]
pub struct OpenIntent(AtomicUsize);

impl OpenIntent {
    fn begin(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    fn finish(&self) -> bool {
        self.0.fetch_sub(1, Ordering::SeqCst) == 1
    }

    fn pending(&self) -> bool {
        self.0.load(Ordering::SeqCst) != 0
    }
}

pub struct Opening(Arc<Shell>);

pub fn opening(shell: &Arc<Shell>) -> Opening {
    shell.window_intent.begin();
    Opening(shell.clone())
}

impl Drop for Opening {
    fn drop(&mut self) {
        let shell = &self.0;
        if shell.window_intent.finish() && !is_open_or_opening(shell) {
            // Let a startup decision that observed this request publish Held first.
            let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
            if is_open_or_opening(shell) {
                return;
            }
            let state = shell.agent.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
            // A failed foreground attempt must not leave an unseen consent question.
            if agent::closing_quits(&state, shell.take_over_confirmed()) {
                shell::quit(shell);
            }
        }
    }
}

pub fn is_open_or_opening(shell: &Shell) -> bool {
    shell.window_intent.pending() || is_open(shell)
}

/// The requested navigation, including one the web view has not committed yet.
#[cfg(any(test, not(target_os = "linux")))]
#[derive(Default)]
pub struct Navigation(Option<(u64, Url)>);

#[cfg(any(test, not(target_os = "linux")))]
impl Navigation {
    pub fn request(&mut self, generation: u64, url: Url, force: bool) -> bool {
        if self.0.as_ref().is_some_and(|(old, _)| *old > generation) {
            return false;
        }
        let changed = self.0.as_ref().is_none_or(|(old, target)| *old != generation || *target != url);
        self.0 = Some((generation, url));
        force || changed
    }
}

#[cfg(not(target_os = "linux"))]
pub const LABEL: &str = "main";

/// The origin of the app's own pages (the files in `static/`).
pub fn own_origin() -> Url {
    let origin = if cfg!(target_os = "linux") {
        "quotum://localhost/"
    } else if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).expect("a valid URL")
}

/// The hub's log, named on the error page.
pub static HUB_LOG: OnceLock<String> = OnceLock::new();

/// Which of the app's own pages stands for a state of the hub: `index.html` says it starts,
/// `error.html` that it is down (and where its log is); `#quit` that the app is quitting.
pub(crate) fn own_page(state: &HubState, quitting: bool) -> Url {
    let page = match state {
        _ if quitting => "index.html#quit",
        HubState::Down => "error.html",
        _ => "index.html",
    };
    let mut url = own_origin().join(page).expect("a valid URL");
    if let (HubState::Down, false, Some(log)) = (state, quitting, HUB_LOG.get()) {
        url.query_pairs_mut().append_pair("log", log);
    }
    url
}

/// Where the window belongs now: the board of the running hub, entered with this start's
/// key (the hub sends it on to `/` at once, so the key stays in no address), else a page
/// of the app's own.
pub fn target(state: &HubState) -> Url {
    match state {
        HubState::Ready(ready) => {
            Url::parse(&format!("{}/local?key={}", ready.origin(), ready.key)).expect("a valid URL")
        }
        other => own_page(other, false),
    }
}

/// Whether a page at `url` is where the window belongs in `state` (it need not be moved).
#[cfg(any(test, not(target_os = "linux")))]
pub(crate) fn belongs(url: &Url, state: &HubState) -> bool {
    match state {
        HubState::Ready(ready) => same_origin(url, &ready.origin()),
        other => same_origin(url, own_origin().as_str()) && url.path() == own_page(other, false).path(),
    }
}

/// Scheme, host and port compared: `Url::origin` is opaque, never equal, for `tauri://`.
pub(crate) fn same_origin(url: &Url, origin: &str) -> bool {
    let parts = |u: &Url| (u.scheme().to_string(), u.host_str().map(str::to_string), u.port_or_known_default());
    Url::parse(origin).is_ok_and(|o| parts(&o) == parts(url))
}

/// Whether the window may go to `url`: the app's own pages always, the hub's only while
/// it is ready, and only on its current port.
#[cfg(any(test, not(target_os = "linux")))]
pub fn allowed(url: &Url, state: &HubState) -> bool {
    same_origin(url, own_origin().as_str())
        || matches!(state, HubState::Ready(ready) if same_origin(url, &ready.origin()))
}

/// Whether a page may call the app's commands (all but `quit`): only the board of the
/// running hub, on its current port.
pub fn guard(url: &Url, state: &HubState) -> bool {
    matches!(state, HubState::Ready(ready) if same_origin(url, &ready.origin()))
}

pub use crate::host::{close, follow, is_open, leave, open, reenter};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::Ready;

    fn ready(port: u16) -> HubState {
        HubState::Ready(Ready { port, key: "k".repeat(43), token: "qt_m_t".into() })
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_window_goes_to_the_board_only_while_the_hub_is_ready() {
        assert_eq!(target(&ready(23456)).as_str(), format!("http://127.0.0.1:23456/local?key={}", "k".repeat(43)));
        assert_eq!(target(&HubState::Starting), own_origin().join("index.html").unwrap());
        assert_eq!(target(&HubState::Down), own_origin().join("error.html").unwrap());
    }

    #[test]
    fn only_the_current_port_and_the_apps_own_pages_are_open_to_the_window() {
        let board = url("http://127.0.0.1:23456/");
        assert!(allowed(&board, &ready(23456)));
        assert!(!allowed(&board, &ready(23457)), "a port of an earlier start");
        assert!(!allowed(&board, &HubState::Starting) && !allowed(&board, &HubState::Down));
        assert!(!allowed(&url("http://localhost:23456/"), &ready(23456)), "another address of the same port");
        assert!(allowed(&own_origin().join("error.html").unwrap(), &HubState::Down));
        assert!(!allowed(&url("https://github.com/padurets/Quotum"), &ready(23456)));
    }

    #[test]
    fn commands_are_for_the_board_of_the_running_hub_only() {
        let board = url("http://127.0.0.1:23456/");
        assert!(guard(&board, &ready(23456)));
        assert!(!guard(&board, &ready(24000)), "an old port");
        assert!(!guard(&board, &HubState::Starting));
        assert!(!guard(&board, &HubState::Down));
        assert!(!guard(&own_origin().join("index.html").unwrap(), &ready(23456)), "the app's own page");
    }

    #[test]
    fn a_window_in_place_is_not_moved() {
        assert!(belongs(&url("http://127.0.0.1:23456/?board=x"), &ready(23456)));
        assert!(!belongs(&own_origin().join("index.html").unwrap(), &ready(23456)));
        assert!(belongs(&own_origin().join("index.html").unwrap(), &HubState::Starting));
        assert!(!belongs(&own_origin().join("index.html").unwrap(), &HubState::Down));
    }

    #[test]
    fn foreground_start_waits_for_its_window_and_failed_attempts_do_not_latch_intent() {
        let intent = OpenIntent::default();
        assert_eq!(agent::on_held(false, intent.pending()), agent::OnHeld::Quit, "hidden start");
        intent.begin();
        assert_eq!(agent::on_held(false, intent.pending()), agent::OnHeld::Ask, "hub wins the startup race");
        intent.begin();
        assert!(!intent.finish());
        assert!(intent.pending(), "another open is still queued");
        assert!(intent.finish());
        assert!(!intent.pending(), "failed attempts or a completed open leave no permanent intent");
        assert_eq!(agent::on_held(false, intent.pending()), agent::OnHeld::Quit, "closed before consent");
        intent.begin();
        assert!(intent.pending(), "a later open can try again");
        assert!(intent.finish());
    }

    #[test]
    fn navigation_follows_generations_even_before_the_previous_request_commits() {
        let mut navigation = Navigation::default();
        let first = target(&ready(23456));
        assert!(navigation.request(1, first.clone(), false));
        assert!(navigation.request(2, target(&HubState::Starting), false));
        let mut next = ready(23456);
        if let HubState::Ready(ready) = &mut next {
            ready.key = "new-key".into();
        }
        let next = target(&next);
        assert!(navigation.request(3, next.clone(), false), "same port, new start and entry key");
        assert!(!navigation.request(2, target(&HubState::Starting), false), "late old state");
        assert!(!navigation.request(3, next.clone(), false), "focus does not reload");
        assert!(navigation.request(3, next, true), "explicit reentry does reload");
        assert!(navigation.request(4, first, false), "generation is independent of the URL");
    }
}
