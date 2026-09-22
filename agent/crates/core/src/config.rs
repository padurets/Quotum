//! Settings: one TOML file, overridable from the environment. Everything has a
//! default, so the agent works without any file at all.

use std::collections::BTreeMap;
use std::collections::hash_map::RandomState;
use std::env;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{Machine, Provider, now_ms};
use crate::schedule::{DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS};

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Seconds between two measurements of one provider (at least 60, default 120).
    pub interval: Option<u64>,
    /// Measure providers less often while nobody uses them (default on).
    pub eco: Option<bool>,
    /// Whom this machine measures for on a shared board (default: the e-mail an
    /// installed client is signed in with). Not needed when connected with a code.
    pub owner: Option<String>,
    pub hub: Option<Hub>,
    pub machine: MachineSettings,
    pub providers: BTreeMap<Provider, ProviderSettings>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Hub {
    /// Base URL of the hub; measurements go to `<url>/v1/ingest`.
    pub url: String,
    pub token: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MachineSettings {
    /// How this machine is shown on the hub (default: the host name).
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderSettings {
    pub enabled: Option<bool>,
    /// Seconds; overrides the global interval for this provider.
    pub interval: Option<u64>,
    /// Path to the client, when it is not on PATH.
    pub path: Option<PathBuf>,
    /// A name for this subscription when the client does not identify the account
    /// (Antigravity), to tell two subscriptions of one owner apart.
    pub account: Option<String>,
}

impl Config {
    /// Reads `path` (a missing file means defaults) and applies environment overrides.
    pub fn load(path: &Path) -> Result<Config, String> {
        let mut config = match fs::read_to_string(path) {
            Ok(text) => toml::from_str::<Config>(&text).map_err(|e| format!("{}: {e}", path.display()))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        config.apply_env(|key| env::var(key).ok().filter(|v| !v.is_empty()));
        Ok(config)
    }

    fn apply_env(&mut self, var: impl Fn(&str) -> Option<String>) {
        if let Some(seconds) = var("AGENT_LIMITS_INTERVAL").and_then(|v| v.parse().ok()) {
            self.interval = Some(seconds);
        }
        if let Some(owner) = var("AGENT_LIMITS_OWNER") {
            self.owner = Some(owner);
        }
        match (var("AGENT_LIMITS_HUB_URL"), var("AGENT_LIMITS_HUB_TOKEN")) {
            (Some(url), Some(token)) => self.hub = Some(Hub { url, token }),
            (Some(url), None) => {
                if let Some(hub) = &mut self.hub {
                    hub.url = url;
                }
            }
            (None, Some(token)) => {
                if let Some(hub) = &mut self.hub {
                    hub.token = token;
                }
            }
            (None, None) => {}
        }
    }

    pub fn enabled(&self, provider: Provider) -> bool {
        self.providers.get(&provider).and_then(|p| p.enabled).unwrap_or(true)
    }

    pub fn interval_ms(&self, provider: Provider) -> u64 {
        let seconds = self.providers.get(&provider).and_then(|p| p.interval).or(self.interval);
        seconds.map(|s| s.saturating_mul(1000)).unwrap_or(DEFAULT_INTERVAL_MS).max(MIN_INTERVAL_MS)
    }

    pub fn eco(&self) -> bool {
        self.eco.unwrap_or(true)
    }

    pub fn program(&self, provider: Provider) -> Option<&Path> {
        self.providers.get(&provider).and_then(|p| p.path.as_deref())
    }

    pub fn account_name(&self, provider: Provider) -> Option<&str> {
        self.providers.get(&provider).and_then(|p| p.account.as_deref())
    }
}

/// What `agent-limits connect` receives from a hub: its address and this device's token.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Credentials {
    pub url: String,
    pub token: String,
    pub board: String,
    pub owner: String,
}

impl Credentials {
    fn file(paths: &Paths) -> PathBuf {
        paths.state.join("credentials.json")
    }

    pub fn load(paths: &Paths) -> Option<Credentials> {
        serde_json::from_slice(&fs::read(Self::file(paths)).ok()?).ok()
    }

    /// Written readable by the user only.
    pub fn save(&self, paths: &Paths) -> io::Result<()> {
        let file = Self::file(paths);
        let text = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut out = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file)?;
            out.write_all(&text)
        }
        #[cfg(not(unix))]
        fs::write(file, text)
    }

    pub fn remove(paths: &Paths) -> bool {
        fs::remove_file(Self::file(paths)).is_ok()
    }
}

impl Config {
    /// The hub to deliver to: from the settings or environment, else the one connected with a code.
    pub fn hub_or_connected(&self, paths: &Paths) -> Option<Hub> {
        self.hub.clone().or_else(|| Credentials::load(paths).map(|c| Hub { url: c.url, token: c.token }))
    }
}

/// Where the agent keeps its files.
#[derive(Clone, Debug)]
pub struct Paths {
    pub config: PathBuf,
    /// Machine id, delivery spool, client logs.
    pub state: PathBuf,
    /// Empty working directory for client processes.
    pub work: PathBuf,
}

impl Paths {
    pub fn resolve() -> Paths {
        let config = env::var_os("AGENT_LIMITS_CONFIG").map(PathBuf::from).unwrap_or_else(|| {
            dirs::config_dir().unwrap_or_else(|| home().join(".config")).join("agent-limits").join("config.toml")
        });
        let state = env::var_os("AGENT_LIMITS_STATE_DIR").map(PathBuf::from).unwrap_or_else(|| {
            dirs::state_dir()
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(|| home().join(".local/state"))
                .join("agent-limits")
        });
        let work = state.join("work");
        Paths { config, state, work }
    }

    pub fn ensure(&self) -> io::Result<()> {
        fs::create_dir_all(&self.work)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.state, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// This machine as the hub sees it. The id is random and created on first use.
pub fn machine(paths: &Paths, config: &Config) -> Machine {
    let file = paths.state.join("machine-id");
    let id =
        fs::read_to_string(&file).ok().map(|s| s.trim().to_string()).filter(|s| s.len() >= 16).unwrap_or_else(|| {
            let id = random_hex();
            let _ = fs::write(&file, &id);
            id
        });
    Machine {
        id,
        name: config.machine.name.clone().unwrap_or_else(hostname),
        os: env::consts::OS.into(),
        arch: env::consts::ARCH.into(),
    }
}

/// 128 random bits as hex, from the standard library's per-process random keys.
fn random_hex() -> String {
    (0..2u8)
        .map(|i| {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_i64(now_ms());
            hasher.write_u32(std::process::id());
            hasher.write_u8(i);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

/// A number in [-1, 1] for scheduling jitter.
pub fn jitter() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now_ms());
    (hasher.finish() as f64 / u64::MAX as f64) * 2.0 - 1.0
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed along.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        if ok {
            let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
            if let Ok(name) = std::str::from_utf8(&buffer[..end]) {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    env::var("COMPUTERNAME").or_else(|_| env::var("HOSTNAME")).unwrap_or_else(|_| "machine".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_defaults() {
        let config = Config::load(Path::new("/nonexistent/agent-limits.toml")).unwrap();
        assert!(config.enabled(Provider::Claude) && config.eco());
        assert_eq!(config.interval_ms(Provider::Codex), DEFAULT_INTERVAL_MS);
    }

    #[test]
    fn per_provider_settings_override_the_global_ones_and_a_minute_is_the_floor() {
        let config: Config = toml::from_str(
            r#"
            interval = 300
            eco = false
            [hub]
            url = "https://limits.example.com"
            token = "t"
            [providers.claude]
            interval = 10
            [providers.antigravity]
            enabled = false
            "#,
        )
        .unwrap();
        assert_eq!(config.interval_ms(Provider::Codex), 300_000);
        assert_eq!(config.interval_ms(Provider::Claude), MIN_INTERVAL_MS);
        assert!(!config.enabled(Provider::Antigravity) && !config.eco());
        assert!(
            toml::from_str::<Config>("[providers.cursor]\nenabled = true").is_err(),
            "unknown providers are errors"
        );
    }

    #[test]
    fn the_environment_can_point_the_agent_at_a_hub() {
        let mut config = Config::default();
        config.apply_env(|key| match key {
            "AGENT_LIMITS_HUB_URL" => Some("https://hub.example".into()),
            "AGENT_LIMITS_HUB_TOKEN" => Some("secret".into()),
            "AGENT_LIMITS_INTERVAL" => Some("90".into()),
            _ => None,
        });
        assert_eq!(config.hub, Some(Hub { url: "https://hub.example".into(), token: "secret".into() }));
        assert_eq!(config.interval_ms(Provider::Claude), 90_000);
    }

    #[test]
    fn jitter_stays_in_range() {
        assert!((0..100).map(|_| jitter()).all(|j| (-1.0..=1.0).contains(&j)));
    }
}
