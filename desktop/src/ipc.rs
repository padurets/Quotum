//! What the pages may ask of the app. The board of the running hub gets the app's six
//! commands; the app's own pages ("Starting…", "Error") only `quit`. Nothing else: no
//! `core:default`, no plugin's API. Capabilities can be added at run time but never taken
//! back, so a port of an earlier start of the hub keeps its capability; every command but
//! `quit` therefore checks that it is called from the board of the current start.

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{State, Webview};

use crate::settings::Patch;
use crate::shell::{self, Shell};
use crate::window::{self, LABEL};
use crate::{agent, autostart};

/// The app's commands, as build.rs declares them.
pub const COMMANDS: [&str; 6] = ["app_state", "save_settings", "take_over", "set_autostart", "reenter", "quit"];

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

/// Refuses a command unless it comes from the board of the running hub.
fn guard(webview: &Webview, shell: &Arc<Shell>) -> Result<(), String> {
    // The URL first: reading it goes to the main thread, which must not wait on the state.
    let url = webview.url().map_err(|e| e.to_string())?;
    let (state, _) = shell.hub();
    if window::guard(&url, &state) { Ok(()) } else { Err("not the board of the running hub".into()) }
}

/// What the board shows of the app: its agent, the settings of measuring, start at
/// login, where its files are, which build it is.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub agent: agent::State,
    pub providers: Vec<agent::Provided>,
    pub sessions: bool,
    pub autostart: bool,
    pub config_path: String,
    pub log_path: String,
    pub version: &'static str,
    pub commit: &'static str,
}

fn state_of(shell: &Arc<Shell>) -> AppState {
    let (agent, providers, sessions) = agent::snapshot(shell);
    AppState {
        agent,
        providers,
        sessions,
        autostart: autostart::is_enabled(shell),
        config_path: shell.paths.config.display().to_string(),
        log_path: shell.dirs.agent_log().display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("QUOTUM_COMMIT"),
    }
}

/// Only reads: the state as the app last saw it.
#[tauri::command(async)]
pub fn app_state(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<AppState, String> {
    guard(&webview, &shell)?;
    if let Some(smoke) = &shell.smoke {
        smoke.board_asked(&shell);
    }
    Ok(state_of(&shell))
}

/// Changes the settings of measuring in config.toml; the agent follows in a moment.
#[tauri::command(async)]
pub fn save_settings(webview: Webview, shell: State<'_, Arc<Shell>>, patch: Patch) -> Result<AppState, String> {
    guard(&webview, &shell)?;
    agent::save_settings(&shell, &patch)?;
    Ok(state_of(&shell))
}

/// The person agreed: the app takes the machine over from `quotum` (up to about half a minute).
#[tauri::command(async)]
pub fn take_over(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<AppState, String> {
    guard(&webview, &shell)?;
    agent::take_over(&shell)?;
    Ok(state_of(&shell))
}

#[tauri::command(async)]
pub fn set_autostart(webview: Webview, shell: State<'_, Arc<Shell>>, on: bool) -> Result<AppState, String> {
    guard(&webview, &shell)?;
    autostart::set(&shell, on)?;
    Ok(state_of(&shell))
}

/// Opens the board again: after the window lost its session, it enters with the key of
/// the hub's current start.
#[tauri::command(async)]
pub fn reenter(webview: Webview, shell: State<'_, Arc<Shell>>) -> Result<(), String> {
    guard(&webview, &shell)?;
    window::reenter(&shell);
    Ok(())
}

#[tauri::command(async)]
pub fn quit(shell: State<'_, Arc<Shell>>) -> Result<(), String> {
    shell::quit(&shell);
    Ok(())
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
    fn the_board_gets_the_six_commands_and_the_apps_own_pages_only_quit() {
        let hub = built(hub_capability(23456));
        assert!(!hub.local, "not the app's own pages");
        let urls = &hub.remote.as_ref().unwrap().urls;
        assert_eq!(urls, &["http://127.0.0.1:23456/*"]);
        assert_eq!(hub.windows, ["main"]);
        assert_eq!(hub.permissions.len(), 6);
        let own = built(own_capability());
        assert!(own.local && own.remote.is_none());
        assert_eq!(own.permissions.len(), 1);
        assert_eq!(allow("save_settings"), "allow-save-settings");
    }
}
