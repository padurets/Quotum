//! The native host on Windows. The controller has no Tauri dependency.
use crate::{
    Args, agent,
    files::Dirs,
    shell::{self, Shell},
    smoke, tauri_ipc, tray, window,
};
use std::{io, path::PathBuf, sync::Arc, thread};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt;
pub struct Host {
    pub app: AppHandle,
}
pub fn run(args: Args) {
    // No inherited debugging listeners in a packaged application.
    unsafe {
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
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
            tauri_ipc::app_state,
            tauri_ipc::save_settings,
            tauri_ipc::take_over,
            tauri_ipc::set_autostart,
            tauri_ipc::reenter,
            tauri_ipc::quit
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
            let shell = Arc::new(Shell::new(
                dirs,
                node,
                hub_dir,
                smoke.map(smoke::Smoke::new),
                lock,
                Host { app: handle.clone() },
            ));
            app.manage(shell.clone());
            app.add_capability(tauri_ipc::own_capability())?;
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

pub fn grant_port(shell: &Shell, port: u16) {
    if let Err(e) = shell.host.app.add_capability(tauri_ipc::hub_capability(port)) {
        shell.hub_log.line(&format!("app: the board on port {port} gets no commands: {e}"));
    }
}
pub fn exit(shell: &Arc<Shell>, from_exit_event: bool) {
    for (_, window) in shell.host.app.webview_windows() {
        let _ = window.destroy();
    }
    if !from_exit_event {
        shell.host.app.exit(0);
    }
}
pub fn autostart_enabled(shell: &Shell) -> bool {
    shell.host.app.autolaunch().is_enabled().unwrap_or(false)
}
pub fn set_autostart(shell: &Shell, on: bool) -> Result<(), String> {
    let launch = shell.host.app.autolaunch();
    (if on { launch.enable() } else { launch.disable() }).map_err(|e| e.to_string())
}
pub use crate::tauri_window::{close, follow, is_open, leave, open, reenter};
