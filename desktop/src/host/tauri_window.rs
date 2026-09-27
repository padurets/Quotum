use crate::{hub::HubState, shell::Shell, window::*};
use std::{
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};
/// Whether the window is open (it may be on its way out).
pub fn is_open(shell: &Shell) -> bool {
    shell.host.app.get_webview_window(LABEL).is_some()
}

/// Shows the window: creates it if there is none, on a thread of its own. `from` names who
/// asked, for the log.
pub fn open(shell: &Arc<Shell>, from: &'static str) {
    let intent = opening(shell);
    let shell = shell.clone();
    thread::spawn(move || {
        let _intent = intent;
        open_now(&shell, from);
    });
}

/// How long a request waits, from its start, for the main thread to tell whether the window
/// it found is still there, and for a closing one to go. The main thread may be busy for a
/// while with the window that is closing, or with one being created. The UI smoke waits
/// 20 s for the window after a second start.
const WAIT_LIMIT: Duration = Duration::from_secs(15);

/// Milliseconds since `start`, for the log of opening the window.
fn ms(start: Instant) -> u128 {
    start.elapsed().as_millis()
}

fn open_now(shell: &Arc<Shell>, from: &'static str) {
    let start = Instant::now();
    if shell.exiting() {
        return;
    }
    shell.hub_log.line(&format!("app: {from} asks for the window"));
    let _creating = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
    let app = &shell.host.app;
    if let Some(window) = app.get_webview_window(LABEL) {
        // A second start can hand over while Tauri still holds a closed window under its
        // label: off the screen and without its web view, but not destroyed yet. Showing it
        // shows nothing, and the request would be spent: a new window comes once it has gone.
        match alive(shell, window.clone(), start + WAIT_LIMIT) {
            Some(true) => {
                shell.hub_log.line(&format!("app: found the window {LABEL} at {} ms", ms(start)));
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                drop(_creating);
                follow(shell);
                return;
            }
            Some(false) => {
                shell.hub_log.line(&format!("app: the window {LABEL} is closing at {} ms", ms(start)));
                while app.get_webview_window(LABEL).is_some() {
                    if shell.exiting() {
                        return;
                    }
                    if start.elapsed() >= WAIT_LIMIT {
                        shell.hub_log.line(&format!("app: the window {LABEL} did not go within {} ms", ms(start)));
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                shell.hub_log.line(&format!("app: the window {LABEL} went at {} ms", ms(start)));
            }
            None => {
                shell.hub_log.line(&format!(
                    "app: the main thread did not tell within {} ms whether the window {LABEL} is there",
                    ms(start)
                ));
                return;
            }
        }
    }
    // A window that went may still hold its label for a moment.
    for attempt in 1..=20 {
        shell.hub_log.line(&format!("app: attempt {attempt} to create the window {LABEL} at {} ms", ms(start)));
        let (state, generation) = shell.hub();
        match build(shell, &state, generation, start) {
            Ok(_) => {
                drop(_creating);
                if shell.generation() != generation {
                    follow(shell);
                }
                return;
            }
            Err(e) => {
                shell.hub_log.line(&format!("app: the window did not open at {} ms: {e}", ms(start)));
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    shell.hub_log.line(&format!("app: gave up on the window after {} ms", ms(start)));
}

/// Whether `window` is still there, as the main thread tells: there a getter of a closing
/// window fails at once. `None` without an answer by `deadline`. Not asked on a worker: a
/// getter there waits for the main thread, for ever if it is stuck.
fn alive(shell: &Shell, window: tauri::WebviewWindow, deadline: Instant) -> Option<bool> {
    let (answer, answered) = mpsc::channel();
    shell
        .host
        .app
        .run_on_main_thread(move || {
            let _ = answer.send(window.is_visible().is_ok());
        })
        .ok()?;
    answered.recv_timeout(deadline.saturating_duration_since(Instant::now())).ok()
}

fn build(shell: &Arc<Shell>, state: &HubState, generation: u64, start: Instant) -> tauri::Result<tauri::WebviewWindow> {
    let app = &shell.host.app;
    let navigating = shell.clone();
    let loading = shell.clone();
    let url = target(state);
    {
        let mut navigation = shell.host.navigation.lock().unwrap_or_else(|e| e.into_inner());
        *navigation = Navigation::default();
        navigation.request(generation, url.clone(), false);
    }
    let url = if same_origin(&url, own_origin().as_str()) {
        WebviewUrl::App(url.path().trim_start_matches('/').into())
    } else {
        WebviewUrl::External(url)
    };
    let mut builder = WebviewWindowBuilder::new(app, LABEL, url)
        .title("Quotum")
        .visible(false)
        // Match the board's --bg while the web view has not painted a newly exposed area yet.
        .background_color(tauri::utils::config::Color(0x0b, 0x0b, 0x0e, 255))
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
                if !belongs(payload.url(), &loading.hub().0) {
                    navigate_current(&loading, true);
                }
                if let Some(smoke) = &loading.smoke {
                    smoke.page_loaded(&loading, payload.url());
                }
            }
        });
    if let Some(dir) = &shell.dirs.webview {
        builder = builder.data_directory(dir.clone());
    }
    let window = builder.build()?;
    let ready = window.clone();
    let shell = shell.clone();
    // Tauri queues the plugin's window-ready hook on the event loop. Restoring on
    // this worker can hold its cache while that hook waits for it, blocking both
    // threads. Queue placement after the hook, on the same event loop.
    window.run_on_main_thread(move || {
        // `build` returns before the event loop creates the window, and Tauri tells a failure
        // only to `log`. Here, after that, a getter of a window never created fails at once.
        match ready.is_visible() {
            Ok(_) => shell.hub_log.line(&format!("app: the window {LABEL} is up after {} ms", ms(start))),
            Err(e) => {
                shell.hub_log.line(&format!("app: the window {LABEL} was not created at {} ms: {e}", ms(start)));
                return;
            }
        }
        if shell.exiting() {
            return;
        }
        if shell.smoke.is_none() {
            let _ = ready.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
        }
        if let Err(error) = fit_on_screen(&ready) {
            shell.hub_log.line(&format!("app: the window could not be fitted to the screen: {error}"));
        }
        if let Err(error) = ready.show() {
            shell.hub_log.line(&format!("app: the window could not be shown: {error}"));
        }
    })?;
    Ok(window)
}

fn fit_on_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let position = window.outer_position()?;
    let width = outer.width.min(area.size.width);
    let height = outer.height.min(area.size.height);
    // The work area includes neither taskbar nor docks; account for the native frame
    // when setting the client size. All measurements here are physical pixels.
    if width != outer.width || height != outer.height {
        window.set_size(tauri::PhysicalSize::new(
            width.saturating_sub(outer.width.saturating_sub(inner.width)).max(1),
            height.saturating_sub(outer.height.saturating_sub(inner.height)).max(1),
        ))?;
    }
    let x = position.x.clamp(area.position.x, area.position.x + (area.size.width - width) as i32);
    let y = position.y.clamp(area.position.y, area.position.y + (area.size.height - height) as i32);
    if x != position.x || y != position.y {
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

/// Navigate from the requested generation, not the last document that committed.
pub fn follow(shell: &Arc<Shell>) {
    navigate_current(shell, false);
}

fn navigate_current(shell: &Arc<Shell>, force: bool) {
    let queued = shell.clone();
    // Ordering native requests on the event loop prevents a delayed worker from
    // navigating back to a snapshot that another worker already superseded.
    let _ = shell.host.app.run_on_main_thread(move || {
        if queued.exiting() {
            return;
        }
        let Some(window) = queued.host.app.get_webview_window(LABEL) else { return };
        let (state, generation) = queued.hub();
        let url = target(&state);
        let changed =
            queued.host.navigation.lock().unwrap_or_else(|e| e.into_inner()).request(generation, url.clone(), force);
        if changed && window.navigate(url).is_err() {
            *queued.host.navigation.lock().unwrap_or_else(|e| e.into_inner()) = Navigation::default();
            queued.hub_log.line("app: the window could not navigate");
        }
    });
}

/// Leads the window to the board again, entering with the key of the hub's current start
/// (a window that lost its session), or to the app's own page while the hub is not ready.
pub fn reenter(shell: &Arc<Shell>) {
    if is_open(shell) {
        navigate_current(shell, true);
    } else {
        open(shell, "reenter");
    }
}

/// Takes the window off the hub's pages while the app quits.
pub fn leave(shell: &Arc<Shell>) {
    if let Some(window) = shell.host.app.get_webview_window(LABEL) {
        let _ = window.navigate(own_page(&HubState::Down, true));
    }
}

pub fn close(shell: &Arc<Shell>) {
    if let Some(window) = shell.host.app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}
