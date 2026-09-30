//! Tauri capabilities and command transport; execution belongs to the controller.
use crate::{
    ipc::{self, COMMANDS, Request},
    settings::Patch,
    shell::Shell,
    window::{LABEL, Role},
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
    CapabilityBuilder::new("own").window(LABEL).window("compact").permission(allow("quit"))
}

fn execute(webview: Webview, shell: State<'_, Arc<Shell>>, request: Request) -> Result<Value, String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    let (role, instance) = caller(&webview, &shell)?;
    ipc::execute(&shell, &url, role, instance, request)
}
fn caller(webview: &Webview, shell: &Shell) -> Result<(Role, u64), String> {
    let role = match webview.label() {
        "main" => Role::Main,
        "compact" => Role::Compact,
        _ => return Err("unknown window".into()),
    };
    let instance = webview.window().hwnd().map_err(|_| "closed window")?.0 as u64;
    let current = shell.host.app.get_webview_window(role.label()).ok_or("closed window")?;
    if current.hwnd().map_err(|_| "closed window")?.0 as u64 != instance {
        return Err("stale window".into());
    }
    Ok((role, instance))
}
pub fn panel_capability(port: u16) -> CapabilityBuilder {
    ["app_state", "watch_state", "reenter", "open_main", "close_panel", "report_panel_height"].iter().fold(
        CapabilityBuilder::new(format!("compact-{port}"))
            .local(false)
            .window("compact")
            .remote(format!("http://127.0.0.1:{port}/*")),
        |capability, command| capability.permission(allow(command)),
    )
}
#[tauri::command(async)]
pub fn open_main(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::OpenMain)
}
#[tauri::command(async)]
pub fn close_panel(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::ClosePanel)
}
#[tauri::command(async)]
pub fn report_panel_height(
    webview: Webview,
    shell: State<'_, Arc<Shell>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Height {
        height_css_px: f64,
    }
    let tauri::ipc::InvokeBody::Json(value) = request.body() else {
        return Err("invalid panel height".into());
    };
    let height: Height = serde_json::from_value(value.clone()).map_err(|_| "invalid panel height")?;
    execute(webview, shell, Request::ReportPanelHeight { height_css_px: height.height_css_px })
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
pub fn save_desktop_settings(
    webview: Webview,
    shell: State<'_, Arc<Shell>>,
    patch: crate::desktop_settings::Patch,
) -> Result<Value, String> {
    execute(webview, shell, Request::SaveDesktopSettings { patch })
}
#[tauri::command(async)]
pub fn take_over(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<Value, String> {
    execute(webview, shell, Request::TakeOver)
}
#[tauri::command(async)]
pub fn reset_secret_key(
    webview: Webview,
    shell: State<'_, Arc<Shell>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Json(Value::Object(fields)) if fields.is_empty() => {}
        _ => return Err("secret_key_reset_invalid".into()),
    }
    execute(webview, shell, Request::ResetSecretKey)
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
    let (role, instance) = caller(&webview, &shell)?;
    let mut sent = false;
    ipc::watch(&shell, |state| {
        let mut watching = shell.host.watching.lock().unwrap_or_else(|e| e.into_inner());
        sent = channel.send(state.clone()).is_ok();
        if sent {
            watching.insert(role, (instance, channel.clone()));
        }
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
    let subscribers = shell.host.watching.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for (role, (instance, channel)) in subscribers {
        let current = shell.host.app.get_webview_window(role.label());
        let valid = current.is_some_and(|w| {
            w.hwnd().is_ok_and(|h| h.0 as u64 == instance) && w.url().is_ok_and(|url| ipc::is_board(shell, &url))
        });
        if !valid || channel.send(state.clone()).is_err() {
            let mut watching = shell.host.watching.lock().unwrap_or_else(|e| e.into_inner());
            if watching.get(&role).is_some_and(|(old, _)| *old == instance) {
                watching.remove(&role);
            }
        }
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
        assert_eq!(hub.permissions.len(), 8);
        assert!(hub.permissions.iter().any(|p| p.identifier().get() == "allow-watch-state"));
        let own = built(own_capability());
        assert!(own.local && own.remote.is_none());
        assert_eq!(own.permissions.len(), 1);
        assert_eq!(allow("save_settings"), "allow-save-settings");
    }
}
