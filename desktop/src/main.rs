//! Quotum as a desktop app: the agent of this machine and the hub it delivers to, with the
//! hub's board in a window of its own. One copy runs per user; closing the window keeps it
//! measuring, and "Quit" (in the tray, the settings, or a page of the app) ends it all.

// No console window on Windows in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod autostart;
mod files;
#[cfg(target_os = "linux")]
mod graphics;
mod hub;
mod ipc;
mod settings;
mod shell;
mod smoke;
mod tray;
mod window;

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use tauri::{Manager, RunEvent};

use crate::files::Dirs;
use crate::shell::Shell;

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

/// `no_proxy` with 127.0.0.1 added: WebKitGTK outside GNOME takes a proxy from the
/// environment and would lead the window to the hub through it.
fn without_proxy_for_loopback(current: Option<String>) -> String {
    match current.filter(|v| !v.trim().is_empty()) {
        Some(list) if list.split(',').any(|host| host.trim() == "127.0.0.1") => list,
        Some(list) => format!("{list},127.0.0.1"),
        None => "127.0.0.1".into(),
    }
}

/// WebDriver needs WebKit's inspector transport. It is available only in an explicitly
/// isolated Linux debug run; release builds never retain a debugging listener.
fn qa_inspector(qa: Option<&str>, automation: Option<&str>, endpoint: Option<&str>, isolated: bool) -> bool {
    cfg!(all(debug_assertions, target_os = "linux"))
        && qa == Some("1")
        && automation == Some("true")
        && isolated
        && endpoint
            .and_then(|value| value.parse::<std::net::SocketAddr>().ok())
            .is_some_and(|address| address.ip().is_loopback())
}

fn main() {
    let args = Args::parse(std::env::args_os());
    let inspection = qa_inspector(
        std::env::var("QUOTUM_NATIVE_QA").ok().as_deref(),
        std::env::var("TAURI_WEBVIEW_AUTOMATION").ok().as_deref(),
        std::env::var("WEBKIT_INSPECTOR_SERVER").ok().as_deref(),
        ["QUOTUM_APP_DATA_DIR", "QUOTUM_STATE_DIR", "QUOTUM_CONFIG"]
            .iter()
            .all(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty())),
    );
    // SAFETY: the first thing the program does, before any thread exists.
    unsafe {
        #[cfg(target_os = "linux")]
        graphics::configure(args.software_rendering);
        // Debugging switches of the person's would open the window to other users of the
        // machine (a DevTools port, WebKit's inspector server).
        for name in ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBKIT_INSPECTOR_SERVER", "WEBKIT_INSPECTOR_HTTP_SERVER"]
        {
            if name != "WEBKIT_INSPECTOR_SERVER" || !inspection {
                std::env::remove_var(name);
            }
        }
        for name in ["no_proxy", "NO_PROXY"] {
            std::env::set_var(name, without_proxy_for_loopback(std::env::var(name).ok()));
        }
    }
    let smoke = args.smoke;

    let mut builder = tauri::Builder::default();
    if smoke.is_none() {
        // First: a second copy hands its arguments to this one and ends before anything else.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
                if let Some(shell) = app.try_state::<Arc<Shell>>() {
                    if !Args::parse(argv).hidden {
                        window::open(shell.inner());
                    }
                }
            }))
            .plugin(tauri_plugin_window_state::Builder::default().build());
    }
    let app = builder
        // Its JavaScript API is not given to any page: the app itself turns it on and off.
        .plugin(tauri_plugin_autostart::Builder::new().arg("--hidden").build())
        .invoke_handler(tauri::generate_handler![
            ipc::app_state,
            ipc::save_settings,
            ipc::take_over,
            ipc::set_autostart,
            ipc::reenter,
            ipc::quit
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let paths = app.path();
            let dirs = Dirs::new(paths.app_local_data_dir()?, paths.app_log_dir()?, smoke.is_some());
            dirs.ensure()?;
            // A second line behind single-instance, which is off without a session bus on Linux.
            let lock = match quotum_core::config::lock_file(&dirs.app_lock()) {
                Ok(lock) => lock,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::process::exit(0),
                Err(e) => return Err(format!("{}: {e}", dirs.app_lock().display()).into()),
            };
            let exe = std::env::current_exe()?;
            let node = exe.with_file_name(if cfg!(windows) { "quotum-node.exe" } else { "quotum-node" });
            let hub_dir: PathBuf = paths.resource_dir()?.join("hub");
            let _ = window::HUB_LOG.set(dirs.hub_log().display().to_string());
            let shell = Arc::new(Shell::new(dirs, node, hub_dir, smoke.map(smoke::Smoke::new), lock));
            shell.attach(handle.clone());
            app.manage(shell.clone());
            app.add_capability(ipc::own_capability())?;
            shell.hub_log.line(&format!(
                "app: Quotum {} ({}) starts",
                env!("CARGO_PKG_VERSION"),
                env!("QUOTUM_COMMIT")
            ));
            if shell.smoke.is_some() {
                smoke::Smoke::watch(&shell);
            }
            tray::create(&handle, &shell);
            let hub = shell.clone();
            thread::spawn(move || shell::run_hub(hub));
            let ticker = shell.clone();
            thread::spawn(move || shell::run_ticker(ticker));
            if !args.hidden {
                window::open(&shell);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("quotum: {e}");
            std::process::exit(1)
        });

    app.run(|app, event| match event {
        // The last window closed: the app keeps measuring. Unless it is quitting, or the
        // window asked whether to take over from `quotum`: closing it is the answer no.
        RunEvent::ExitRequested { code: None, api, .. } => {
            if let Some(shell) = app.try_state::<Arc<Shell>>().filter(|shell| !shell.exiting()) {
                api.prevent_exit();
                let state = shell.agent.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
                if agent::closing_quits(&state, shell.take_over_confirmed()) {
                    shell::quit(shell.inner());
                }
            }
        }
        // The event loop ends (also at the end of the system's session): quick, right here.
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell::shutdown(shell.inner(), true, true);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspector_is_only_for_explicit_isolated_linux_debug_automation() {
        assert_eq!(
            qa_inspector(Some("1"), Some("true"), Some("127.0.0.1:12345"), true),
            cfg!(all(debug_assertions, target_os = "linux")),
        );
        assert!(!qa_inspector(None, Some("true"), Some("127.0.0.1:12345"), true));
        assert!(!qa_inspector(Some("1"), None, Some("127.0.0.1:12345"), true));
        assert!(!qa_inspector(Some("1"), Some("true"), Some("127.0.0.1:12345"), false));
        assert!(!qa_inspector(Some("1"), Some("true"), Some("0.0.0.0:12345"), true));
        assert!(!qa_inspector(Some("1"), Some("true"), Some("example.com:12345"), true));
    }

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
