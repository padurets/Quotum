//! The one window: the board of the running hub, or the app's own page while the hub
//! starts ("Starting…") or when it is down ("Error"). Windows are created on worker threads
//! only: on Windows, creating one from an event handler or a command deadlocks WebView2.

use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

use crate::hub::HubState;
use crate::shell::Shell;

pub const LABEL: &str = "main";

/// The origin of the app's own pages (the files in `static/`).
pub fn own_origin() -> Url {
    let origin = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(origin).expect("a valid URL")
}

/// The hub's log, named on the error page.
pub static HUB_LOG: OnceLock<String> = OnceLock::new();

/// Which of the app's own pages stands for a state of the hub: `index.html` says it starts,
/// `error.html` that it is down (and where its log is); `#quit` that the app is quitting.
fn own_page(state: &HubState, quitting: bool) -> Url {
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
fn belongs(url: &Url, state: &HubState) -> bool {
    match state {
        HubState::Ready(ready) => same_origin(url, &ready.origin()),
        other => same_origin(url, own_origin().as_str()) && url.path() == own_page(other, false).path(),
    }
}

/// Scheme, host and port compared: `Url::origin` is opaque, never equal, for `tauri://`.
fn same_origin(url: &Url, origin: &str) -> bool {
    let parts = |u: &Url| (u.scheme().to_string(), u.host_str().map(str::to_string), u.port_or_known_default());
    Url::parse(origin).is_ok_and(|o| parts(&o) == parts(url))
}

/// Whether the window may go to `url`: the app's own pages always, the hub's only while
/// it is ready, and only on its current port.
pub fn allowed(url: &Url, state: &HubState) -> bool {
    same_origin(url, own_origin().as_str())
        || matches!(state, HubState::Ready(ready) if same_origin(url, &ready.origin()))
}

/// Whether a page may call the app's commands (all but `quit`): only the board of the
/// running hub, on its current port.
pub fn guard(url: &Url, state: &HubState) -> bool {
    matches!(state, HubState::Ready(ready) if same_origin(url, &ready.origin()))
}

/// Whether the window is open (it may be on its way out).
pub fn is_open(shell: &Shell) -> bool {
    shell.app().get_webview_window(LABEL).is_some()
}

/// Shows the window: creates it if there is none, on a thread of its own.
pub fn open(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || open_now(&shell));
}

fn open_now(shell: &Arc<Shell>) {
    if shell.exiting() {
        return;
    }
    let _creating = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
    let app = shell.app();
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        drop(_creating);
        follow(shell);
        return;
    }
    // A window just closed may still hold its label for a moment.
    for _ in 0..20 {
        let (state, generation) = shell.hub();
        match build(shell, &state) {
            Ok(_) => {
                drop(_creating);
                if shell.generation() != generation {
                    follow(shell);
                }
                return;
            }
            Err(e) => {
                shell.hub_log.line(&format!("app: the window did not open: {e}"));
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn build(shell: &Arc<Shell>, state: &HubState) -> tauri::Result<tauri::WebviewWindow> {
    let app = shell.app();
    let navigating = shell.clone();
    let loading = shell.clone();
    let url = target(state);
    let url = if same_origin(&url, own_origin().as_str()) {
        WebviewUrl::App(url.path().trim_start_matches('/').into())
    } else {
        WebviewUrl::External(url)
    };
    let mut builder = WebviewWindowBuilder::new(app, LABEL, url)
        .title("Quotum")
        .inner_size(1280.0, 800.0)
        .min_inner_size(480.0, 400.0)
        .on_navigation(move |url| {
            let (state, _) = navigating.hub();
            if allowed(url, &state) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(|url, _| {
            // Links that open a new window go to the browser; nothing else opens.
            if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(smoke) = &loading.smoke {
                    smoke.page_loaded(&loading, payload.url());
                }
            }
        });
    if let Some(dir) = &shell.dirs.webview {
        builder = builder.data_directory(dir.clone());
    }
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    crate::graphics::observe(&window, shell);
    Ok(window)
}

/// Moves the window where it belongs in the hub's current state, if it is not there;
/// again if the state changed meanwhile.
pub fn follow(shell: &Arc<Shell>) {
    for _ in 0..10 {
        let (state, generation) = shell.hub();
        let Some(window) = shell.app().get_webview_window(LABEL) else { return };
        let here = window.url().ok();
        if !here.as_ref().is_some_and(|url| belongs(url, &state)) {
            let _ = window.navigate(target(&state));
        }
        if shell.generation() == generation {
            return;
        }
    }
}

/// Leads the window to the board again, entering with the key of the hub's current start
/// (a window that lost its session), or to the app's own page while the hub is not ready.
pub fn reenter(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || {
        for _ in 0..10 {
            let (state, generation) = shell.hub();
            // A new window opens where it belongs by itself.
            let Some(window) = shell.app().get_webview_window(LABEL) else { return open_now(&shell) };
            let _ = window.navigate(target(&state));
            if shell.generation() == generation {
                return;
            }
        }
    });
}

/// Takes the window off the hub's pages while the app quits.
pub fn leave(shell: &Arc<Shell>) {
    if let Some(window) = shell.app().get_webview_window(LABEL) {
        let _ = window.navigate(own_page(&HubState::Down, true));
    }
}

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
}
