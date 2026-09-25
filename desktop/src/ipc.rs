//! The six operations the board may request, independent of its window engine.
use crate::{
    agent, autostart,
    settings::Patch,
    shell::{self, Shell},
    window,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use url::Url;
#[cfg(not(target_os = "linux"))]
pub const COMMANDS: [&str; 6] = ["app_state", "save_settings", "take_over", "set_autostart", "reenter", "quit"];

#[derive(Deserialize)]
#[serde(tag = "command", content = "args", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    AppState,
    SaveSettings { patch: Patch },
    TakeOver,
    SetAutostart { on: bool },
    Reenter,
    Quit,
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

pub fn execute(shell: &Arc<Shell>, origin: &Url, request: Request) -> Result<Value, String> {
    let (hub, _) = shell.hub();
    let own_quit = matches!(request, Request::Quit) && window::same_origin(origin, window::own_origin().as_str());
    if !own_quit && !window::guard(origin, &hub) {
        return Err("not the board of the running hub".into());
    }
    match request {
        Request::AppState => {
            if let Some(smoke) = &shell.smoke {
                smoke.board_asked(shell);
            }
        }
        Request::SaveSettings { patch } => agent::save_settings(shell, &patch)?,
        Request::TakeOver => agent::take_over(shell)?,
        Request::SetAutostart { on } => autostart::set(shell, on)?,
        Request::Reenter => {
            window::reenter(shell);
            return Ok(Value::Null);
        }
        Request::Quit => {
            shell::quit(shell);
            return Ok(Value::Null);
        }
    }
    serde_json::to_value(state_of(shell)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requests_are_typed_and_unknown_commands_are_rejected() {
        assert!(serde_json::from_str::<Request>(r#"{"command":"app_state"}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":true}}"#).is_ok());
        assert!(serde_json::from_str::<Request>(r#"{"command":"set_autostart","args":{"on":"yes"}}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"command":"open_file","args":{"path":"/tmp/a"}}"#).is_err());
    }
}
