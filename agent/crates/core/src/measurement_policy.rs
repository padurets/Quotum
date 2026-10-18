//! Last confirmed hub participation, independent of local configuration and activity.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::model::Provider;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectorPolicy {
    pub enabled: bool,
    pub epoch: u64,
    pub requires_epoch: bool,
    pub changed_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeasurementPolicy {
    pub version: u8,
    pub authority: String,
    pub revision: u64,
    pub enabled: bool,
    pub collectors: BTreeMap<Provider, CollectorPolicy>,
}

impl MeasurementPolicy {
    pub fn valid(&self) -> bool {
        self.version == 1
            && uuid(&self.authority)
            && self.revision < (1_u64 << 53)
            && self.collectors.len() == Provider::ALL.len()
            && Provider::ALL
                .iter()
                .all(|provider| self.collectors.get(provider).is_some_and(|gate| gate.epoch < (1_u64 << 53)))
    }

    pub fn allows(&self, provider: Provider) -> bool {
        self.enabled && self.collectors.get(&provider).is_some_and(|gate| gate.enabled)
    }

    pub fn attempt(&self, provider: Provider, account: Option<String>, command_id: Option<String>) -> AttemptContext {
        AttemptContext {
            version: 1,
            authority: self.authority.clone(),
            collector_epoch: self.collectors[&provider].epoch,
            target: account.map_or(AttemptTarget::Unknown, |account_key| AttemptTarget::Verified { account_key }),
            command_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttemptTarget {
    Verified {
        #[serde(rename = "accountKey")]
        account_key: String,
    },
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptContext {
    pub version: u8,
    pub authority: String,
    pub collector_epoch: u64,
    pub target: AttemptTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
        })
}

#[derive(Serialize, Deserialize)]
struct Stored {
    scope: String,
    policy: MeasurementPolicy,
}

/// Only an atomic durable save can be acknowledged; failed saves still enforce the learned gate.
pub struct PolicyCache {
    file: PathBuf,
    scope: String,
    pub policy: Option<MeasurementPolicy>,
    pub confirmed: bool,
    uncertain: bool,
}

impl PolicyCache {
    pub(crate) fn credential_scope(&self) -> String {
        self.scope.clone()
    }

    pub fn load(file: PathBuf, base: &str, machine: &str, token: &str) -> Self {
        let mut hash = Sha256::new();
        for part in [base, machine, token] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        let scope = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        let mut cache = Self { file, scope, policy: None, confirmed: false, uncertain: false };
        match fs::symlink_metadata(&cache.file) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 4096 => {
                let stored = fs::File::open(&cache.file).and_then(|file| {
                    let mut data = Vec::new();
                    file.take(4097).read_to_end(&mut data)?;
                    serde_json::from_slice::<Stored>(&data).map_err(io::Error::other)
                });
                match stored {
                    Ok(stored) if stored.scope == cache.scope && stored.policy.valid() => {
                        cache.policy = Some(stored.policy);
                        cache.confirmed = true;
                    }
                    Ok(stored) if stored.scope != cache.scope => {}
                    _ => cache.uncertain = true,
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => cache.uncertain = true,
        }
        cache
    }

    pub fn allows(&self, provider: Provider) -> bool {
        !self.uncertain && self.policy.as_ref().is_none_or(|policy| policy.allows(provider))
    }

    pub fn needs_contact(&self) -> bool {
        self.uncertain || self.policy.is_some()
    }

    pub fn learn(&mut self, policy: MeasurementPolicy) -> io::Result<()> {
        if !policy.valid() {
            return Err(io::Error::other("invalid measurement policy"));
        }
        if self
            .policy
            .as_ref()
            .is_some_and(|prior| prior.authority == policy.authority && prior.revision > policy.revision)
        {
            return Ok(());
        }
        if self.confirmed && self.policy.as_ref() == Some(&policy) {
            return Ok(());
        }
        self.policy = Some(policy);
        self.confirmed = false;
        self.uncertain = false;
        let text = serde_json::to_vec(&Stored { scope: self.scope.clone(), policy: self.policy.clone().unwrap() })
            .map_err(io::Error::other)?;
        if fs::symlink_metadata(&self.file).is_ok_and(|meta| !meta.is_file() || meta.file_type().is_symlink()) {
            return Err(io::Error::other("unsafe measurement policy file"));
        }
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nonce = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let next =
            self.file.with_extension(format!("json.new.{}.{}.{}", std::process::id(), crate::model::now_ms(), nonce));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&next)?;
        let saved = file.write_all(&text).and_then(|_| file.sync_all()).and_then(|_| fs::rename(&next, &self.file));
        if saved.is_err() {
            let _ = fs::remove_file(&next);
        }
        saved?;
        #[cfg(unix)]
        fs::File::open(self.file.parent().unwrap_or_else(|| std::path::Path::new(".")))?.sync_all()?;
        self.confirmed = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(enabled: bool) -> MeasurementPolicy {
        MeasurementPolicy {
            version: 1,
            authority: "11111111-1111-4111-8111-111111111111".into(),
            revision: 1,
            enabled,
            collectors: Provider::ALL
                .into_iter()
                .map(|p| (p, CollectorPolicy { enabled: true, epoch: 1, requires_epoch: true, changed_at: None }))
                .collect(),
        }
    }
    #[test]
    fn denial_survives_restart_missing_policy_and_profile_changes_do_not_inherit_it() {
        let file = std::env::temp_dir().join(format!("quotum-policy-{}.json", crate::model::now_ms()));
        let mut cache = PolicyCache::load(file.clone(), "https://example.com", "machine", "synthetic");
        assert!(cache.allows(Provider::Codex));
        cache.learn(policy(false)).unwrap();
        let restarted = PolicyCache::load(file.clone(), "https://example.com", "machine", "synthetic");
        assert!(!restarted.allows(Provider::Codex));
        assert!(restarted.confirmed);
        assert!(
            PolicyCache::load(file.clone(), "https://other.example.com", "machine", "synthetic")
                .allows(Provider::Codex)
        );
        cache.learn(MeasurementPolicy { revision: 2, ..policy(true) }).unwrap();
        assert!(cache.allows(Provider::Codex));
        let _ = fs::remove_file(file);
    }
    #[test]
    fn failed_persistence_enforces_gate_without_acknowledgement() {
        let file = std::env::temp_dir().join("quotum-absent-policy-parent").join("policy.json");
        let mut cache = PolicyCache::load(file, "https://example.com", "machine", "synthetic");
        assert!(cache.learn(policy(false)).is_err());
        assert!(!cache.confirmed);
        assert!(!cache.allows(Provider::Claude));
    }
}
