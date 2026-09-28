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
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
impl Panel {
    pub fn new(shell: Weak<Shell>) -> Self {
        Self {
            shell,
            hwnd: Cell::new(std::ptr::null_mut()),
            visible: Cell::new(false),
            font: Cell::new(std::ptr::null_mut()),
            text: RefCell::default(),
            started: Cell::new(None),
        }
    }
    pub fn show(&self, anchor: Option<RECT>) {
        let Some(shell) = self.shell.upgrade().filter(|s| !s.exiting()) else {
            return;
        };
        if !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
            return;
        }
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
            let height = (*shell.host.panel_height.lock().unwrap_or_else(|e| e.into_inner())).clamp(100.0, 600.0);
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
            self.visible.set(true);
            SetWindowPos(hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
            round(hwnd);
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            SetFocus(hwnd);
            SetTimer(hwnd, 1, 80, None);
            UpdateWindow(hwnd);
        }
    }
    pub fn hide(&self) {
        self.visible.set(false);
        let hwnd = self.hwnd.get();
        if !hwnd.is_null() {
            unsafe {
                KillTimer(hwnd, 1);
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
    pub fn present(&self, handle: u64) {
        let Some(shell) = self.shell.upgrade().filter(|s| !s.exiting()) else {
            return;
        };
        if !shell.host.panel_toggle.lock().unwrap_or_else(|e| e.into_inner()).wanted() {
            return;
        }
        let hwnd = handle as HWND;
        unsafe {
            if IsWindow(hwnd) == 0 {
                return;
            }
            // Mark the handoff before activation sends a blur to the loader.
            self.visible.set(false);
            ShowWindow(hwnd, SW_SHOW);
            SetForegroundWindow(hwnd);
            self.hide();
        }
    }
    fn dismiss(&self, blur: bool) {
        self.hide();
        if let Some(shell) = self.shell.upgrade() {
            crate::tauri_window::dismiss_panel(&shell, blur);
        }
    }
    unsafe fn paint(&self, hwnd: HWND) {
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
            if panel.visible.get() {
                panel.dismiss(true);
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
