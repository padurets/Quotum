//! Where measurements go. A hub gets them over HTTPS; while it is unreachable they
//! wait in a small on-disk spool and are sent oldest first once it answers again.

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::Hub;
use crate::model::{
    Batch, ErrorKind, Failure, INGEST_VERSION, Machine, Millis, Outcome, Owner, Provider, Snapshot, now_ms, parse_time,
};

pub trait Sink {
    fn deliver(&mut self, outcome: &Outcome);

    /// Asks whether this device should measure a subscription now. `Some(until)` means
    /// another device is on duty: wait until then. Without a hub, always measure.
    fn checkin(
        &mut self,
        _provider: Provider,
        _account: Option<&str>,
        _account_name: Option<&str>,
        _active: bool,
    ) -> Option<Millis> {
        None
    }
}

/// Discards everything; for running without a hub (the caller logs).
pub struct Discard;

impl Sink for Discard {
    fn deliver(&mut self, _: &Outcome) {}
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Item {
    Snapshot(Snapshot),
    Failure(Failure),
}

/// Keeps about two days of measurements of three providers every two minutes.
const SPOOL_LIMIT: usize = 5_000;
const CHUNK: usize = 200;

enum Delivery {
    Accepted,
    /// The hub will never take this batch (malformed, too large): drop it.
    Rejected(String),
    /// Try again later (network, hub down, token not accepted yet).
    Later(String),
}

pub struct HubSink {
    base: String,
    /// Cleared when the hub has no check-in endpoint (an older hub): then always measure.
    checkins: bool,
    token: String,
    machine: Machine,
    owner: Owner,
    http: ureq::Agent,
    spool_file: PathBuf,
    spool: VecDeque<Item>,
    /// The last problem reported, so a long outage is logged once.
    problem: Option<String>,
    log: Box<dyn FnMut(&str) + Send>,
}

impl HubSink {
    /// `owner`: whom the machine measures for, if configured.
    pub fn new(
        hub: &Hub,
        machine: Machine,
        owner: Owner,
        spool_file: PathBuf,
        log: Box<dyn FnMut(&str) + Send>,
    ) -> HubSink {
        let spool = fs::read_to_string(&spool_file)
            .map(|text| text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
            .unwrap_or_default();
        let http: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .user_agent(concat!("quotum/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        HubSink {
            base: hub.url.trim_end_matches('/').to_string(),
            checkins: true,
            token: hub.token.clone(),
            machine,
            owner,
            http,
            spool_file,
            spool,
            problem: None,
            log,
        }
    }

    fn post(&self, items: &[Item]) -> Delivery {
        let mut batch = Batch {
            version: INGEST_VERSION,
            agent: concat!("quotum/", env!("CARGO_PKG_VERSION")).into(),
            machine: self.machine.clone(),
            owner: self.owner.clone(),
            sent_at: now_ms(),
            snapshots: Vec::new(),
            failures: Vec::new(),
        };
        for item in items {
            match item {
                Item::Snapshot(s) => batch.snapshots.push(s.clone()),
                Item::Failure(f) => batch.failures.push(f.clone()),
            }
        }
        let response = self
            .http
            .post(&format!("{}/v1/ingest", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .send_json(&batch);
        match response {
            Ok(r) if r.status().is_success() => Delivery::Accepted,
            Ok(r) => match r.status().as_u16() {
                401 | 403 => Delivery::Later("the hub does not accept this token".into()),
                400 | 413 | 422 => {
                    Delivery::Rejected(format!("the hub refused the data (HTTP {})", r.status().as_u16()))
                }
                code => Delivery::Later(format!("the hub answered HTTP {code}")),
            },
            Err(e) => Delivery::Later(format!("the hub is unreachable: {e}")),
        }
    }

    fn save_spool(&self) {
        if self.spool.is_empty() {
            let _ = fs::remove_file(&self.spool_file);
            return;
        }
        let text: String = self.spool.iter().filter_map(|i| serde_json::to_string(i).ok()).map(|l| l + "\n").collect();
        let _ = fs::write(&self.spool_file, text);
    }

    fn report(&mut self, problem: Option<String>) {
        if problem != self.problem {
            match &problem {
                Some(p) => (self.log)(&format!("delivery: {p}; keeping measurements ({} waiting)", self.spool.len())),
                None if self.problem.is_some() => (self.log)("delivery: the hub answers again"),
                None => {}
            }
            self.problem = problem;
        }
    }
}

impl Sink for HubSink {
    fn deliver(&mut self, outcome: &Outcome) {
        match outcome {
            Ok(snapshot) => self.spool.push_back(Item::Snapshot(snapshot.clone())),
            // What is not installed here is none of the hub's business.
            Err(failure) if failure.error == ErrorKind::NotInstalled => {}
            Err(failure) => self.spool.push_back(Item::Failure(failure.clone())),
        }
        while self.spool.len() > SPOOL_LIMIT {
            self.spool.pop_front();
        }
        let had_backlog = self.spool.len() > 1;
        let mut problem = None;
        while !self.spool.is_empty() {
            let count = self.spool.len().min(CHUNK);
            let chunk: Vec<Item> = self.spool.iter().take(count).cloned().collect();
            match self.post(&chunk) {
                Delivery::Accepted => {
                    self.spool.drain(..count);
                }
                Delivery::Rejected(reason) => {
                    self.spool.drain(..count);
                    (self.log)(&format!("delivery: {reason}; dropped {count} measurements"));
                }
                Delivery::Later(reason) => {
                    problem = Some(reason);
                    break;
                }
            }
        }
        if had_backlog || !self.spool.is_empty() {
            self.save_spool();
        }
        self.report(problem);
    }

    fn checkin(
        &mut self,
        provider: Provider,
        account: Option<&str>,
        account_name: Option<&str>,
        active: bool,
    ) -> Option<Millis> {
        if !self.checkins {
            return None;
        }
        let request = serde_json::json!({
            "version": INGEST_VERSION,
            "agent": concat!("quotum/", env!("CARGO_PKG_VERSION")),
            "machine": self.machine,
            "owner": self.owner,
            "subscriptions": [{"provider": provider, "account": account, "accountName": account_name, "active": active}],
        });
        let url = format!("{}/v1/checkin", self.base);
        let mut response =
            self.http.post(&url).header("Authorization", &format!("Bearer {}", self.token)).send_json(&request).ok()?;
        if response.status().as_u16() == 404 {
            self.checkins = false;
            return None;
        }
        if !response.status().is_success() {
            return None;
        }
        let body: serde_json::Value = response.body_mut().read_json().ok()?;
        let directive = &body["subscriptions"][0];
        if directive["measure"] != false {
            return None;
        }
        directive["until"].as_str().and_then(parse_time)
    }
}
