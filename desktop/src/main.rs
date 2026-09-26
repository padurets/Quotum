//! The machine controller is independent of the window engine.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod agent;
mod autostart;
mod files;
#[cfg(target_os = "linux")]
#[path = "host/linux.rs"]
mod host;
#[cfg(not(target_os = "linux"))]
#[path = "host/tauri.rs"]
mod host;
mod hub;
mod ipc;
mod settings;
mod shell;
mod smoke;
#[cfg(not(target_os = "linux"))]
#[path = "host/tauri_ipc.rs"]
mod tauri_ipc;
#[cfg(not(target_os = "linux"))]
#[path = "host/tauri_window.rs"]
mod tauri_window;
#[cfg(not(target_os = "linux"))]
mod tray;
mod window;
use std::ffi::OsString;

/// What the app was started with. Looked for anywhere among the arguments: the command of
/// start at login is not quoted on Windows, so a space in the user's name splits it.
#[derive(Debug, Default, PartialEq)]
struct Args {
    /// Started at login: no window until asked for.
    hidden: bool,
    software_rendering: bool,
    smoke: Option<smoke::Mode>,
}

impl Args {
    fn parse(args: impl IntoIterator<Item = impl Into<OsString>>) -> Args {
        let mut parsed = Args::default();
        for arg in args.into_iter().skip(1) {
            match arg.into().to_str() {
                Some("--hidden") => parsed.hidden = true,
                Some("--software-rendering") => parsed.software_rendering = true,
                Some("--smoke") => parsed.smoke = Some(smoke::Mode::Normal),
                Some("--smoke=crash") => parsed.smoke = Some(smoke::Mode::Crash),
                _ => {}
            }
        }
        parsed
    }
}

/// The private hub must remain local even when the login environment defines a proxy.
fn without_proxy_for_loopback(current: Option<String>) -> String {
    match current.filter(|v| !v.trim().is_empty()) {
        Some(list) if list.split(',').any(|host| host.trim() == "127.0.0.1") => list,
        Some(list) => format!("{list},127.0.0.1"),
        None => "127.0.0.1".into(),
    }
}

fn main() {
    // Before any worker is started.
    unsafe {
        for name in ["no_proxy", "NO_PROXY"] {
            std::env::set_var(name, without_proxy_for_loopback(std::env::var(name).ok()));
        }
    }
    host::run(Args::parse(std::env::args_os()));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arguments_are_found_wherever_they_are() {
        assert_eq!(Args::parse(["quotum-desktop"]), Args::default());
        let split = Args::parse(["C:\\Users\\Ann", "Lee\\AppData\\Local\\Quotum\\quotum-desktop.exe", "--hidden"]);
        assert!(split.hidden, "a path split at a space");
        assert_eq!(Args::parse(["q", "--smoke"]).smoke, Some(smoke::Mode::Normal));
        assert_eq!(Args::parse(["q", "--smoke=crash"]).smoke, Some(smoke::Mode::Crash));
        assert!(Args::parse(["q", "--software-rendering"]).software_rendering);
    }

    #[test]
    fn loopback_is_added_to_no_proxy_once() {
        assert_eq!(without_proxy_for_loopback(None), "127.0.0.1");
        assert_eq!(without_proxy_for_loopback(Some("corp.example".into())), "corp.example,127.0.0.1");
        assert_eq!(without_proxy_for_loopback(Some("127.0.0.1, x".into())), "127.0.0.1, x");
    }
}
