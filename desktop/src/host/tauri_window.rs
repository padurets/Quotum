use crate::{hub::HubState, shell::Shell, window::*};
use std::{sync::Arc, thread, time::Duration};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};
/// Whether the window is open (it may be on its way out).
pub fn is_open(shell: &Shell) -> bool {
    shell.host.app.get_webview_window(LABEL).is_some()
}

/// Shows the window: creates it if there is none, on a thread of its own.
pub fn open(shell: &Arc<Shell>) {
    let intent = opening(shell);
    let shell = shell.clone();
    thread::spawn(move || {
        let _intent = intent;
        open_now(&shell);
    });
}

fn open_now(shell: &Arc<Shell>) {
    if shell.exiting() {
        return;
    }
    let _creating = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
    let app = &shell.host.app;
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
        match build(shell, &state, generation) {
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

fn build(shell: &Arc<Shell>, state: &HubState, generation: u64) -> tauri::Result<tauri::WebviewWindow> {
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
        open(shell);
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
