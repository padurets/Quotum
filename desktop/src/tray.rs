//! One Shell icon owns Windows activation, menus and notification delivery, including portable builds.
pub use crate::tray_queue::Command;
use crate::tray_queue::Commands;
use crate::{
    attention::Status,
    shell::{self, Shell},
    window,
};
use std::cell::{Cell, RefCell};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicIsize, Ordering},
};
use windows_sys::Win32::{
    Foundation::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{Shell::*, WindowsAndMessaging::*},
};

const COMMAND: u32 = WM_APP + 1;
const CALLBACK: u32 = WM_APP + 2;
const ID: u32 = 1;
// The SDK defines this as a macro, which windows-sys does not export.
const NIN_KEYSELECT: u32 = NIN_SELECT | NINF_KEY;

pub struct Handle {
    queue: Arc<Mutex<Commands>>,
    hwnd: Arc<AtomicIsize>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Handle {
    pub fn stop(mut self) {
        let hwnd = self.hwnd.load(Ordering::SeqCst) as HWND;
        if !hwnd.is_null() {
            unsafe {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    pub fn rect(&self) -> Option<RECT> {
        let hwnd = self.hwnd.load(Ordering::SeqCst) as HWND;
        if hwnd.is_null() {
            return None;
        }
        icon_rect(hwnd)
    }

    pub fn send(&self, command: Command) {
        let wake = self.queue.lock().unwrap_or_else(|e| e.into_inner()).push(command);
        if wake {
            let hwnd = self.hwnd.load(Ordering::SeqCst) as HWND;
            if !hwnd.is_null() {
                unsafe {
                    PostMessageW(hwnd, COMMAND, 0, 0);
                }
            }
        }
    }
}
fn icon_rect(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let mut identifier: NOTIFYICONIDENTIFIER = std::mem::zeroed();
        identifier.cbSize = std::mem::size_of::<NOTIFYICONIDENTIFIER>() as u32;
        identifier.hWnd = hwnd;
        identifier.uID = ID;
        let mut rect = std::mem::zeroed();
        (Shell_NotifyIconGetRect(&identifier, &mut rect) >= 0).then_some(rect)
    }
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
pub fn cursor_position() -> Option<(i32, i32)> {
    let mut point: POINT = unsafe { std::mem::zeroed() };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}
fn copy_wide<const N: usize>(to: &mut [u16; N], text: &str) {
    let units: Vec<_> =
        text.chars().filter(|c| !c.is_control() || *c == '\n').collect::<String>().encode_utf16().collect();
    let mut n = units.len().min(N - 1);
    if n > 0 && (0xD800..=0xDBFF).contains(&units[n - 1]) {
        n -= 1;
    }
    to.fill(0);
    to[..n].copy_from_slice(&units[..n]);
}
struct Context {
    shell: Weak<Shell>,
    queue: Arc<Mutex<Commands>>,
    icon: Cell<HICON>,
    status: RefCell<Status>,
    restart: u32,
    loading: crate::windows_loading::Panel,
}

pub fn create(_: &tauri::AppHandle, shell: &Arc<Shell>) {
    let queue = Arc::new(Mutex::new(Commands::default()));
    let receive = queue.clone();
    let hwnd = Arc::new(AtomicIsize::new(0));
    let control = hwnd.clone();
    let weak = Arc::downgrade(shell);
    let worker = std::thread::spawn(move || unsafe {
        let name = wide("QuotumTray");
        let instance = GetModuleHandleW(std::ptr::null());
        let class = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: name.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&class);
        let control = CreateWindowExW(
            0,
            name.as_ptr(),
            name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if control.is_null() {
            if let Some(shell) = weak.upgrade() {
                shell.hub_log.line("app: no Windows tray control window");
            }
            return;
        }
        let status = weak.upgrade().map(|s| s.attention.status()).unwrap_or_default();
        let context = Box::new(Context {
            loading: crate::windows_loading::Panel::new(weak.clone()),
            shell: weak,
            queue: receive,
            icon: Cell::new(std::ptr::null_mut()),
            status: RefCell::new(status),
            restart: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
        });
        SetWindowLongPtrW(control, GWLP_USERDATA, (&*context as *const Context) as isize);
        hwnd.store(control as isize, Ordering::SeqCst);
        if context.shell.upgrade().is_none_or(|s| s.exiting()) {
            DestroyWindow(control);
            hwnd.store(0, Ordering::SeqCst);
            return;
        }
        update(control, &context, true);
        PostMessageW(control, COMMAND, 0, 0);
        let mut message: MSG = std::mem::zeroed();
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        hwnd.store(0, Ordering::SeqCst);
        let data = identity(control);
        Shell_NotifyIconW(NIM_DELETE, &data);
        if !context.icon.get().is_null() {
            DestroyIcon(context.icon.get());
        }
        SetWindowLongPtrW(control, GWLP_USERDATA, 0);
        DestroyWindow(control);
        UnregisterClassW(name.as_ptr(), instance);
    });
    *shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Handle { queue, hwnd: control, worker: Some(worker) });
}
unsafe fn identity(hwnd: HWND) -> NOTIFYICONDATAW {
    let mut data: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    data.hWnd = hwnd;
    data.uID = ID;
    data
}
unsafe fn update(hwnd: HWND, context: &Context, add: bool) {
    let Some(shell) = context.shell.upgrade() else {
        return;
    };
    // Shell calls can dispatch another window message. No mutable borrow survives them.
    let status = context.status.borrow().clone();
    let file = shell.hub_dir.parent().unwrap().join("tray").join(format!("{}.ico", status.icon()));
    let icon = unsafe {
        LoadImageW(
            std::ptr::null_mut(),
            wide(&file.to_string_lossy()).as_ptr(),
            IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
            LR_LOADFROMFILE,
        )
    } as HICON;
    let mut data = unsafe { identity(hwnd) };
    data.uFlags = NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = CALLBACK;
    if !icon.is_null() {
        data.uFlags |= NIF_ICON;
        data.hIcon = icon;
    }
    copy_wide(&mut data.szTip, &crate::native_text::tooltip(shell.locale(), &status));
    unsafe {
        Shell_NotifyIconW(if add { NIM_ADD } else { NIM_MODIFY }, &data);
        if add {
            data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIconW(NIM_SETVERSION, &data);
        }
        if !icon.is_null() {
            let old = context.icon.replace(icon);
            if !old.is_null() {
                DestroyIcon(old);
            }
        }
    }
}
unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let pointer = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Context;
    if pointer.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, w, l) };
    }
    let context = unsafe { &*pointer };
    if message == context.restart {
        unsafe {
            update(hwnd, context, true);
        }
        return 0;
    }
    match message {
        COMMAND => {
            loop {
                let command = context.queue.lock().unwrap_or_else(|e| e.into_inner()).pop();
                let Some(command) = command else { break };
                match command {
                    Command::Loading(true) => context.loading.show(icon_rect(hwnd)),
                    Command::Loading(false) => context.loading.hide(),
                    Command::PanelReady(handle) => context.loading.present(handle),
                    Command::Status(status) => {
                        *context.status.borrow_mut() = status;
                        unsafe {
                            update(hwnd, context, false);
                        }
                    }
                    Command::Notify(intent) => {
                        if let Some(shell) = context.shell.upgrade() {
                            crate::attention::delivery::attempt(&shell, *intent, |title, body| unsafe {
                                let mut data = identity(hwnd);
                                data.uFlags = NIF_INFO | NIF_REALTIME;
                                data.dwInfoFlags = NIIF_NOSOUND | NIIF_RESPECT_QUIET_TIME;
                                copy_wide(&mut data.szInfoTitle, &title);
                                copy_wide(&mut data.szInfo, &body);
                                Shell_NotifyIconW(NIM_MODIFY, &data) != 0
                            });
                        }
                    }
                }
            }
            0
        }
        WM_CLOSE => {
            unsafe {
                PostQuitMessage(0);
            }
            0
        }
        WM_POWERBROADCAST => {
            if let Some(shell) = context.shell.upgrade() {
                shell.attention.gate.invalidate();
            }
            1
        }
        CALLBACK => {
            if let Some(shell) = context.shell.upgrade() {
                match (l as u32) & 0xffff {
                    NIN_BALLOONUSERCLICK => window::open(&shell, "a notification"),
                    NIN_SELECT => crate::host::toggle_panel(&shell, cursor_position()),
                    NIN_KEYSELECT => crate::host::toggle_panel(&shell, None),
                    WM_CONTEXTMENU => unsafe {
                        let menu = CreatePopupMenu();
                        AppendMenuW(
                            menu,
                            MF_STRING,
                            3,
                            wide(crate::native_text::text(shell.locale(), "desktop.limits")).as_ptr(),
                        );
                        AppendMenuW(
                            menu,
                            MF_STRING,
                            1,
                            wide(crate::native_text::text(shell.locale(), "desktop.open")).as_ptr(),
                        );
                        AppendMenuW(
                            menu,
                            MF_STRING,
                            2,
                            wide(crate::native_text::text(shell.locale(), "desktop.quit")).as_ptr(),
                        );
                        let mut point: POINT = std::mem::zeroed();
                        GetCursorPos(&mut point);
                        SetForegroundWindow(hwnd);
                        let choice = TrackPopupMenu(
                            menu,
                            TPM_RETURNCMD | TPM_RIGHTBUTTON,
                            point.x,
                            point.y,
                            0,
                            hwnd,
                            std::ptr::null(),
                        );
                        DestroyMenu(menu);
                        if choice == 3 {
                            crate::host::open_panel(&shell);
                        }
                        if choice == 1 {
                            window::open(&shell, "the tray");
                        }
                        if choice == 2 {
                            shell::quit(&shell);
                        }
                    },
                    _ => {}
                }
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, w, l) },
    }
}

pub fn loading(shell: &Shell, show: bool) {
    if let Some(tray) = shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        tray.send(Command::Loading(show));
    }
}
pub fn present_panel(shell: &Shell, handle: u64) {
    if let Some(tray) = shell.host.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        tray.send(Command::PanelReady(handle));
    }
}
