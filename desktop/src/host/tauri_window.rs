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
    let shell = shell.clone();
    thread::spawn(move || open_now(&shell));
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
    let app = &shell.host.app;
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
                if let Some(smoke) = &loading.smoke {
                    smoke.page_loaded(&loading, payload.url());
                }
            }
        });
    if let Some(dir) = &shell.dirs.webview {
        builder = builder.data_directory(dir.clone());
    }
    let window = builder.build()?;
    if shell.smoke.is_none() {
        let _ = window.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
    }
    let _ = fit_on_screen(&window);
    window.show()?;
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

/// Moves the window where it belongs in the hub's current state, if it is not there;
/// again if the state changed meanwhile.
pub fn follow(shell: &Arc<Shell>) {
    for _ in 0..10 {
        let (state, generation) = shell.hub();
        let Some(window) = shell.host.app.get_webview_window(LABEL) else { return };
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
            let Some(window) = shell.host.app.get_webview_window(LABEL) else { return open_now(&shell) };
            let _ = window.navigate(target(&state));
            if shell.generation() == generation {
                return;
            }
        }
    });
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
