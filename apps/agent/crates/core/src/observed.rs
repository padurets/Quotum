//! Completed activity observations. Presence and delivery never extend their duration.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::model::Millis;

pub(crate) mod cadence;
pub(crate) mod clock;
pub(crate) mod cost;
pub(crate) mod delivery;
#[cfg(test)]
mod fault;
pub(crate) mod outbox;
pub(crate) mod privacy;
#[cfg(all(feature = "activity-bench", target_os = "linux"))]
pub mod probe;
pub mod recovery;
pub(crate) mod worker;

pub struct Target {
    pub namespace: String,
    pub credential_scope: String,
}
pub enum Answer {
    Accepted(Value),
    Unsupported,
    Conflict(Value),
    Unanswered,
}

/// Persist privacy restrictions even when the application does not start a Runner.
pub fn update_privacy(paths: &crate::config::Paths, config: &crate::config::Config) -> std::io::Result<String> {
    let clients = crate::clients::ClientId::ALL.into_iter().filter(|c| config.tracks(*c)).collect::<Vec<_>>();
    let route_disabled = crate::clients::ClientId::ALL.into_iter().filter(|c| !config.routes(*c)).collect::<Vec<_>>();
    privacy::update(paths, config.sessions() && !clients.is_empty(), config.projects(), &clients, &route_disabled)
}

/// Pending application policy publication, including when no capture Runner is needed.
/// Callers serialize config acceptance and pass the latest config on every attempt.
#[derive(Default)]
pub struct PrivacyUpdate {
    pending: bool,
    retire: bool,
    retry: recovery::Retry,
    due: Option<std::time::Instant>,
    health: recovery::Health,
}

impl PrivacyUpdate {
    pub fn pending(&self) -> bool {
        self.pending
    }
    pub fn health(&self) -> &recovery::Health {
        &self.health
    }

    pub fn accept(
        &mut self,
        paths: &crate::config::Paths,
        config: &crate::config::Config,
        restriction: bool,
        stop: &crate::stop::Stop,
    ) -> Result<(), recovery::Failure> {
        self.retire |= restriction;
        self.pending = true;
        self.attempt(paths, config, stop)
    }

    pub fn retry(
        &mut self,
        paths: &crate::config::Paths,
        config: &crate::config::Config,
        stop: &crate::stop::Stop,
    ) -> bool {
        if !self.pending
            || stop.requested()
            || self.health.terminal
            || self.due.is_some_and(|due| std::time::Instant::now() < due)
        {
            return false;
        }
        self.attempt(paths, config, stop).is_ok()
    }

    fn attempt(
        &mut self,
        paths: &crate::config::Paths,
        config: &crate::config::Config,
        stop: &crate::stop::Stop,
    ) -> Result<(), recovery::Failure> {
        let clients = crate::clients::ClientId::ALL.into_iter().filter(|c| config.tracks(*c)).collect::<Vec<_>>();
        let routes = crate::clients::ClientId::ALL.into_iter().filter(|c| !config.routes(*c)).collect::<Vec<_>>();
        match privacy::try_update(
            paths,
            config.sessions() && !clients.is_empty(),
            config.projects(),
            &clients,
            &routes,
            self.retire,
            Some(stop),
        ) {
            Ok(_) => {
                self.pending = false;
                self.retire = false;
                self.due = None;
                self.retry.reset();
                self.health.observed();
                Ok(())
            }
            Err(error) => {
                let failure = recovery::Failure::new("privacy", &error);
                self.health.fail(failure);
                self.due = Some(std::time::Instant::now() + self.retry.failed());
                Err(failure)
            }
        }
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    use crate::config::{Config, Paths};
    use std::time::{Duration, Instant};

    #[test]
    fn pending_off_on_keeps_a_restriction_even_before_its_first_successful_publication() {
        let root = std::env::temp_dir().join(format!("quotum-policy-retry-{}", crate::config::random_hex()));
        let paths = Paths { config: root.join("config"), state: root.clone(), work: root.join("work") };
        let on = Config::default();
        let before = update_privacy(&paths, &on).unwrap();
        let held = crate::config::lock_file(&root.join("activity-policy.lock")).unwrap();
        let mut pending = PrivacyUpdate::default();
        let stop = crate::stop::Stop::new();
        let start = Instant::now();
        assert!(pending.accept(&paths, &Config::parse("sessions=false").unwrap(), true, &stop).unwrap_err().retryable);
        assert!(pending.accept(&paths, &on, false, &stop).unwrap_err().retryable);
        assert!(start.elapsed() < Duration::from_secs(1), "policy lock waits never block the coordinator");
        drop(held);
        pending.due = None;
        assert!(pending.retry(&paths, &on, &stop));
        assert!(!pending.pending());
        assert_ne!(before, update_privacy(&paths, &on).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub(crate) const BODY_BYTES: usize = 512 * 1024;
// Two full states can gain UTC date digits; clock, proof and sender fields still need room.
pub(crate) const BODY_RESERVE_BYTES: usize = 24 * 1024;
pub(crate) const MAX_FRAMES: usize = 64;
pub(crate) const MAX_FRAME_MS: u64 = 200_000;
pub(crate) const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub version: u8,
    pub clients: Vec<String>,
    pub route_disabled: Vec<String>,
    pub complete: bool,
}

impl Scope {
    pub fn digest(&self) -> String {
        digest(&json!([self.clients, self.route_disabled]))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub provider: String,
    pub account: Option<String>,
    pub account_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub class: String,
    pub by: String,
    pub host: Option<String>,
    pub provider: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub context_id: String,
    pub client_id: String,
    pub session_id: Option<String>,
    pub ordinal: Option<u32>,
    pub source: Option<Source>,
    pub account_by: Option<String>,
    pub origin: String,
    pub project: Option<String>,
    pub folder: Option<String>,
    pub started_at: Millis,
    pub route: Option<Route>,
    pub working: Option<bool>,
    pub last_worked_at: Option<Millis>,
}

struct ContextTuple<'a>(&'a Context);
impl Serialize for ContextTuple<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let c = self.0;
        (
            &c.context_id,
            &c.client_id,
            &c.session_id,
            c.ordinal,
            c.source.as_ref().map(|s| (&s.provider, &s.account, &s.account_name)),
            &c.account_by,
            &c.origin,
            &c.project,
            &c.folder,
            c.started_at,
            c.route.as_ref().map(|r| (&r.class, &r.by, &r.host, &r.provider)),
            c.working,
            c.last_worked_at,
        )
            .serialize(serializer)
    }
}
struct ContextTuples<'a>(&'a [Context]);
impl Serialize for ContextTuples<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for context in self.0 {
            sequence.serialize_element(&ContextTuple(context))?;
        }
        sequence.end()
    }
}
struct StateTuple<'a>(&'a State);
impl Serialize for StateTuple<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let state = self.0;
        (
            &state.tracking.clients,
            &state.tracking.route_disabled,
            state.tracking.complete,
            ContextTuples(&state.contexts),
        )
            .serialize(serializer)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct State {
    pub tracking: Scope,
    pub contexts: Vec<Context>,
}

impl State {
    pub fn normalize(&mut self) {
        self.tracking.clients.sort();
        self.tracking.route_disabled.sort();
        self.contexts.sort_by(|a, b| a.context_id.cmp(&b.context_id));
    }

    pub fn digest(&self) -> String {
        hash_serialized(&StateTuple(self))
    }
}

struct HashWriter(Sha256);
impl std::io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn hash_serialized(value: &impl Serialize) -> String {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).expect("activity tuple serialization");
    writer.0.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn digest(value: &Value) -> String {
    hash_serialized(value)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub clock_epoch: String,
    pub anchor_tick: u64,
    pub anchor_at: Millis,
}

impl Anchor {
    pub fn project(&self, tick: u64) -> Option<Millis> {
        let at = i128::from(self.anchor_at) + i128::from(tick) - i128::from(self.anchor_tick);
        (0..=i128::from(SAFE_INTEGER)).contains(&at).then_some(at as Millis)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Witness {
    pub id: String,
    pub topology_version: u64,
    pub scope_digest: String,
    pub issued_at: Millis,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub clock_epoch: String,
    pub tick: u64,
    pub state: Arc<State>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub seq: u64,
    pub capture_epoch: String,
    pub clock_epoch: String,
    pub from_at: Millis,
    pub to_at: Millis,
    pub from_tick: u64,
    pub to_tick: u64,
    pub base_state_digest: String,
    pub next_state: Option<Arc<State>>,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loss {
    pub first_seq: u64,
    pub last_seq: u64,
    pub from_at: Option<Millis>,
    pub to_at: Option<Millis>,
    pub reason: String,
}

/// Immutable journal projection. The sender supplies the authenticated envelope for each attempt.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub clock_anchor: Option<Anchor>,
    pub topology_witness_id: Option<String>,
    pub checkpoint: Option<Arc<State>>,
    pub frames: Vec<Frame>,
    pub skip: Option<Loss>,
    pub release_witnesses: Vec<String>,
}
