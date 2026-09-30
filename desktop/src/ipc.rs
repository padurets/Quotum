//! The six operations the board may request, independent of its window engine, and the
//! app's state it is sent whenever that changes (on Windows by a seventh, `watch_state`; on
//! Linux the window's preload script listens).
use crate::{
    agent, autostart, host,
    settings::Patch,
    shell::{self, Shell},
    window,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use url::Url;
#[cfg(not(target_os = "linux"))]
pub const COMMANDS: [&str; 9] = [
    "app_state",
    "save_settings",
    "take_over",
    "set_autostart",
    "reenter",
    "quit",
    "watch_state",
    "save_desktop_settings",
    "reset_secret_key",
];

#[derive(Deserialize)]
#[serde(tag = "command", content = "args", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    AppState,
    ResetSecretKey,
    OpenMain,
    ClosePanel,
    ReportPanelHeight {
        #[serde(rename = "heightCssPx")]
        height_css_px: f64,
    },
    SaveSettings {
        patch: Patch,
    },
    SaveDesktopSettings {
        patch: crate::desktop_settings::Patch,
    },
    TakeOver,
    SetAutostart {
        on: bool,
    },
    Reenter,
    Quit,
}

/// What the board shows of the app: its agent, the settings of measuring, start at
/// login, where its files are, which build it is. It goes to the board numbered (`seq`,
/// see notifier.rs): the board keeps the newest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub secret_key: crate::keys::PublicState,
    pub agent: agent::State,
    pub providers: Vec<agent::Provided>,
    pub sessions: bool,
    pub autostart: bool,
    pub config_path: String,
    pub log_path: String,
    pub version: &'static str,
    pub commit: &'static str,
    pub attention: crate::attention::Status,
    pub notifications: crate::desktop_settings::Notifications,
    pub locale: Option<crate::desktop_settings::Locale>,
    pub effective_locale: crate::desktop_settings::Locale,
    pub notification_delivery: &'static str,
}

fn state_of(shell: &Arc<Shell>) -> AppState {
    let (agent, providers, sessions) = agent::snapshot(shell);
    let (notifications, locale) = shell.desktop_settings();
    AppState {
        secret_key: shell.secret_keys.state(),
        agent,
        providers,
        sessions,
        autostart: autostart::is_enabled(shell),
        config_path: shell.paths.config.display().to_string(),
        log_path: shell.dirs.agent_log().display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("QUOTUM_COMMIT"),
        attention: shell.attention.status(),
        notifications,
        locale,
        effective_locale: locale.unwrap_or_else(crate::desktop_settings::Locale::system),
        notification_delivery: shell.attention.delivery.capability(),
    }
}

fn state_value(shell: &Arc<Shell>) -> Value {
    serde_json::to_value(state_of(shell)).unwrap_or_default()
}

/// Whether the page at `origin` is the board of the running hub: the check before every
/// command but the own page's quit, and before every state sent on Windows (on Linux the
/// window's process checks the page a state goes to, electron/main.cjs).
pub fn is_board(shell: &Shell, origin: &Url) -> bool {
    window::guard(origin, &shell.hub().0)
}

/// Sends the app's state to the board if it changed; the state, numbered. From the ticker
/// and the commands only, never the main thread (see notifier.rs).
pub fn publish(shell: &Arc<Shell>) -> Value {
    shell.notifier.publish(|| state_value(shell), |state| host::push_state(shell, state))
}

/// A board starts watching the app's state: `push` gets it at once.
#[cfg(not(target_os = "linux"))]
pub fn watch(shell: &Arc<Shell>, push: impl FnOnce(&Value)) -> Value {
    shell.notifier.watch(|| state_value(shell), push)
}

pub fn execute(
    shell: &Arc<Shell>,
    origin: &Url,
    role: window::Role,
    instance: u64,
    request: Request,
) -> Result<Value, String> {
    let own_quit = matches!(request, Request::Quit) && window::same_origin(origin, window::own_origin().as_str());
    if !own_quit && !is_board(shell, origin) {
        return Err("not the board of the running hub".into());
    }
    let compact = role == window::Role::Compact;
    let panel_command = matches!(request, Request::OpenMain | Request::ClosePanel | Request::ReportPanelHeight { .. });
    if (!compact && panel_command)
        || (compact
            && !matches!(
                request,
                Request::AppState
                    | Request::Reenter
                    | Request::OpenMain
                    | Request::ClosePanel
                    | Request::ReportPanelHeight { .. }
            )
            && !own_quit)
    {
        return Err("command unavailable in this window".into());
    }
    match request {
        Request::OpenMain => {
            host::open_main_from_panel(shell, instance);
            return Ok(Value::Null);
        }
        Request::ClosePanel => {
            host::close_panel(shell, instance);
            return Ok(Value::Null);
        }
        Request::ReportPanelHeight { height_css_px } => {
            if !height_css_px.is_finite() || height_css_px <= 0.0 || height_css_px > 100_000.0 {
                return Err("invalid panel height".into());
            }
            host::panel_height(shell, instance, height_css_px);
            return Ok(Value::Null);
        }
        Request::AppState => {
            if let Some(smoke) = &shell.smoke {
                smoke.board_asked(shell);
            }
        }
        Request::SaveDesktopSettings { patch } => shell.save_desktop_settings(&patch)?,
        Request::ResetSecretKey => {
            shell.secret_keys.request_reset().map_err(str::to_owned)?;
            shell.wake();
        }
        Request::SaveSettings { patch } => agent::save_settings(shell, &patch)?,
        Request::TakeOver => agent::take_over(shell)?,
        Request::SetAutostart { on } => autostart::set(shell, on)?,
        Request::Reenter => {
            host::reenter_role(shell, role);
            return Ok(Value::Null);
        }
        Request::Quit => {
            shell::quit(shell);
            return Ok(Value::Null);
        }
    }
    // The answer and what goes to the board carry the same number.
    Ok(publish(shell))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_typed_and_unknown_commands_are_rejected() {
        assert!(serde_json::from_str::<Request>(r#"{"command":"app_state"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"reset_secret_key"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"reset_secret_key","args":{"key":"canary"}}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":true}}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":"yes"}}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"open_file","args":{"path":"/tmp/a"}}"#).is_err());
    }
}
