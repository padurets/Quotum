//! The coordinator owns network calls; the capture writer receives only bounded controls.

use std::collections::BTreeMap;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::outbox::Binding;
use super::worker::{Account, Capture, Control, Worker};
use super::{Answer, BODY_BYTES, Batch, Latest, SAFE_INTEGER, Witness};
use crate::clients::{ClientId, InstalledClient};
use crate::model::{ClientSession, ClientSource, Provider, RunningSession, SessionReport, Tracking, now_ms};
use crate::sink::Sink;

#[derive(Clone, Copy)]
enum Mode {
    Hello,
    Intervals,
    Legacy(Instant),
    Unavailable,
}

pub(crate) struct Delivery {
    pub worker: Worker,
    mode: Mode,
    due: Instant,
    failures: u32,
    refresh: bool,
    replace: Option<String>,
    pending: Option<Control>,
    preparing: Option<mpsc::Receiver<std::io::Result<Batch>>>,
    batch: Option<Arc<Batch>>,
    accounts: BTreeMap<ClientId, Account>,
    last_state: Option<String>,
    last_live: Option<Instant>,
    last_history: Option<Instant>,
    legacy: Option<(Instant, SessionReport)>,
    legacy_fault: bool,
    known: bool,
    inventory: Option<Vec<InstalledClient>>,
    drain_through: u64,
    proof_retry: Option<Instant>,
    rollback_probe: bool,
}

impl Delivery {
    pub fn new(worker: Worker) -> Self {
        Self {
            worker,
            mode: Mode::Hello,
            due: Instant::now(),
            failures: 0,
            refresh: false,
            replace: None,
            pending: None,
            preparing: None,
            batch: None,
            accounts: BTreeMap::new(),
            last_state: None,
            last_live: None,
            last_history: None,
            legacy: None,
            legacy_fault: true,
            known: false,
            inventory: None,
            drain_through: 0,
            proof_retry: None,
            rollback_probe: false,
        }
    }
    pub fn accounts(&mut self, accounts: BTreeMap<ClientId, Account>) {
        if self.accounts != accounts && self.worker.control(Control::Accounts(accounts.clone())) {
            self.accounts = accounts;
        }
    }
    fn failed(&mut self) {
        self.failures = self.failures.saturating_add(1);
        self.due = Instant::now()
            + Duration::from_secs(60u64.saturating_mul(1u64 << self.failures.saturating_sub(1).min(6)).min(3600));
    }
    fn success(&mut self) {
        self.failures = 0;
        self.due = Instant::now();
    }
    fn pending(&mut self, control: Control) {
        self.pending = Some(control);
    }

    fn unavailable(&mut self) {
        self.mode = Mode::Unavailable;
        self.worker.fence();
        self.pending = None;
        self.batch = None;
        self.preparing = None;
    }

    fn conflict(&mut self, value: &Value, capture: &Capture) {
        if value["error"] == "activity_sequence"
            && capture.binding.is_some()
            && integer(&value["expectedSeq"]).is_some_and(|n| n >= 1 && n <= capture.ack)
        {
            self.rollback_probe = true;
            self.mode = Mode::Hello;
            self.batch = None;
            self.preparing = None;
            self.last_history = None;
            self.success();
        } else {
            self.unavailable();
        }
    }

    pub fn turn(&mut self, sink: &mut dyn Sink, inventory: &[InstalledClient]) {
        if self.worker.failed() {
            return;
        }
        if let Some(control) = self.pending.take() {
            if !self.worker.control(control.clone()) {
                self.pending = Some(control);
            }
            return;
        }
        if matches!(self.mode, Mode::Unavailable) {
            return;
        }
        let Some(capture) = self.worker.snapshot() else {
            return;
        };
        self.known |= capture.binding.is_some();
        if let Mode::Legacy(until) = self.mode {
            if Instant::now() < until {
                self.legacy(sink, &capture, inventory);
                return;
            }
            self.mode = Mode::Hello;
            self.pending(Control::Legacy(false));
            return;
        }
        if Instant::now() < self.due {
            return;
        }
        if self.proof_retry.is_some_and(|at| Instant::now() >= at) {
            self.refresh = true;
            self.proof_retry = None;
        }
        if matches!(self.mode, Mode::Intervals)
            && self.inventory.as_deref() != Some(inventory)
            && sink.inventory(inventory)
        {
            self.inventory = Some(inventory.to_vec());
        }
        let unanchored = capture.epoch.anchor.is_none();
        if matches!(self.mode, Mode::Hello) || self.refresh || unanchored {
            let sent = self.worker.clock.read();
            if capture.epoch.compatible(&sent, false) {
                let request = json!({"op":"hello","sentAt":sent.wall,"queueId":capture.queue_id,"openId":capture.open_id,
                    "replaceAuthorityEpoch":self.replace,"clock":{"clockEpoch":capture.epoch.id,"tick":capture.epoch.tick(&sent),"wall":sent.wall},
                    "tracking":capture.latest.state.tracking,"knownWitnessId":capture.witness.as_ref().map(|w|&w.id),"latest":null,"acknowledgedThrough":if self.rollback_probe {0}else{capture.ack}});
                let started = Instant::now();
                let answer = sink.activity_request(&request, self.known);
                match answer {
                    Answer::Accepted(value) => {
                        let Some(binding) = binding(&value, &capture) else {
                            self.failed();
                            return;
                        };
                        if capture.binding.as_ref().is_some_and(|old| {
                            old.hub_id != binding.hub_id
                                || old.device_id != binding.device_id
                                || old.authority_epoch != binding.authority_epoch
                        }) {
                            self.unavailable();
                            return;
                        }
                        let Some(server) = value["serverTime"].as_i64().filter(|v| *v >= 0) else {
                            self.failed();
                            return;
                        };
                        let Some(ack) = integer(&value["acknowledgedThrough"]) else {
                            self.failed();
                            return;
                        };
                        let recover = ack < capture.ack;
                        if recover && (!self.rollback_probe || capture.binding.is_none()) || ack >= capture.sequence {
                            self.unavailable();
                            return;
                        }
                        let witness = if value["topologyWitness"].is_null() {
                            None
                        } else {
                            match serde_json::from_value::<Witness>(value["topologyWitness"].clone()) {
                                Ok(w)
                                    if valid_id(&w.id)
                                        && w.scope_digest == capture.latest.state.tracking.digest()
                                        && w.issued_at <= server =>
                                {
                                    Some(w)
                                }
                                _ => {
                                    self.failed();
                                    return;
                                }
                            }
                        };
                        self.known = true;
                        if witness.is_none() {
                            self.proof_retry = Some(Instant::now() + Duration::from_secs(60));
                        }
                        self.mode = Mode::Intervals;
                        self.refresh = false;
                        self.replace = None;
                        self.rollback_probe = false;
                        let timely = started.elapsed() <= Duration::from_secs(5)
                            && capture.epoch.compatible(&self.worker.clock.read(), false);
                        self.pending(Control::Bind {
                            binding,
                            epoch: if timely { capture.epoch.id.clone() } else { String::new() },
                            sent,
                            server,
                            witness,
                            ack,
                            recover,
                        });
                        if timely {
                            self.success();
                        } else {
                            self.failed();
                        }
                    }
                    Answer::Unsupported if !self.known => {
                        self.mode = Mode::Legacy(Instant::now() + Duration::from_secs(3600));
                        self.pending(Control::Legacy(true));
                        self.success();
                    }
                    Answer::Conflict(value) if value["error"] == "activity_binding" && !self.known => {
                        if let Some(authority) = value["authorityEpoch"].as_str().filter(|v| valid_id(v)) {
                            self.replace = Some(authority.into());
                            self.pending(Control::Replacement);
                            self.success();
                        } else {
                            self.failed();
                        }
                    }
                    Answer::Conflict(value) => self.conflict(&value, &capture),
                    _ => self.failed(),
                }
                return;
            }
        }
        let Some(bound) = capture.binding.as_ref() else {
            return;
        };
        let changed = self.last_state.as_ref() != Some(&capture.digest);
        if changed {
            self.drain_through = self.drain_through.max(capture.sequence.saturating_sub(1));
        }
        let heartbeat = self.last_live.is_none_or(|at| at.elapsed() >= Duration::from_secs(120));
        let current = self.worker.clock.read();
        let live_due = (changed || heartbeat)
            && current.boot == capture.reading.boot
            && current.tick.saturating_sub(capture.reading.tick) <= 300_000;
        let latest = if live_due {
            let Some(state) = capture.epoch.utc_state(capture.latest.state.clone()) else {
                self.unavailable();
                return;
            };
            Some(Latest { state, ..capture.latest.clone() })
        } else {
            None
        };
        let backlog = capture.sequence.saturating_sub(capture.ack + 1) > super::MAX_FRAMES as u64;
        let history_due = self.last_history.is_none_or(|at| at.elapsed() >= Duration::from_secs(30))
            || backlog
            || changed
            || capture.ack < self.drain_through
            || capture.release_pending;
        if self.batch.is_none() {
            if let Some(receiver) = &self.preparing {
                match receiver.try_recv() {
                    Ok(Ok(batch)) => {
                        self.batch = Some(Arc::new(batch));
                        self.preparing = None;
                    }
                    Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => {
                        self.unavailable();
                        return;
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            } else if history_due && (capture.ack + 1 < capture.sequence || capture.release_pending) {
                let (tx, rx) = mpsc::sync_channel(1);
                if self.worker.control(Control::Prepare(tx)) {
                    self.preparing = Some(rx);
                }
            }
        }
        let same_anchor = self.batch.as_ref().is_some_and(|b| b.clock_anchor.as_ref() == capture.epoch.anchor.as_ref());
        if live_due && !same_anchor {
            if let Some(anchor) = capture.epoch.anchor.as_ref() {
                let request = json!({"op":"presence","sentAt":now_ms(),"queueId":capture.queue_id,"authorityEpoch":bound.authority_epoch,
                    "clockAnchor":anchor,"topologyWitnessId":capture.witness.as_ref().map(|w|&w.id),"latest":latest});
                self.answer(sink, &capture, &request, None);
            }
            return;
        }
        let Some(batch) = self.batch.as_ref().cloned() else {
            return;
        };
        if batch.frames.is_empty() && batch.skip.is_none() && batch.release_witnesses.is_empty() {
            self.batch = None;
            if live_due {
                if let Some(anchor) = capture.epoch.anchor.as_ref() {
                    let request = json!({"op":"presence","sentAt":now_ms(),"queueId":capture.queue_id,"authorityEpoch":bound.authority_epoch,
                        "clockAnchor":anchor,"topologyWitnessId":capture.witness.as_ref().map(|w|&w.id),"latest":latest});
                    self.answer(sink, &capture, &request, None);
                }
            }
            return;
        }
        if !history_due && batch.skip.is_none() && batch.release_witnesses.is_empty() {
            return;
        }
        let mut request = serde_json::to_value(&*batch).expect("activity batch serialization");
        request["op"] = json!("batch");
        request["sentAt"] = json!(now_ms());
        request["queueId"] = json!(capture.queue_id);
        request["authorityEpoch"] = json!(bound.authority_epoch);
        if same_anchor && live_due {
            request["latest"] = json!(latest);
            if serde_json::to_vec(&request).is_ok_and(|bytes| bytes.len() + 2048 > BODY_BYTES) {
                request.as_object_mut().unwrap().remove("latest");
            }
        }
        self.answer(sink, &capture, &request, Some(&batch));
    }

    fn answer(&mut self, sink: &mut dyn Sink, capture: &Capture, request: &Value, batch: Option<&Batch>) {
        match sink.activity_request(request, true) {
            Answer::Accepted(value) => {
                let Some(bound) = capture.binding.as_ref() else {
                    return;
                };
                if value["queueId"] != capture.queue_id || value["authorityEpoch"] != bound.authority_epoch {
                    self.unavailable();
                    return;
                }
                if let Some(batch) = batch {
                    let through = batch
                        .frames
                        .last()
                        .map(|f| f.seq)
                        .or_else(|| batch.skip.as_ref().map(|l| l.last_seq))
                        .unwrap_or(capture.ack);
                    if integer(&value["acknowledgedThrough"]) != Some(through) {
                        self.failed();
                        return;
                    }
                    let Ok(released) = serde_json::from_value::<Vec<String>>(value["releasedWitnesses"].clone()) else {
                        self.failed();
                        return;
                    };
                    if released.iter().any(|id| !batch.release_witnesses.contains(id)) {
                        self.failed();
                        return;
                    }
                    self.pending(Control::Ack { through, released });
                    self.batch = None;
                    self.last_history = Some(Instant::now());
                }
                if value["presenceAccepted"] == true {
                    self.last_state = Some(capture.digest.clone());
                    self.last_live = Some(Instant::now());
                }
                if value["coverageRefreshRequired"] == true {
                    if let Some(version) = integer(&value["topologyVersion"]) {
                        if let Some(active) = capture.witness.as_ref() {
                            self.refresh = active.topology_version != version
                                || active.scope_digest != capture.latest.state.tracking.digest();
                        } else {
                            self.proof_retry.get_or_insert_with(|| Instant::now() + Duration::from_secs(60));
                        }
                    }
                }
                self.success();
            }
            Answer::Conflict(value) => self.conflict(&value, capture),
            _ => self.failed(),
        }
    }

    fn legacy(&mut self, sink: &mut dyn Sink, capture: &Capture, inventory: &[InstalledClient]) {
        if capture.latest.state.contexts.iter().any(|c| c.working.is_none()) {
            return;
        }
        let mut report = legacy_report(capture, inventory);
        report.tracking.as_mut().unwrap().complete &= !self.legacy_fault;
        if self.legacy.as_ref().is_some_and(|(at, old)| *old == report && at.elapsed() < Duration::from_secs(120)) {
            return;
        }
        if sink.report(&report) {
            if !report.tracking.as_ref().unwrap().complete {
                self.legacy_fault = false;
            }
            self.legacy = Some((Instant::now(), report));
        } else {
            self.legacy_fault = true;
        }
    }
}

fn valid_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn integer(value: &Value) -> Option<u64> {
    value.as_u64().filter(|v| *v <= SAFE_INTEGER)
}
fn binding(value: &Value, capture: &Capture) -> Option<Binding> {
    let hub_id = value["hubId"].as_str()?.to_string();
    let device_id = value["deviceId"].as_str()?.to_string();
    let authority_epoch = value["authorityEpoch"].as_str()?.to_string();
    let floor_at = value["floorAt"].as_i64()?;
    (value["queueId"] == capture.queue_id
        && valid_id(&hub_id)
        && valid_id(&authority_epoch)
        && !device_id.is_empty()
        && device_id.len() <= 120
        && floor_at >= 0)
        .then_some(Binding { hub_id, device_id, authority_epoch, floor_at })
}

fn legacy_report(capture: &Capture, inventory: &[InstalledClient]) -> SessionReport {
    let state = &capture.latest.state;
    let mut report = SessionReport {
        clients: inventory.to_vec(),
        tracking: Some(Tracking {
            version: 1,
            clients: state.tracking.clients.iter().filter_map(|c| ClientId::parse(c)).collect(),
            route_disabled: state.tracking.route_disabled.iter().filter_map(|c| ClientId::parse(c)).collect(),
            complete: state.tracking.complete,
        }),
        ..SessionReport::default()
    };
    for context in capture.order.iter().filter_map(|id| state.contexts.iter().find(|c| &c.context_id == id)) {
        let Some(client) = ClientId::parse(&context.client_id) else {
            continue;
        };
        let origin = match context.origin.as_str() {
            "editor" => "editor",
            "app" => "app",
            _ => "terminal",
        };
        let source = context.source.as_ref().and_then(|s| {
            Some(ClientSource {
                provider: Provider::parse(&s.provider)?,
                account: s.account.clone(),
                account_name: s.account_name.clone(),
            })
        });
        if let Some(source) = source.clone().filter(|_| capture.legacy_ids.contains(&context.context_id)) {
            report.sessions.push(RunningSession {
                session_id: context.session_id.clone(),
                provider: source.provider,
                account: source.account,
                account_name: source.account_name,
                origin,
                project: context.project.clone(),
                folder: context.folder.clone(),
                started_at: context.started_at,
                last_worked_at: context.last_worked_at,
                working: context.working == Some(true),
            });
        } else {
            report.client_sessions.push(ClientSession {
                client_id: client,
                session_id: context.session_id.clone(),
                source,
                origin,
                project: context.project.clone(),
                folder: context.folder.clone(),
                started_at: context.started_at,
                last_worked_at: context.last_worked_at,
                working: context.working == Some(true),
            });
        }
    }
    report
}
