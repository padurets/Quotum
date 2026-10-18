//! The coordinator owns network calls; the capture writer receives only bounded controls.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::outbox::Binding;
use super::worker::{Account, Capture, Control, Prepared, Worker};
use super::{Anchor, Answer, BODY_BYTES, Batch, Latest, SAFE_INTEGER, Witness};
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
    preparing: Option<mpsc::Receiver<std::io::Result<Prepared>>>,
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
    reported_failure: bool,
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
            reported_failure: false,
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
        self.preparing = None;
    }

    fn conflict(&mut self, value: &Value, capture: &Capture) {
        if value["error"] == "activity_sequence"
            && capture.binding.is_some()
            && integer(&value["expectedSeq"]).is_some_and(|n| n >= 1 && n <= capture.ack)
        {
            self.rollback_probe = true;
            self.mode = Mode::Hello;
            self.preparing = None;
            self.last_history = None;
            self.success();
        } else {
            self.unavailable();
        }
    }

    pub fn turn(&mut self, sink: &mut dyn Sink, inventory: &[InstalledClient]) {
        if self.worker.failed() {
            if !self.reported_failure {
                sink.activity_failed();
                self.reported_failure = true;
            }
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
        let _privacy = match self.worker.delivery_guard() {
            Ok(Some(guard)) => guard,
            Ok(None) => {
                self.unavailable();
                return;
            }
            Err(_) => {
                sink.activity_failed();
                self.unavailable();
                return;
            }
        };
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
                        let accepted_anchor = if value["acceptedClockAnchor"].is_null() {
                            None
                        } else {
                            match serde_json::from_value::<Anchor>(value["acceptedClockAnchor"].clone()) {
                                Ok(anchor)
                                    if valid_id(&anchor.clock_epoch)
                                        && anchor.anchor_tick <= SAFE_INTEGER
                                        && (0..=SAFE_INTEGER as i64).contains(&anchor.anchor_at) =>
                                {
                                    Some(anchor)
                                }
                                _ => {
                                    self.failed();
                                    return;
                                }
                            }
                        };
                        if accepted_anchor.as_ref().is_some_and(|anchor| {
                            anchor.clock_epoch == capture.epoch.id
                                && capture.epoch.anchor.as_ref().is_some_and(|saved| saved != anchor)
                        }) {
                            sink.activity_failed();
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
                        // Binding can restore a lost clock or retire an unrecoverable one; prepare again afterward.
                        self.preparing = None;
                        let timely = started.elapsed() <= Duration::from_secs(5)
                            && capture.epoch.compatible(&self.worker.clock.read(), false);
                        self.pending(Control::Bind {
                            binding: Box::new(binding),
                            epoch: if timely { capture.epoch.id.clone() } else { String::new() },
                            sent,
                            server,
                            accepted_anchor,
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
        let prepared = if let Some(receiver) = &self.preparing {
            match receiver.try_recv() {
                Ok(Ok(prepared)) => {
                    self.preparing = None;
                    // Coordinator work can block while the writer's reply waits in this channel.
                    Some(prepared).filter(|prepared| prepared.fresh(&self.worker.clock.read()))
                }
                Ok(Err(_)) | Err(mpsc::TryRecvError::Disconnected) => {
                    self.unavailable();
                    return;
                }
                Err(mpsc::TryRecvError::Empty) => None,
            }
        } else {
            if history_due && (capture.ack + 1 < capture.sequence || capture.release_pending) {
                let (tx, rx) = mpsc::sync_channel(1);
                if self.worker.control(Control::Prepare(tx)) {
                    self.preparing = Some(rx);
                }
            }
            None
        };
        let same_anchor =
            prepared.as_ref().is_some_and(|ready| ready.batch.clock_anchor.as_ref() == capture.epoch.anchor.as_ref());
        if live_due && !same_anchor {
            if let Some(anchor) = capture.epoch.anchor.as_ref() {
                let request = json!({"op":"presence","sentAt":now_ms(),"queueId":capture.queue_id,"authorityEpoch":bound.authority_epoch,
                    "clockAnchor":anchor,"topologyWitnessId":capture.witness.as_ref().map(|w|&w.id),"latest":latest});
                self.answer(sink, &capture, &request, None);
            }
            return;
        }
        let Some(prepared) = prepared else {
            return;
        };
        let batch = &prepared.batch;
        if batch.frames.is_empty() && batch.skip.is_none() && batch.release_witnesses.is_empty() {
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
        let mut request = serde_json::to_value(batch).expect("activity batch serialization");
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
        // A ready payload authorizes only this immediate attempt, including an unanswered or invalid reply.
        if prepared.fresh(&self.worker.clock.read()) {
            self.answer(sink, &capture, &request, Some(batch));
        }
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
            complete: state.tracking.complete && state.contexts.iter().all(|context| context.working.is_some()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;
    use crate::model::Outcome;
    use crate::observed::clock::{Epoch, Reading};
    use crate::observed::outbox::{Outbox, Raw};
    use crate::observed::worker::{Start, WriterFixture};
    use crate::observed::{Context, Scope, State};
    use crate::stop::Stop;
    use std::path::PathBuf;
    use std::sync::Arc;

    struct Stand {
        root: PathBuf,
        paths: Paths,
        delivery: Option<Delivery>,
    }
    impl Stand {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("quotum-activity-delivery-{}", crate::config::random_hex()));
            let paths = Paths { config: root.join("config"), work: root.join("work"), state: root.join("state") };
            let privacy = super::super::privacy::update(&paths, true, true, &[ClientId::Codex], &[]).unwrap();
            let reading = Reading { boot: Some("fixture".into()), tick: 0, wall: now_ms() };
            let epoch = Epoch::new(&reading);
            let state = Arc::new(State {
                tracking: Scope {
                    version: 1,
                    clients: vec!["codex".into()],
                    route_disabled: Vec::new(),
                    complete: true,
                },
                contexts: Vec::new(),
            });
            let capture = Capture {
                latest: Latest { clock_epoch: epoch.id.clone(), tick: 0, state: state.clone() },
                epoch,
                reading,
                witness: None,
                paths: BTreeMap::new(),
                queue_id: "a".repeat(32),
                open_id: "b".repeat(32),
                binding: None,
                ack: 0,
                sequence: 1,
                digest: state.digest(),
                order: Vec::new(),
                legacy_ids: Vec::new(),
                release_pending: false,
            };
            let worker = Worker::with_capture(paths.clone(), privacy, capture);
            Self { root, paths, delivery: Some(Delivery::new(worker)) }
        }

        fn history() -> (Self, WriterFixture) {
            Self::history_with_boot(Some("fixture".into()))
        }

        fn history_with_boot(boot: Option<String>) -> (Self, WriterFixture) {
            let mut stand = Self::new();
            let initial = Reading { boot, tick: 0, wall: 1_800_000_000_000 };
            let mut historical = Epoch::new(&initial);
            assert!(historical.bind(&initial, initial.wall));
            let mut queue = Outbox::open(stand.root.join("queue"), "fixture".into()).unwrap();
            let privacy = super::super::privacy::update(&stand.paths, true, true, &[ClientId::Codex], &[]).unwrap();
            queue.apply_privacy(privacy.clone()).unwrap();
            queue.install_clock(historical.clone()).unwrap();
            let mut capture = (*stand.delivery.as_ref().unwrap().worker.snapshot().unwrap()).clone();
            let mut state = (*capture.latest.state).clone();
            state.contexts.push(Context {
                context_id: "c".repeat(32),
                client_id: "codex".into(),
                session_id: Some("d".repeat(32)),
                ordinal: None,
                source: None,
                account_by: None,
                origin: "terminal".into(),
                project: Some("captured project".into()),
                folder: None,
                started_at: initial.wall - 1000,
                route: None,
                working: Some(true),
                last_worked_at: None,
            });
            let state = Arc::new(state);
            queue
                .append(
                    &state,
                    Raw {
                        seq: 0,
                        capture_epoch: "e".repeat(32),
                        clock_epoch: historical.id,
                        from_tick: 0,
                        to_tick: 15_000,
                        from_wall: initial.wall,
                        to_wall: initial.wall + 15_000,
                        base_state_digest: state.digest(),
                        next_state: None,
                        complete: false,
                    },
                    None,
                )
                .unwrap();
            let reading = Reading { tick: 60_000, wall: initial.wall + 60_000, ..initial };
            let mut epoch = Epoch::new(&reading);
            assert!(epoch.bind(&reading, reading.wall));
            queue.install_clock(epoch.clone()).unwrap();
            capture.binding = Some(Binding {
                hub_id: "a".repeat(32),
                device_id: "fixture".into(),
                authority_epoch: "b".repeat(32),
                floor_at: 0,
            });
            queue.bind(capture.binding.clone().unwrap()).unwrap();
            capture.epoch = epoch.clone();
            capture.reading = reading;
            capture.latest = Latest { clock_epoch: epoch.id.clone(), tick: 0, state };
            capture.digest = capture.latest.state.digest();
            capture.queue_id = queue.queue_id().into();
            capture.open_id = queue.open_id().into();
            capture.sequence = queue.next_sequence();
            let digest = capture.digest.clone();
            let (worker, writer) = Worker::with_outbox(stand.paths.clone(), privacy, queue, epoch, capture);
            let mut delivery = Delivery::new(worker);
            delivery.mode = Mode::Intervals;
            delivery.inventory = Some(Vec::new());
            delivery.last_live = Some(Instant::now());
            delivery.last_state = Some(digest);
            stand.delivery = Some(delivery);
            (stand, writer)
        }
    }
    impl Drop for Stand {
        fn drop(&mut self) {
            self.delivery.take();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[derive(Default)]
    struct Recorder {
        reports: Vec<SessionReport>,
        requests: usize,
        failures: usize,
        response: Option<Value>,
    }
    impl Sink for Recorder {
        fn deliver(&mut self, _: &Outcome) {}
        fn report(&mut self, report: &SessionReport) -> bool {
            self.reports.push(report.clone());
            true
        }
        fn activity_request(&mut self, _: &Value, _: bool) -> Answer {
            self.requests += 1;
            self.response.clone().map_or(Answer::Unanswered, Answer::Accepted)
        }
        fn activity_failed(&mut self) {
            self.failures += 1;
        }
    }

    #[derive(Default)]
    struct ActivitySink {
        requests: Vec<Value>,
        accepted: bool,
        invalid_ack: bool,
        committed: u64,
    }
    impl Sink for ActivitySink {
        fn deliver(&mut self, _: &Outcome) {}
        fn activity_request(&mut self, request: &Value, _: bool) -> Answer {
            self.requests.push(request.clone());
            let through = request["frames"]
                .as_array()
                .and_then(|frames| frames.last())
                .and_then(|frame| frame["seq"].as_u64())
                .or_else(|| request["skip"]["lastSeq"].as_u64())
                .expect("history request");
            // A lost reply can leave this authenticated prefix committed at the remote end.
            self.committed = self.committed.max(through);
            if self.accepted {
                Answer::Accepted(json!({"queueId":request["queueId"],"authorityEpoch":request["authorityEpoch"],
                    "acknowledgedThrough":if self.invalid_ack {0}else{self.committed},"releasedWitnesses":[]}))
            } else {
                Answer::Unanswered
            }
        }
    }

    fn advance_eight_days(delivery: &mut Delivery, writer: &mut WriterFixture) {
        let reading = delivery.worker.clock.read();
        let elapsed = 8 * 86_400_000;
        writer.reading(
            &mut delivery.worker,
            Reading { tick: reading.tick + elapsed, wall: reading.wall + elapsed as i64, ..reading },
        );
        // Make the network retry eligible without waiting through its actual backoff.
        delivery.due = Instant::now();
    }

    #[test]
    fn every_failed_history_attempt_prepares_again_and_observes_durable_age_loss() {
        for invalid_ack in [false, true] {
            let (mut stand, mut writer) = Stand::history();
            let delivery = stand.delivery.as_mut().unwrap();
            let original = serde_json::to_value(writer.pending()).unwrap();
            let mut sink = ActivitySink { accepted: invalid_ack, invalid_ack, ..ActivitySink::default() };
            delivery.turn(&mut sink, &[]);
            assert!(sink.requests.is_empty());
            writer.process();
            delivery.turn(&mut sink, &[]);
            assert_eq!(sink.requests.len(), 1);
            assert_eq!(sink.requests[0]["frames"], original["frames"]);
            assert_eq!(sink.requests[0]["clockAnchor"], original["clockAnchor"]);
            assert_ne!(sink.requests[0]["clockAnchor"]["clockEpoch"], delivery.worker.snapshot().unwrap().epoch.id);
            assert!(delivery.pending.is_none());
            assert_eq!(delivery.failures, 1);

            advance_eight_days(delivery, &mut writer);
            delivery.turn(&mut sink, &[]);
            assert_eq!(sink.requests.len(), 1, "a retry needs fresh writer authorization");
            writer.process();
            let retired = writer.pending();
            sink.accepted = true;
            sink.invalid_ack = false;
            delivery.turn(&mut sink, &[]);
            assert_eq!(sink.requests.len(), 2);
            assert_eq!(sink.requests[1]["frames"], json!([]));
            assert!(retired.frames.is_empty());
            let loss = retired.skip.unwrap();
            assert_eq!((loss.first_seq, loss.last_seq, loss.reason.as_str()), (1, 1, "age"));
            assert_eq!(sink.requests[1]["skip"], serde_json::to_value(loss).unwrap());
            assert_eq!(sink.committed, 1, "skip preserves the prefix whose reply was lost");
            assert!(matches!(delivery.pending, Some(Control::Ack { through: 1, .. })));
            assert_eq!(delivery.worker.snapshot().unwrap().ack, 0);
            delivery.turn(&mut sink, &[]);
            assert_eq!(delivery.worker.snapshot().unwrap().ack, 0, "only the writer persists the ACK");
            writer.process();
            assert_eq!(delivery.worker.snapshot().unwrap().ack, 1);
            assert!(writer.pending().skip.is_none());
        }
    }

    #[test]
    fn a_fresh_retry_keeps_captured_payload_and_its_historical_anchor() {
        let (mut stand, mut writer) = Stand::history();
        let delivery = stand.delivery.as_mut().unwrap();
        let mut sink = ActivitySink::default();
        delivery.turn(&mut sink, &[]);
        writer.process();
        delivery.turn(&mut sink, &[]);
        delivery.due = Instant::now();
        delivery.turn(&mut sink, &[]);
        assert_eq!(sink.requests.len(), 1);
        writer.process();
        sink.accepted = true;
        delivery.turn(&mut sink, &[]);
        assert_eq!(sink.requests.len(), 2);
        for field in ["frames", "checkpoint", "clockAnchor", "topologyWitnessId", "skip"] {
            assert_eq!(sink.requests[0][field], sink.requests[1][field], "{field}");
        }
        assert!(matches!(delivery.pending, Some(Control::Ack { through: 1, .. })));
        delivery.turn(&mut sink, &[]);
        writer.process();
        assert_eq!(delivery.worker.snapshot().unwrap().ack, 1);
        assert!(writer.pending().frames.is_empty());
    }

    #[test]
    fn an_unsent_reply_aged_by_coordinator_work_is_dropped_before_expiry_is_prepared_again() {
        let (mut stand, mut writer) = Stand::history();
        let delivery = stand.delivery.as_mut().unwrap();
        let mut sink = ActivitySink::default();
        delivery.turn(&mut sink, &[]);
        writer.process();
        let mut prepared = delivery.preparing.take().unwrap().try_recv().unwrap().unwrap();
        assert!(prepared.fresh(&delivery.worker.clock.read()));
        assert_eq!(prepared.batch.frames.len(), 1);
        // Simulate quota/version/coordinator work exceeding the handoff, without a native sleep.
        prepared.prepared_at = Instant::now() - Duration::from_secs(6);
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(Ok(prepared)).unwrap();
        delivery.preparing = Some(rx);
        delivery.turn(&mut sink, &[]);
        assert!(sink.requests.is_empty(), "stale unsent data must never reach the network");
        assert!(delivery.preparing.is_none());
        assert_eq!(writer.pending().frames.len(), 1, "expiry belongs to the next production Prepare");
        advance_eight_days(delivery, &mut writer);
        delivery.turn(&mut sink, &[]);
        writer.process();
        delivery.turn(&mut sink, &[]);
        assert_eq!(sink.requests.len(), 1);
        assert_eq!(sink.requests[0]["frames"], json!([]));
        assert_eq!(sink.requests[0]["skip"]["reason"], "age");
    }

    #[test]
    fn suspend_and_clock_faults_expire_an_unsent_reply_even_with_a_fresh_instant() {
        for case in ["suspend", "boot", "tick rollback", "wall jump", "wall rollback", "fallback wall jump"] {
            let boot = (case != "fallback wall jump").then(|| "fixture".into());
            let (mut stand, mut writer) = Stand::history_with_boot(boot);
            let delivery = stand.delivery.as_mut().unwrap();
            let mut sink = ActivitySink::default();
            delivery.turn(&mut sink, &[]);
            writer.process();
            let prepared = delivery.preparing.take().unwrap().try_recv().unwrap().unwrap();
            let mut reading = delivery.worker.clock.read();
            assert!(prepared.fresh(&reading));
            match case {
                "suspend" => {
                    reading.tick += 8 * 86_400_000;
                    reading.wall += 8 * 86_400_000;
                }
                "boot" => reading.boot = Some("replacement boot".into()),
                "tick rollback" => reading.tick -= 1,
                "wall rollback" => reading.wall -= 1,
                _ => reading.wall += 6000,
            }
            assert!(prepared.prepared_at.elapsed() < Duration::from_secs(5));
            let (tx, rx) = mpsc::sync_channel(1);
            tx.send(Ok(prepared)).unwrap();
            delivery.preparing = Some(rx);
            writer.reading(&mut delivery.worker, reading);
            delivery.turn(&mut sink, &[]);
            assert!(sink.requests.is_empty(), "{case} must invalidate the unsent authorization");
            assert!(delivery.preparing.is_none());
            assert_eq!(writer.pending().frames.len(), 1);
            if case == "suspend" {
                delivery.turn(&mut sink, &[]);
                writer.process();
                delivery.turn(&mut sink, &[]);
                assert_eq!(sink.requests.len(), 1);
                assert_eq!(sink.requests[0]["frames"], json!([]));
                assert_eq!(sink.requests[0]["skip"]["reason"], "age");
            }
        }
    }

    #[test]
    fn a_prepared_history_reply_cannot_bypass_an_accepted_privacy_restriction() {
        let (mut stand, mut writer) = Stand::history();
        let delivery = stand.delivery.as_mut().unwrap();
        let mut sink = ActivitySink::default();
        delivery.turn(&mut sink, &[]);
        writer.process();
        super::super::privacy::update(&stand.paths, false, true, &[ClientId::Codex], &[]).unwrap();
        super::super::privacy::update(&stand.paths, true, true, &[ClientId::Codex], &[]).unwrap();
        delivery.turn(&mut sink, &[]);
        assert!(sink.requests.is_empty());
        assert!(delivery.preparing.is_none());
        assert!(matches!(delivery.mode, Mode::Unavailable));
    }

    #[test]
    fn hello_recovers_only_a_valid_committed_anchor_and_never_rebinds_a_saved_one() {
        for case in ["recovered", "unsafe", "conflict"] {
            let mut stand = Stand::new();
            let delivery = stand.delivery.as_mut().unwrap();
            let reading = delivery.worker.clock.read();
            let mut capture = (*delivery.worker.snapshot().unwrap()).clone();
            capture.epoch = super::super::clock::Epoch::new(&reading);
            capture.reading = reading.clone();
            capture.latest.clock_epoch = capture.epoch.id.clone();
            capture.sequence = 2;
            let accepted =
                Anchor { clock_epoch: capture.epoch.id.clone(), anchor_tick: 0, anchor_at: reading.wall + 500 };
            if case == "conflict" {
                capture.epoch.anchor = Some(Anchor { anchor_at: reading.wall, ..accepted.clone() });
            }
            let mut wire = serde_json::to_value(&accepted).unwrap();
            if case == "unsafe" {
                wire["anchorTick"] = json!(SAFE_INTEGER + 1);
            }
            let response = json!({"version":1,"protocol":"observed-intervals","hubId":"a".repeat(32),"deviceId":"fixture",
                "queueId":capture.queue_id,"authorityEpoch":"b".repeat(32),"floorAt":0,"acknowledgedThrough":1,
                "serverTime":reading.wall,"acceptedClockAnchor":wire,"topologyWitness":null});
            let privacy = super::super::privacy::update(&stand.paths, true, true, &[ClientId::Codex], &[]).unwrap();
            delivery.worker = Worker::with_capture(stand.paths.clone(), privacy, capture);
            let mut sink = Recorder { response: Some(response), ..Recorder::default() };
            delivery.turn(&mut sink, &[]);
            assert_eq!(sink.requests, 1);
            match case {
                "recovered" => assert!(matches!(
                    delivery.pending.as_ref(),
                    Some(Control::Bind { accepted_anchor: Some(anchor), .. }) if anchor == &accepted
                )),
                "unsafe" => {
                    assert!(delivery.pending.is_none());
                    assert!(matches!(delivery.mode, Mode::Hello));
                }
                _ => {
                    assert!(delivery.pending.is_none());
                    assert!(matches!(delivery.mode, Mode::Unavailable));
                    assert_eq!(sink.failures, 1);
                }
            }
        }
    }

    #[test]
    fn old_hub_fallback_sends_known_roots_and_an_incomplete_witness_for_unknown_roots() {
        let mut stand = Stand::new();
        let delivery = stand.delivery.as_mut().unwrap();
        let mut capture = (*delivery.worker.snapshot().unwrap()).clone();
        let context = |id: &str, working| Context {
            context_id: id.repeat(32),
            client_id: "codex".into(),
            session_id: Some(id.repeat(32)),
            ordinal: None,
            source: None,
            account_by: None,
            origin: "terminal".into(),
            project: None,
            folder: None,
            started_at: now_ms() - 1000,
            route: None,
            working,
            last_worked_at: None,
        };
        let mut tracking = capture.latest.state.tracking.clone();
        tracking.complete = true;
        capture.latest.state =
            Arc::new(State { tracking, contexts: vec![context("a", Some(true)), context("b", None)] });
        capture.order = vec!["a".repeat(32), "b".repeat(32)];
        delivery.legacy_fault = false;
        let mut sink = Recorder::default();
        delivery.legacy(&mut sink, &capture, &[]);
        assert_eq!(sink.reports.len(), 1);
        assert_eq!(sink.reports[0].client_sessions.len(), 2);
        assert!(sink.reports[0].client_sessions[0].working);
        assert!(!sink.reports[0].client_sessions[1].working);
        assert!(!sink.reports[0].tracking.as_ref().unwrap().complete);
        Arc::make_mut(&mut capture.latest.state).contexts[1].working = Some(false);
        delivery.legacy(&mut sink, &capture, &[]);
        assert_eq!(sink.reports.len(), 2);
        assert!(sink.reports[1].tracking.as_ref().unwrap().complete);
    }

    #[test]
    fn accepting_off_then_on_blocks_the_old_delivery_before_its_next_request() {
        let mut stand = Stand::new();
        super::super::privacy::update(&stand.paths, false, true, &[ClientId::Codex], &[]).unwrap();
        super::super::privacy::update(&stand.paths, true, true, &[ClientId::Codex], &[]).unwrap();
        let mut sink = Recorder::default();
        let delivery = stand.delivery.as_mut().unwrap();
        delivery.turn(&mut sink, &[]);
        assert_eq!(sink.requests, 0);
        assert!(matches!(delivery.mode, Mode::Unavailable));
    }

    #[test]
    fn an_unrecoverable_capture_failure_reports_one_bounded_warning() {
        let root = std::env::temp_dir().join(format!("quotum-activity-failed-{}", crate::config::random_hex()));
        let paths = Paths { config: root.join("config"), work: root.join("work"), state: root.join("state") };
        let privacy = super::super::privacy::update(&paths, true, true, &[ClientId::Codex], &[]).unwrap();
        std::fs::write(paths.state.join("activity"), b"not a directory").unwrap();
        let worker = Worker::start(Start {
            paths,
            home: root.clone(),
            clients: Vec::new(),
            scope: Scope { version: 1, clients: vec!["codex".into()], route_disabled: Vec::new(), complete: true },
            namespace: "a".repeat(64),
            credential_scope: "b".repeat(64),
            projects: true,
            stop: Stop::new(),
            privacy,
        })
        .unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while !worker.failed() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut delivery = Delivery::new(worker);
        let mut sink = Recorder::default();
        delivery.turn(&mut sink, &[]);
        delivery.turn(&mut sink, &[]);
        assert_eq!(sink.failures, 1);
        assert_eq!(sink.requests, 0);
        drop(delivery);
        std::fs::remove_dir_all(root).unwrap();
    }
}
