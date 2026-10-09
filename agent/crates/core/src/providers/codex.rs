//! Codex: `account/rateLimits/read` of `codex app-server`, the JSON-RPC protocol the
//! Codex IDE extensions use. Codex answers from its own login and refreshes its own
//! tokens.

use std::env;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Collector, Context, locate, process_failure, version_in};
use crate::model::{BalanceStatus, CreditBalance, ResourceStatus, ResourceStatuses};
use crate::model::{ErrorKind, Failure, Kind, Millis, Outcome, Provider, Resets, Snapshot, Window, now_ms, pseudonym};
use crate::process::Client;

const P: Provider = Provider::Codex;
pub const VIA: &str = "codex/app-server";
/// The limit id of the plan's own windows; other ids are per-model limits.
const PLAN_LIMIT: &str = "codex";

pub struct Codex;

impl Collector for Codex {
    fn provider(&self) -> Provider {
        P
    }

    fn measure(&mut self, ctx: &Context) -> Outcome {
        let program = locate(self, ctx)?;
        let mut client = Client::spawn(&program, &["app-server"], &[], ctx.work_dir, ctx.timeout, ctx.stop)
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

/// The directories holding the client of the Codex extension (`openai.chatgpt-<version>-<platform>`)
/// in VS Code, its server and its forks, the newest version first.
pub(crate) fn extension_clients(home: &Path) -> Vec<PathBuf> {
    let version = |dir: &Path| -> Vec<u32> {
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let version = name.trim_start_matches("openai.chatgpt-").split('-').next().unwrap_or_default();
        version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
    };
    let mut extensions: Vec<PathBuf> = [".vscode", ".vscode-server", ".vscode-insiders", ".cursor", ".windsurf"]
        .iter()
        .filter_map(|editor| std::fs::read_dir(home.join(editor).join("extensions")).ok())
        .flatten()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|dir| dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("openai.chatgpt-")))
        .collect();
    extensions.sort_by_key(|dir| std::cmp::Reverse(version(dir)));
    // Inside: bin/<platform>/codex.
    extensions
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir.join("bin")).ok())
        .flat_map(|entries| entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect::<Vec<_>>())
        .collect()
}

/// Where the Codex app on Windows keeps the client it carries, under `%LOCALAPPDATA%`
/// (installed from the web, or from the Store): each place, then the directories in it
/// (`bin\\<hash>`), the newest first. Not the app's own package in WindowsApps: nobody
/// but the app may start what is there.
pub(crate) fn app_clients(local: &Path) -> Vec<PathBuf> {
    let places = [
        local.join("OpenAI").join("Codex").join("bin"),
        local
            .join("Packages")
            .join("OpenAI.Codex_2p2nqsd0c76g0")
            .join("LocalCache")
            .join("Local")
            .join("OpenAI")
            .join("Codex")
            .join("bin"),
    ];
    places
        .into_iter()
        .flat_map(|place| {
            let mut inside: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&place)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.ok().map(|e| e.path()))
                .filter(|dir| dir.is_dir())
                .map(|dir| (dir.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), dir))
                .collect();
            inside.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
            std::iter::once(place).chain(inside.into_iter().map(|(_, dir)| dir))
        })
        .collect()
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

    let account = result["accountId"].as_str().filter(|id| !id.trim().is_empty()).map(|id| pseudonym(P, id));
    let authoritative = result["rateLimitsByLimitId"].as_object().and_then(|map| map.get(PLAN_LIMIT)).or_else(|| {
        match &result["rateLimits"]["limitId"] {
            Value::Null => Some(&result["rateLimits"]),
            Value::String(id) if id == PLAN_LIMIT => Some(&result["rateLimits"]),
            _ => None,
        }
    });
    let mut invalid_windows = false;
    let mut windows: Vec<Window> = Vec::new();
    for entry in entries {
        let limit = entry["limitId"].as_str().unwrap_or(PLAN_LIMIT);
        for w in [&entry["primary"], &entry["secondary"]] {
            if w.is_null() {
                continue;
            }
            let Some(used) = w["usedPercent"].as_f64().filter(|v| v.is_finite() && (0.0..=100.0).contains(v)) else {
                invalid_windows = true;
                continue;
            };
            let minutes = w["windowDurationMins"].as_u64().and_then(|m| u32::try_from(m).ok());
            let slug = Kind::of_minutes(minutes).slug(minutes);
            let (id, label) = if limit == PLAN_LIMIT {
                (slug, None)
            } else {
                (format!("{limit}:{slug}"), Some(entry["limitName"].as_str().unwrap_or(limit).to_string()))
            };
            if !windows.iter().any(|x| x.id == id) {
                windows.push(Window::new(
                    id,
                    minutes,
                    label,
                    used,
                    w["resetsAt"].as_i64().and_then(|s| s.checked_mul(1000)),
                ));
            }
        }
    }
    if windows.is_empty() && account.is_none() {
        let kind = if result["rateLimits"].is_null() { ErrorKind::Unsupported } else { ErrorKind::InvalidOutput };
        return Err(Failure::new(P, kind, "no rate limit windows (API-key login?)"));
    }

    let resets = reset_credits(&result["rateLimitResetCredits"]);
    let resource_status = account.as_ref().map(|_| ResourceStatuses {
        windows: if !windows.is_empty() {
            ResourceStatus::Observed
        } else if invalid_windows {
            ResourceStatus::Invalid
        } else {
            ResourceStatus::Missing
        },
        resets: if resets.is_some() {
            ResourceStatus::Observed
        } else if result["rateLimitResetCredits"].is_null() {
            ResourceStatus::Missing
        } else {
            ResourceStatus::Invalid
        },
    });
    let balances = account.as_ref().map(|_| vec![credit_balance(authoritative.map(|entry| &entry["credits"]))]);
    Ok(Snapshot {
        provider: P,
        account_name: None,
        account,
        plan: authoritative
            .and_then(|entry| entry["planType"].as_str())
            .or_else(|| result["rateLimits"]["planType"].as_str())
            .map(str::to_string),
        observed_at,
        via: VIA.into(),
        client: init["result"]["userAgent"].as_str().and_then(version_in),
        stale_after_ms: 0,
        windows,
        resets,
        resource_status,
        balances,
    })
}

/// Only the account bucket supplies funds; flags are facts, never inferred permission.
fn credit_balance(value: Option<&Value>) -> CreditBalance {
    let mut balance = CreditBalance {
        id: "balance:credits".into(),
        unit: "credits:codex".into(),
        status: BalanceStatus::Missing,
        amount: None,
        has_credits: None,
    };
    let Some(value) = value.filter(|v| !v.is_null()) else { return balance };
    let (Some(has), Some(unlimited)) = (value["hasCredits"].as_bool(), value["unlimited"].as_bool()) else {
        balance.status = BalanceStatus::Invalid;
        return balance;
    };
    balance.has_credits = Some(has);
    if unlimited {
        balance.status = BalanceStatus::Unlimited;
    } else if !value["balance"].is_null() {
        balance.amount = value["balance"].as_str().and_then(exact_credits);
        balance.status = if balance.amount.is_some() { BalanceStatus::Finite } else { BalanceStatus::Invalid };
    }
    balance
}

/// Normalize bounded plain decimals using integer digits alone, without rounding.
fn exact_credits(value: &str) -> Option<String> {
    if value.len() > 128 || !value.is_ascii() {
        return None;
    }
    let negative = value.starts_with('-');
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() => (whole, fraction),
        Some(_) => return None,
        None => (digits, ""),
    };
    if whole.is_empty()
        || whole.len() > 1 && whole.starts_with('0')
        || !whole.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let fraction = fraction.trim_end_matches('0');
    if fraction.len() > 18 {
        return None;
    }
    let coefficient: i64 = format!("{whole}{fraction}").parse().ok()?;
    if coefficient == 0 {
        return Some("0".into());
    }
    Some(format!(
        "{}{}{}",
        if negative { "-" } else { "" },
        whole,
        if fraction.is_empty() { String::new() } else { format!(".{fraction}") }
    ))
}

/// Free rate-limit resets the account holds (`rateLimitResetCredits`): the available ones,
/// each with its own expiry time.
fn reset_credits(value: &Value) -> Option<Resets> {
    let credits = value["credits"].as_array();
    let available: Vec<&Value> = credits.into_iter().flatten().filter(|c| c["status"] == "available").collect();
    let count = if value["availableCount"].is_null() {
        u32::try_from(credits.map(|_| available.len())?).ok()?
    } else {
        u32::try_from(value["availableCount"].as_u64()?).ok()?
    };
    if count > 1000 {
        return None;
    }
    Some(Resets::new(count, available.iter().map(|c| (1, c["expiresAt"].as_i64().and_then(|s| s.checked_mul(1000))))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() -> Value {
        json!({"id": 1, "result": {"userAgent": "quotum/0.154.0 (Ubuntu 24.4.0; x86_64) xterm (quotum; 0.1.0)"}})
    }

    #[test]
    fn exact_native_credits_survive_serde_and_tidy_without_rounding() {
        let limits = json!({"result":{"accountId":"synthetic", "rateLimits":{"credits":{"hasCredits":false,"unlimited":false,"balance":"1234.5678912000"}}}});
        let mut snapshot = from_responses(&init(), &limits, 1).unwrap();
        snapshot.tidy();
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.balances.as_ref().unwrap()[0].amount.as_deref(), Some("1234.5678912"));
        let wire = serde_json::to_string(&snapshot).unwrap();
        assert_eq!(serde_json::from_str::<Snapshot>(&wire).unwrap(), snapshot);
        assert_eq!(exact_credits("-0.000"), Some("0".into()));
        for value in ["1e2", "01", "+1", "1.", "0.0000000000000000001", "9223372036854775808", "NaN"] {
            assert_eq!(exact_credits(value), None, "{value}");
        }
        assert_eq!(exact_credits("0.000000000000000001"), Some("0.000000000000000001".into()));
        assert_eq!(exact_credits("-9223372036854775807"), Some("-9223372036854775807".into()));
    }

    #[test]
    fn only_the_authoritative_account_bucket_supplies_one_balance() {
        let credits = json!({"hasCredits":true,"unlimited":false,"balance":"2500"});
        let mut result = json!({"accountId":"synthetic", "rateLimits":{"credits":credits}, "rateLimitsByLimitId":{"codex":{"credits":null},"model":{"credits":credits}}});
        let get = |result: &Value| from_responses(&init(), &json!({"result":result}), 1).unwrap().balances.unwrap();
        assert_eq!(get(&result)[0].status, BalanceStatus::Missing);
        result["rateLimitsByLimitId"]["codex"]["credits"] = credits.clone();
        assert_eq!(get(&result).len(), 1);
        assert_eq!(get(&result)[0].amount.as_deref(), Some("2500"));
        result["rateLimitsByLimitId"] = json!({"model":{"credits":credits}});
        result["rateLimits"]["limitId"] = json!("another-model");
        assert_eq!(get(&result)[0].status, BalanceStatus::Missing);
    }

    #[test]
    fn flags_are_not_a_zero_balance_or_purchase_permission() {
        for (value, status, amount) in [
            (json!({"hasCredits":false,"unlimited":false,"balance":"0"}), BalanceStatus::Finite, Some("0")),
            (json!({"hasCredits":false,"unlimited":false,"balance":"-1.25"}), BalanceStatus::Finite, Some("-1.25")),
            (json!({"hasCredits":true,"unlimited":true,"balance":"2500"}), BalanceStatus::Unlimited, None),
            (json!({"hasCredits":false,"unlimited":false,"balance":null}), BalanceStatus::Missing, None),
            (json!({"hasCredits":false,"unlimited":false,"balance":"NaN"}), BalanceStatus::Invalid, None),
            (json!({"hasCredits":"false","unlimited":false,"balance":"0"}), BalanceStatus::Invalid, None),
        ] {
            let balance = credit_balance(Some(&value));
            assert_eq!(balance.status, status);
            assert_eq!(balance.amount.as_deref(), amount);
        }
        let result = json!({"result":{"rateLimits":{"primary":{"usedPercent":10},"credits":{"hasCredits":true,"unlimited":false,"balance":"2500"}}}});
        let snapshot = from_responses(&init(), &result, 1).unwrap();
        assert!(snapshot.balances.is_none());
        assert!(snapshot.resource_status.is_none());
    }

    #[test]
    fn the_clients_of_editor_extensions_are_found_newest_first() {
        let home = env::temp_dir().join(format!("quotum-codex-{}", std::process::id()));
        for dir in [
            ".vscode/extensions/openai.chatgpt-26.9.1-linux-x64/bin/linux-x86_64",
            ".vscode/extensions/openai.chatgpt-26.10.2-linux-x64/bin/linux-x86_64",
            ".cursor/extensions/openai.chatgpt-25.1.0-linux-x64/bin/linux-x86_64",
            ".vscode/extensions/someone.else-1.0.0/bin/linux-x86_64",
        ] {
            std::fs::create_dir_all(home.join(dir)).unwrap();
        }
        let found = extension_clients(&home);
        let _ = std::fs::remove_dir_all(&home);
        let versions: Vec<String> = found
            .iter()
            .map(|dir| dir.parent().unwrap().parent().unwrap().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            versions,
            ["openai.chatgpt-26.10.2-linux-x64", "openai.chatgpt-26.9.1-linux-x64", "openai.chatgpt-25.1.0-linux-x64"]
        );
    }

    #[test]
    fn the_client_of_the_codex_app_on_windows_is_found_newest_first() {
        let local = env::temp_dir().join(format!("quotum-codex-app-{}", std::process::id()));
        let bin = local.join("OpenAI/Codex/bin");
        // A directory is as new as its making.
        for hash in ["old1", "new2"] {
            std::fs::create_dir_all(bin.join(hash)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let found = app_clients(&local);
        let _ = std::fs::remove_dir_all(&local);
        let store = local.join("Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/OpenAI/Codex/bin");
        assert_eq!(found, [bin.clone(), bin.join("new2"), bin.join("old1"), store]);
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
    fn free_resets_are_counted_each_with_its_expiry() {
        let weekly = json!({"usedPercent": 96, "windowDurationMins": 10080, "resetsAt": 1790429819});
        let credit = |id: &str, status: &str, expires: i64| json!({"id": id, "resetType": "codexRateLimits", "status": status, "grantedAt": 1790110321, "expiresAt": expires, "title": "Full reset"});
        let credits = json!({"availableCount": 3, "credits": [credit("a", "available", 1792702321), credit("b", "used", 1791000000), credit("c", "available", 1792000000), credit("d", "available", 1792702321)]});
        let limits = json!({"id": 2, "result": {"rateLimits": {"primary": weekly, "planType": "pro"}, "rateLimitResetCredits": credits}});
        let s = from_responses(&init(), &limits, 1).unwrap();
        let resets = s.resets.unwrap();
        assert_eq!(resets.available, 3);
        let groups: Vec<_> = resets.expiring.iter().map(|g| (g.count, g.expires_at)).collect();
        assert_eq!(
            groups,
            [(1, Some(1_792_000_000_000)), (2, Some(1_792_702_321_000))],
            "soonest first, one group per time, used ones left out"
        );
        let none = json!({"id": 2, "result": {"rateLimits": {"primary": weekly}, "rateLimitResetCredits": {"availableCount": 0, "credits": []}}});
        assert_eq!(from_responses(&init(), &none, 1).unwrap().resets, Some(Resets::new(0, [])));
        let count_only = json!({"id": 2, "result": {"rateLimits": {"primary": weekly}, "rateLimitResetCredits": {"availableCount": 2}}});
        assert_eq!(
            from_responses(&init(), &count_only, 1).unwrap().resets,
            Some(Resets::new(2, [])),
            "only a count: no expiry to tell"
        );
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
