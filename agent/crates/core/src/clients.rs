//! Coding clients and their local discovery, independent of subscription collectors.

use crate::config::Config;
use crate::model::Provider;
use crate::process::{find_program, usual_dirs};
use crate::stop::Stop;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientId {
    Claude,
    Codex,
    Antigravity,
    OpenCode,
}

impl ClientId {
    pub const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Antigravity, Self::OpenCode];
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
            Self::OpenCode => "opencode",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::OpenCode => "OpenCode",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        let value = match value {
            "agy" => "antigravity",
            _ => value,
        };
        Self::ALL.into_iter().find(|client| client.id() == value)
    }
    pub fn by_process_name(name: &str) -> Option<Self> {
        match name.strip_suffix(".exe").unwrap_or(name) {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "agy" => Some(Self::Antigravity),
            "opencode" => Some(Self::OpenCode),
            _ => None,
        }
    }
    pub fn collector(self) -> Option<Provider> {
        match self {
            Self::Claude => Some(Provider::Claude),
            Self::Codex => Some(Provider::Codex),
            Self::Antigravity => Some(Provider::Antigravity),
            Self::OpenCode => None,
        }
    }
    pub fn program(self) -> &'static str {
        match self {
            Self::Antigravity => "agy",
            _ => self.id(),
        }
    }
    pub fn directories(self, home: &Path) -> Vec<PathBuf> {
        let install = match self {
            Self::Claude => {
                vec![home.join(".claude/local")]
            }
            Self::Codex => {
                // And where the installer of the command-line client puts it on Windows.
                let installer = dirs::data_local_dir().filter(|_| cfg!(windows));
                let installer = installer.map(|local| local.join("Programs").join("OpenAI").join("Codex").join("bin"));
                std::iter::once(home.join(".codex/bin")).chain(installer).collect()
            }
            Self::Antigravity => {
                let installer =
                    dirs::data_local_dir().filter(|_| cfg!(windows)).map(|local| local.join("agy").join("bin"));
                installer.into_iter().chain(std::iter::once(home.join(".gemini/antigravity-cli/bin"))).collect()
            }
            Self::OpenCode => vec![home.join(".opencode/bin")],
        };
        let fallback = if self == Self::Codex {
            let mut found = Vec::new();
            if cfg!(target_os = "linux") {
                found.push(PathBuf::from("/usr/lib/chatgpt/resources"));
            }
            if cfg!(windows) {
                found.extend(
                    dirs::data_local_dir()
                        .map(|local| crate::providers::codex::app_clients(&local))
                        .unwrap_or_default(),
                );
            }
            found.extend(crate::providers::codex::extension_clients(home));
            found
        } else {
            Vec::new()
        };
        [install, usual_dirs(home), fallback].concat()
    }
    pub fn find(self, home: &Path) -> Option<PathBuf> {
        find_program(self.program(), &self.directories(home))
    }
}
impl From<Provider> for ClientId {
    fn from(provider: Provider) -> Self {
        match provider {
            Provider::Claude => Self::Claude,
            Provider::Codex => Self::Codex,
            Provider::Antigravity => Self::Antigravity,
        }
    }
}
impl std::fmt::Display for ClientId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledClient {
    pub client_id: ClientId,
    pub version: Option<String>,
    #[serde(with = "crate::model::ts::option")]
    pub observed_at: Option<crate::model::Millis>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Image {
    path: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64),
}

pub(crate) fn executable_image(path: &Path) -> Option<Image> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(Image {
        path: path.to_path_buf(),
        length: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        identity: (metadata.dev(), metadata.ino()),
    })
}

struct VersionObservation {
    image: Image,
    version: Option<String>,
    observed_at: crate::model::Millis,
    due: std::time::Instant,
    failures: u32,
}

pub(crate) fn fresh_version(
    path: &Path,
    work: &Path,
    stop: &Stop,
) -> Result<Option<String>, crate::process::ProcError> {
    let raw = crate::process::Client::version_output(path, work, stop)?;
    Ok(std::str::from_utf8(&raw).ok().and_then(crate::providers::version_in).filter(|version| version.len() <= 64))
}

#[derive(Default)]
pub struct Inventory {
    versions: BTreeMap<ClientId, VersionObservation>,
}

impl Inventory {
    pub fn look(
        &mut self,
        config: &Config,
        clients: &[ClientId],
        home: &Path,
        work: &Path,
        stop: &Stop,
    ) -> Vec<InstalledClient> {
        self.look_running(config, clients, home, work, stop, &BTreeMap::new())
    }

    pub fn look_running(
        &mut self,
        config: &Config,
        clients: &[ClientId],
        home: &Path,
        work: &Path,
        stop: &Stop,
        running: &BTreeMap<ClientId, PathBuf>,
    ) -> Vec<InstalledClient> {
        let mut found = Vec::new();
        for &client in clients {
            let path = config
                .client_program(client)
                .map(Path::to_path_buf)
                .or_else(|| client.find(home))
                .or_else(|| running.get(&client).cloned());
            let Some(path) = path else {
                self.versions.remove(&client);
                continue;
            };
            let Some(image) = executable_image(&path) else {
                self.versions.remove(&client);
                continue;
            };
            let now = std::time::Instant::now();
            if self.versions.get(&client).is_none_or(|before| before.image != image || now >= before.due) {
                let prior = self
                    .versions
                    .get(&client)
                    .filter(|before| before.image == image)
                    .map_or(0, |before| before.failures);
                let (version, failures, ttl) = match fresh_version(&path, work, stop) {
                    Ok(Some(version)) => (Some(version), 0, 6 * 3600),
                    Ok(None) => (None, prior + 1, 900),
                    Err(_) => (None, prior + 1, (60_u64 << (prior.min(4))).min(900)),
                };
                self.versions.insert(
                    client,
                    VersionObservation {
                        image,
                        version,
                        observed_at: crate::model::now_ms(),
                        due: now + std::time::Duration::from_secs(ttl),
                        failures,
                    },
                );
            }
            let observation = &self.versions[&client];
            found.push(InstalledClient {
                client_id: client,
                version: observation.version.clone(),
                observed_at: Some(observation.observed_at),
            });
        }
        found
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn inventory_cache_has_bounded_recovery_while_measurement_probes_are_fresh() {
        let dir =
            std::env::temp_dir().join(format!("quotum-version-{}-{}", std::process::id(), crate::model::now_ms()));
        std::fs::create_dir(&dir).unwrap();
        let program = dir.join("client");
        let payload = dir.join("version");
        std::fs::write(
            &program,
            format!("#!/bin/sh\nprintf x >> '{}/calls'\ncat '{}'\n", dir.display(), payload.display()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&payload, "1.2.3").unwrap();
        let mut config = Config::default();
        config.clients.insert(
            "opencode".into(),
            crate::config::ClientSettings { path: Some(program.clone()), ..Default::default() },
        );
        let mut inventory = Inventory::default();
        let stop = Stop::new();
        let look = |inventory: &mut Inventory| inventory.look(&config, &[ClientId::OpenCode], &dir, &dir, &stop);
        let first = look(&mut inventory);
        std::fs::write(&payload, "2.3.4").unwrap();
        assert_eq!(look(&mut inventory), first, "the installed observation retains its actual time and version");
        for _ in 0..2 {
            assert_eq!(fresh_version(&program, &dir, &stop).unwrap().as_deref(), Some("2.3.4"));
        }
        assert_eq!(std::fs::read_to_string(dir.join("calls")).unwrap(), "xxx");
        inventory.versions.get_mut(&ClientId::OpenCode).unwrap().due = std::time::Instant::now();
        assert_eq!(look(&mut inventory)[0].version.as_deref(), Some("2.3.4"));
        std::fs::write(&payload, "1..3").unwrap();
        inventory.versions.get_mut(&ClientId::OpenCode).unwrap().due = std::time::Instant::now();
        assert!(look(&mut inventory)[0].version.is_none());
        let due = inventory.versions[&ClientId::OpenCode].due;
        assert!(due.saturating_duration_since(std::time::Instant::now()).as_secs() >= 898);
        let before = std::fs::read_to_string(dir.join("calls")).unwrap();
        look(&mut inventory);
        assert_eq!(std::fs::read_to_string(dir.join("calls")).unwrap(), before);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn inventory_reprobes_only_a_changed_executable_and_removes_missing_clients() {
        let dir =
            std::env::temp_dir().join(format!("quotum-inventory-{}-{}", std::process::id(), crate::model::now_ms()));
        std::fs::create_dir(&dir).unwrap();
        let program = dir.join("opencode");
        let write = |version: &str| {
            std::fs::write(
                &program,
                format!("#!/bin/sh\nprintf x >> '{}/calls'\nprintf '{}\\n'\n", dir.display(), version),
            )
            .unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        write("1.2.3");
        let mut config = Config::default();
        config.clients.insert(
            "opencode".into(),
            crate::config::ClientSettings { path: Some(program.clone()), ..Default::default() },
        );
        let mut inventory = Inventory::default();
        let look = |inventory: &mut Inventory| inventory.look(&config, &[ClientId::OpenCode], &dir, &dir, &Stop::new());
        assert_eq!(look(&mut inventory)[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(look(&mut inventory)[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(std::fs::read_to_string(dir.join("calls")).unwrap(), "x");
        write("2.12.34");
        assert_eq!(look(&mut inventory)[0].version.as_deref(), Some("2.12.34"));
        write("no version");
        assert_eq!(look(&mut inventory)[0].version, None);
        assert_eq!(look(&mut inventory)[0].version, None);
        assert_eq!(std::fs::read_to_string(dir.join("calls")).unwrap(), "xxx");
        std::fs::remove_file(program).unwrap();
        assert!(look(&mut inventory).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
