//! The local collector is a bounded transport. The runner owns all account scheduling.
use crate::collection::{AccountRef, CollectionOutcome};
use crate::config::{Config, HookSettings, Paths};
use crate::model::{
    BalanceStatus, CreditBalance, ErrorKind, Expiring, Failure, Kind, Provider, Resets, ResourceStatus,
    ResourceStatuses, Snapshot, TEXT_LIMIT, Window, exact_credits, now_ms, parse_time, pseudonym,
};
use crate::process::{Client, ProcError};
use crate::stop::Stop;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

pub const LIMIT: usize = 256 * 1024;
pub const ACCOUNT_LIMIT: usize = 16;
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Identity {
    pub wire: Value,
    pub account: AccountRef,
}
#[derive(Clone)]
pub(crate) struct Hook {
    pub provider: Provider,
    command: HookSettings,
}

fn object<'a>(v: &'a Value, fields: &[&str]) -> Result<&'a serde_json::Map<String, Value>, ()> {
    let o = v.as_object().ok_or(())?;
    if o.keys().any(|k| !fields.contains(&k.as_str())) {
        return Err(());
    }
    Ok(o)
}
fn text(v: &Value, empty: bool) -> Result<&str, ()> {
    let s = v.as_str().ok_or(())?;
    if (!empty && s.trim().is_empty()) || s.chars().count() > TEXT_LIMIT || s.chars().any(char::is_control) {
        return Err(());
    }
    Ok(s)
}
fn optional_text(v: &Value) -> Result<Option<String>, ()> {
    if v.is_null() { Ok(None) } else { Ok(Some(text(v, false)?.trim().into())) }
}
fn time(v: &Value) -> Result<i64, ()> {
    parse_time(v.as_str().ok_or(())?).ok_or(())
}
fn optional_time(v: &Value) -> Result<Option<i64>, ()> {
    if v.is_null() { Ok(None) } else { Ok(Some(time(v)?)) }
}
fn array(v: &Value, limit: usize) -> Result<&Vec<Value>, ()> {
    let a = v.as_array().ok_or(())?;
    if a.len() > limit { Err(()) } else { Ok(a) }
}

pub(crate) fn identity(provider: Provider, v: &Value) -> Result<Identity, ()> {
    let reference = match provider {
        Provider::Claude => {
            object(v, &["email", "organization"])?;
            let email = text(&v["email"], false)?;
            let organization = text(&v["organization"], true)?;
            AccountRef::Supplier { account: pseudonym(provider, &format!("{email}/{organization}")) }
        }
        Provider::Codex => {
            object(v, &["accountId"])?;
            AccountRef::Supplier { account: pseudonym(provider, text(&v["accountId"], false)?) }
        }
        Provider::Antigravity => {
            let o = object(v, &["accountName"])?;
            if !o.contains_key("accountName") {
                return Err(());
            }
            AccountRef::Declared { account_name: optional_text(&v["accountName"])?.map(|s| s.to_lowercase()) }
        }
    };
    Ok(Identity { wire: v.clone(), account: reference })
}
fn invalid(provider: Provider) -> Failure {
    Failure::new(provider, ErrorKind::InvalidOutput, "invalid local collector response")
}
fn envelope(provider: Provider, bytes: &[u8], field: &str) -> Result<Vec<Value>, Failure> {
    if bytes.len() > LIMIT {
        return Err(invalid(provider));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid(provider))?;
    object(&value, &["version", field]).map_err(|_| invalid(provider))?;
    if value["version"] != 1 {
        return Err(Failure::new(provider, ErrorKind::Unsupported, "unsupported local collector version"));
    }
    Ok(array(&value[field], ACCOUNT_LIMIT).map_err(|_| invalid(provider))?.clone())
}
fn observed(provider: Provider, id: &Identity, v: &Value, interval: u64) -> Result<Snapshot, ()> {
    object(v, &["identity", "status", "observedAt", "plan", "windows", "resets", "resourceStatus", "balances"])?;
    let observed_at = time(&v["observedAt"])?;
    if observed_at > now_ms() + 30_000 {
        return Err(());
    }
    let mut ids = BTreeSet::new();
    let windows = array(&v["windows"], 32)?
        .iter()
        .map(|v| {
            object(v, &["id", "kind", "minutes", "label", "usedPercent", "resetsAt"])?;
            let id = text(&v["id"], false)?.trim().to_string();
            if !ids.insert(id.clone()) {
                return Err(());
            }
            let kind: Kind = serde_json::from_value(v["kind"].clone()).map_err(|_| ())?;
            let minutes = if v["minutes"].is_null() {
                None
            } else {
                Some(u32::try_from(v["minutes"].as_u64().filter(|n| *n > 0).ok_or(())?).map_err(|_| ())?)
            };
            let used_percent =
                v["usedPercent"].as_f64().filter(|n| n.is_finite() && (0.0..=100.0).contains(n)).ok_or(())?;
            Ok(Window {
                id,
                kind,
                minutes,
                label: optional_text(&v["label"])?,
                used_percent,
                resets_at: optional_time(&v["resetsAt"])?,
            })
        })
        .collect::<Result<Vec<_>, ()>>()?;
    let resets = if v["resets"].is_null() {
        None
    } else {
        let r = &v["resets"];
        object(r, &["available", "expiring"])?;
        let available = r["available"].as_u64().filter(|n| *n <= 1000).ok_or(())? as u32;
        let expiring = if r["expiring"].is_null() {
            vec![]
        } else {
            array(&r["expiring"], 50)?
                .iter()
                .map(|g| {
                    object(g, &["count", "expiresAt"])?;
                    Ok(Expiring {
                        count: u32::try_from(g["count"].as_u64().filter(|n| *n > 0).ok_or(())?).map_err(|_| ())?,
                        expires_at: optional_time(&g["expiresAt"])?,
                    })
                })
                .collect::<Result<Vec<_>, ()>>()?
        };
        if expiring.iter().map(|g| u64::from(g.count)).sum::<u64>() > u64::from(available)
            || expiring
                .windows(2)
                .any(|w| w[0].expires_at.is_none() || w[1].expires_at.is_some_and(|n| n <= w[0].expires_at.unwrap()))
        {
            return Err(());
        }
        Some(Resets { available, expiring })
    };
    let resource_status = if let Some(r) = v.get("resourceStatus") {
        if provider != Provider::Codex {
            return Err(());
        }
        object(r, &["windows", "resets"])?;
        let statuses: ResourceStatuses = serde_json::from_value(r.clone()).map_err(|_| ())?;
        if (statuses.windows == ResourceStatus::Observed) != !windows.is_empty()
            || (statuses.resets == ResourceStatus::Observed) != resets.is_some()
        {
            return Err(());
        }
        Some(statuses)
    } else {
        None
    };
    if windows.is_empty() && resource_status.is_none() {
        return Err(());
    }
    let balances = if let Some(b) = v.get("balances") {
        if provider != Provider::Codex {
            return Err(());
        }
        Some(
            array(b, 1)?
                .iter()
                .map(|b| {
                    object(b, &["id", "unit", "status", "amount", "hasCredits"])?;
                    if b["id"] != "balance:credits" || b["unit"] != "credits:codex" {
                        return Err(());
                    }
                    let status: BalanceStatus = serde_json::from_value(b["status"].clone()).map_err(|_| ())?;
                    let amount = if status == BalanceStatus::Finite {
                        Some(exact_credits(b["amount"].as_str().ok_or(())?).ok_or(())?)
                    } else {
                        if b.get("amount").is_some() {
                            return Err(());
                        }
                        None
                    };
                    let has_credits = b.get("hasCredits").map(|h| h.as_bool().ok_or(())).transpose()?;
                    Ok(CreditBalance {
                        id: "balance:credits".into(),
                        unit: "credits:codex".into(),
                        status,
                        amount,
                        has_credits,
                    })
                })
                .collect::<Result<Vec<_>, ()>>()?,
        )
    } else {
        None
    };
    Ok(Snapshot {
        provider,
        account: id.account.account().map(str::to_string),
        account_name: id.account.name().map(str::to_string),
        plan: optional_text(&v["plan"])?,
        observed_at,
        via: "local-collector/v1".into(),
        client: None,
        stale_after_ms: interval,
        windows,
        resets,
        resource_status,
        balances,
    })
}
impl Hook {
    pub fn configured(config: &Config) -> Vec<Self> {
        config
            .providers
            .iter()
            .filter_map(|(&provider, s)| {
                s.hooks.collect.clone().filter(|_| config.enabled(provider)).map(|command| Self { provider, command })
            })
            .collect()
    }
    pub fn provider(&self) -> Provider {
        self.provider
    }
    fn invoke(&self, request: Value, paths: &Paths, stop: &Stop) -> Result<Vec<u8>, Failure> {
        Client::command_output(
            &self.command.path,
            &self.command.args,
            Some(serde_json::to_vec(&request).expect("serializable request")),
            &paths.work,
            Duration::from_secs(60),
            stop,
            LIMIT,
        )
        .map_err(|e| {
            Failure::new(
                self.provider,
                match e {
                    ProcError::NotFound => ErrorKind::NotInstalled,
                    ProcError::Timeout => ErrorKind::Timeout,
                    _ => ErrorKind::Failed,
                },
                "local collector did not complete",
            )
        })
    }
    pub fn discover(&self, paths: &Paths, stop: &Stop) -> Result<Vec<Identity>, Failure> {
        let bytes = self.invoke(json!({"version":1,"action":"discover","provider":self.provider}), paths, stop)?;
        let mut seen = BTreeSet::new();
        envelope(self.provider, &bytes, "accounts")?
            .iter()
            .map(|v| {
                object(v, &["identity"]).map_err(|_| invalid(self.provider))?;
                let id = identity(self.provider, &v["identity"]).map_err(|_| invalid(self.provider))?;
                if !seen.insert(id.account.clone()) {
                    return Err(invalid(self.provider));
                }
                Ok(id)
            })
            .collect()
    }
    pub fn measure(
        &self,
        selected: &[Identity],
        paths: &Paths,
        stop: &Stop,
        interval: u64,
    ) -> (Vec<CollectionOutcome>, bool) {
        let input = selected.iter().map(|id| json!({"identity":id.wire})).collect::<Vec<_>>();
        let reply = self
            .invoke(json!({"version":1,"action":"measure","provider":self.provider,"accounts":input}), paths, stop)
            .and_then(|bytes| envelope(self.provider, &bytes, "results"));
        decode_measure(self.provider, selected, reply, interval)
    }
}

fn decode_measure(
    provider: Provider,
    selected: &[Identity],
    reply: Result<Vec<Value>, Failure>,
    interval: u64,
) -> (Vec<CollectionOutcome>, bool) {
    let reply = match reply {
        Ok(v) => v,
        Err(f) => return (selected.iter().map(|_| CollectionOutcome::Failed(f.clone())).collect(), false),
    };
    let mut by_account = BTreeMap::new();
    let mut diagnostic = false;
    for v in reply {
        let Ok(id) = identity(provider, &v["identity"]) else {
            diagnostic = true;
            continue;
        };
        if !selected.iter().any(|s| s.account == id.account) {
            diagnostic = true;
            continue;
        }
        let outcome = match v["status"].as_str() {
            Some("observed") => observed(provider, &id, &v, interval).map(CollectionOutcome::Observed),
            Some("no_new_data") => object(&v, &["identity", "status"]).map(|_| CollectionOutcome::NoNewData),
            Some("failed") => object(&v, &["identity", "status", "error"])
                .and_then(|_| serde_json::from_value(v["error"].clone()).map_err(|_| ()))
                .map(|error| {
                    CollectionOutcome::Failed(Failure::new(provider, error, "local collector reported failure"))
                }),
            _ => Err(()),
        }
        .unwrap_or_else(|_| CollectionOutcome::Failed(invalid(provider)));
        if by_account.insert(id.account.clone(), outcome).is_some() {
            by_account.insert(id.account, CollectionOutcome::Failed(invalid(provider)));
        }
    }
    (
        selected
            .iter()
            .map(|id| by_account.remove(&id.account).unwrap_or_else(|| CollectionOutcome::Failed(invalid(provider))))
            .collect(),
        diagnostic,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_independent_hook_combination_is_valid_and_old_keys_fail() {
        let executable = if cfg!(windows) { "C:/Tools/collector.exe" } else { "/bin/collector" };
        for mask in 0..8 {
            let mut config = String::new();
            for (bit, name) in ["collect", "on_collected", "on_collection_failed"].iter().enumerate() {
                if mask & (1 << bit) != 0 {
                    config += &format!(
                        "[providers.codex.hooks.{name}]\npath = '{executable}'\nargs = ['literal $HOME', 'x y']\n"
                    );
                }
            }
            let config = Config::parse(&config).unwrap();
            assert_eq!(Hook::configured(&config).len(), usize::from(mask & 1 != 0));
        }
        for text in [
            "[providers.codex.hook]\npath='/bin/sh'",
            "[providers.codex.hooks.other]\npath='/bin/sh'",
            "[providers.codex.hooks.collect]\npath='relative'",
            "[providers.codex.hooks.collect]\npath='/x.cmd'",
            "[providers.codex.hooks.collect]\npath='/x'\nextra=true",
        ] {
            assert!(Config::parse(text).is_err(), "{text}");
        }
        assert!(
            Config::parse(&format!(
                "[providers.codex]\npath='/native'\n[providers.codex.hooks.collect]\npath='{executable}'"
            ))
            .unwrap()
            .program(Provider::Codex)
            .is_some_and(|p| p == std::path::Path::new("/native"))
        );
    }
    #[test]
    fn default_identity_is_explicit_distinct_and_canonical() {
        let default = identity(Provider::Antigravity, &json!({"accountName":null})).unwrap();
        assert_eq!(default.account, AccountRef::Declared { account_name: None });
        assert!(identity(Provider::Antigravity, &json!({})).is_err());
        assert_ne!(default, identity(Provider::Antigravity, &json!({"accountName":"default"})).unwrap());
        assert_eq!(
            identity(Provider::Antigravity, &json!({"accountName":" Work "})).unwrap().account,
            identity(Provider::Antigravity, &json!({"accountName":"work"})).unwrap().account
        );
        assert!(identity(Provider::Codex, &json!({"accountId":"id","email":"extra"})).is_err());
        assert_eq!(
            identity(Provider::Codex, &json!({"accountId":"id"})).unwrap().account.account(),
            Some(pseudonym(Provider::Codex, "id").as_str())
        );
    }
    fn measured() -> Value {
        json!({"identity":{"accountId":"id"},"status":"observed","observedAt":"2026-01-01T00:00:00Z","windows":[{"id":"session","kind":"session","minutes":300,"usedPercent":12.5}]})
    }
    #[test]
    fn strict_resources_keep_exact_credits_and_independent_availability() {
        let id = identity(Provider::Codex, &json!({"accountId":"id"})).unwrap();
        let mut value = measured();
        assert_eq!(observed(Provider::Codex, &id, &value, 120_000).unwrap().windows[0].used_percent, 12.5);
        value["windows"] = json!([]);
        value["resourceStatus"] = json!({"windows":"missing","resets":"unsupported"});
        value["balances"] =
            json!([{"id":"balance:credits","unit":"credits:codex","status":"finite","amount":"0.000000000000000001"}]);
        assert_eq!(
            observed(Provider::Codex, &id, &value, 120_000).unwrap().balances.unwrap()[0].amount.as_deref(),
            Some("0.000000000000000001")
        );
        value["balances"][0]["amount"] = json!(0.25);
        assert!(observed(Provider::Codex, &id, &value, 120_000).is_err());
        value["balances"][0]["amount"] = json!("1.2");
        value["resourceStatus"]["windows"] = json!("observed");
        assert!(observed(Provider::Codex, &id, &value, 120_000).is_err());
        for (field, bad) in [
            ("observedAt", json!("bad")),
            ("windows", json!([{"id":"w","kind":"session","usedPercent":101}])),
            ("extra", json!(true)),
        ] {
            let mut v = measured();
            v[field] = bad;
            assert!(observed(Provider::Codex, &id, &v, 120_000).is_err());
        }
    }
    #[test]
    fn measure_items_are_independent_and_cannot_invent_accounts() {
        let a = identity(Provider::Codex, &json!({"accountId":"a"})).unwrap();
        let b = identity(Provider::Codex, &json!({"accountId":"b"})).unwrap();
        let mut valid = measured();
        valid["identity"] = a.wire.clone();
        let reply = vec![
            valid.clone(),
            json!({"identity":b.wire,"status":"no_new_data"}),
            json!({"identity":{"accountId":"unrequested"},"status":"no_new_data"}),
        ];
        let (results, diagnostic) = decode_measure(Provider::Codex, &[a.clone(), b.clone()], Ok(reply), 120_000);
        assert!(matches!(results[0], CollectionOutcome::Observed(_)));
        assert!(matches!(results[1], CollectionOutcome::NoNewData));
        assert!(diagnostic);
        let bad = json!({"identity":b.wire,"status":"no_new_data","observedAt":"2026-01-01T00:00:00Z"});
        let (results, _) =
            decode_measure(Provider::Codex, &[a.clone(), b.clone()], Ok(vec![valid.clone(), bad]), 120_000);
        assert!(matches!(results[0], CollectionOutcome::Observed(_)));
        assert!(matches!(results[1], CollectionOutcome::Failed(_)));
        let (results, _) = decode_measure(Provider::Codex, &[a, b], Ok(vec![valid.clone(), valid]), 120_000);
        assert!(results.iter().all(|r| matches!(r, CollectionOutcome::Failed(_))));
    }
    #[test]
    fn windows_and_resets_are_validated_before_normalization() {
        let id = identity(Provider::Codex, &json!({"accountId":"id"})).unwrap();
        for resets in [
            json!({"available":0,"expiring":[{"count":1}]}),
            json!({"available":2,"expiring":[{"count":1,"expiresAt":"bad"}]}),
            json!({"available":2,"expiring":[{"count":1},{"count":1,"expiresAt":"2026-01-01T00:00:00Z"}]}),
        ] {
            let mut v = measured();
            v["resets"] = resets;
            assert!(observed(Provider::Codex, &id, &v, 120_000).is_err());
        }
        let mut v = measured();
        v["windows"][0]["resetsAt"] = json!("invalid");
        assert!(observed(Provider::Codex, &id, &v, 120_000).is_err());
        v = measured();
        v["resets"] = json!({"available":0});
        assert_eq!(observed(Provider::Codex, &id, &v, 120_000).unwrap().resets.unwrap().available, 0);
    }
}
