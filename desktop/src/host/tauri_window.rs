use crate::{hub::HubState, shell::Shell, window::*};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::{StateFlags, WindowExt};
use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
/// Whether the window is open (it may be on its way out).
pub fn is_open(shell: &Shell) -> bool {
    [Role::Main, Role::Compact].iter().any(|role| shell.host.app.get_webview_window(role.label()).is_some())
}

/// Shows the window: creates it if there is none, on a thread of its own. `from` names who
/// asked, for the log.
pub fn open(shell: &Arc<Shell>, from: &'static str) {
    shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).close();
    open_role(shell, from, Role::Main);
}
pub fn open_panel(shell: &Arc<Shell>) {
    shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).show();
    open_role(shell, "the tray", Role::Compact);
}
pub fn toggle_panel(shell: &Arc<Shell>, point: Option<(i32, i32)>) {
    let show = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).toggle(Instant::now(), point);
    if show {
        open_role(shell, "the tray", Role::Compact);
    } else {
        let queued = shell.clone();
        let _ = shell.host.app.run_on_main_thread(move || {
            if queued.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
                return;
            }
            if let Some(panel) = queued.host.app.get_webview_window("compact") {
                let _ = panel.close();
            }
        });
    }
}
fn open_role(shell: &Arc<Shell>, from: &'static str, role: Role) {
    let intent = opening(shell);
    let shell = shell.clone();
    thread::spawn(move || {
        let _intent = intent;
        open_now(&shell, from, role);
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

fn open_now(shell: &Arc<Shell>, from: &'static str, role: Role) {
    let label = role.label();
    let start = Instant::now();
    if shell.exiting() {
        return;
    }
    shell.hub_log.line(&format!("app: {from} asks for the window"));
    let _creating = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
    if role == Role::Compact && !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
        return;
    }
    let app = &shell.host.app;
    if let Some(window) = app.get_webview_window(label) {
        // A second start can hand over while Tauri still holds a closed window under its
        // label: off the screen and without its web view, but not destroyed yet. Showing it
        // shows nothing, and the request would be spent: a new window comes once it has gone.
        match alive(shell, window.clone(), start + WAIT_LIMIT) {
            Some(true) => {
                // The UI smoke (desktop/smoke/windows-ui.ps1) reads this line.
                shell.hub_log.line(&format!("app: found the window {label} at {} ms", ms(start)));
                let _ = window.unminimize();
                if role == Role::Compact && !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted()
                {
                    return;
                }
                let _ = window.show();
                let _ = window.set_focus();
                drop(_creating);
                follow(shell);
                return;
            }
            // A window whose creation failed answers the same, and never goes.
            Some(false) => {
                shell
                    .hub_log
                    .line(&format!("app: the window {label} is closing, or was never created, at {} ms", ms(start)));
                while app.get_webview_window(label).is_some() {
                    if shell.exiting() {
                        return;
                    }
                    if start.elapsed() >= WAIT_LIMIT {
                        shell.hub_log.line(&format!("app: the window {label} did not go within {} ms", ms(start)));
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                shell.hub_log.line(&format!("app: the window {label} went at {} ms", ms(start)));
            }
            // No answer by the deadline, which counts from the request and so includes its wait
            // for the lock: the main thread is stuck or far behind. A new window cannot be made
            // while the label is taken, and a show queued now could come long after it was asked
            // for: the request ends here, in the log.
            None => {
                shell
                    .hub_log
                    .line(&format!("app: no answer within {} ms whether the window {label} is still there", ms(start)));
                return;
            }
        }
    }
    // A window that went may still hold its label for a moment.
    for attempt in 1..=20 {
        shell.hub_log.line(&format!("app: attempt {attempt} to create the window {label} at {} ms", ms(start)));
        let (state, generation) = shell.hub();
        match build(shell, &state, generation, start, role) {
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

fn build(
    shell: &Arc<Shell>,
    state: &HubState,
    generation: u64,
    start: Instant,
    role: Role,
) -> tauri::Result<tauri::WebviewWindow> {
    let label = role.label();
    let compact = role == Role::Compact;
    let height = if compact { *shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner()) } else { 800.0 };
    let app = &shell.host.app;
    let navigating = shell.clone();
    let loading = shell.clone();
    let url = if compact { panel_target(state) } else { target(state) };
    {
        let mut navigation = shell.host.navigation.lock().unwrap_or_else(|e| e.into_inner());
        navigation.insert(role, Navigation::default());
        navigation.get_mut(&role).unwrap().request(generation, url.clone(), false);
    }
    let url = if same_origin(&url, own_origin().as_str()) {
        WebviewUrl::App(url.path().trim_start_matches('/').into())
    } else {
        WebviewUrl::External(url)
    };
    let mut builder = WebviewWindowBuilder::new(app, label, url)
        .title("Quotum")
        .visible(false)
        .focused(!compact)
        .decorations(!compact)
        // Match the board's --bg while the web view has not painted a newly exposed area yet.
        .background_color(tauri::utils::config::Color(0x0b, 0x0b, 0x0e, 255))
        .inner_size(if compact { 400.0 } else { 1280.0 }, if compact { height.min(600.0) } else { height })
        .min_inner_size(if compact { 160.0 } else { 480.0 }, if compact { 100.0 } else { 400.0 })
        .always_on_top(compact)
        .skip_taskbar(compact)
        .resizable(!compact)
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
                    navigate_current(&loading, true, Some(role));
                }
                if let Some(smoke) = loading.smoke.as_ref().filter(|_| !compact) {
                    smoke.page_loaded(&loading, payload.url());
                }
            }
        });
    if let Some(dir) = &shell.dirs.webview {
        builder = builder.data_directory(dir.clone());
    }
    let window = builder.build()?;
    if compact {
        let closing = window.clone();
        let resizing = shell.clone();
        let focused = AtomicBool::new(false);
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(active) = event {
                // WebView2 sends focus changes while the window is still hidden.
                // Dismiss only after this panel has actually been visible and focused.
                if *active && closing.is_visible().unwrap_or(false) {
                    focused.store(true, Ordering::SeqCst);
                } else if !*active
                    && focused.load(Ordering::SeqCst)
                    && closing.hwnd().is_ok_and(|handle| unsafe { GetForegroundWindow() != handle.0 })
                {
                    // Moving keyboard focus into WebView2 can report a blur while
                    // this top-level window still owns the foreground.
                    focused.store(false, Ordering::SeqCst);
                    resizing
                        .host
                        .panel_toggle
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .blur(Instant::now(), crate::tray::cursor_position());
                    let _ = closing.close();
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                resizing.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).closed();
            }
            if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. } | tauri::WindowEvent::Moved(_)) {
                let height = *resizing.host.panel_height.lock().unwrap_or_else(|e| e.into_inner());
                if let Ok(hwnd) = closing.hwnd() {
                    panel_height(&resizing, hwnd.0 as u64, height);
                }
            }
        });
    }
    let ready = window.clone();
    let shell = shell.clone();
    // Tauri queues the plugin's window-ready hook on the event loop. Restoring on
    // this worker can hold its cache while that hook waits for it, blocking both
    // threads. Queue placement after the hook, on the same event loop.
    window.run_on_main_thread(move || {
        // `build` returns before the event loop creates the window, and Tauri tells a failure
        // only to `log`. Here, after that, a getter of a window never created fails at once.
        match ready.is_visible() {
            Ok(_) => shell.hub_log.line(&format!("app: the window {label} is up after {} ms", ms(start))),
            Err(e) => {
                shell.hub_log.line(&format!("app: the window {label} was not created at {} ms: {e}", ms(start)));
                return;
            }
        }
        if shell.exiting() {
            return;
        }
        if compact && !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
            let _ = ready.destroy();
            return;
        }
        if !compact && shell.smoke.is_none() {
            let _ = ready.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
        }
        if let Err(error) = fit_on_screen(&ready) {
            shell.hub_log.line(&format!("app: the window could not be fitted to the screen: {error}"));
        }
        if compact {
            place_panel(&shell, &ready);
            if let Ok(hwnd) = ready.hwnd() {
                panel_height(&shell, hwnd.0 as u64, height);
            }
        }
        if let Err(error) = ready.show() {
            shell.hub_log.line(&format!("app: the window could not be shown: {error}"));
        } else if compact {
            let _ = ready.set_focus();
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
    navigate_current(shell, false, None);
}

fn navigate_current(shell: &Arc<Shell>, force: bool, only: Option<Role>) {
    let queued = shell.clone();
    // Ordering native requests on the event loop prevents a delayed worker from
    // navigating back to a snapshot that another worker already superseded.
    let _ = shell.host.app.run_on_main_thread(move || {
        if queued.exiting() {
            return;
        }
        for role in [Role::Main, Role::Compact] {
            if only.is_some_and(|only| only != role) {
                continue;
            }
            let Some(window) = queued.host.app.get_webview_window(role.label()) else {
                continue;
            };
            let (state, generation) = queued.hub();
            let url = if role == Role::Compact { panel_target(&state) } else { target(&state) };
            let changed =
                queued.host.navigation.lock().unwrap_or_else(|e| e.into_inner()).entry(role).or_default().request(
                    generation,
                    url.clone(),
                    force,
                );
            if changed && window.navigate(url).is_err() {
                queued.host.navigation.lock().unwrap_or_else(|e| e.into_inner()).remove(&role);
                queued.hub_log.line("app: the window could not navigate");
            }
        }
    });
}

/// Takes the window off the hub's pages while the app quits.
pub fn leave(shell: &Arc<Shell>) {
    for role in [Role::Main, Role::Compact] {
        if let Some(window) = shell.host.app.get_webview_window(role.label()) {
            let _ = window.navigate(own_page(&HubState::Down, true));
        }
    }
}

pub fn close(shell: &Arc<Shell>) {
    for role in [Role::Main, Role::Compact] {
        if let Some(window) = shell.host.app.get_webview_window(role.label()) {
            let _ = window.destroy();
        }
    }
}

/// Leads the window to the board again, entering with the key of the hub's current start
/// (a window that lost its session), or to the app's own page while the hub is not ready.
pub fn reenter_role(shell: &Arc<Shell>, role: Role) {
    if shell.host.app.get_webview_window(role.label()).is_some() {
        navigate_current(shell, true, Some(role));
    } else if role == Role::Compact {
        open_panel(shell);
    } else {
        open_role(shell, "reenter", role);
    }
}
fn current_panel(shell: &Shell, instance: u64) -> Option<tauri::WebviewWindow> {
    shell.host.app.get_webview_window("compact").filter(|w| w.hwnd().is_ok_and(|h| h.0 as u64 == instance))
}
pub fn close_panel(shell: &Arc<Shell>, instance: u64) {
    if let Some(w) = current_panel(shell, instance) {
        shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).close();
        let _ = w.close();
    }
}
pub fn open_main_from_panel(shell: &Arc<Shell>, instance: u64) {
    let shell = shell.clone();
    thread::spawn(move || {
        if current_panel(&shell, instance).is_none() {
            return;
        }
        shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).close();
        open_now(&shell, "the compact panel", Role::Main);
        close_panel(&shell, instance);
    });
}
pub fn panel_height(shell: &Arc<Shell>, instance: u64, height: f64) {
    let queued = shell.clone();
    let generation = shell.generation();
    let _ = shell.host.app.run_on_main_thread(move || {
        if queued.generation() != generation {
            return;
        }
        let Some(window) = current_panel(&queued, instance) else {
            return;
        };
        *queued.host.panel_height.lock().unwrap_or_else(|e| e.into_inner()) = height;
        let Ok(Some(monitor)) = window.current_monitor() else {
            return;
        };
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let width = 400.0_f64.min(f64::from(area.size.width) / scale);
        let height = height.min(600.0).min(f64::from(area.size.height) / scale * 0.8).max(100.0);
        let requested = tauri::LogicalSize::new(width, height).to_physical::<u32>(scale);
        if window.inner_size().is_ok_and(|size| size != requested) {
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
        }
        place_panel(&queued, &window);
        let _ = fit_on_screen(&window);
    });
}

fn place_panel(shell: &Shell, window: &tauri::WebviewWindow) {
    let rect = shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|tray| tray.rect());
    let Some(rect) = rect else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Some(monitor) = monitors.iter().find(|m| {
        let p = m.position();
        let s = m.size();
        rect.left >= p.x && rect.left < p.x + s.width as i32 && rect.top >= p.y && rect.top < p.y + s.height as i32
    }) else {
        return;
    };
    let a = monitor.work_area();
    let Ok(size) = window.outer_size() else {
        return;
    };
    let width = size.width.min(a.size.width) as i32;
    let height = size.height.min(a.size.height) as i32;
    let x = (rect.right - width).clamp(a.position.x, a.position.x + a.size.width as i32 - width);
    let y = if rect.top - height >= a.position.y { rect.top - height } else { rect.bottom };
    let y = y.clamp(a.position.y, a.position.y + a.size.height as i32 - height);
    let position = tauri::PhysicalPosition::new(x, y);
    if window.outer_position().is_ok_and(|current| current != position) {
        let _ = window.set_position(position);
    }
}
