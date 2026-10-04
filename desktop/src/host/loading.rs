//! A native response to the tray, independent of Chromium startup and page painting.
use super::{
    Gui, Shell, accept, cancel, current,
    foreground::{Head, Target},
    head, open_at,
};
use crate::{native_text, window::Role};
use gtk::{gdk, glib, prelude::*};
use std::{
    cell::{Cell, RefCell},
    sync::Arc,
    time::Duration,
};

thread_local! { static PANEL: RefCell<Option<Loader>> = const { RefCell::new(None) }; }
#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Handoff,
    Browser,
}
struct Loader {
    css: gtk::CssProvider,
    tray_anchor: Option<(i32, i32)>,
    panel: Option<Panel>,
}
struct Panel {
    window: gtk::Window,
    spinner: gtk::Spinner,
    label: gtk::Label,
    ticket: Head,
    phase: Phase,
    handle: u64,
    timeout: Option<glib::SourceId>,
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
pub fn install(_: &Arc<Shell>) {
    // Parse the prepared shared colours once; closed loaders retain no widgets.
    let css = gtk::CssProvider::new();
    let _ = css.load_from_data(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/loading.css")));
    PANEL.with(|state| *state.borrow_mut() = Some(Loader { css, tray_anchor: None, panel: None }));
}
impl Panel {
    fn new(shell: &Arc<Shell>, css: &gtk::CssProvider, ticket: Head) -> Self {
        let request = ticket.revision;
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
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
        window.style_context().add_provider(css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        label.style_context().add_provider(css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        spinner.style_context().add_provider(css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        let clipped = Cell::new((0, 0, 0));
        window.connect_size_allocate(move |widget, allocation| {
            if let Some(native) = widget.window() {
                let width = allocation.width();
                let height = allocation.height();
                if clipped.replace((width, height, widget.scale_factor())) == (width, height, widget.scale_factor()) {
                    return;
                }
                let radius = (native_text::popup_radius() as i32).min(width / 2).min(height / 2);
                let region = gtk::cairo::Region::create();
                for y in 0..height {
                    let inset = if y < radius || y >= height - radius {
                        let dy = f64::from(if y < radius { radius - y } else { y - (height - radius) + 1 }) - 0.5;
                        (f64::from(radius) - (f64::from(radius * radius) - dy * dy).max(0.0).sqrt()).ceil() as i32
                    } else {
                        0
                    };
                    let _ =
                        region.union_rectangle(&gtk::cairo::RectangleInt::new(inset, y, (width - 2 * inset).max(1), 1));
                }
                native.shape_combine_region(Some(&region), 0, 0);
            }
        });
        let weak = Arc::downgrade(shell);
        window.connect_focus_out_event(move |_, _| {
            // This signal belongs to the native window that lost focus, even if
            // GDK delivers it after a later presentation has already been accepted.
            if let Some(shell) = weak.upgrade() {
                dispatch(shell, move |loader, shell| {
                    let blurred = current(shell, ticket)
                        && loader.panel.as_ref().is_some_and(|panel| {
                            panel.ticket == ticket
                                && panel.phase == Phase::Loading
                                && !panel.window.has_toplevel_focus()
                        });
                    if blurred {
                        loader.dismiss(shell, request, true);
                    }
                });
            }
            glib::Propagation::Proceed
        });
        let weak = Arc::downgrade(shell);
        window.connect_delete_event(move |_, _| {
            if let Some(shell) = weak.upgrade() {
                dismiss_at(&shell, request);
            }
            glib::Propagation::Stop
        });
        let weak = Arc::downgrade(shell);
        window.connect_key_press_event(move |_, event| {
            if event.keyval() == gdk::keys::constants::Escape {
                if let Some(shell) = weak.upgrade() {
                    dismiss_at(&shell, request);
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        Self { window, spinner, label, ticket, phase: Phase::Loading, handle: 0, timeout: None, retried: false }
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        if let Some(timeout) = self.timeout.take() {
            timeout.remove();
        }
        self.spinner.stop();
        self.window.hide();
        // All signals own only the ticket and a weak Shell. No callback retains
        // this window or reads its state after the presentation is retired.
        unsafe {
            self.window.destroy();
        }
    }
}

fn dispatch(shell: Arc<Shell>, action: impl FnOnce(&mut Loader, &Arc<Shell>) + Send + 'static) {
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
fn menu_anchor(wayland: bool, last_tray: Option<(i32, i32)>, pointer: Option<(i32, i32)>) -> Option<(i32, i32)> {
    // An XWayland pointer can still name the last X11 window after the person
    // has moved to a Wayland tray menu on another monitor.
    if wayland { last_tray } else { pointer.or(last_tray) }
}
fn fallback_anchor(bounds: gdk::Rectangle, area: gdk::Rectangle, width: i32, height: i32) -> (i32, i32) {
    let top = area.y() - bounds.y();
    let bottom = bounds.y() + bounds.height() - area.y() - area.height();
    let left = area.x() - bounds.x();
    let right = bounds.x() + bounds.width() - area.x() - area.width();
    let end_x = area.x() + area.width() - 1;
    let end_y = area.y() + area.height() - 1;
    if top > 0 && top >= bottom.max(left).max(right) {
        (end_x, area.y())
    } else if left > 0 && left >= bottom.max(right) {
        (area.x(), end_y)
    } else if bottom > 0 || right > 0 {
        (end_x, end_y)
    } else {
        // An auto-hidden panel reserves no edge. Keep the first menu opening
        // within the primary monitor until an activation supplies its position.
        ((area.x() + (area.width() + width) / 2).min(end_x), (area.y() + (area.height() + height) / 2).min(end_y))
    }
}
impl Panel {
    fn present(&self) {
        if let Some(native) = self.window.window() {
            native.set_opacity(1.0);
            use glib::translate::ToGlibPtr;
            unsafe {
                gdk::ffi::gdk_window_input_shape_combine_region(native.to_glib_none().0, std::ptr::null_mut(), 0, 0);
            }
        }
        self.window.show_all();
        self.window.present();
    }
    fn conceal(&mut self) {
        if let Some(timeout) = self.timeout.take() {
            timeout.remove();
        }
        self.spinner.stop();
        // Keep the managed focus owner while Chromium's popup is visible. Hiding
        // it here would restore the previous Wayland app's keyboard focus.
        if let Some(native) = self.window.window() {
            native.set_opacity(0.0);
            native.input_shape_combine_region(&gtk::cairo::Region::create(), 0, 0);
        }
    }
    fn arm_timeout(&mut self, shell: &Arc<Shell>) {
        let request = self.ticket.revision;
        let weak = Arc::downgrade(shell);
        self.timeout = Some(glib::timeout_add_local_once(Duration::from_secs(15), move || {
            PANEL.with(|state| {
                if let Some(panel) = state.borrow_mut().as_mut().and_then(|loader| loader.at(request)) {
                    panel.timeout.take();
                }
            });
            if let Some(shell) = weak.upgrade() {
                failed(&shell, request);
            }
        }));
    }
}
impl Loader {
    fn at(&mut self, request: u64) -> Option<&mut Panel> {
        self.panel.as_mut().filter(|panel| panel.ticket.revision == request)
    }
    fn hide(&mut self) {
        self.panel.take();
    }
    fn dismiss(&mut self, shell: &Shell, request: u64, blur: bool) {
        if self.at(request).is_some() {
            cancel(shell, request, blur, pointer());
            self.hide();
        }
    }
    fn show(&mut self, shell: &Arc<Shell>, anchor: Option<(i32, i32)>, toggle: bool) {
        let anchor = anchor.filter(|&(x, y)| x != 0 || y != 0);
        let mut anchor =
            anchor.or_else(|| menu_anchor(std::env::var_os("WAYLAND_DISPLAY").is_some(), self.tray_anchor, pointer()));
        let display = gdk::Display::default().expect("initialized GDK");
        let monitor = anchor
            .and_then(|(x, y)| display.monitor_at_point(x, y))
            .or_else(|| display.primary_monitor())
            .or_else(|| display.monitor(0));
        let placement = monitor.map(|monitor| {
            let area = monitor.workarea();
            let width = 400.min(area.width());
            let height = (*shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner()) as i32)
                .max(100)
                .min(area.height() * 4 / 5);
            let (x, y) = anchor.unwrap_or_else(|| fallback_anchor(monitor.geometry(), area, width, height));
            anchor = Some((x, y));
            (
                width,
                height,
                (x - width).clamp(area.x(), area.x() + area.width() - width),
                (y - height).clamp(area.y(), area.y() + area.height() - height),
            )
        });
        let ticket = accept(shell, Role::Compact, anchor, toggle, pointer());
        self.hide();
        if ticket.target != Target::Compact {
            return;
        }
        let mut panel = Panel::new(shell, &self.css, ticket);
        panel.label.set_text(native_text::text(shell.locale(), "desktop.loading"));
        panel.spinner.start();
        if let Some((width, height, x, y)) = placement {
            panel.window.set_size_request(width, height);
            panel.window.resize(width, height);
            panel.window.move_(x, y);
        }
        shell.hub_log.line(&format!("app: loading panel {}", ticket.revision));
        // With no engine there is no older browser focus queued. Otherwise the
        // publisher schedules this presentation only after the complete head is sent.
        if shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).is_none() {
            panel.present();
        }
        panel.arm_timeout(shell);
        self.panel = Some(panel);
        open_at(shell, ticket);
    }
}

pub fn activate(shell: &Arc<Shell>, anchor: Option<(i32, i32)>, toggle: bool) {
    let opening = crate::window::opening(shell);
    dispatch(shell.clone(), move |panel, shell| {
        let _opening = opening;
        if shell.exiting() {
            return;
        }
        if let Some(anchor) = anchor.filter(|&(x, y)| x != 0 || y != 0) {
            panel.tray_anchor = Some(anchor);
        }
        if !toggle
            && head(shell).target == Target::Compact
            && panel.panel.as_ref().is_some_and(|p| current(shell, p.ticket))
        {
            // Explicit Limits is idempotent for the current presentation. Its
            // native callbacks keep the same revision and resolved tray anchor.
            open_at(shell, head(shell));
        } else {
            panel.show(shell, anchor, toggle);
        }
    });
}
pub fn dismiss_at(shell: &Arc<Shell>, request: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        panel.dismiss(shell, request, false);
    });
}
pub fn main(shell: &Arc<Shell>) {
    let opening = crate::window::opening(shell);
    dispatch(shell.clone(), move |panel, shell| {
        let _opening = opening;
        let ticket = accept(shell, Role::Main, None, false, None);
        shell.hub_log.line(&format!("app: main window request {}", ticket.revision));
        panel.hide();
        open_at(shell, ticket);
    });
}
pub fn main_from_panel(shell: &Arc<Shell>, instance: u64, ticket: Head) {
    let opening = crate::window::opening(shell);
    dispatch(shell.clone(), move |panel, shell| {
        let _opening = opening;
        if let Some(ticket) = super::accept_main_from_panel(shell, instance, ticket) {
            panel.hide();
            open_at(shell, ticket);
        }
    });
}
pub fn published(shell: &Arc<Shell>, pid: u32, ticket: Head) {
    if !shell.host.native_panel || ticket.target != Target::Compact {
        return;
    }
    dispatch(shell.clone(), move |panel, shell| {
        let engine = shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|g| g.pid == pid);
        if engine
            && current(shell, ticket)
            && let Some(panel) = panel.at(ticket.revision).filter(|p| p.ticket == ticket && p.phase == Phase::Loading)
        {
            panel.present();
        }
    });
}

pub fn ready(shell: &Arc<Shell>, gui: Arc<Gui>, request: u64, instance: u64, handle: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        let engine =
            shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui));
        let Some(panel) = panel.at(request) else {
            return;
        };
        if shell.exiting() || !engine || head(shell).target != Target::Compact || head(shell).revision != request {
            return;
        }
        shell.hub_log.line(&format!("app: panel {request} painted (window {handle})"));
        if !native_window(handle, false) {
            return;
        }
        panel.handle = handle;
        panel.phase = Phase::Handoff;
        gui.publisher.defer(serde_json::json!({"type":"panel_reveal", "request":request, "instance":instance}));
    });
}
pub fn visible(shell: &Arc<Shell>, gui: Arc<Gui>, request: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        if !shell.exiting()
            && shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui))
            && head(shell).revision == request
            && head(shell).target == Target::Compact
            && let Some(panel) = panel.at(request)
        {
            panel.conceal();
            panel.phase = Phase::Browser;
            native_window(panel.handle, true);
        }
    });
}
pub fn closed(shell: &Arc<Shell>, gui: Arc<Gui>, request: u64, blur: bool, point: Option<(i32, i32)>) {
    if !shell.host.native_panel {
        if !shell.exiting()
            && shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui))
        {
            cancel(shell, request, blur, point);
        }
        return;
    }
    dispatch(shell.clone(), move |panel, shell| {
        if !shell.exiting()
            && shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|g| Arc::ptr_eq(g, &gui))
            && head(shell).revision == request
            && head(shell).target == Target::Compact
        {
            panel.dismiss(shell, request, blur);
        }
    });
}

pub fn failed(shell: &Arc<Shell>, request: u64) {
    dispatch(shell.clone(), move |panel, shell| {
        if let Some(panel) = panel.at(request).filter(|p| matches!(p.phase, Phase::Loading | Phase::Handoff)) {
            panel.spinner.stop();
            panel.label.set_text(native_text::text(shell.locale(), "desktop.windowFailed"));
        }
    });
}

// A tray popup is an unmanaged X11 surface, as a native menu is. Chromium's
// normal window mapping overwrites skip-taskbar hints and asks the WM to animate
// it. Configure before mapping, then focus it after the loader becomes transparent.
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
    dispatch(shell.clone(), move |loader, shell| {
        if shell.host.gui.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            return;
        }
        let Some(panel) = loader.panel.as_mut() else {
            return;
        };
        if success && panel.phase == Phase::Loading && current(shell, panel.ticket) && !panel.retried {
            // A click can reach the old process just as its idle exit starts.
            // Keep this same presentation and ticket for the fresh browser.
            panel.retried = true;
            open_at(shell, panel.ticket);
        } else if panel.phase == Phase::Browser {
            let request = panel.ticket.revision;
            loader.dismiss(shell, request, false);
        } else if matches!(panel.phase, Phase::Loading | Phase::Handoff) {
            panel.spinner.stop();
            panel.label.set_text(native_text::text(shell.locale(), "desktop.windowFailed"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wayland_menu_does_not_follow_an_old_x11_pointer_to_another_monitor() {
        let tray = Some((4200, 190));
        let pointer = Some((250, 330));
        assert_eq!(menu_anchor(true, tray, pointer), tray);
        assert_eq!(menu_anchor(true, None, pointer), None);
        assert_eq!(menu_anchor(false, tray, pointer), pointer);
    }

    #[test]
    fn the_first_menu_uses_the_reserved_edge_of_the_primary_monitor() {
        let bounds = gdk::Rectangle::new(1200, 171, 3440, 1440);
        let top = gdk::Rectangle::new(1200, 207, 3440, 1404);
        assert_eq!(fallback_anchor(bounds, top, 400, 368), (4639, 207));
        let bottom = gdk::Rectangle::new(1200, 171, 3440, 1404);
        assert_eq!(fallback_anchor(bounds, bottom, 400, 368), (4639, 1574));
        let left = gdk::Rectangle::new(1236, 171, 3404, 1440);
        assert_eq!(fallback_anchor(bounds, left, 400, 368), (1236, 1610));
        let right = gdk::Rectangle::new(1200, 171, 3404, 1440);
        assert_eq!(fallback_anchor(bounds, right, 400, 368), (4603, 1610));
        assert_eq!(fallback_anchor(bounds, bounds, 400, 368), (3120, 1075));
        let narrow = gdk::Rectangle::new(-300, 0, 300, 200);
        assert_eq!(fallback_anchor(narrow, narrow, 300, 160), (-1, 180));
    }
    #[test]
    #[ignore = "requires an isolated X11 display; run explicitly under Xvfb"]
    fn native_signals_keep_their_presentation_and_retired_widgets_are_released() {
        use glib::translate::{IntoGlib, ToGlibPtrMut};
        use std::{
            path::PathBuf,
            sync::{Condvar, Mutex},
        };
        assert!(init(), "this native regression requires X11");
        let root = std::env::temp_dir().join(format!("quotum-loader-test-{}", std::process::id()));
        let dirs = crate::files::Dirs { data: root.join("data"), logs: root.join("logs"), webview: None };
        dirs.ensure().unwrap();
        let lock = std::fs::File::create(dirs.app_lock()).unwrap();
        let shell = Arc::new(Shell::new(
            dirs,
            PathBuf::new(),
            PathBuf::new(),
            None,
            lock,
            super::super::Host {
                native_panel: true,
                resources: PathBuf::new(),
                electron: PathBuf::new(),
                software: false,
                inspector: None,
                gui: Mutex::default(),
                stopped: Condvar::new(),
                tray: Mutex::default(),
                panel_height: Mutex::new(180.0),
                foreground: Mutex::default(),
            },
        ));
        install(&shell);
        let baseline = gtk::Window::list_toplevels().len();
        let create = |ticket| {
            PANEL.with(|state| {
                let mut state = state.borrow_mut();
                let loader = state.as_mut().unwrap();
                let mut panel = Panel::new(&shell, &loader.css, ticket);
                panel.window.realize();
                panel.arm_timeout(&shell);
                loader.panel.replace(panel)
            })
        };
        let drain = || {
            let context = glib::MainContext::default();
            while context.pending() {
                context.iteration(false);
            }
        };
        let blur = gdk::Event::new(gdk::EventType::FocusChange);
        let first = accept(&shell, Role::Compact, None, false, None);
        create(first);
        let next = accept(&shell, Role::Compact, None, false, None);
        // Retain the previous native window only in this test, so its real GTK
        // signal is delivered after the new presentation has become current.
        let old = create(next).unwrap();
        let old_window = old.window.downgrade();
        old.window.emit_by_name::<bool>("focus-out-event", &[&blur]);
        dismiss_at(&shell, first.revision);
        drop(old);
        drain();
        assert_eq!(head(&shell), next, "old native callbacks must not cancel the new head");
        assert!(old_window.upgrade().is_none());
        assert_eq!(gtk::Window::list_toplevels().len(), baseline + 1);

        // A genuine current blur still cancels; no focus-delay or debounce guard.
        PANEL.with(|state| {
            state
                .borrow()
                .as_ref()
                .unwrap()
                .panel
                .as_ref()
                .unwrap()
                .window
                .emit_by_name::<bool>("focus-out-event", &[&blur])
        });
        drain();
        assert_eq!(head(&shell).target, Target::None);
        assert_eq!(gtk::Window::list_toplevels().len(), baseline);

        for _ in 0..4 {
            let ticket = accept(&shell, Role::Compact, None, false, None);
            create(ticket);
            let mut escape = gdk::Event::new(gdk::EventType::KeyPress);
            unsafe {
                let event: *mut gdk::ffi::GdkEvent = escape.to_glib_none_mut().0;
                (*event).key.keyval = gdk::keys::constants::Escape.into_glib();
            }
            PANEL.with(|state| {
                state
                    .borrow()
                    .as_ref()
                    .unwrap()
                    .panel
                    .as_ref()
                    .unwrap()
                    .window
                    .emit_by_name::<bool>("key-press-event", &[&escape])
            });
            drain();
            assert_eq!(head(&shell).target, Target::None);
            assert_eq!(gtk::Window::list_toplevels().len(), baseline, "no hidden loader widgets accumulate");
        }
        PANEL.with(|state| state.borrow_mut().take());
        drop(shell);
        std::fs::remove_dir_all(root).unwrap();
    }
}
