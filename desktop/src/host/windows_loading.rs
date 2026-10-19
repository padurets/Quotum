//! The tray thread can paint this native surface while WebView2 starts on the UI thread.
use crate::{native_text, shell::Shell};
use std::{
    cell::{Cell, RefCell},
    sync::Weak,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::*, Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
};

pub struct Panel {
    shell: Weak<Shell>,
    hwnd: Cell<HWND>,
    visible: Cell<bool>,
    font: Cell<HFONT>,
    text: RefCell<Vec<u16>>,
    started: Cell<Option<Instant>>,
    probe: bool,
    request_probe: std::rc::Rc<RequestOwner>,
    request: Cell<u64>,
}
const PHASE_PROPERTY: *const u16 = windows_sys::w!("Quotum.LoadingPhase");
// Each nibble names a nested operation; 1 is the idle surface. The smoke observer
// can read it without sending a message to the possibly blocked tray thread.
struct Phase {
    hwnd: HWND,
    previous: HANDLE,
    published: bool,
}
impl Phase {
    fn new(hwnd: HWND, stage: usize) -> Self {
        unsafe {
            let previous = GetPropW(hwnd, PHASE_PROPERTY);
            if previous as usize > 0xfffff {
                return Self { hwnd, previous, published: false };
            }
            let value = ((previous as usize) << 4) | stage;
            let published = SetPropW(hwnd, PHASE_PROPERTY, value as HANDLE) != 0;
            Self { hwnd, previous, published }
        }
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        if self.published {
            unsafe {
                SetPropW(self.hwnd, PHASE_PROPERTY, self.previous);
            }
        }
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
impl Panel {
    pub fn new(shell: Weak<Shell>, request_probe: std::rc::Rc<RequestOwner>) -> Self {
        Self {
            shell,
            hwnd: Cell::new(std::ptr::null_mut()),
            visible: Cell::new(false),
            font: Cell::new(std::ptr::null_mut()),
            text: RefCell::default(),
            started: Cell::new(None),
            probe: std::env::var("QUOTUM_WINDOW_PROBE").ok().as_deref() == Some("1"),
            request_probe,
            request: Cell::new(0),
        }
    }
    fn observed<R>(&self, hwnd: HWND, stage: usize, action: impl FnOnce() -> R) -> R {
        let _phase = self.probe.then(|| Phase::new(hwnd, stage));
        action()
    }
    pub fn show(&self, anchor: Option<RECT>) {
        let _phase = (self.probe && !self.hwnd.get().is_null()).then(|| Phase::new(self.hwnd.get(), 14));
        let Some(shell) = self.shell.upgrade().filter(|s| !s.exiting()) else {
            return;
        };
        let toggle = shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner());
        if !toggle.wanted() {
            return;
        }
        let request = toggle.revision();
        self.request.set(request);
        drop(toggle);
        self.request_probe.mark(6, request, 1, 0, 0, 0);
        unsafe {
            let mut hwnd = self.hwnd.get();
            if hwnd.is_null() {
                let class = wide("QuotumLoading");
                let module = GetModuleHandleW(std::ptr::null());
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(procedure),
                    hInstance: module,
                    lpszClassName: class.as_ptr(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    ..std::mem::zeroed()
                };
                RegisterClassW(&wc);
                hwnd = CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    class.as_ptr(),
                    wide("Quotum").as_ptr(),
                    WS_POPUP | WS_THICKFRAME,
                    0,
                    0,
                    400,
                    180,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    module,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    return;
                }
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, self as *const Self as isize);
                self.hwnd.set(hwnd);
                self.request_probe.bind_loader(hwnd);
                if self.probe {
                    SetPropW(hwnd, PHASE_PROPERTY, 1usize as HANDLE);
                }
                disable_transitions(hwnd);
            }
            let anchor = anchor.unwrap_or_else(|| {
                let mut p: POINT = std::mem::zeroed();
                GetCursorPos(&mut p);
                RECT { left: p.x, top: p.y, right: p.x, bottom: p.y }
            });
            let monitor = MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return;
            }
            let (mut dpi, mut other) = (96, 96);
            GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut other);
            let scale = f64::from(dpi.max(96)) / 96.0;
            let area = info.rcWork;
            let width = (400.0 * scale).round() as i32;
            let width = width.min(area.right - area.left);
            let height = (*shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner())).max(100.0);
            let height = ((height * scale).round() as i32).min((area.bottom - area.top) * 4 / 5);
            let mut frame = RECT { left: 0, top: 0, right: width, bottom: height };
            AdjustWindowRectExForDpi(
                &mut frame,
                WS_POPUP | WS_THICKFRAME,
                0,
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                dpi.max(96),
            );
            let width = (frame.right - frame.left).min(area.right - area.left);
            let height = (frame.bottom - frame.top).min(area.bottom - area.top);
            let x = (anchor.right - width).clamp(area.left, area.right - width);
            let y = if anchor.top - height >= area.top { anchor.top - height } else { anchor.bottom };
            let y = y.clamp(area.top, area.bottom - height);
            let font = CreateFontW(
                -(14.0 * scale).round() as i32,
                0,
                0,
                0,
                FW_NORMAL as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                0,
                0,
                CLEARTYPE_QUALITY as u32,
                0,
                wide("Segoe UI").as_ptr(),
            );
            let old = self.font.replace(font);
            if !old.is_null() {
                DeleteObject(old);
            }
            *self.text.borrow_mut() = wide(native_text::text(shell.locale(), "desktop.loading"));
            self.started.set(Some(Instant::now()));
            self.observed(hwnd, 2, || SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE));
            self.observed(hwnd, 3, || round(hwnd));
            if !crate::window::activate_loading(
                || {
                    self.request.get() == request
                        && !shell.exiting()
                        && shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).requested(request)
                },
                |operation| match operation {
                    crate::window::LoadingActivation::Show => {
                        self.visible.set(true);
                        self.request_probe.mark(6, request, 2, hwnd as u64, 0, 0);
                        self.observed(hwnd, 4, || ShowWindow(hwnd, SW_SHOW));
                        self.request_probe.mark(6, request, 3, hwnd as u64, 0, 0);
                    }
                    crate::window::LoadingActivation::Foreground => {
                        self.request_probe.mark(6, request, 4, hwnd as u64, 0, 0);
                        self.observed(hwnd, 5, || SetForegroundWindow(hwnd));
                        self.request_probe.mark(6, request, 5, hwnd as u64, 0, 0);
                    }
                    crate::window::LoadingActivation::Focus => {
                        self.request_probe.mark(6, request, 6, hwnd as u64, 0, 0);
                        self.observed(hwnd, 6, || SetFocus(hwnd));
                        self.request_probe.mark(6, request, 7, hwnd as u64, 0, 0);
                    }
                },
            ) {
                return;
            }
            self.observed(hwnd, 7, || SetTimer(hwnd, 1, 80, None));
            self.observed(hwnd, 8, || UpdateWindow(hwnd));
        }
    }
    pub fn hide(&self) {
        self.visible.set(false);
        let hwnd = self.hwnd.get();
        if !hwnd.is_null() {
            unsafe {
                KillTimer(hwnd, 1);
                self.request_probe.mark(6, self.request.get(), 8, hwnd as u64, 0, 0);
                self.observed(hwnd, 9, || ShowWindow(hwnd, SW_HIDE));
                self.request_probe.mark(6, self.request.get(), 9, hwnd as u64, 0, 0);
            }
        }
    }
    pub fn complete(&self, handle: u64) {
        let _phase = self.probe.then(|| Phase::new(self.hwnd.get(), 10));
        let Some(shell) = self.shell.upgrade().filter(|s| !s.exiting()) else {
            return;
        };
        if shell.host.panel_ready.load(std::sync::atomic::Ordering::SeqCst) != handle
            || !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted()
        {
            return;
        }
        let hwnd = handle as HWND;
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return;
            }
            self.hide();
        }
    }
    fn dismiss(&self, blur: bool) {
        let request = self.request.get();
        let _phase = self.probe.then(|| Phase::new(self.hwnd.get(), 11));
        self.request_probe.mark(6, request, 10, self.hwnd.get() as u64, usize::from(blur), 0);
        if let Some(shell) = self.shell.upgrade() {
            crate::tauri_window::dismiss_panel(&shell, request, blur);
        }
        self.request_probe.mark(6, request, 11, self.hwnd.get() as u64, usize::from(blur), 0);
        if self.request.get() == request {
            self.hide();
        }
    }
    unsafe fn paint(&self, hwnd: HWND) {
        let _phase = self.probe.then(|| Phase::new(hwnd, 12));
        unsafe {
            let mut paint: PAINTSTRUCT = std::mem::zeroed();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut rect: RECT = std::mem::zeroed();
            GetClientRect(hwnd, &mut rect);
            let bg = CreateSolidBrush(native_text::native_colour("bg"));
            FillRect(dc, &rect, bg);
            DeleteObject(bg);
            let old_font = SelectObject(dc, self.font.get());
            SetBkMode(dc, TRANSPARENT as i32);
            SetTextColor(dc, native_text::native_colour("text"));
            let text = self.text.borrow().clone();
            let mut size: SIZE = std::mem::zeroed();
            GetTextExtentPoint32W(dc, text.as_ptr(), (text.len() - 1) as i32, &mut size);
            let scale = f64::from(GetDpiForWindow(hwnd).max(96)) / 96.0;
            let diameter = (20.0 * scale).round() as i32;
            let gap = (12.0 * scale).round() as i32;
            let left = (rect.right - size.cx - diameter - gap) / 2;
            let top = (rect.bottom - diameter) / 2;
            TextOutW(dc, left + diameter + gap, (rect.bottom - size.cy) / 2, text.as_ptr(), (text.len() - 1) as i32);
            let pen = CreatePen(PS_SOLID, (2.0 * scale).round() as i32, native_text::native_colour("text"));
            let old_pen = SelectObject(dc, pen);
            let angle = self.started.get().map(|at| at.elapsed().as_secs_f64() * 5.0).unwrap_or_default();
            let center_x = left + diameter / 2;
            let center_y = top + diameter / 2;
            let radius = f64::from(diameter) / 2.0;
            Arc(
                dc,
                left,
                top,
                left + diameter,
                top + diameter,
                center_x + (radius * angle.cos()) as i32,
                center_y + (radius * angle.sin()) as i32,
                center_x + (radius * (angle + 4.5).cos()) as i32,
                center_y + (radius * (angle + 4.5).sin()) as i32,
            );
            SelectObject(dc, old_pen);
            DeleteObject(pen);
            SelectObject(dc, old_font);
            EndPaint(hwnd, &paint);
        }
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        self.hide();
        unsafe {
            let hwnd = self.hwnd.get();
            if !hwnd.is_null() {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                if self.probe {
                    RemovePropW(hwnd, PHASE_PROPERTY);
                }
                self.request_probe.bind_loader(std::ptr::null_mut());
                DestroyWindow(hwnd);
            }
            let font = self.font.get();
            if !font.is_null() {
                DeleteObject(font);
            }
        }
    }
}
unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Panel;
    if ptr.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, w, l) };
    }
    let panel = unsafe { &*ptr };
    match message {
        WM_NCDESTROY => {
            if panel.probe {
                unsafe { RemovePropW(hwnd, PHASE_PROPERTY) };
            }
            unsafe { DefWindowProcW(hwnd, message, w, l) }
        }
        WM_PAINT => {
            unsafe { panel.paint(hwnd) };
            0
        }
        WM_ERASEBKGND => 1,
        WM_TIMER => {
            if panel.visible.get() {
                if panel.started.get().is_some_and(|at| at.elapsed().as_secs() >= 15) {
                    if let Some(shell) = panel.shell.upgrade() {
                        *panel.text.borrow_mut() = wide(native_text::text(shell.locale(), "desktop.windowFailed"));
                    }
                    unsafe {
                        KillTimer(hwnd, 1);
                    }
                }
                unsafe {
                    InvalidateRect(hwnd, std::ptr::null(), 0);
                }
            }
            0
        }
        WM_KEYDOWN if w == 27 => {
            panel.dismiss(false);
            0
        }
        WM_CLOSE => {
            panel.dismiss(false);
            0
        }
        WM_ACTIVATE if w & 0xffff == WA_INACTIVE as usize => {
            let _phase = panel.probe.then(|| Phase::new(hwnd, 13));
            let visible = panel.visible.get();
            let mut activation = panel.request_probe.activation(panel.request.get(), hwnd, w, l, visible);
            if visible {
                let handoff = panel.shell.upgrade().is_some_and(|s| {
                    let ready = s.host.panel_ready.load(std::sync::atomic::Ordering::SeqCst);
                    activation.ready(ready);
                    ready != 0
                        && unsafe {
                            let foreground = GetForegroundWindow() as u64;
                            activation.foreground(foreground);
                            foreground == ready
                        }
                });
                activation.decision(handoff);
                panel.request_probe.publish(hwnd, 5);
                if handoff {
                    panel.hide();
                } else {
                    panel.dismiss(true);
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, w, l) },
    }
}

/// The two native windows form one popup. DWM must not animate their show/hide handoff.
pub fn disable_transitions(hwnd: HWND) {
    let disabled: i32 = 1;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            (&disabled as *const i32).cast(),
            std::mem::size_of_val(&disabled) as u32,
        );
    }
}

/// Clip to the rounded client area, including on Windows versions/VMs where DWM does not round it.
pub fn round(hwnd: HWND) {
    unsafe {
        let mut client: RECT = std::mem::zeroed();
        let mut outer: RECT = std::mem::zeroed();
        let mut origin = POINT { x: 0, y: 0 };
        if GetClientRect(hwnd, &mut client) == 0
            || GetWindowRect(hwnd, &mut outer) == 0
            || ClientToScreen(hwnd, &mut origin) == 0
        {
            return;
        }
        let x = origin.x - outer.left;
        let y = origin.y - outer.top;
        let diameter =
            (2.0 * native_text::popup_radius() * f64::from(GetDpiForWindow(hwnd).max(96)) / 96.0).round() as i32;
        let next = CreateRoundRectRgn(x, y, x + client.right + 1, y + client.bottom + 1, diameter, diameter);
        if next.is_null() {
            return;
        }
        let old = CreateRectRgn(0, 0, 0, 0);
        let same = GetWindowRgn(hwnd, old) != 0 && EqualRgn(old, next) != 0;
        DeleteObject(old);
        if same || SetWindowRgn(hwnd, next, 1) == 0 {
            DeleteObject(next);
        }
    }
}

pub fn request_thread(records: &crate::windows_request::Records) -> u32 {
    if records.enabled { unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() } } else { 0 }
}
struct RequestProperties {
    hwnd: HWND,
}
fn request_key(row: usize, field: usize) -> [u16; 24] {
    let mut key = [0; 24];
    for (to, from) in key.iter_mut().zip(b"Quotum.Request.") {
        *to = u16::from(*from);
    }
    key[15] = u16::from(b'0') + (row / 10) as u16;
    key[16] = u16::from(b'0') + (row % 10) as u16;
    key[17] = u16::from(b'.');
    key[18] = u16::from(b'0') + (field / 10) as u16;
    key[19] = u16::from(b'0') + (field % 10) as u16;
    key
}
impl crate::windows_request::Properties for RequestProperties {
    fn set(&self, row: usize, field: usize, value: u64) -> bool {
        let key = request_key(row, field);
        unsafe { SetPropW(self.hwnd, key.as_ptr(), value as HANDLE) != 0 }
    }
    fn remove(&self, row: usize, field: usize) {
        let key = request_key(row, field);
        unsafe {
            RemovePropW(self.hwnd, key.as_ptr());
        }
    }
}
// Rc and the publisher's owner capability stay in Context/Panel on the tray
// thread. Arc<Shell> exposes only Records, so a worker cannot write HWND props.
pub struct RequestOwner {
    pub records: std::sync::Arc<crate::windows_request::Records>,
    publisher: crate::windows_request::NativePublisher<RequestProperties>,
    control: HWND,
}
impl RequestOwner {
    pub fn new(control: HWND, records: std::sync::Arc<crate::windows_request::Records>) -> Self {
        let thread = request_thread(&records);
        Self {
            publisher: crate::windows_request::NativePublisher::new(
                RequestProperties { hwnd: control },
                control as u64,
                thread,
                1,
            ),
            records,
            control,
        }
    }
    pub fn bind_loader(&self, hwnd: HWND) {
        self.publisher.bind_loader(hwnd as u64);
    }
    pub fn close(&self) {
        if self.records.enabled {
            self.publisher.close();
        }
    }
    pub fn publish(&self, source: HWND, event: u64) {
        if !self.records.enabled {
            return;
        }
        if let Some(owner) = self.publisher.owner(request_thread(&self.records), source as u64) {
            owner.publish(&self.records, event);
        }
    }
    pub fn mark(&self, lane: usize, request: u64, stage: u64, subject: u64, detail: usize, value: usize) {
        self.records.mark(lane, request, request_thread(&self.records), stage, subject, [detail as u64, value as u64]);
        // A natural owner snapshot precedes an existing native operation. Later
        // worker updates stay in memory until another natural owner callback.
        if matches!(stage, 1 | 2 | 4 | 6 | 8 | 10) {
            let source = if subject == 0 { self.control } else { subject as HWND };
            self.publish(source, 3);
        }
    }
    pub fn activation(
        &self,
        request: u64,
        hwnd: HWND,
        w: WPARAM,
        l: LPARAM,
        visible: bool,
    ) -> crate::windows_request::Activation<'_> {
        let activation =
            self.records.activation(request, request_thread(&self.records), hwnd as u64, w as u64, l as u64, visible);
        self.publish(hwnd, 4);
        activation
    }
}
