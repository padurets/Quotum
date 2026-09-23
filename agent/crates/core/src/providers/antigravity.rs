//! Antigravity: the `/usage` command of `agy` in print mode with JSON output
//! (agy 1.1.11+). It is answered locally, without a model request.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{Adapter, Context, VersionCache, locate, process_failure, version_tuple};
use crate::model::{
    ErrorKind, Failure, Kind, Millis, Outcome, Provider, SESSION_MINUTES, Snapshot, WEEK_MINUTES, Window, now_ms,
    parse_time,
};
use crate::process::Client;

const P: Provider = Provider::Antigravity;
pub const VIA: &str = "agy/usage";
/// Older versions have no `/usage` command and would send it to a model as a prompt.
const MIN_VERSION: (u32, u32, u32) = (1, 1, 11);
/// Names the agy version that took `/usage` for a prompt, in the state directory, so
/// no later run of the agent sends it again.
const OFF_FILE: &str = "agy-usage-off";

#[derive(Default)]
pub struct Antigravity {
    version: VersionCache,
    /// The agy version that took `/usage` for a prompt, as far as known in this run.
    off: Option<String>,
}

impl Adapter for Antigravity {
    fn provider(&self) -> Provider {
        P
    }

    fn program(&self) -> &'static str {
        "agy"
    }

    fn install_dirs(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".gemini/antigravity-cli/bin")]
    }

    fn measure(&mut self, ctx: &Context) -> Outcome {
        let program = locate(self, ctx)?;
        let off_file = ctx.state_dir.join(OFF_FILE);
        let off = self.off.clone().or_else(|| fs::read_to_string(&off_file).ok().map(|v| v.trim().to_string()));
        if off.is_some() {
            // Only another version can answer differently: ask for it every time (it is free).
            self.version.forget();
        }
        let version = self.version.get(&program, ctx);
        match &version {
            Some(v) if off.as_deref() == Some(v) => return Err(prompted(v)),
            Some(v) if version_tuple(v) >= MIN_VERSION => {}
            Some(v) => {
                return Err(Failure::new(
                    P,
                    ErrorKind::Unsupported,
                    format!("agy {v} has no /usage; 1.1.11 or newer is needed"),
                ));
            }
            None => return Err(Failure::new(P, ErrorKind::Failed, "agy --version did not answer")),
        }
        // agy writes a new log file per run into its own directory unless told otherwise.
        let log = ctx.state_dir.join("agy.log");
        let _ = fs::remove_file(&log);
        let args = [
            OsStr::new("-p"),
            OsStr::new("/usage"),
            OsStr::new("--output-format"),
            OsStr::new("json"),
            OsStr::new("--log-file"),
            log.as_os_str(),
        ];
        let mut client =
            Client::spawn(&program, &args, &[], ctx.work_dir, ctx.timeout).map_err(|e| process_failure(P, e))?;
        let output = client.output().map_err(|e| process_failure(P, e))?;
        drop(client);
        if let Some(v) = version.as_deref().filter(|_| took_as_prompt(&output)) {
            self.off = Some(v.to_string());
            let _ = fs::write(&off_file, v);
            return Err(prompted(v));
        }
        let mut snapshot = from_output(&output, now_ms())?;
        if off.is_some() {
            self.off = None;
            let _ = fs::remove_file(&off_file);
        }
        snapshot.client = version;
        Ok(snapshot)
    }

    fn activity_paths(&self, home: &Path) -> Vec<PathBuf> {
        let root = home.join(".gemini/antigravity-cli");
        vec![root.join("history.jsonl"), root.join("conversations")]
    }

    fn identifies_account(&self) -> bool {
        false
    }
}

/// Whether agy handled `/usage` as a prompt for a model instead of as its own command:
/// it then answers without the command block, or after model turns. Such a request may
/// cost the subscription, so it is not repeated with the same agy.
fn took_as_prompt(output: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(output.trim()) else { return false };
    value["num_turns"].as_f64().is_some_and(|turns| turns > 0.0)
        || (value["status"] == "SUCCESS" && value["command"].is_null())
}

/// The same text every time, so the agent's log shows it once.
fn prompted(version: &str) -> Failure {
    Failure::new(
        P,
        ErrorKind::Unsupported,
        format!(
            "agy {version} took /usage for a prompt, possibly a paid model request; not asked again until agy changes"
        ),
    )
}

/// Builds a snapshot from the JSON printed by `agy -p /usage --output-format json`.
pub fn from_output(output: &str, observed_at: Millis) -> Outcome {
    let value: Value = serde_json::from_str(output.trim())
        .map_err(|_| Failure::new(P, ErrorKind::InvalidOutput, "agy did not print JSON"))?;
    if value["status"] != "SUCCESS" {
        let message = value["error"].as_str().or(value["response"].as_str()).unwrap_or("agy /usage failed");
        let lower = message.to_lowercase();
        let kind = if ["login", "log in", "sign in", "auth"].iter().any(|w| lower.contains(w)) {
            ErrorKind::NotLoggedIn
        } else {
            ErrorKind::Failed
        };
        return Err(Failure::new(P, kind, message));
    }
    if value["command"]["name"] != "usage" {
        return Err(Failure::new(P, ErrorKind::Unsupported, "agy answered /usage without usage data"));
    }

    let mut windows = Vec::new();
    for group in value["command"]["data"]["groups"].as_array().into_iter().flatten() {
        let label = group["name"].as_str().map(short_group);
        for bucket in group["buckets"].as_array().into_iter().flatten() {
            let (Some(raw_id), Some(remaining)) = (bucket["id"].as_str(), bucket["remaining_fraction"].as_f64()) else {
                continue;
            };
            let window = bucket["window"].as_str().unwrap_or("");
            let minutes = match window {
                "5h" => Some(SESSION_MINUTES),
                "weekly" => Some(WEEK_MINUTES),
                _ => None,
            };
            let scope = raw_id.strip_suffix(&format!("-{window}")).unwrap_or(raw_id);
            let id = format!("{scope}:{}", Kind::of_minutes(minutes).slug(minutes));
            windows.push(Window::new(
                id,
                minutes,
                label.clone(),
                (1.0 - remaining) * 100.0,
                bucket["reset_time"].as_str().and_then(parse_time),
            ));
        }
    }
    // Within each group the 5-hour window first, like the other providers (the sort is stable).
    let group = |w: &Window| w.id.split(':').next().map(str::to_string);
    let groups: Vec<_> = windows.iter().map(group).fold(Vec::new(), |mut seen, g| {
        if !seen.contains(&g) {
            seen.push(g);
        }
        seen
    });
    windows.sort_by_key(|w| (groups.iter().position(|g| *g == group(w)), w.kind != Kind::Session));
    if windows.is_empty() {
        return Err(Failure::new(P, ErrorKind::InvalidOutput, "agy /usage has no limit windows"));
    }
    Ok(Snapshot {
        provider: P,
        account: None,
        account_name: None,
        plan: None,
        observed_at,
        via: VIA.into(),
        client: None,
        stale_after_ms: 0,
        windows,
        resets: None,
    })
}

/// "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude / GPT".
fn short_group(name: &str) -> String {
    let name = name.trim();
    let name = name.strip_suffix(" models").or_else(|| name.strip_suffix(" Models")).unwrap_or(name);
    name.replace(" and ", " / ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTPUT: &str = r#"{"conversation_id":"","status":"SUCCESS","response":"…","num_turns":0,
      "usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0},
      "command":{"name":"usage","data":{"groups":[
        {"name":"Gemini Models","buckets":[
          {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.9628010392189026,"reset_time":"2026-09-23T21:54:08Z"},
          {"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"2026-09-22T22:45:18Z"}]},
        {"name":"Claude and GPT models","buckets":[
          {"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-09-29T17:45:18Z"},
          {"id":"3p-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2026-09-22T22:45:18Z"}]}]}}}"#;

    #[test]
    fn both_model_groups_and_their_windows_are_read() {
        let s = from_output(OUTPUT, 1).unwrap();
        let ids: Vec<_> = s.windows.iter().map(|w| (w.id.as_str(), w.used_percent, w.label.as_deref())).collect();
        assert_eq!(
            ids,
            [
                ("gemini:session", 0.0, Some("Gemini")),
                ("gemini:weekly", 3.72, Some("Gemini")),
                ("3p:session", 50.0, Some("Claude / GPT")),
                ("3p:weekly", 0.0, Some("Claude / GPT")),
            ]
        );
        assert_eq!(s.windows[1].resets_at, parse_time("2026-09-23T21:54:08Z"));
    }

    #[test]
    fn failures_and_foreign_output_are_classified() {
        assert_eq!(from_output("not json", 1).unwrap_err().error, ErrorKind::InvalidOutput);
        let logged_out = r#"{"status":"ERROR","error":"Please sign in with agy login"}"#;
        assert_eq!(from_output(logged_out, 1).unwrap_err().error, ErrorKind::NotLoggedIn);
        let prompt = r#"{"status":"SUCCESS","response":"Here is how to check usage…","num_turns":1}"#;
        assert_eq!(from_output(prompt, 1).unwrap_err().error, ErrorKind::Unsupported);
    }

    #[test]
    fn an_answer_from_a_model_is_told_from_the_command() {
        assert!(!took_as_prompt(OUTPUT));
        assert!(took_as_prompt(r#"{"status":"SUCCESS","response":"Here is how to check usage…","num_turns":1}"#));
        assert!(took_as_prompt(r#"{"status":"SUCCESS","response":"Usage: …","num_turns":0}"#), "no command block");
        assert!(!took_as_prompt(r#"{"status":"ERROR","error":"Please sign in with agy login"}"#));
        assert!(!took_as_prompt("not json"));
    }

    /// A stand-in for agy that logs its arguments and answers /usage like a model.
    #[cfg(unix)]
    #[test]
    fn an_agy_that_took_usage_for_a_prompt_is_not_asked_again_until_it_changes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("quotum-agy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("agy");
        let script = |version: &str, answer: &str| {
            let text = format!(
                "#!/bin/sh\necho \"$1\" >> \"{calls}\"\nif [ \"$1\" = --version ]; then echo {version}; else echo '{answer}'; fi\n",
                calls = dir.join("calls").display()
            );
            fs::write(&program, text).unwrap();
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        };
        let ctx = Context {
            home: &dir,
            work_dir: &dir,
            state_dir: &dir,
            program: Some(program.as_path()),
            timeout: std::time::Duration::from_secs(10),
        };
        let calls = || fs::read_to_string(dir.join("calls")).unwrap_or_default().lines().collect::<Vec<_>>().join(" ");

        script("1.2.0", r#"{"status":"SUCCESS","response":"Sure! Usage…","num_turns":1}"#);
        let first = Antigravity::default().measure(&ctx).unwrap_err();
        // A new run of the agent remembers it too.
        let second = Antigravity::default().measure(&ctx).unwrap_err();
        assert_eq!(calls(), "--version -p --version");
        assert_eq!(first.detail, second.detail);
        assert!(first.detail.unwrap().contains("agy 1.2.0 took /usage for a prompt"));

        script("1.2.1", &OUTPUT.replace('\n', " "));
        let snapshot = Antigravity::default().measure(&ctx).unwrap();
        let off = dir.join(OFF_FILE).exists();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(snapshot.client.as_deref(), Some("1.2.1"));
        assert!(!off, "a new version that answers is trusted again");
    }
}
