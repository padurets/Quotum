//! Codex: `account/rateLimits/read` of `codex app-server`, the JSON-RPC protocol the
//! Codex IDE extensions use. Codex answers from its own login and refreshes its own
//! tokens.

use std::env;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Adapter, Context, locate, process_failure, version_in};
use crate::model::{ErrorKind, Failure, Kind, Millis, Outcome, Provider, Resets, Snapshot, Window, now_ms, pseudonym};
use crate::process::Client;

const P: Provider = Provider::Codex;
pub const VIA: &str = "codex/app-server";
/// The limit id of the plan's own windows; other ids are per-model limits.
const PLAN_LIMIT: &str = "codex";

pub struct Codex;

impl Adapter for Codex {
    fn provider(&self) -> Provider {
        P
    }

    fn program(&self) -> &'static str {
        "codex"
    }

    fn install_dirs(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".local/bin"), home.join(".codex/bin")]
    }

    fn measure(&mut self, ctx: &Context) -> Outcome {
        let program = locate(self, ctx)?;
        let mut client = Client::spawn(&program, &["app-server"], &[], ctx.work_dir, ctx.timeout)
            .map_err(|e| process_failure(P, e))?;
        let send = |client: &mut Client, message: Value| client.send(&message).map_err(|e| process_failure(P, e));
        let reply =
            // A reply carries our id and no method; a request of the server may carry the same id.
            |client: &mut Client, id: u64| client.wait_for(|m| m["id"] == id && m.get("method").is_none()).map_err(|e| process_failure(P, e));

        let info = json!({"name": "quotum", "title": "Quotum", "version": env!("CARGO_PKG_VERSION")});
        send(&mut client, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": info}}))?;
        let init = reply(&mut client, 1)?;
        send(&mut client, json!({"jsonrpc": "2.0", "method": "initialized"}))?;
        send(&mut client, json!({"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"}))?;
        let limits = reply(&mut client, 2)?;
        client.finish();
        from_responses(&init, &limits, now_ms())
    }

    fn activity_paths(&self, home: &Path) -> Vec<PathBuf> {
        vec![codex_home(home)]
    }

    fn identity_paths(&self, home: &Path) -> Vec<PathBuf> {
        vec![codex_home(home).join("auth.json")]
    }
}

fn codex_home(home: &Path) -> PathBuf {
    env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"))
}

/// Builds a snapshot from the `initialize` and `account/rateLimits/read` responses.
pub fn from_responses(init: &Value, limits: &Value, observed_at: Millis) -> Outcome {
    if let Some(error) = limits.get("error") {
        let message = error["message"].as_str().unwrap_or("rate limits request failed");
        let lower = message.to_lowercase();
        let kind = if lower.contains("unknown variant") {
            ErrorKind::Unsupported
        } else if ["auth", "login", "log in", "sign in"].iter().any(|w| lower.contains(w)) {
            ErrorKind::NotLoggedIn
        } else {
            ErrorKind::Failed
        };
        return Err(Failure::new(P, kind, message));
    }
    let result = &limits["result"];
    let entries: Vec<&Value> = match result["rateLimitsByLimitId"].as_object() {
        Some(map) if !map.is_empty() => {
            // The plan's own limit first, then per-model limits in a stable order.
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(id, _)| (id.as_str() != PLAN_LIMIT, id.to_string()));
            entries.into_iter().map(|(_, v)| v).collect()
        }
        _ => vec![&result["rateLimits"]],
    };

    let mut windows: Vec<Window> = Vec::new();
    for entry in entries {
        let limit = entry["limitId"].as_str().unwrap_or(PLAN_LIMIT);
        for w in [&entry["primary"], &entry["secondary"]] {
            let Some(used) = w["usedPercent"].as_f64() else { continue };
            let minutes = w["windowDurationMins"].as_u64().map(|m| m as u32);
            let slug = Kind::of_minutes(minutes).slug(minutes);
            let (id, label) = if limit == PLAN_LIMIT {
                (slug, None)
            } else {
                (format!("{limit}:{slug}"), Some(entry["limitName"].as_str().unwrap_or(limit).to_string()))
            };
            if !windows.iter().any(|x| x.id == id) {
                windows.push(Window::new(id, minutes, label, used, w["resetsAt"].as_i64().map(|s| s * 1000)));
            }
        }
    }
    if windows.is_empty() {
        let kind = if result["rateLimits"].is_null() { ErrorKind::Unsupported } else { ErrorKind::InvalidOutput };
        return Err(Failure::new(P, kind, "no rate limit windows (API-key login?)"));
    }

    Ok(Snapshot {
        provider: P,
        account_name: None,
        account: result["accountId"].as_str().map(|id| pseudonym(P, id)),
        plan: result["rateLimits"]["planType"].as_str().map(str::to_string),
        observed_at,
        via: VIA.into(),
        client: init["result"]["userAgent"].as_str().and_then(version_in),
        stale_after_ms: 0,
        windows,
        resets: reset_credits(&result["rateLimitResetCredits"]),
    })
}

/// Free rate-limit resets the account holds (`rateLimitResetCredits`): the available
/// ones and the earliest of their expiry times.
fn reset_credits(value: &Value) -> Option<Resets> {
    let credits = value["credits"].as_array();
    let available: Vec<&Value> = credits.into_iter().flatten().filter(|c| c["status"] == "available").collect();
    let count =
        value["availableCount"].as_u64().map(|n| n as u32).or_else(|| credits.map(|_| available.len() as u32))?;
    let expires_at = available.iter().filter_map(|c| c["expiresAt"].as_i64()).min().map(|s| s * 1000);
    Some(Resets { available: count, expires_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() -> Value {
        json!({"id": 1, "result": {"userAgent": "quotum/0.154.0 (Ubuntu 24.4.0; x86_64) xterm (quotum; 0.1.0)"}})
    }

    #[test]
    fn plan_and_per_model_limits_are_read() {
        let weekly = json!({"usedPercent": 92, "windowDurationMins": 10080, "resetsAt": 1790429819});
        let plan =
            json!({"limitId": "codex", "limitName": null, "primary": weekly, "secondary": null, "planType": "pro"});
        let model = json!({"limitId": "gpt-6-astra", "limitName": "GPT-6 Astra", "primary": {"usedPercent": 5, "windowDurationMins": 300, "resetsAt": 1790000000}, "secondary": null});
        let limits = json!({"id": 2, "result": {"rateLimits": plan, "rateLimitsByLimitId": {"gpt-6-astra": model, "codex": plan}, "accountId": "acc-1"}});
        let s = from_responses(&init(), &limits, 1).unwrap();
        let ids: Vec<_> = s.windows.iter().map(|w| (w.id.as_str(), w.used_percent, w.label.as_deref())).collect();
        assert_eq!(ids, [("weekly", 92.0, None), ("gpt-6-astra:session", 5.0, Some("GPT-6 Astra"))]);
        assert_eq!(s.windows[0].resets_at, Some(1_790_429_819_000));
        assert_eq!((s.plan.as_deref(), s.client.as_deref()), (Some("pro"), Some("0.154.0")));
        assert_eq!(s.account, Some(pseudonym(P, "acc-1")));
        assert_eq!(s.resets, None, "an older client does not report resets");
    }

    #[test]
    fn free_resets_are_counted_with_the_earliest_expiry() {
        let weekly = json!({"usedPercent": 96, "windowDurationMins": 10080, "resetsAt": 1790429819});
        let credit = |id: &str, status: &str, expires: i64| json!({"id": id, "resetType": "codexRateLimits", "status": status, "grantedAt": 1790110321, "expiresAt": expires, "title": "Full reset"});
        let credits = json!({"availableCount": 2, "credits": [credit("a", "available", 1792702321), credit("b", "used", 1791000000), credit("c", "available", 1792000000)]});
        let limits = json!({"id": 2, "result": {"rateLimits": {"primary": weekly, "planType": "pro"}, "rateLimitResetCredits": credits}});
        let s = from_responses(&init(), &limits, 1).unwrap();
        assert_eq!(s.resets, Some(Resets { available: 2, expires_at: Some(1_792_000_000_000) }));
        let none = json!({"id": 2, "result": {"rateLimits": {"primary": weekly}, "rateLimitResetCredits": {"availableCount": 0, "credits": []}}});
        assert_eq!(from_responses(&init(), &none, 1).unwrap().resets, Some(Resets { available: 0, expires_at: None }));
    }

    #[test]
    fn errors_and_api_key_logins_are_classified() {
        let auth = json!({"id": 2, "error": {"code": -32000, "message": "Not logged in: run codex login"}});
        assert_eq!(from_responses(&init(), &auth, 1).unwrap_err().error, ErrorKind::NotLoggedIn);
        let old = json!({"id": 2, "error": {"code": -32600, "message": "Invalid request: unknown variant `account/rateLimits/read`"}});
        assert_eq!(from_responses(&init(), &old, 1).unwrap_err().error, ErrorKind::Unsupported);
        let api_key = json!({"id": 2, "result": {"rateLimits": null, "rateLimitsByLimitId": null}});
        assert_eq!(from_responses(&init(), &api_key, 1).unwrap_err().error, ErrorKind::Unsupported);
    }
}
