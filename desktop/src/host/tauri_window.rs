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
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindowVisible};
/// Whether the window is open (it may be on its way out).
pub fn is_open(shell: &Shell) -> bool {
    [Role::Main, Role::Compact].iter().any(|role| shell.host.app.get_webview_window(role.label()).is_some())
}

/// Shows the window: creates it if there is none, on a thread of its own. `from` names who
/// asked, for the log.
pub fn open(shell: &Arc<Shell>, from: &'static str) {
    let request = {
        let mut toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
        toggle.close();
        toggle.revision()
    };
    crate::tray::loading(shell, false);
    close_unwanted_panel(shell);
    open_role(shell, from, Role::Main, request);
}
pub fn open_panel(shell: &Arc<Shell>) {
    let request = {
        let mut toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
        toggle.show();
        shell.host.panel_ready.store(0, Ordering::SeqCst);
        toggle.revision()
    };
    crate::tray::loading(shell, true);
    open_role(shell, "the tray", Role::Compact, request);
}
pub fn toggle_panel(shell: &Arc<Shell>, point: Option<(i32, i32)>) {
    let (show, request) = {
        let mut toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
        let show = toggle.toggle(Instant::now(), point);
        if show {
            shell.host.panel_ready.store(0, Ordering::SeqCst);
        }
        (show, toggle.revision())
    };
    if show {
        crate::tray::loading(shell, true);
        open_role(shell, "the tray", Role::Compact, request);
    } else {
        crate::tray::loading(shell, false);
        close_unwanted_panel(shell);
    }
}
pub fn dismiss_panel(shell: &Arc<Shell>, blur: bool) {
    {
        let mut toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
        if blur {
            toggle.blur(Instant::now(), crate::tray::cursor_position());
        } else {
            toggle.close();
        }
    }
    crate::tray::loading(shell, false);
    close_unwanted_panel(shell);
}
fn close_unwanted_panel(shell: &Arc<Shell>) {
    let paint = shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(paint) = paint else { return };
    if shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).requested(paint.request) {
        return;
    }
    retire_panel(shell, paint);
}
fn retire_panel(shell: &Arc<Shell>, paint: Arc<PanelPaint>) {
    paint.cancelled.store(true, Ordering::SeqCst);
    if current_paint(shell, &paint) {
        shell.host.panel_closing.store(true, Ordering::SeqCst);
        shell.host.panel_ready.store(0, Ordering::SeqCst);
    }
    let queued = shell.clone();
    let _ = shell.host.app.run_on_main_thread(move || {
        // This retires a particular presentation, even if a newer open arrived
        // while its UI thread was busy. It must never close that newer window.
        if current_paint(&queued, &paint)
            && let Some(panel) = queued.host.app.get_webview_window("compact")
        {
            let _ = panel.close();
        }
    });
}
#[derive(Default)]
pub struct PanelPaint {
    request: u64,
    focused: AtomicBool,
    placed: AtomicBool,
    loaded: AtomicBool,
    shown: AtomicBool,
    cancelled: AtomicBool,
}
fn current_paint(shell: &Shell, paint: &Arc<PanelPaint>) -> bool {
    shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|p| Arc::ptr_eq(p, paint))
}
fn reveal_panel(shell: &Arc<Shell>, window: &tauri::WebviewWindow, gate: &Arc<PanelPaint>) {
    if shell.exiting()
        || !current_paint(shell, gate)
        || !gate.placed.load(Ordering::SeqCst)
        || !gate.loaded.load(Ordering::SeqCst)
        || gate.cancelled.load(Ordering::SeqCst)
    {
        return;
    }
    let Ok(handle) = window.hwnd() else { return };
    let toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
    if !toggle.requested(gate.request) || gate.cancelled.load(Ordering::SeqCst) || !current_paint(shell, gate) {
        return;
    }
    shell.host.panel_ready.store(handle.0 as u64, Ordering::SeqCst);
    if !gate.shown.swap(true, Ordering::SeqCst) {
        drop(toggle);
        let handle = handle.0 as u64;
        let ready = window.clone();
        let showing = shell.clone();
        let paint = gate.clone();
        let _ = window.run_on_main_thread(move || {
            if paint.cancelled.load(Ordering::SeqCst)
                || !current_paint(&showing, &paint)
                || !showing.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).requested(paint.request)
            {
                return;
            }
            // Tauri owns this HWND and its visibility state. Showing it from the
            // tray thread races focus messages with WebView2 destruction.
            if let Err(error) = ready.show() {
                showing.hub_log.line(&format!("app: the panel could not be shown: {error}"));
                return;
            }
            // Showing can dispatch native messages before it returns. A new tray
            // request can retire this presentation even while its HWND is visible.
            if paint.cancelled.load(Ordering::SeqCst)
                || !current_paint(&showing, &paint)
                || !foreground_requested(&showing, Role::Compact, paint.request)
            {
                return;
            }
            let _ = ready.set_focus();
            crate::tray::present_panel(&showing, handle);
        });
    }
}

fn foreground_requested(shell: &Shell, role: Role, request: u64) -> bool {
    !shell.exiting()
        && shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).foreground_requested(role, request)
}

fn open_role(shell: &Arc<Shell>, from: &'static str, role: Role, request: u64) {
    let intent = opening(shell);
    let shell = shell.clone();
    thread::spawn(move || {
        let _intent = intent;
        open_now(&shell, from, role, request);
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

fn open_now(shell: &Arc<Shell>, from: &'static str, role: Role, request: u64) {
    let label = role.label();
    let start = Instant::now();
    if shell.exiting() {
        return;
    }
    shell.hub_log.line(&format!("app: {from} asks for the window"));
    let _creating = shell.window_lock.lock().unwrap_or_else(|e| e.into_inner());
    if !foreground_requested(shell, role, request) {
        return;
    }
    let app = &shell.host.app;
    if let Some(window) = app.get_webview_window(label) {
        // A second start can hand over while Tauri still holds a closed window under its
        // label: off the screen and without its web view, but not destroyed yet. Showing it
        // shows nothing, and the request would be spent: a new window comes once it has gone.
        let mut present = alive(shell, window.clone(), start + WAIT_LIMIT);
        if role == Role::Compact && present == Some(true) {
            let paint = shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if paint.as_ref().is_none_or(|p| p.request != request || p.cancelled.load(Ordering::SeqCst)) {
                // A native HWND keeps its request for life. Reusing it for a new
                // request would relabel old queued close/focus events as current.
                if let Some(paint) = paint {
                    retire_panel(shell, paint);
                } else {
                    shell.host.panel_closing.store(true, Ordering::SeqCst);
                    let _ = window.close();
                }
                present = Some(false);
            }
        }
        match present {
            Some(true) => {
                // The UI smoke (desktop/smoke/windows-ui.ps1) reads this line.
                shell.hub_log.line(&format!("app: found the window {label} at {} ms", ms(start)));
                if !foreground_requested(shell, role, request) {
                    return;
                }
                if role == Role::Compact {
                    let paint = shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).clone();
                    let Some(paint) = paint else { return };
                    if paint.cancelled.load(Ordering::SeqCst) || shell.host.panel_closing.load(Ordering::SeqCst) {
                        return;
                    }
                    reveal_panel(shell, &window, &paint);
                } else {
                    let showing = shell.clone();
                    let _ = shell.host.app.run_on_main_thread(move || {
                        // A later tray press may already own the foreground. Check
                        // here, not when this worker first found the main window.
                        if !foreground_requested(&showing, role, request) {
                            return;
                        }
                        let _ = window.unminimize();
                        if !foreground_requested(&showing, role, request) {
                            return;
                        }
                        let _ = window.show();
                        if foreground_requested(&showing, role, request) {
                            let _ = window.set_focus();
                        }
                    });
                }
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
        if !foreground_requested(shell, role, request) {
            return;
        }
        shell.hub_log.line(&format!("app: attempt {attempt} to create the window {label} at {} ms", ms(start)));
        let (state, generation) = shell.hub();
        match build(shell, &state, generation, start, role, request) {
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
            let shell = window.app_handle().state::<Arc<Shell>>();
            let closing =
                if window.label() == "compact" { &shell.host.panel_closing } else { &shell.host.main_closing };
            let closing = closing.load(Ordering::SeqCst);
            let _ = answer.send(!closing && window.is_visible().is_ok());
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
    request: u64,
) -> tauri::Result<tauri::WebviewWindow> {
    let label = role.label();
    let compact = role == Role::Compact;
    let height = if compact { *shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner()) } else { 800.0 };
    let app = &shell.host.app;
    let navigating = shell.clone();
    let loading = shell.clone();
    let paint = Arc::new(PanelPaint { request, ..PanelPaint::default() });
    let loaded_paint = paint.clone();
    if compact {
        *shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()) = Some(paint.clone());
        shell.host.panel_ready.store(0, Ordering::SeqCst);
        shell.host.panel_closing.store(false, Ordering::SeqCst);
    } else {
        shell.host.main_closing.store(false, Ordering::SeqCst);
    }
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
        .focused(false)
        .decorations(!compact)
        // Match the board's --bg while the web view has not painted a newly exposed area yet.
        .background_color(tauri::utils::config::Color(0x0b, 0x0b, 0x0e, 255))
        .inner_size(
            if compact { 400.0 } else { 1280.0 },
            if compact { initial_panel_height(shell, height) } else { height },
        )
        .min_inner_size(if compact { 160.0 } else { 480.0 }, if compact { 100.0 } else { 400.0 })
        .always_on_top(compact)
        .skip_taskbar(compact)
        .resizable(!compact)
        .on_navigation(move |url| {
            let (state, _) = navigating.hub();
            if allowed(url, &state) && !stale_hub_entry(url, &state) {
                return true;
            }
            let private = private_hub_url(url, &navigating.state().capabilities);
            if private {
                navigate_current(&navigating, true, Some(role));
            } else if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window({
            let shell = shell.clone();
            move |url, _| {
                // Links that open a new window go to the browser; nothing else opens.
                if matches!(url.scheme(), "http" | "https") && !private_hub_url(url, &shell.state().capabilities) {
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                }
                NewWindowResponse::Deny
            }
        })
        .on_page_load(move |view, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if !belongs(payload.url(), &loading.hub().0) {
                    navigate_current(&loading, true, Some(role));
                    return;
                }
                if compact && !loaded_paint.cancelled.load(Ordering::SeqCst) {
                    loaded_paint.loaded.store(true, Ordering::SeqCst);
                    reveal_panel(&loading, &view, &loaded_paint);
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
        let hwnd = window.hwnd()?.0 as usize;
        let escape_shell = Arc::downgrade(shell);
        let escape_paint = paint.clone();
        window.with_webview(move |view| unsafe {
            use webview2_com::{AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::*};
            use windows_sys::Win32::UI::{
                Input::KeyboardAndMouse::VK_ESCAPE,
                WindowsAndMessaging::{PostMessageW, WM_CLOSE},
            };
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut key = 0;
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.VirtualKey(&mut key)?;
                args.KeyEventKind(&mut kind)?;
                if key == u32::from(VK_ESCAPE) && kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                    args.SetHandled(true)?;
                    if let Some(shell) = escape_shell.upgrade() {
                        if !current_paint(&shell, &escape_paint) {
                            return Ok(());
                        }
                        shell
                            .host
                            .panel_toggle
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .closed_at(escape_paint.request);
                        escape_paint.cancelled.store(true, Ordering::SeqCst);
                        if current_paint(&shell, &escape_paint) {
                            shell.host.panel_closing.store(true, Ordering::SeqCst);
                            shell.host.panel_ready.store(0, Ordering::SeqCst);
                        }
                        if !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
                            crate::tray::loading(&shell, false);
                        }
                        // Defer destruction until WebView2 has returned from its callback.
                        PostMessageW(hwnd as _, WM_CLOSE, 0, 0);
                    }
                }
                Ok(())
            }));
            if let Err(error) = view.controller().add_AcceleratorKeyPressed(&handler, &mut 0) {
                log::warn!("cannot register panel Escape handler: {error}");
            }
        })?;
        let closing = window.clone();
        let resizing = shell.clone();
        let closing_paint = paint.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(active) = event {
                // WebView2 sends focus changes while the window is still hidden.
                // Dismiss only after this panel has actually been visible and focused.
                if *active
                    && !closing_paint.cancelled.load(Ordering::SeqCst)
                    && unsafe { IsWindowVisible(hwnd as _) != 0 && GetForegroundWindow() as usize == hwnd }
                {
                    closing_paint.focused.store(true, Ordering::SeqCst);
                } else if !*active
                    && !closing_paint.cancelled.load(Ordering::SeqCst)
                    && closing_paint.focused.load(Ordering::SeqCst)
                    && unsafe { GetForegroundWindow() as usize != hwnd }
                {
                    // Moving keyboard focus into WebView2 can report a blur while
                    // this top-level window still owns the foreground.
                    closing_paint.focused.store(false, Ordering::SeqCst);
                    let accepted = resizing.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).blur_at(
                        closing_paint.request,
                        Instant::now(),
                        crate::tray::cursor_position(),
                    );
                    if accepted {
                        close_unwanted_panel(&resizing);
                    }
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                closing_paint.cancelled.store(true, Ordering::SeqCst);
                if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                    && current_paint(&resizing, &closing_paint)
                {
                    resizing.host.panel_closing.store(true, Ordering::SeqCst);
                    resizing.host.panel_ready.store(0, Ordering::SeqCst);
                    resizing
                        .host
                        .panel_toggle
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .closed_at(closing_paint.request);
                }
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    // Publish the closed intent before the HWND becomes hidden.
                    // Focus must leave while the WebView2 controller still exists.
                    let _ = closing.hide();
                }
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let mut current = resizing.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner());
                    if current.as_ref().is_some_and(|p| Arc::ptr_eq(p, &closing_paint)) {
                        current.take();
                    }
                }
                if !resizing.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
                    crate::tray::loading(&resizing, false);
                }
            }
            if matches!(event, tauri::WindowEvent::Resized(_))
                && let Ok(hwnd) = closing.hwnd()
            {
                crate::windows_loading::round(hwnd.0);
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
        if paint.cancelled.load(Ordering::SeqCst) || !foreground_requested(&shell, role, request) {
            discard_created(&shell, &ready, role, &paint);
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
        if compact {
            if let Ok(hwnd) = ready.hwnd() {
                crate::windows_loading::disable_transitions(hwnd.0);
                crate::windows_loading::round(hwnd.0);
            }
            paint.placed.store(true, Ordering::SeqCst);
            reveal_panel(&shell, &ready, &paint);
            return;
        }
        if !foreground_requested(&shell, role, request) {
            discard_created(&shell, &ready, role, &paint);
        } else if let Err(error) = ready.show() {
            shell.hub_log.line(&format!("app: the window could not be shown: {error}"));
        } else if foreground_requested(&shell, role, request) {
            let _ = ready.set_focus();
        } else {
            discard_created(&shell, &ready, role, &paint);
        }
    })?;
    Ok(window)
}

fn discard_created(shell: &Shell, window: &tauri::WebviewWindow, role: Role, paint: &PanelPaint) {
    paint.cancelled.store(true, Ordering::SeqCst);
    let closing = if role == Role::Compact { &shell.host.panel_closing } else { &shell.host.main_closing };
    closing.store(true, Ordering::SeqCst);
    // An opening worker must wait for this label to go, even though its hidden
    // HWND is still alive until the queued destruction runs.
    let _ = window.destroy();
}

fn initial_panel_height(shell: &Shell, height: f64) -> f64 {
    let rect = shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|tray| tray.rect());
    let monitor = rect
        .and_then(|rect| shell.host.app.monitor_from_point(f64::from(rect.left), f64::from(rect.top)).ok().flatten())
        .or_else(|| shell.host.app.primary_monitor().ok().flatten());
    monitor.map_or(180.0, |monitor| {
        height.min(f64::from(monitor.work_area().size.height) / monitor.scale_factor() * 0.8).max(100.0)
    })
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
    crate::tray::loading(shell, false);
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
        let request = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).revision();
        open_role(shell, "reenter", role, request);
    }
}
fn current_panel(shell: &Shell, instance: u64) -> Option<tauri::WebviewWindow> {
    shell.host.app.get_webview_window("compact").filter(|w| w.hwnd().is_ok_and(|h| h.0 as u64 == instance))
}
pub fn close_panel(shell: &Arc<Shell>, instance: u64) {
    let paint = shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(paint) = paint.filter(|p| current_paint(shell, p) && current_panel(shell, instance).is_some()) {
        shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).closed_at(paint.request);
        retire_panel(shell, paint);
    }
}
pub fn open_main_from_panel(shell: &Arc<Shell>, instance: u64) {
    let shell = shell.clone();
    thread::spawn(move || {
        let paint = shell.host.panel_paint.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(paint) = paint.filter(|p| current_paint(&shell, p) && current_panel(&shell, instance).is_some())
        else {
            return;
        };
        let _intent = opening(&shell);
        let request = {
            let mut toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
            if paint.cancelled.load(Ordering::SeqCst) || !toggle.requested(paint.request) {
                return;
            }
            toggle.closed_at(paint.request);
            toggle.revision()
        };
        open_now(&shell, "the compact panel", Role::Main, request);
        retire_panel(&shell, paint);
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
        let height = height.min(f64::from(area.size.height) / scale * 0.8).max(100.0);
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
