//! A native response to the tray, independent of Chromium startup and page painting.
use super::{Gui, Shell, open_at};
use crate::{
    native_text,
    window::{PanelToggle, Role},
};
use gtk::{gdk, glib, prelude::*};
use std::{
    cell::RefCell,
    sync::Arc,
    time::{Duration, Instant},
};

thread_local! { static PANEL: RefCell<Option<Panel>> = const { RefCell::new(None) }; }
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Closed,
    Loading,
    Handoff,
    Browser,
}
struct Panel {
    window: gtk::Window,
    spinner: gtk::Spinner,
    label: gtk::Label,
    intent: PanelToggle,
    request: u64,
    phase: Phase,
    handle: u64,
    timeout: Option<glib::SourceId>,
    anchor: Option<(i32, i32)>,
    retried: bool,
}

// Before worker threads: GDK and Electron must agree on their coordinate space.
// A desktop without X11 keeps the existing compositor-managed browser path.
pub fn init() -> bool {
    if std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    unsafe {
        gdk::ffi::gdk_set_allowed_backends(c"x11".as_ptr());
    }
    gtk::init().is_ok()
}
pub fn install(shell: &Arc<Shell>) {
    let window = gtk::Window::new(gtk::WindowType::Popup);
    window.set_title("Quotum");
    window.set_role("quotum-loading");
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    window.set_keep_above(true);
    window.set_type_hint(gdk::WindowTypeHint::PopupMenu);
    let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    row.set_halign(gtk::Align::Center);
    row.set_valign(gtk::Align::Center);
    let spinner = gtk::Spinner::new();
    spinner.set_size_request(24, 24);
    let label = gtk::Label::new(None);
    row.add(&spinner);
    row.add(&label);
    window.add(&row);
    // These prepared colours come from the board's shared tokens.
    let css = gtk::CssProvider::new();
    let _ = css.load_from_data(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/loading.css")));
    window.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    label.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    spinner.style_context().add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    let weak = Arc::downgrade(shell);
    window.connect_focus_out_event(move |_, _| {
        if let Some(shell) = weak.upgrade() {
            dispatch(shell, |panel, shell| {
                if panel.phase == Phase::Loading {
                    panel.dismiss(shell, true);
                }
            });
        }
        glib::Propagation::Proceed
    });
    let weak = Arc::downgrade(shell);
    window.connect_delete_event(move |_, _| {
        if let Some(shell) = weak.upgrade() {
            dismiss(&shell);
        }
        glib::Propagation::Stop
    });
    let weak = Arc::downgrade(shell);
    window.connect_key_press_event(move |_, event| {
        if event.keyval() == gdk::keys::constants::Escape {
            if let Some(shell) = weak.upgrade() {
                dismiss(&shell);
            }
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    PANEL.with(|state| {
        *state.borrow_mut() = Some(Panel {
            window,
            spinner,
            label,
            intent: PanelToggle::default(),
            request: 0,
            phase: Phase::Closed,
            handle: 0,
            timeout: None,
            anchor: None,
            retried: false,
        })
    });
}
fn dispatch(shell: Arc<Shell>, action: impl FnOnce(&mut Panel, &Arc<Shell>) + Send + 'static) {
    glib::idle_add_once(move || {
        PANEL.with(|state| {
            if let Some(panel) = state.borrow_mut().as_mut() {
                action(panel, &shell);
            }
        })
    });
}
fn pointer() -> Option<(i32, i32)> {
    let (_, x, y) = gdk::Display::default()?.default_seat()?.pointer()?.position();
    Some((x, y))
}
impl Panel {
    fn hide(&mut self) {
        if let Some(timeout) = self.timeout.take() {
            timeout.remove();
        }
        self.phase = Phase::Closed;
        self.spinner.stop();
        self.window.hide();
    }
    fn dismiss(&mut self, shell: &Shell, blur: bool) {
        if blur {
            self.intent.blur(Instant::now(), pointer());
        } else {
            self.intent.close();
        }
        self.hide();
        if let Some(gui) = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            let _ = gui.send(&serde_json::json!({"type":"panel_intent", "request":self.request, "open":false}));
        }
    }
    fn show(&mut self, shell: &Arc<Shell>, anchor: Option<(i32, i32)>) {
        self.request += 1;
        self.retried = false;
        let request = self.request;
        self.phase = Phase::Loading;
        self.label.set_text(native_text::text(shell.locale(), "desktop.loading"));
        self.spinner.start();
        let anchor = anchor.filter(|&(x, y)| x != 0 || y != 0).or_else(pointer);
        self.anchor = anchor;
        let display = gdk::Display::default().expect("initialized GDK");
        let monitor = anchor.and_then(|(x, y)| display.monitor_at_point(x, y)).or_else(|| display.primary_monitor());
        if let Some(monitor) = monitor {
            let area = monitor.workarea();
            let width = 400.min(area.width());
            let height = (*shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner()) as i32)
                .clamp(100, 600)
                .min(area.height() * 4 / 5);
            let (x, y) = anchor.unwrap_or((area.x() + area.width(), area.y() + area.height()));
            self.window.set_size_request(width, height);
            self.window.resize(width, height);
            self.window.move_(
                (x - width).clamp(area.x(), area.x() + area.width() - width),
                (y - height).clamp(area.y(), area.y() + area.height() - height),
            );
        }
        shell.hub_log.line(&format!("app: loading panel {request}"));
        self.window.show_all();
        if let Some(native) = self.window.window().and_then(|w| w.downcast::<gdkx11::X11Window>().ok()) {
            native_window(native.xid(), true);
        }
        open_at(shell, Role::Compact, anchor, false, Some(request));
        let weak = Arc::downgrade(shell);
        self.timeout = Some(glib::timeout_add_local_once(Duration::from_secs(15), move || {
            PANEL.with(|state| {
                if let Some(panel) = state.borrow_mut().as_mut().filter(|p| p.request == request) {
                    panel.timeout.take();
                }
            });
            if let Some(shell) = weak.upgrade() {
                failed(&shell, request);
            }
        }));
    }
}
pub fn activate(shell: &Arc<Shell>, anchor: Option<(i32, i32)>, toggle: bool) {
    dispatch(shell.clone(), move |panel, shell| {
        if shell.exiting() {
            return;
        }
        let was_open = panel.intent.wanted();
        if toggle {
            if !panel.intent.toggle(Instant::now(), pointer()) {
                // Preserve blur pairing until its matching tray release has arrived.
                panel.hide();
                if let Some(gui) = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    let _ =
                        gui.send(&serde_json::json!({"type":"panel_intent", "request":panel.request, "open":false}));
                }
                return;
            }
        } else {
            panel.intent.show();
        }
        if was_open && panel.phase != Phase::Closed {
            if panel.phase == Phase::Loading {
                panel.window.present();
            } else {
                open_at(shell, Role::Compact, anchor, false, Some(panel.request));
            }
        } else {
            panel.show(shell, anchor);
        }
    });
}
pub fn dismiss(shell: &Arc<Shell>) {
    dispatch(shell.clone(), |panel, shell| panel.dismiss(shell, false));
}
pub fn main(shell: &Arc<Shell>) {
    dispatch(shell.clone(), |panel, shell| {
        panel.dismiss(shell, false);
        open_at(shell, Role::Main, None, false, None);
    });
}
pub fn ready(shell: &Arc<Shell>, gui: Arc<Gui>, request: u64, instance: u64, handle: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        if shell.exiting() || request != panel.request || !panel.intent.wanted() {
            let _ = gui.send(&serde_json::json!({"type":"panel_intent", "request":request, "open":false}));
            return;
        }
        shell.hub_log.line(&format!("app: panel {request} painted (window {handle})"));
        if !native_window(handle, false) {
            return;
        }
        panel.handle = handle;
        panel.phase = Phase::Handoff;
        let _ = gui.send(&serde_json::json!({"type":"panel_reveal", "request":request, "instance":instance}));
    });
}
pub fn visible(shell: &Arc<Shell>, request: u64) {
    dispatch(shell.clone(), move |panel, _| {
        if panel.request == request && panel.intent.wanted() {
            panel.hide();
            panel.phase = Phase::Browser;
            native_window(panel.handle, true);
        }
    });
}
pub fn closed(shell: &Arc<Shell>, request: u64, blur: bool) {
    dispatch(shell.clone(), move |panel, _| {
        if panel.request == request {
            if blur {
                panel.intent.blur(Instant::now(), pointer());
            } else {
                panel.intent.closed();
            }
            panel.hide();
        }
    });
}
pub fn failed(shell: &Arc<Shell>, request: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        if panel.request == request && matches!(panel.phase, Phase::Loading | Phase::Handoff) {
            panel.spinner.stop();
            panel.label.set_text(native_text::text(shell.locale(), "desktop.windowFailed"));
        }
    });
}

// A tray popup is an unmanaged X11 surface, as a native menu is. Chromium's
// normal window mapping overwrites skip-taskbar hints and asks the WM to animate
// it. Configure before mapping, then focus it after the native loader is hidden.
fn native_window(handle: u64, focus: bool) -> bool {
    use glib::translate::*;
    use x11::xlib;
    let Some(display) = gdk::Display::default().and_then(|d| d.downcast::<gdkx11::X11Display>().ok()) else {
        return false;
    };
    display.error_trap_push();
    unsafe {
        let xdisplay = gdkx11::ffi::gdk_x11_display_get_xdisplay(display.to_glib_none().0);
        if focus {
            xlib::XRaiseWindow(xdisplay, handle as _);
            xlib::XSetInputFocus(xdisplay, handle as _, xlib::RevertToPointerRoot, xlib::CurrentTime);
        } else {
            let mut attributes: xlib::XSetWindowAttributes = std::mem::zeroed();
            attributes.override_redirect = 1;
            xlib::XChangeWindowAttributes(xdisplay, handle as _, xlib::CWOverrideRedirect, &mut attributes);
            let property = xlib::XInternAtom(xdisplay, c"_NET_WM_WINDOW_TYPE".as_ptr(), 0);
            let value = xlib::XInternAtom(xdisplay, c"_NET_WM_WINDOW_TYPE_POPUP_MENU".as_ptr(), 0);
            xlib::XChangeProperty(
                xdisplay,
                handle as _,
                property,
                xlib::XA_ATOM,
                32,
                xlib::PropModeReplace,
                (&value as *const xlib::Atom).cast(),
                1,
            );
        }
        xlib::XSync(xdisplay, 0);
    }
    display.error_trap_pop() == 0
}

pub fn engine_ended(shell: &Arc<Shell>, success: bool) {
    dispatch(shell.clone(), move |panel, shell| {
        if shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return;
        }
        if success && panel.phase == Phase::Loading && panel.intent.wanted() && !panel.retried {
            // A click can reach the old process just as its idle exit starts.
            // Keep the loader and deliver that request once to a fresh browser.
            panel.retried = true;
            open_at(shell, Role::Compact, panel.anchor, false, Some(panel.request));
        } else if panel.phase == Phase::Browser {
            panel.intent.close();
            panel.hide();
        } else if matches!(panel.phase, Phase::Loading | Phase::Handoff) {
            panel.spinner.stop();
            panel.label.set_text(native_text::text(shell.locale(), "desktop.windowFailed"));
        }
    });
}
