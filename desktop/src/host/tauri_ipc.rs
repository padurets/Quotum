//! Tauri capabilities and command transport; execution belongs to the controller.
use crate::{
    ipc::{self, COMMANDS, Request},
    settings::Patch,
    shell::Shell,
    window::LABEL,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{CapabilityBuilder, Channel};
use tauri::{Manager, State, Webview};
fn allow(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

/// The board served on `port`: not the app's own pages, only that origin.
pub fn hub_capability(port: u16) -> CapabilityBuilder {
    COMMANDS.iter().fold(
        CapabilityBuilder::new(format!("hub-{port}"))
            .local(false)
            .window(LABEL)
            .remote(format!("http://127.0.0.1:{port}/*")),
        |capability, command| capability.permission(allow(command)),
    )
}

/// The app's own pages: they can only quit.
pub fn own_capability() -> CapabilityBuilder {
    CapabilityBuilder::new("own").window(LABEL).permission(allow("quit"))
}

fn execute(webview: Webview, shell: State<'_, Arc<Shell>>, request: Request) -> Result<Value, String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    ipc::execute(&shell, &url, request)
}
#[tauri::command(async)]
pub fn app_state(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::AppState)
}
#[tauri::command(async)]
pub fn save_settings(webview: Webview, shell: State<'_, Arc<Shell>>, patch: Patch) -> Result<Value, String> {
    execute(webview, shell, Request::SaveSettings { patch })
}
#[tauri::command(async)]
pub fn take_over(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::TakeOver)
}
#[tauri::command(async)]
pub fn set_autostart(webview: Webview, shell: State<'_, Arc<Shell>>, on: bool) -> Result<Value, String> {
    execute(webview, shell, Request::SetAutostart { on })
}
#[tauri::command(async)]
pub fn reenter(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::Reenter)
}
#[tauri::command(async)]
pub fn quit(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::Quit)
}

/// The board hears the app's state from now on, the current one first: the app sends it
/// whenever it changes, instead of being asked every few seconds. A board loaded again
/// watches anew, in place of the one before.
#[tauri::command(async)]
pub fn watch_state(webview: Webview, shell: State<'_, Arc<Shell>>, channel: Channel<Value>) -> Result<(), String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    if !ipc::is_board(&shell, &url) {
        return Err("not the board of the running hub".into());
    }
    let mut sent = false;
    ipc::watch(&shell, |state| {
        let mut watching = shell.host.watching.lock().unwrap_or_else(|e| e.into_inner());
        sent = channel.send(state.clone()).is_ok();
        *watching = sent.then(|| channel.clone());
    });
    if !sent {
        return Err("the board's channel is closed".into());
    }
    if let Some(smoke) = &shell.smoke {
        smoke.watched(&shell);
    }
    Ok(())
}

/// The app's state, to the board watching it while the window shows the board of the
/// running hub (checked as it goes); a board gone elsewhere hears nothing more.
pub fn push_state(shell: &Shell, state: &Value) {
    let mut watching = shell.host.watching.lock().unwrap_or_else(|e| e.into_inner());
    let Some(channel) = watching.as_ref() else { return };
    let url = shell.host.app.get_webview_window(LABEL).and_then(|window| window.url().ok());
    if !url.is_some_and(|url| ipc::is_board(shell, &url)) || channel.send(state.clone()).is_err() {
        watching.take();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::capability::{Capability, CapabilityFile};

    fn built(capability: CapabilityBuilder) -> Capability {
        match capability.build() {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("one capability"),
        }
    }

    #[test]
    fn the_board_gets_the_seven_commands_and_the_apps_own_pages_only_quit() {
        let hub = built(hub_capability(23456));
        assert!(!hub.local, "not the app's own pages");
        let urls = &hub.remote.as_ref().unwrap().urls;
        assert_eq!(urls, &["http://127.0.0.1:23456/*"]);
        assert_eq!(hub.windows, ["main"]);
        assert_eq!(hub.permissions.len(), 7);
        assert!(hub.permissions.iter().any(|p| p.identifier().get() == "allow-watch-state"));
        let own = built(own_capability());
        assert!(own.local && own.remote.is_none());
        assert_eq!(own.permissions.len(), 1);
        assert_eq!(allow("save_settings"), "allow-save-settings");
    }
}
