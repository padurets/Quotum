//! The operations the board may request, independent of its window engine, and the
//! app's state it is sent whenever that changes (on Windows by `watch_state`; on
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
    OpenMain {
        #[serde(default)]
        destination: Option<MainDestination>,
    },
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MainDestination {
    Devices {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
}
impl MainDestination {
    fn valid(&self) -> bool {
        let Self::Devices { source_id } = self;
        let Some((provider, id)) = source_id.split_once(':') else {
            return false;
        };
        matches!(provider, "claude" | "codex" | "antigravity")
            && id.len() == 12
            && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

#[derive(Default, Clone, Serialize)]
pub struct MainNavigation {
    pub revision: u64,
    pub destination: Option<MainDestination>,
    #[serde(skip)]
    pending: Option<(u64, u64, Option<MainDestination>)>,
}
impl MainNavigation {
    /// Keep the last validated destination while the native event loop takes the main window.
    pub fn queue(&mut self, instance: u64, request: u64, destination: Option<MainDestination>) {
        self.pending = Some((instance, request, destination));
    }
    pub fn commit(&mut self, instance: u64, request: u64) -> bool {
        if !self.pending.as_ref().is_some_and(|&(owner, revision, _)| owner == instance && revision == request) {
            return false;
        }
        let (_, _, destination) = self.pending.take().unwrap();
        self.set(destination);
        true
    }
    pub fn set(&mut self, destination: Option<MainDestination>) {
        self.revision += 1;
        self.destination = destination;
    }
}

/// What the board shows of the app: its agent, the settings of measuring, start at
/// login, where its files are, which build it is. It goes to the board numbered (`seq`,
/// see notifier.rs): the board keeps the newest.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub main_navigation: MainNavigation,
    pub secret_key: crate::keys::PublicState,
    pub agent: agent::State,
    pub providers: Vec<agent::Provided>,
    pub clients: Vec<agent::Tracked>,
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
    let (agent, providers, clients, sessions) = agent::snapshot(shell);
    let (notifications, locale) = shell.desktop_settings();
    AppState {
        main_navigation: shell.main_navigation.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        secret_key: shell.secret_keys.state(),
        agent,
        providers,
        clients,
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
    let panel_command =
        matches!(request, Request::OpenMain { .. } | Request::ClosePanel | Request::ReportPanelHeight { .. });
    if (!compact && panel_command)
        || (compact
            && !matches!(
                request,
                Request::AppState
                    | Request::Reenter
                    | Request::OpenMain { .. }
                    | Request::ClosePanel
                    | Request::ReportPanelHeight { .. }
            )
            && !own_quit)
    {
        return Err("command unavailable in this window".into());
    }
    match request {
        Request::OpenMain { destination } => {
            if destination.as_ref().is_some_and(|target| !target.valid()) {
                return Err("invalid main destination".into());
            }
            host::open_main_from_panel(shell, instance, destination);
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
    fn queued_main_handoff_keeps_the_latest_validated_destination_and_rejects_retired_tickets() {
        let mut navigation = MainNavigation::default();
        navigation.queue(2, 1, Some(MainDestination::Devices { source_id: "codex:123456abcdef".into() }));
        navigation.queue(2, 1, Some(MainDestination::Devices { source_id: "claude:abcdef123456".into() }));
        assert!(navigation.destination.is_none());
        assert!(!navigation.commit(1, 1));
        assert!(!navigation.commit(2, 0));
        assert!(navigation.commit(2, 1));
        assert_eq!(serde_json::to_value(&navigation).unwrap()["destination"]["sourceId"], "claude:abcdef123456");
        assert!(!navigation.commit(2, 1));
        navigation.queue(3, 4, None);
        assert!(!navigation.commit(2, 1));
        assert!(navigation.commit(3, 4));
        assert_eq!(navigation.revision, 2);
        assert!(navigation.destination.is_none());
    }
    #[test]
    fn requests_are_typed_and_unknown_commands_are_rejected() {
        assert!(serde_json::from_str::<Request>(r#"{"command":"app_state"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"reset_secret_key"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"reset_secret_key","args":{"key":"canary"}}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":true}}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":"yes"}}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"open_file","args":{"path":"/tmp/a"}}"#).is_err());
    }
    #[test]
    fn main_destinations_are_bounded_and_keep_only_the_latest_intent() {
        let destination = MainDestination::Devices { source_id: "codex:123456abcdef".into() };
        assert!(destination.valid());
        for source in ["https://example.com", "../settings", "codex:123", "codex:123456abcdeF", "opencode:123456abcdef"]
        {
            assert!(!MainDestination::Devices { source_id: source.into() }.valid());
        }
        assert!(serde_json::from_str::<Request>(r#"{"command":"open_main","args":{"destination":{"kind":"devices","sourceId":"codex:123456abcdef","url":"https://example.com"}}}"#).is_err());
        let mut pending = MainNavigation::default();
        pending.set(Some(destination));
        pending.set(Some(MainDestination::Devices { source_id: "claude:abcdef123456".into() }));
        assert_eq!(pending.revision, 2);
        assert_eq!(serde_json::to_value(&pending).unwrap()["destination"]["sourceId"], "claude:abcdef123456");
        pending.set(None);
        assert!(pending.destination.is_none());
    }
}
