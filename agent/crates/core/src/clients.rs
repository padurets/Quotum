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
}

#[derive(PartialEq)]
struct Image {
    path: PathBuf,
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64),
}

#[derive(Default)]
pub struct Inventory {
    versions: BTreeMap<ClientId, (Image, Option<String>)>,
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
            let Ok(metadata) = path.metadata() else {
                self.versions.remove(&client);
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            #[cfg(unix)]
            use std::os::unix::fs::MetadataExt;
            let image = Image {
                path: path.clone(),
                length: metadata.len(),
                modified: metadata.modified().ok(),
                #[cfg(unix)]
                identity: (metadata.dev(), metadata.ino()),
            };
            if self.versions.get(&client).is_none_or(|(before, _)| *before != image) {
                let version = crate::process::Client::version_output(&path, work, stop)
                    .ok()
                    .and_then(|raw| String::from_utf8(raw).ok())
                    .and_then(|text| crate::providers::version_in(&text))
                    .filter(|version| {
                        version.len() <= 64
                            && version
                                .split('.')
                                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                    });
                self.versions.insert(client, (image, version));
            }
            found.push(InstalledClient { client_id: client, version: self.versions[&client].1.clone() });
        }
        found
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
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
