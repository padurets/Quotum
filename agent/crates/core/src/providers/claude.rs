//! Claude Code: the `get_usage` control request of its stream-json (Agent SDK)
//! protocol. Claude Code answers from its own login, refreshes its own tokens and
//! caches the answer for a minute; no model request is made.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Adapter, Context, VersionCache, locate, process_failure};
use crate::model::{
    ErrorKind, Failure, Millis, Outcome, Provider, Resets, SESSION_MINUTES, Snapshot, WEEK_MINUTES, Window, now_ms,
    parse_time, pseudonym,
};
use crate::process::Client;

const P: Provider = Provider::Claude;
pub const VIA: &str = "claude-code/get_usage";

/// Headless, without MCP servers, hooks, plugins, skills or a saved session.
const ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    r#"{"mcpServers":{}}"#,
    "--setting-sources",
    "",
    "--disable-slash-commands",
];
/// A measurement never updates Claude Code. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
/// would halve the start-up cost, but it also switches off the feature flags that make
/// Claude Code ask for model-scoped weekly limits, so those windows would disappear.
const ENV: &[(&str, &str)] = &[("DISABLE_AUTOUPDATER", "1")];

#[derive(Default)]
pub struct Claude {
    version: VersionCache,
}

impl Adapter for Claude {
    fn provider(&self) -> Provider {
        P
    }

    fn program(&self) -> &'static str {
        "claude"
    }

    fn install_dirs(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".local/bin"), home.join(".claude/local")]
    }

    fn measure(&mut self, ctx: &Context) -> Outcome {
        let program = locate(self, ctx)?;
        let version = self.version.get(&program, ctx);
        let mut client =
            Client::spawn(&program, ARGS, ENV, ctx.work_dir, ctx.timeout).map_err(|e| process_failure(P, e))?;
        let init = request(&mut client, "init", json!({"subtype": "initialize"}))?;
        let usage = request(&mut client, "usage", json!({"subtype": "get_usage", "skip_behaviors": true}))?;
        client.finish();
        let mut snapshot = from_responses(&init, &usage, now_ms())?;
        snapshot.client = version;
        Ok(snapshot)
    }

    fn activity_paths(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".claude/history.jsonl"), global_config(home)]
    }

    /// The signed-in account from Claude Code's own config (no tokens there): the same
    /// e-mail and organization `initialize` reports, so the same pseudonym.
    fn local_account(&self, home: &Path) -> Option<String> {
        let account = signed_in(home)?;
        let email = account["emailAddress"].as_str()?;
        Some(pseudonym(P, &format!("{email}/{}", account["organizationName"].as_str().unwrap_or(""))))
    }
}

fn request(client: &mut Client, id: &str, request: Value) -> Result<Value, Failure> {
    client
        .send(&json!({"type": "control_request", "request_id": id, "request": request}))
        .map_err(|e| process_failure(P, e))?;
    let message = client
        .wait_for(|m| m["type"] == "control_response" && m["response"]["request_id"] == id)
        .map_err(|e| process_failure(P, e))?;
    Ok(message["response"].clone())
}

/// The signed-in account as Claude Code's global config records it.
fn signed_in(home: &Path) -> Option<Value> {
    let config: Value = serde_json::from_slice(&fs::read(global_config(home)).ok()?).ok()?;
    Some(config["oauthAccount"].clone()).filter(Value::is_object)
}

/// Claude Code's global config file (it honours `CLAUDE_CONFIG_DIR`).
fn global_config(home: &Path) -> PathBuf {
    match env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir).join(".claude.json"),
        None => home.join(".claude.json"),
    }
}

/// Builds a snapshot from the `initialize` and `get_usage` responses.
/// The account is the signed-in e-mail with its organization, exactly as `initialize`
/// reports them on every machine, so one account measured anywhere has one pseudonym.
pub fn from_responses(init: &Value, usage: &Value, observed_at: Millis) -> Outcome {
    if usage["subtype"] != "success" {
        let message = usage["error"].as_str().unwrap_or("get_usage failed");
        let kind = if message.contains("not supported") || message.contains("Unknown") {
            ErrorKind::Unsupported
        } else {
            ErrorKind::Failed
        };
        return Err(Failure::new(P, kind, message));
    }
    let body = &usage["response"];
    if body["rate_limits_available"] == false {
        return Err(Failure::new(
            P,
            ErrorKind::Unsupported,
            "plan limits do not apply to this login (API key or cloud provider)",
        ));
    }
    let limits = &body["rate_limits"];
    if !limits.is_object() {
        return Err(Failure::new(P, ErrorKind::InvalidOutput, "no rate_limits in get_usage"));
    }

    let mut windows = Vec::new();
    let mut add = |id: String, minutes: u32, label: Option<&str>, used: Option<f64>, resets_at: &Value| {
        if let Some(used) = used {
            if !windows.iter().any(|w: &Window| w.id == id) {
                windows.push(Window::new(
                    id,
                    Some(minutes),
                    label.map(str::to_string),
                    used,
                    resets_at.as_str().and_then(parse_time),
                ));
            }
        }
    };
    let mut plan = |id: &str, label: Option<&str>, minutes: u32, value: &Value| {
        add(id.into(), minutes, label, value["utilization"].as_f64(), &value["resets_at"])
    };
    plan("session", None, SESSION_MINUTES, &limits["five_hour"]);
    plan("weekly", None, WEEK_MINUTES, &limits["seven_day"]);
    plan("weekly:opus", Some("Opus"), WEEK_MINUTES, &limits["seven_day_opus"]);
    plan("weekly:sonnet", Some("Sonnet"), WEEK_MINUTES, &limits["seven_day_sonnet"]);
    // Model-scoped weekly limits: the projected list, or else the raw `limits` entries.
    for scoped in limits["model_scoped"].as_array().into_iter().flatten() {
        if let Some(name) = scoped["display_name"].as_str() {
            add(
                format!("weekly:{}", slug(name)),
                WEEK_MINUTES,
                Some(name),
                scoped["utilization"].as_f64(),
                &scoped["resets_at"],
            );
        }
    }
    for limit in limits["limits"].as_array().into_iter().flatten().filter(|l| l["kind"] == "weekly_scoped") {
        if let Some(name) = limit["scope"]["model"]["display_name"].as_str() {
            add(
                format!("weekly:{}", slug(name)),
                WEEK_MINUTES,
                Some(name),
                limit["percent"].as_f64(),
                &limit["resets_at"],
            );
        }
    }
    if windows.is_empty() {
        return Err(Failure::new(P, ErrorKind::InvalidOutput, "get_usage has no limit windows"));
    }

    let account = &init["response"]["account"];
    let stable_id =
        account["email"].as_str().map(|email| format!("{email}/{}", account["organization"].as_str().unwrap_or("")));
    Ok(Snapshot {
        provider: P,
        account_name: None,
        account: stable_id.map(|id| pseudonym(P, &id)),
        plan: body["subscription_type"].as_str().map(str::to_string),
        observed_at,
        via: VIA.into(),
        client: None,
        stale_after_ms: 0,
        windows,
        resets: free_resets(&limits["cedar_ember"]),
    })
}

/// Free resets of the limits (`cedar_ember`: grants with the resets left in each). Claude
/// Code fills this block only when it asks for it explicitly, which `get_usage` does not
/// do yet; until then it is null and nothing is reported.
fn free_resets(value: &Value) -> Option<Resets> {
    let grants = value["grants"].as_array()?;
    let usable: Vec<&Value> = grants.iter().filter(|g| g["paused"] != true).collect();
    let available = usable.iter().filter_map(|g| g["resets_left"].as_u64()).sum::<u64>() as u32;
    let expires_at = usable.iter().filter_map(|g| g["ends_at"].as_str().and_then(parse_time)).min();
    Some(Resets { available, expires_at })
}

fn slug(name: &str) -> String {
    let slug: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    slug.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() -> Value {
        json!({"subtype": "success", "request_id": "init", "response": {"account": {"email": "dev@example.com", "organization": "Example"}}})
    }

    fn usage(rate_limits: Value) -> Value {
        json!({"subtype": "success", "request_id": "usage", "response": {"subscription_type": "max", "rate_limits_available": true, "rate_limits": rate_limits}})
    }

    #[test]
    fn plan_windows_and_model_scoped_limits_are_read() {
        let limits = json!({
            "five_hour": {"utilization": 4, "resets_at": "2026-09-22T20:20:00.770584+00:00"},
            "seven_day": {"utilization": 10.5, "resets_at": "2026-09-28T06:00:00+00:00"},
            "seven_day_opus": null,
            "nimbus_quill": {"utilization": 0, "resets_at": null},
            "model_scoped": [{"display_name": "Fable", "utilization": 0, "resets_at": "2026-09-28T06:00:00+00:00"}]
        });
        let s = from_responses(&init(), &usage(limits), 1).unwrap();
        let ids: Vec<_> = s.windows.iter().map(|w| (w.id.as_str(), w.used_percent, w.label.as_deref())).collect();
        assert_eq!(ids, [("session", 4.0, None), ("weekly", 10.5, None), ("weekly:fable", 0.0, Some("Fable"))]);
        assert_eq!(s.plan.as_deref(), Some("max"));
        assert_eq!(s.account, Some(pseudonym(P, "dev@example.com/Example")));
        assert_eq!(s.windows[0].resets_at, parse_time("2026-09-22T20:20:00.770Z"));
        assert_eq!(s.resets, None, "get_usage leaves the reset block empty");
    }

    #[test]
    fn free_resets_are_read_when_the_client_reports_them() {
        let grant = |left: u64, ends: &str, paused: bool| json!({"id": "g", "label": "Reset", "resets_total": 1, "resets_left": left, "ends_at": ends, "paused": paused, "usable_now": true});
        let limits = json!({
            "five_hour": {"utilization": 100, "resets_at": null},
            "cedar_ember": {"eligible": true, "grants": [grant(1, "2026-10-20T00:00:00Z", false), grant(2, "2026-10-10T00:00:00Z", true)]}
        });
        let s = from_responses(&init(), &usage(limits), 1).unwrap();
        assert_eq!(s.resets, Some(Resets { available: 1, expires_at: parse_time("2026-10-20T00:00:00Z") }));
    }

    #[test]
    fn model_scoped_limits_are_also_read_from_the_raw_list() {
        let limits = json!({
            "five_hour": {"utilization": 5, "resets_at": null},
            "limits": [
                {"kind": "weekly_all", "group": "weekly", "percent": 10, "scope": null},
                {"kind": "weekly_scoped", "group": "weekly", "percent": 7, "resets_at": "2026-09-28T06:00:00+00:00",
                 "scope": {"model": {"display_name": "Fable", "id": null}, "surface": null}}
            ]
        });
        let s = from_responses(&init(), &usage(limits), 1).unwrap();
        let ids: Vec<_> = s.windows.iter().map(|w| (w.id.as_str(), w.used_percent)).collect();
        assert_eq!(ids, [("session", 5.0), ("weekly:fable", 7.0)]);
    }

    #[test]
    fn the_local_account_is_the_one_a_measurement_reports() {
        let home = std::env::temp_dir().join(format!("quotum-claude-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let config = json!({"oauthAccount": {"emailAddress": "dev@example.com", "organizationName": "Example", "accountUuid": "u"}});
        fs::write(home.join(".claude.json"), config.to_string()).unwrap();
        let local = Claude::default().local_account(&home);
        let measured = from_responses(&init(), &usage(json!({"five_hour": {"utilization": 1}})), 1).unwrap().account;
        fs::remove_dir_all(&home).unwrap();
        assert!(local.is_some());
        assert_eq!(local, measured);
    }

    #[test]
    fn logins_without_plan_limits_and_errors_are_classified() {
        let api_key = json!({"subtype": "success", "response": {"rate_limits_available": false, "rate_limits": null}});
        assert_eq!(from_responses(&init(), &api_key, 1).unwrap_err().error, ErrorKind::Unsupported);
        let old = json!({"subtype": "error", "error": "get_usage is not supported in this context"});
        assert_eq!(from_responses(&init(), &old, 1).unwrap_err().error, ErrorKind::Unsupported);
        let empty = usage(json!({"five_hour": null}));
        assert_eq!(from_responses(&init(), &empty, 1).unwrap_err().error, ErrorKind::InvalidOutput);
    }
}
