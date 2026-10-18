//! One capture owner per Runner. No client invocation, HTTP or application callback runs here.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use super::cadence::Cadence;
use super::clock::{Clock, Epoch, Reading};
use super::outbox::{Binding, Outbox, Raw};
use super::{Anchor, BODY_BYTES, Batch, Context, Latest, Scope, Source, State, Witness, digest};
use crate::activity::{Activity, Session};
use crate::clients::ClientId;
use crate::config::Paths;
use crate::model::Millis;
use crate::providers::last_activity;
use crate::stop::Stop;

#[derive(Clone, PartialEq)]
pub(crate) struct Account {
    pub source: Option<Source>,
    pub by: Option<String>,
    pub identity: Option<SystemTime>,
    pub paths: Vec<PathBuf>,
    pub legacy: bool,
}

#[cfg(test)]
pub(crate) use tests::captured_accounts;

#[cfg(test)]
mod tests {
    use super::super::Anchor;
    use super::*;

    struct Stand {
        root: PathBuf,
        sampler: Sampler,
        epoch: Epoch,
        at: Instant,
    }
    impl Stand {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("quotum-capture-{}", crate::config::random_hex()));
            let mut queue = Outbox::open(root.clone(), "fixture".into()).unwrap();
            let reading = Reading { boot: Some("fixture".into()), tick: 0, wall: 1_800_000_000_000 };
            let mut epoch = Epoch::new(&reading);
            epoch.anchor = Some(Anchor { clock_epoch: epoch.id.clone(), anchor_tick: 0, anchor_at: reading.wall });
            queue.install_clock(epoch.clone()).unwrap();
            Self {
                root: root.clone(),
                epoch,
                at: Instant::now(),
                sampler: Sampler {
                    activity: Activity::new(root, true),
                    queue,
                    clock: Arc::new(Clock::new()),
                    scope: Scope {
                        version: 1,
                        clients: vec!["codex".into()],
                        route_disabled: Vec::new(),
                        complete: true,
                    },
                    accounts: BTreeMap::new(),
                    salt: None,
                    producers: HashMap::new(),
                    run: crate::config::random_hex(),
                    previous: None,
                    legacy: false,
                    first_sequence: 1,
                    fenced: false,
                },
            }
        }
        fn state(&self, working: Option<bool>) -> Arc<State> {
            Arc::new(State {
                tracking: self.sampler.scope.clone(),
                contexts: vec![Context {
                    context_id: "a".repeat(32),
                    client_id: "codex".into(),
                    session_id: Some("b".repeat(32)),
                    ordinal: None,
                    source: None,
                    account_by: None,
                    origin: "terminal".into(),
                    project: None,
                    folder: None,
                    started_at: self.epoch.zero_wall,
                    route: None,
                    working,
                    last_worked_at: None,
                }],
            })
        }
        fn record(&mut self, ms: u64, state: Arc<State>, hold: Option<u64>) {
            let reading = Reading {
                boot: self.epoch.boot.clone(),
                tick: self.epoch.zero_tick + ms,
                wall: self.epoch.zero_wall + ms as i64,
            };
            let holds = hold.map(|h| ("a".repeat(32), self.at + Duration::from_millis(h))).into_iter().collect();
            self.sampler
                .record(&state, &reading, &self.epoch, true, self.at + Duration::from_millis(ms), holds)
                .unwrap();
        }
        fn capture(&mut self, ms: u64, client: ClientId) {
            self.sampler.salt = Some("0123456789abcdef0123456789abcdef".into());
            self.sampler.scope.clients = vec![client.id().into()];
            let wall = self.epoch.zero_wall + ms as i64;
            self.sampler.clock = Arc::new(Clock::fixed(Reading {
                boot: self.epoch.boot.clone(),
                tick: self.epoch.zero_tick + ms,
                wall,
            }));
            let session = Session {
                client,
                pid: 42,
                native_birth: Some(vec![4, 2]),
                started_at: self.epoch.zero_wall - 1_000,
                project: Some("synthetic-project".into()),
                folder: None,
                working: Some(true),
                last_worked: Some(self.epoch.zero_wall),
                origin: crate::activity::Origin::Terminal,
            };
            let (state, holds, _, _) = self.sampler.state(vec![session], wall);
            let reading = self.sampler.clock.read();
            self.sampler
                .record(&Arc::new(state), &reading, &self.epoch, true, self.at + Duration::from_millis(ms), holds)
                .unwrap();
        }
        fn work(&self) -> u64 {
            let batch = self.sampler.queue.prepare().unwrap();
            let mut state = batch.checkpoint.unwrap();
            let mut total = 0;
            for frame in batch.frames {
                if state.contexts.iter().any(|c| c.working == Some(true)) {
                    total += frame.to_tick - frame.from_tick;
                }
                if let Some(next) = frame.next_state {
                    state = next;
                }
            }
            total
        }
        fn reopen(&mut self, publication: usize) {
            let temporary = self.root.with_extension("reopen");
            let placeholder = Outbox::open(temporary.clone(), "placeholder".into()).unwrap();
            drop(std::mem::replace(&mut self.sampler.queue, placeholder));
            self.sampler.queue = Outbox::open(self.root.clone(), "fixture".into())
                .unwrap_or_else(|error| panic!("reopen after publication {publication}: {error:?}"));
            std::fs::remove_dir_all(temporary).unwrap();
            self.sampler.previous = None;
            self.sampler.activity.reset_evidence();
            self.sampler.run = crate::config::random_hex();
            self.epoch = self.sampler.restore_clock(&self.sampler.clock.read()).unwrap();
        }
    }
    impl Drop for Stand {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Runner fixtures replace only process/clock inputs, then reopen the production journal.
    pub(crate) fn captured_accounts(accounts: BTreeMap<ClientId, Account>, client: ClientId) -> Batch {
        let mut s = Stand::new();
        s.sampler.control(Control::Accounts(accounts), &mut s.epoch).unwrap();
        s.capture(0, client);
        s.capture(15_000, client);
        let before = serde_json::to_vec(&s.sampler.queue.prepare().unwrap()).unwrap();
        s.reopen(0);
        let batch = s.sampler.queue.prepare().unwrap();
        assert_eq!(serde_json::to_vec(&batch).unwrap(), before, "captured funding survives reopening unchanged");
        batch
    }

    #[test]
    fn observed_account_changes_after_publication_do_not_rebind_durable_work() {
        let mut s = Stand::new();
        let path = s.root.join("identity");
        std::fs::write(&path, "synthetic sign-in metadata").unwrap();
        let first = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        let set_time = |at| {
            std::fs::File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(at))
                .unwrap();
        };
        set_time(first);
        let source = Source { provider: "codex".into(), account: Some("a".repeat(24)), account_name: None };
        let accounts = BTreeMap::from([(
            ClientId::Codex,
            Account {
                source: Some(source.clone()),
                by: Some("login".into()),
                identity: Some(first),
                paths: vec![path.clone()],
                legacy: true,
            },
        )]);
        s.sampler.control(Control::Accounts(accounts), &mut s.epoch).unwrap();
        s.capture(0, ClientId::Codex);
        s.capture(15_000, ClientId::Codex);
        set_time(first + Duration::from_secs(60));
        s.capture(30_000, ClientId::Codex);
        s.capture(45_000, ClientId::Codex);
        s.reopen(0);
        let batch = s.sampler.queue.prepare().unwrap();
        let mut state = batch.checkpoint.unwrap();
        let producer = state.contexts[0].session_id.clone();
        assert!(producer.is_some());
        assert_eq!(state.contexts[0].source, Some(source.clone()));
        let (mut funded, mut unfunded) = (0, 0);
        for frame in batch.frames {
            let context = &state.contexts[0];
            assert_eq!(context.session_id, producer);
            if context.working == Some(true) {
                if context.source == Some(source.clone()) {
                    funded += frame.to_tick - frame.from_tick;
                } else {
                    assert!(context.source.is_none() && context.account_by.is_none());
                    unfunded += frame.to_tick - frame.from_tick;
                }
            }
            if let Some(next) = frame.next_state {
                state = next;
            }
        }
        assert_eq!((funded, unfunded), (15_000, 15_000));
        assert!(state.contexts[0].source.is_none(), "the changed sign-in cannot fund new work");
    }

    fn pending_clock() -> (Stand, Reading, Anchor, u64) {
        let mut stand = Stand::new();
        let sent = Reading { boot: Some("fixture-boot".into()), tick: 55_000, wall: 1_800_000_055_000 };
        stand.sampler.clock = Arc::new(Clock::fixed(sent.clone()));
        let elapsed = sent.tick.min(55_000);
        stand.epoch = Epoch::new(&Reading {
            boot: sent.boot.clone(),
            tick: sent.tick - elapsed,
            wall: sent.wall - elapsed as i64,
        });
        stand.sampler.queue.install_clock(stand.epoch.clone()).unwrap();
        let interval = elapsed.min(15_000);
        stand.record(elapsed - interval, stand.state(Some(true)), None);
        stand.record(elapsed, stand.state(Some(true)), None);
        let accepted =
            Anchor { clock_epoch: stand.epoch.id.clone(), anchor_tick: 0, anchor_at: stand.epoch.zero_wall + 500 };
        (stand, sent, accepted, interval)
    }

    fn binding(s: &Stand, sent: Reading, accepted_anchor: Option<Anchor>, timely: bool, ack: u64) -> Control {
        Control::Bind {
            binding: Box::new(Binding {
                hub_id: "a".repeat(32),
                device_id: "fixture".into(),
                authority_epoch: "b".repeat(32),
                floor_at: 0,
            }),
            epoch: if timely { s.epoch.id.clone() } else { String::new() },
            server: sent.wall,
            sent,
            accepted_anchor,
            witness: None,
            ack,
            recover: false,
        }
    }

    fn rebound(s: &mut Stand, sent: Reading, accepted_anchor: Option<Anchor>, timely: bool) {
        let control = binding(s, sent, accepted_anchor, timely, 1);
        s.sampler.control(control, &mut s.epoch).unwrap();
    }

    #[test]
    fn every_interrupted_bind_keeps_clock_recovery_ahead_of_acknowledgement() {
        for matching in [false, true] {
            for privacy in [false, true] {
                let mut cuts = 0;
                let mut completed = false;
                for publication in 1..32 {
                    let (mut s, sent, accepted, _) = pending_clock();
                    let old_id = s.epoch.id.clone();
                    if privacy {
                        s.sampler.queue.apply_privacy("a".repeat(32)).unwrap();
                        s.sampler.previous = None;
                        s.sampler.run = crate::config::random_hex();
                        s.record(s.epoch.tick(&sent), s.state(Some(false)), None);
                    }
                    let anchor = matching.then_some(accepted.clone());
                    let control = binding(&s, sent, anchor.clone(), false, 2);
                    s.sampler.queue.interrupt_after(publication);
                    let interrupted = s.sampler.control(control, &mut s.epoch).is_err();
                    cuts += usize::from(interrupted);
                    s.reopen(publication);
                    let reading = s.sampler.clock.read();
                    s.record(s.epoch.tick(&reading), s.state(Some(false)), None);
                    let control = binding(&s, reading, anchor.clone(), true, 2);
                    s.sampler.control(control, &mut s.epoch).unwrap();
                    if !matching && s.epoch.anchor.is_none() {
                        let reading = s.sampler.clock.read();
                        s.record(s.epoch.tick(&reading), s.state(Some(false)), None);
                        let control = binding(&s, reading, None, true, 2);
                        s.sampler.control(control, &mut s.epoch).unwrap();
                    }
                    if matching {
                        assert_eq!(s.epoch.id, old_id);
                        assert_eq!(s.epoch.anchor.as_ref(), Some(&accepted));
                        assert_eq!(s.epoch.wall_offset, Some(500));
                    } else {
                        assert_ne!(s.epoch.id, old_id, "publication {publication} cannot revive the consumed identity");
                        assert!(!s.sampler.queue.metadata.clocks.contains_key(&old_id));
                    }
                    let batch = s.sampler.queue.prepare().unwrap();
                    assert!(!batch.frames.is_empty());
                    assert!(batch.frames.iter().all(|frame| frame.seq > 2 && frame.from_tick == frame.to_tick));
                    assert_eq!(batch.clock_anchor.as_ref().unwrap().clock_epoch, s.epoch.id);
                    assert_eq!(s.work(), 0, "accepted work must not be credited again after a crash");
                    if !interrupted {
                        completed = true;
                        break;
                    }
                }
                assert!(completed && cuts >= 4, "exercise the actual durable writes, then finish without interruption");
            }
        }
    }

    #[test]
    fn restored_metadata_cannot_revive_an_old_active_clock_identity() {
        let (mut s, _, _, _) = pending_clock();
        let old = s.epoch.clone();
        let fresh = Epoch::new(&s.sampler.clock.read());
        s.sampler.queue.install_clock(fresh.clone()).unwrap();
        s.sampler.queue.metadata.clocks.insert(old.id.clone(), old.clone());
        s.sampler.queue.metadata.active_clock = Some(old.id.clone());
        s.sampler.queue.save_metadata().unwrap();
        s.reopen(0);
        assert_ne!(s.epoch.id, old.id);
        assert!(s.sampler.queue.is_current_clock(&s.epoch.id));
    }

    #[test]
    fn a_committed_anchor_restores_pending_context_dates_after_an_old_queue_backup() {
        for timely in [false, true] {
            let (mut s, sent, accepted, interval) = pending_clock();
            let mut expected = s.state(Some(true)).as_ref().clone();
            expected.contexts[0].started_at += 500;
            rebound(&mut s, sent.clone(), Some(accepted.clone()), timely);
            assert_eq!(s.epoch.anchor.as_ref(), Some(&accepted));
            assert_eq!(s.epoch.wall_offset, Some(500));
            let batch = s.sampler.queue.prepare().unwrap();
            assert!(batch.skip.is_none());
            assert_eq!(batch.clock_anchor.as_ref(), Some(&accepted));
            assert_eq!(batch.frames.len(), 1);
            assert_eq!(batch.frames[0].seq, 2);
            assert_eq!(
                (batch.frames[0].from_at, batch.frames[0].to_at),
                (sent.wall - interval as i64 + 500, sent.wall + 500)
            );
            assert_eq!(batch.checkpoint.unwrap().as_ref(), &expected);
            assert_eq!(batch.frames[0].base_state_digest, expected.digest());
        }
    }

    #[test]
    fn an_acknowledged_uncalibrated_clock_without_a_matching_anchor_starts_a_fresh_identity() {
        for matching_field_missing in [false, true] {
            for timely in [false, true] {
                let (mut s, sent, mut different, _) = pending_clock();
                let old_id = s.epoch.id.clone();
                let old_capture = s.sampler.run.clone();
                different.clock_epoch = crate::config::random_hex();
                rebound(&mut s, sent, (!matching_field_missing).then_some(different), timely);
                assert_ne!(s.epoch.id, old_id);
                assert!(s.epoch.anchor.is_none());
                assert!(s.sampler.previous.is_none());
                assert_ne!(s.sampler.run, old_capture);
                let batch = s.sampler.queue.prepare().unwrap();
                assert!(batch.frames.is_empty());
                let loss = batch.skip.unwrap();
                assert_eq!((loss.first_seq, loss.last_seq), (2, 2));
                let fresh_id = s.epoch.id.clone();
                s.record(0, s.state(Some(true)), None);
                let next_sent = s.sampler.clock.read();
                rebound(&mut s, next_sent, None, true);
                assert_eq!(s.epoch.id, fresh_id, "a clock born after the cursor is safe to calibrate");
                let batch = s.sampler.queue.prepare().unwrap();
                assert_eq!(batch.frames[0].seq, 3);
                assert_eq!(batch.clock_anchor.unwrap().clock_epoch, fresh_id);
            }
        }
    }

    #[test]
    fn completed_ten_minutes_need_no_delivery_or_presence_to_stay_exact() {
        let mut s = Stand::new();
        let state = s.state(Some(true));
        for i in 0..=40 {
            s.record(i * 15_000, state.clone(), None);
        }
        assert_eq!(s.work(), 600_000);
        assert_eq!(s.sampler.queue.next_sequence(), 42);
    }
    #[test]
    fn a_lost_context_or_unknown_endpoint_does_not_extend_old_work() {
        let mut s = Stand::new();
        s.record(0, s.state(Some(true)), None);
        s.record(10_000, s.state(None), None);
        s.record(20_000, s.state(Some(true)), None);
        s.record(30_000, s.state(Some(true)), None);
        assert_eq!(s.work(), 10_000);
    }
    #[test]
    fn a_hold_expires_inside_a_capture_span_before_new_positive_evidence() {
        let mut s = Stand::new();
        s.record(0, s.state(Some(true)), Some(5_000));
        s.record(10_000, s.state(Some(true)), Some(70_000));
        assert_eq!(s.work(), 5_000);
        s.record(15_000, s.state(Some(true)), Some(70_000));
        assert_eq!(s.work(), 10_000);
    }
    #[test]
    fn an_unobserved_gap_starts_a_new_capture_instead_of_backfilling() {
        let mut s = Stand::new();
        s.record(0, s.state(Some(true)), None);
        s.record(10_000, s.state(Some(true)), None);
        s.sampler.previous = None;
        s.sampler.run = crate::config::random_hex();
        s.record(600_000, s.state(Some(true)), None);
        s.record(610_000, s.state(Some(true)), None);
        assert_eq!(s.work(), 20_000);
    }
    #[test]
    fn two_large_states_split_at_one_capture_boundary_without_an_undeliverable_head() {
        let mut s = Stand::new();
        let mut state = s.state(Some(true)).as_ref().clone();
        let template = state.contexts[0].clone();
        state.contexts = (0..200)
            .map(|i| Context {
                context_id: format!("{i:032x}"),
                session_id: Some(format!("{:032x}", 1000 + i)),
                project: Some("🌍".repeat(120)),
                folder: Some("🌍".repeat(120)),
                source: Some(Source {
                    provider: "codex".into(), account: None, account_name: Some("🌍".repeat(120))
                }),
                ..template.clone()
            })
            .collect();
        // Trim the same byte boundary used by capture, independently of the context count cap.
        while serde_json::to_vec(&state).unwrap().len() + super::super::BODY_RESERVE_BYTES > BODY_BYTES {
            state.contexts.pop();
        }
        let mut changed = state.clone();
        for context in &mut changed.contexts {
            context.project = Some("🚀".repeat(120));
        }
        assert!(serde_json::to_vec(&state).unwrap().len() + serde_json::to_vec(&changed).unwrap().len() > BODY_BYTES);
        s.record(0, Arc::new(state), None);
        s.record(5000, Arc::new(changed.clone()), None);
        s.sampler.queue.metadata.releases = (1000..1064).map(|id| format!("{id:032x}")).collect();
        let first = s.sampler.queue.prepare().unwrap();
        assert_eq!(first.frames.len(), 2);
        assert!(first.frames.iter().all(|f| f.next_state.is_none()));
        assert_eq!(first.frames[1].to_tick - first.frames[1].from_tick, 5000);
        assert!(serde_json::to_vec(&first).unwrap().len() + 4096 <= BODY_BYTES);
        let original = first.frames[0].capture_epoch.clone();
        s.sampler.queue.acknowledge(2, &[]).unwrap();
        let next = s.sampler.queue.prepare().unwrap();
        assert_eq!(next.frames.len(), 1);
        assert_eq!(next.frames[0].to_tick - next.frames[0].from_tick, 0);
        assert_ne!(next.frames[0].capture_epoch, original);
        assert_eq!(next.checkpoint.unwrap().as_ref(), &changed);
    }
    #[test]
    fn a_late_binding_rejection_after_stop_retires_the_run_before_releasing_its_writer() {
        let root = std::env::temp_dir().join(format!("quotum-capture-stop-{}", crate::config::random_hex()));
        let paths = Paths { state: root.join("state"), work: root.join("work"), config: root.join("config") };
        let stop = Stop::new();
        let namespace = "a".repeat(64);
        let worker = Worker::start(Start {
            paths: paths.clone(),
            home: root.clone(),
            clients: Vec::new(),
            scope: Scope { version: 1, clients: vec!["codex".into()], route_disabled: Vec::new(), complete: true },
            namespace: namespace.clone(),
            credential_scope: "c".repeat(64),
            projects: true,
            stop: stop.clone(),
            privacy: "b".repeat(32),
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while worker.snapshot().is_none() {
            assert!(!worker.failed());
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        stop.request(crate::stop::How::Exit);
        let (tx, rx) = mpsc::sync_channel(1);
        assert!(worker.control(Control::Accounts(BTreeMap::new())));
        assert!(worker.control(Control::Prepare(tx)));
        rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
        worker.fence();
        drop(worker);
        let q = Outbox::open_bounded(paths.state.join("activity"), namespace).unwrap();
        let batch = q.prepare().unwrap();
        assert!(batch.frames.is_empty());
        assert_eq!(batch.skip.unwrap().reason, "recovery");
        drop(q);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_replacement_waits_for_the_old_writer_and_can_be_cancelled_while_waiting() {
        for cancel in [false, true] {
            let root = std::env::temp_dir().join(format!("quotum-capture-handoff-{}", crate::config::random_hex()));
            let paths = Paths { config: root.join("config"), work: root.join("work"), state: root.join("state") };
            let namespace = "a".repeat(64);
            let held = Outbox::open_bounded(paths.state.join("activity"), namespace.clone()).unwrap();
            let stop = Stop::new();
            let worker = Worker::start(Start {
                paths,
                home: root.clone(),
                clients: Vec::new(),
                scope: Scope { version: 1, clients: vec!["codex".into()], route_disabled: Vec::new(), complete: true },
                namespace,
                credential_scope: "c".repeat(64),
                projects: true,
                stop: stop.clone(),
                privacy: "b".repeat(32),
            })
            .unwrap();
            thread::sleep(Duration::from_millis(100));
            assert!(!worker.failed());
            assert!(worker.snapshot().is_none());
            if cancel {
                stop.request(crate::stop::How::Exit);
                let started = Instant::now();
                drop(worker);
                assert!(started.elapsed() < Duration::from_secs(1));
                drop(held);
            } else {
                drop(held);
                let deadline = Instant::now() + Duration::from_secs(3);
                while worker.snapshot().is_none() {
                    assert!(!worker.failed());
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(5));
                }
                drop(worker);
            }
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[derive(Clone)]
pub(crate) struct Capture {
    pub epoch: Epoch,
    pub reading: Reading,
    pub latest: Latest,
    pub witness: Option<Witness>,
    pub paths: BTreeMap<ClientId, PathBuf>,
    pub queue_id: String,
    pub open_id: String,
    pub binding: Option<Binding>,
    pub ack: u64,
    pub sequence: u64,
    pub digest: String,
    pub order: Vec<String>,
    pub legacy_ids: Vec<String>,
    pub release_pending: bool,
}

#[derive(Clone)]
pub(crate) enum Control {
    Accounts(BTreeMap<ClientId, Account>),
    Bind {
        binding: Box<Binding>,
        epoch: String,
        sent: Reading,
        server: Millis,
        accepted_anchor: Option<Anchor>,
        witness: Option<Witness>,
        ack: u64,
        recover: bool,
    },
    Ack {
        through: u64,
        released: Vec<String>,
    },
    Prepare(mpsc::SyncSender<io::Result<Prepared>>),
    Legacy(bool),
    Replacement,
    Fence,
}

const PREPARED_HANDOFF: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub(crate) struct Prepared {
    pub batch: Batch,
    pub prepared_at: Instant,
    pub reading: Reading,
}

impl Prepared {
    pub fn fresh(&self, current: &Reading) -> bool {
        let limit = PREPARED_HANDOFF.as_millis() as u64;
        self.prepared_at.elapsed() <= PREPARED_HANDOFF
            && self.reading.boot == current.boot
            && current.tick.checked_sub(self.reading.tick).is_some_and(|elapsed| elapsed <= limit)
            && current.wall >= self.reading.wall
            && current.wall.abs_diff(self.reading.wall) <= limit
    }
}

pub(crate) struct Worker {
    tx: Option<mpsc::SyncSender<Control>>,
    thread: Option<JoinHandle<()>>,
    snapshot: Arc<Mutex<Option<Arc<Capture>>>>,
    failed: Arc<AtomicBool>,
    retiring: Arc<AtomicBool>,
    paths: Paths,
    privacy: String,
    pub clock: Arc<Clock>,
}

pub(crate) struct Start {
    pub paths: Paths,
    pub home: PathBuf,
    pub clients: Vec<ClientId>,
    pub scope: Scope,
    pub namespace: String,
    pub credential_scope: String,
    pub projects: bool,
    pub stop: Stop,
    pub privacy: String,
}

impl Worker {
    pub fn start(start: Start) -> io::Result<Self> {
        let Start { paths, home, clients, scope, namespace, credential_scope, projects, stop, privacy } = start;
        let (tx, rx) = mpsc::sync_channel(8);
        let snapshot = Arc::new(Mutex::new(None));
        let shared = snapshot.clone();
        let failed = Arc::new(AtomicBool::new(false));
        let failure = failed.clone();
        let retiring = Arc::new(AtomicBool::new(false));
        let retirement = retiring.clone();
        let clock = Arc::new(Clock::new());
        let time = clock.clone();
        let policy_paths = paths.clone();
        let policy_revision = privacy.clone();
        let thread = thread::Builder::new().name("quotum-activity".into()).spawn(move || {
            let run = || -> io::Result<()> {
                let mut initial_accounts = BTreeMap::new();
                let mut queue = loop {
                    if stop.requested() || retirement.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    match Outbox::open_bounded(paths.state.join("activity"), namespace.clone()) {
                        Ok(queue) => break queue,
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            // Handoff releases the run lock before a pending HTTP reply releases its writer.
                            match rx.recv_timeout(Duration::from_millis(50)) {
                                Ok(Control::Accounts(accounts)) => initial_accounts = accounts,
                                Ok(Control::Fence) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                                Err(mpsc::RecvTimeoutError::Timeout) => {}
                                Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
                            }
                        }
                        Err(error) => return Err(error),
                    }
                };
                queue.check_credentials(credential_scope)?;
                queue.apply_privacy(privacy)?;
                let salt = crate::session_identity::salt(&paths);
                let mut activity = Activity::new(home, projects);
                activity.track(&clients);
                let first_sequence = queue.next_sequence();
                let mut capture = Sampler {
                    activity,
                    queue,
                    clock: time,
                    scope,
                    accounts: initial_accounts,
                    salt,
                    producers: HashMap::new(),
                    run: crate::config::random_hex(),
                    previous: None,
                    legacy: false,
                    first_sequence,
                    fenced: false,
                };
                capture.run(rx, &stop, &shared, &retirement)
            };
            if run().is_err() {
                failure.store(true, Ordering::Release);
            }
        })?;
        Ok(Self {
            tx: Some(tx),
            thread: Some(thread),
            snapshot,
            failed,
            retiring,
            paths: policy_paths,
            privacy: policy_revision,
            clock,
        })
    }
    pub(crate) fn delivery_guard(&self) -> io::Result<Option<super::privacy::Guard>> {
        super::privacy::allow(&self.paths, &self.privacy)
    }
    pub fn snapshot(&self) -> Option<Arc<Capture>> {
        self.snapshot.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    pub fn control(&self, control: Control) -> bool {
        self.tx.as_ref().is_some_and(|tx| tx.try_send(control).is_ok())
    }
    pub fn fence(&self) {
        self.retiring.store(true, Ordering::Release);
        // Wake a parked writer; a full channel cannot postpone the retirement flag.
        let _ = self.control(Control::Fence);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Clone)]
struct Endpoint {
    epoch: String,
    capture: String,
    reading: Reading,
    tick: u64,
    state: Arc<State>,
    witness: Option<String>,
    complete: bool,
    at: Instant,
    holds: BTreeMap<String, Instant>,
}
struct Sampler {
    activity: Activity,
    queue: Outbox,
    clock: Arc<Clock>,
    scope: Scope,
    accounts: BTreeMap<ClientId, Account>,
    salt: Option<String>,
    producers: HashMap<(ClientId, u32, Millis), String>,
    run: String,
    previous: Option<Endpoint>,
    legacy: bool,
    first_sequence: u64,
    fenced: bool,
}

impl Sampler {
    fn restore_clock(&mut self, reading: &Reading) -> io::Result<Epoch> {
        let saved =
            self.queue.metadata.active_clock.as_ref().and_then(|id| self.queue.metadata.clocks.get(id)).cloned();
        let epoch = match saved {
            Some(epoch) if self.queue.is_current_clock(&epoch.id) && epoch.compatible(reading, true) => epoch,
            Some(old) => {
                self.queue.retire_unanchored(&old.id)?;
                Epoch::new(reading)
            }
            None => Epoch::new(reading),
        };
        self.queue.install_clock(epoch.clone())?;
        Ok(epoch)
    }

    fn run(
        &mut self,
        rx: mpsc::Receiver<Control>,
        stop: &Stop,
        shared: &Mutex<Option<Arc<Capture>>>,
        retiring: &AtomicBool,
    ) -> io::Result<()> {
        let origin = Instant::now();
        let mut cadence = Cadence::new();
        let reading = self.clock.read();
        let mut epoch = self.restore_clock(&reading)?;
        // A process restart never carries a CPU hold or complete endpoints across its gap.
        if self.active_witness().is_some_and(|w| w.scope_digest != self.scope.digest()) {
            self.queue.install_witness(None)?;
        }
        loop {
            if retiring.load(Ordering::Acquire) {
                self.queue.retire_since(self.first_sequence)?;
                shared.lock().unwrap_or_else(|e| e.into_inner()).take();
                break;
            }
            let now = origin.elapsed().as_millis() as u64;
            let stopping = stop.requested();
            let due = if stopping {
                now
            } else if self.legacy {
                cadence.next
            } else {
                cadence.due(now)
            };
            let wait = Duration::from_millis(due.saturating_sub(now));
            // Keep the writer available for a response arriving after Stop, until its owner drops it.
            let received = if stopping {
                rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
            } else {
                rx.recv_timeout(wait)
            };
            if retiring.load(Ordering::Acquire) {
                self.queue.retire_since(self.first_sequence)?;
                shared.lock().unwrap_or_else(|e| e.into_inner()).take();
                break;
            }
            match received {
                Ok(control) => {
                    let control_started = Instant::now();
                    let budget_cost = super::cost::Cost::start();
                    #[cfg(all(feature = "activity-bench", target_os = "linux"))]
                    let control_cpu = super::probe::cpu();
                    self.control(control, &mut epoch)?;
                    if self.fenced {
                        shared.lock().unwrap_or_else(|e| e.into_inner()).take();
                        break;
                    }
                    if self.publish_control(shared, &epoch) {
                        cadence.reset_grid(origin.elapsed().as_millis() as u64);
                    }
                    cadence.control(
                        origin.elapsed().as_millis() as u64,
                        budget_cost.elapsed_ms(control_started.elapsed()),
                    );
                    #[cfg(all(feature = "activity-bench", target_os = "linux"))]
                    super::probe::cost(
                        "control",
                        super::probe::cpu() - control_cpu,
                        control_started.elapsed().as_secs_f64() * 1000.0,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if stop.requested() {
                continue;
            }
            let started = Instant::now();
            let budget_cost = super::cost::Cost::start();
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            let capture_cpu = super::probe::cpu();
            let reading = self.clock.read();
            let now = origin.elapsed().as_millis() as u64;
            let period = self.previous.as_ref().map(|p| reading.tick.saturating_sub(p.reading.tick));
            let suspended = self.previous.as_ref().is_some_and(|p| {
                (i128::from(reading.tick)
                    - i128::from(p.reading.tick)
                    - started.duration_since(p.at).as_millis() as i128)
                    .abs()
                    > 2000
            });
            let late = now.saturating_sub(cadence.deadline()) > 2000.max(period.unwrap_or(0) / 4);
            let clock_fault = !epoch.compatible(&reading, false);
            let missed_judgement = now.saturating_sub(cadence.judgement) > 3750;
            if clock_fault {
                self.queue.retire_unanchored(&epoch.id)?;
                epoch = Epoch::new(&reading);
                self.queue.install_clock(epoch.clone())?;
            }
            if late || clock_fault || suspended || missed_judgement {
                self.previous = None;
                self.activity.reset_evidence();
                self.run = crate::config::random_hex();
                cadence.reset_grid(now);
            }
            let judge = cadence.should_judge(now);
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            let native_started = (super::probe::cpu(), Instant::now());
            let sessions = self.activity.capture(judge);
            let roots = sessions.len();
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            super::probe::cost(
                "native",
                super::probe::cpu() - native_started.0,
                native_started.1.elapsed().as_secs_f64() * 1000.0,
            );
            if judge {
                cadence.judged(now);
            }
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            let context_started = (super::probe::cpu(), Instant::now());
            let (mut state, holds, order, legacy_ids) = self.state(sessions, reading.wall);
            state.tracking.complete &= self.activity.complete();
            let complete = state.tracking.complete;
            let state = Arc::new(state);
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            super::probe::cost(
                "context",
                super::probe::cpu() - context_started.0,
                context_started.1.elapsed().as_secs_f64() * 1000.0,
            );
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            let persistence_started = (super::probe::cpu(), Instant::now());
            if !self.legacy {
                self.record(&state, &reading, &epoch, complete, started, holds)?;
            }
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            super::probe::cost(
                "persistence",
                super::probe::cpu() - persistence_started.0,
                persistence_started.1.elapsed().as_secs_f64() * 1000.0,
            );
            let empty = state.contexts.is_empty() && complete;
            let idle = !state.contexts.is_empty() && state.contexts.iter().all(|c| c.working == Some(false));
            let paths = self.activity.client_paths();
            let latest = Latest { clock_epoch: epoch.id.clone(), tick: epoch.tick(&reading), state };
            epoch.last_tick = reading.tick;
            if let Some(saved) = self.queue.metadata.clocks.get_mut(&epoch.id) {
                saved.last_tick = reading.tick;
            }
            let digest = latest.state.digest();
            let capture = Capture {
                epoch: epoch.clone(),
                reading,
                latest,
                witness: self.active_witness(),
                paths,
                digest,
                order,
                legacy_ids,
                queue_id: self.queue.queue_id().into(),
                open_id: self.queue.open_id().into(),
                binding: self.queue.binding().cloned(),
                ack: self.queue.ack(),
                sequence: self.queue.next_sequence(),
                release_pending: !self.queue.metadata.releases.is_empty(),
            };
            Self::publish(shared, capture);
            #[cfg(all(feature = "activity-bench", target_os = "linux"))]
            super::probe::cost("capture", super::probe::cpu() - capture_cpu, started.elapsed().as_secs_f64() * 1000.0);
            cadence.completed(
                origin.elapsed().as_millis() as u64,
                budget_cost.elapsed_ms(started.elapsed()),
                empty,
                idle,
                Cadence::pressure(self.activity.contributors(), roots),
            );
            if self.legacy {
                cadence.next = (now / 15_000 + 1) * 15_000;
            }
        }
        Ok(())
    }

    fn publish(shared: &Mutex<Option<Arc<Capture>>>, capture: Capture) {
        let old = shared.lock().unwrap_or_else(|e| e.into_inner()).replace(Arc::new(capture));
        drop(old);
    }
    fn publish_control(&self, shared: &Mutex<Option<Arc<Capture>>>, epoch: &Epoch) -> bool {
        let before = { shared.lock().unwrap_or_else(|e| e.into_inner()).clone() };
        if let Some(before) = before {
            if before.latest.clock_epoch != epoch.id {
                // Recovery chose a new clock; its first real endpoint must publish its state.
                shared.lock().unwrap_or_else(|e| e.into_inner()).take();
                return true;
            }
            let mut next = (*before).clone();
            next.binding = self.queue.binding().cloned();
            next.ack = self.queue.ack();
            next.epoch = epoch.clone();
            next.witness = self.active_witness();
            next.release_pending = !self.queue.metadata.releases.is_empty();
            Self::publish(shared, next);
        }
        false
    }
    fn active_witness(&self) -> Option<Witness> {
        self.queue.metadata.active_witness.as_ref().and_then(|id| self.queue.metadata.witnesses.get(id)).cloned()
    }

    fn control(&mut self, control: Control, epoch: &mut Epoch) -> io::Result<()> {
        match control {
            Control::Accounts(accounts) => self.accounts = accounts,
            Control::Fence => {
                self.queue.retire_since(self.first_sequence)?;
                self.fenced = true;
            }
            Control::Replacement => {
                self.queue.retire_all("recovery")?;
                self.legacy = true;
                self.previous = None;
            }
            Control::Prepare(sender) => {
                // Clock reads, expiry and journal IO all spend this one attempt's handoff time.
                let prepared_at = Instant::now();
                let reading = self.clock.read();
                if epoch.compatible(&reading, false) {
                    if let Some(now) = epoch.anchor.as_ref().and_then(|a| a.project(epoch.tick(&reading))) {
                        self.queue.expire(now)?;
                    }
                }
                let _ = sender.send(self.queue.prepare().map(|batch| Prepared { batch, prepared_at, reading }));
            }
            Control::Legacy(legacy) => {
                self.legacy = legacy;
                self.previous = None;
                self.activity.reset_evidence();
                self.run = crate::config::random_hex();
            }
            Control::Ack { through, released } => self.queue.acknowledge(through, &released)?,
            Control::Bind { binding, epoch: sent_epoch, sent, server, accepted_anchor, witness, ack, recover } => {
                self.legacy = false;
                let acknowledged_clock = self.queue.clock_started_by(&epoch.id, ack);
                self.queue.bind(*binding)?;
                let restored = accepted_anchor.filter(|anchor| anchor.clock_epoch == epoch.id);
                if epoch.anchor.is_none() && restored.is_none() && acknowledged_clock {
                    // A coherent old backup can forget a previously accepted clock. Never rebind that identity.
                    self.queue.retire_unanchored(&epoch.id)?;
                    *epoch = Epoch::new(&self.clock.read());
                    self.previous = None;
                    self.activity.reset_evidence();
                    self.run = crate::config::random_hex();
                    self.queue.install_clock(epoch.clone())?;
                } else {
                    let bound = match restored {
                        // This restores an immutable historical mapping, independently of the current HTTP sample.
                        Some(anchor) => epoch.restore(anchor),
                        None if sent_epoch == epoch.id && epoch.compatible(&self.clock.read(), false) => {
                            epoch.bind(&sent, server)
                        }
                        None => false,
                    };
                    if bound {
                        self.queue.install_clock(epoch.clone())?;
                    }
                }
                // Reclamation must not erase the only evidence needed to restore or retire a clock identity.
                if recover {
                    self.queue.rewind_acknowledgement(ack)?;
                } else {
                    self.queue.acknowledge(ack, &[])?;
                }
                let witness = witness.filter(|w| w.scope_digest == self.scope.digest());
                self.queue.install_witness(witness)?;
                self.queue.expire(server)?;
            }
        }
        Ok(())
    }

    fn state(
        &mut self,
        sessions: Vec<Session>,
        wall: Millis,
    ) -> (State, BTreeMap<String, Instant>, Vec<String>, Vec<String>) {
        let valid_accounts: BTreeMap<_, _> = self
            .accounts
            .iter()
            .map(|(client, a)| (*client, a.paths.is_empty() || last_activity(&a.paths) == a.identity))
            .collect();
        let (mut legacy, mut supplemental): (Vec<_>, Vec<_>) =
            sessions.into_iter().filter(|s| self.scope.clients.iter().any(|id| id == s.client.id())).partition(|s| {
                self.accounts
                    .get(&s.client)
                    .is_some_and(|a| a.legacy && a.source.is_some() && valid_accounts.get(&s.client) == Some(&true))
            });
        let mut complete = legacy.len() + supplemental.len() <= 200;
        let cap = |sessions: &mut Vec<Session>, limit: usize| {
            if sessions.len() > limit {
                sessions.sort_by_key(|s| {
                    std::cmp::Reverse((
                        s.working == Some(true),
                        if s.working == Some(true) { None } else { s.last_worked },
                        s.started_at,
                    ))
                });
                sessions.truncate(limit);
            }
        };
        cap(&mut legacy, 200);
        cap(&mut supplemental, 200 - legacy.len());
        let legacy_count = legacy.len();
        let sessions = legacy.into_iter().chain(supplemental);
        let mut ordinals = HashMap::<String, u32>::new();
        let mut contexts = Vec::new();
        let mut holds = BTreeMap::new();
        let mut order = Vec::new();
        let mut legacy_ids = Vec::new();
        for session in sessions {
            let hold = self.activity.work_deadline(&session);
            let session_id = session.native_birth.as_deref().and_then(|birth| {
                self.salt.as_ref().map(|salt| crate::session_identity::identify(salt, session.client, birth))
            });
            let producer = self
                .producers
                .entry((session.client, session.pid, session.started_at))
                .or_insert_with(crate::config::random_hex)
                .clone();
            let account =
                self.accounts.get(&session.client).filter(|_| valid_accounts.get(&session.client) == Some(&true));
            let source = account.and_then(|a| a.source.clone());
            let project = crate::runner::names(session.project, session.folder, true);
            let fingerprint = serde_json::to_string(&(
                session.client.id(),
                &source,
                session.origin.id(),
                session.started_at,
                &project,
            ))
            .expect("activity fingerprint");
            let ordinal = ordinals.entry(fingerprint).or_default();
            let legacy = *ordinal;
            if session.working == Some(true) {
                *ordinal += 1;
            }
            let context_id: String = digest(&serde_json::json!([
                session_id.as_ref().unwrap_or(&producer),
                source,
                session.origin.id(),
                project
            ]))
            .chars()
            .take(32)
            .collect();
            if let Some(hold) = hold.filter(|_| session.working == Some(true)) {
                holds.insert(context_id.clone(), hold);
            }
            if order.len() < legacy_count {
                legacy_ids.push(context_id.clone());
            }
            order.push(context_id.clone());
            contexts.push(Context {
                context_id,
                client_id: session.client.id().into(),
                session_id: session_id.clone(),
                ordinal: session_id.is_none().then_some(legacy),
                source,
                account_by: account.and_then(|a| a.by.clone()),
                origin: session.origin.id().into(),
                project: project.0,
                folder: project.1,
                started_at: session.started_at.min(wall),
                route: None,
                working: session.working,
                last_worked_at: session.last_worked,
            });
        }
        let live: std::collections::HashSet<_> = contexts.iter().map(|c| (&c.client_id, c.started_at)).collect();
        self.producers.retain(|(client, _, started), _| live.contains(&(&client.id().to_string(), *started)));
        let mut scope = self.scope.clone();
        scope.complete = complete;
        let mut state = State { tracking: scope, contexts };
        state.normalize();
        while serde_json::to_vec(&state).expect("activity state").len() + super::BODY_RESERVE_BYTES > BODY_BYTES {
            let worst = state
                .contexts
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| {
                    (legacy_ids.contains(&c.context_id), c.working == Some(true), c.last_worked_at, c.started_at)
                })
                .map(|(i, _)| i)
                .unwrap();
            let removed = state.contexts.remove(worst);
            order.retain(|id| *id != removed.context_id);
            legacy_ids.retain(|id| *id != removed.context_id);
            complete = false;
            state.tracking.complete = false;
        }
        state.tracking.complete &= complete;
        (state, holds, order, legacy_ids)
    }

    fn record(
        &mut self,
        state: &Arc<State>,
        reading: &Reading,
        epoch: &Epoch,
        complete: bool,
        at: Instant,
        holds: BTreeMap<String, Instant>,
    ) -> io::Result<()> {
        let witness = self.active_witness().map(|w| w.id);
        let endpoint = Endpoint {
            epoch: epoch.id.clone(),
            capture: self.run.clone(),
            reading: reading.clone(),
            tick: epoch.tick(reading),
            state: state.clone(),
            witness: witness.clone(),
            complete,
            at,
            holds,
        };
        if let Some(before) = self.previous.take().filter(|p| {
            p.epoch == epoch.id
                && p.capture == self.run
                && endpoint.tick >= p.tick
                && endpoint.tick - p.tick <= super::MAX_FRAME_MS
        }) {
            let changed = before.state.contexts.iter().any(|old| {
                old.working.is_some()
                    && state
                        .contexts
                        .iter()
                        .find(|new| new.context_id == old.context_id)
                        .is_none_or(|new| new.working.is_none())
            });
            let mut records = Vec::new();
            let mut from = before;
            // Losing a context never extends its old work to the first uncertain endpoint.
            if changed {
                let mut unknown = from.state.as_ref().clone();
                unknown.tracking.complete = false;
                for old in &mut unknown.contexts {
                    if state
                        .contexts
                        .iter()
                        .find(|new| new.context_id == old.context_id)
                        .is_none_or(|new| new.working.is_none())
                    {
                        old.working = None;
                    }
                }
                let unknown = Arc::new(unknown);
                from = self.span(&mut records, &from, from.clone(), Some(unknown), false, from.witness.clone())?;
            }
            let proof = if from.witness == witness { witness.clone() } else { None };
            let mut expiries = from
                .holds
                .iter()
                .filter(|(id, deadline)| {
                    **deadline > from.at
                        && **deadline < endpoint.at
                        && from.state.contexts.iter().any(|c| &c.context_id == *id && c.working == Some(true))
                })
                .map(|(_, deadline)| *deadline)
                .collect::<Vec<_>>();
            expiries.sort();
            expiries.dedup();
            for deadline in expiries {
                let tick = from.tick + deadline.duration_since(from.at).as_millis() as u64;
                if tick >= endpoint.tick {
                    continue;
                }
                let mut idle = from.state.as_ref().clone();
                for c in &mut idle.contexts {
                    if from.holds.get(&c.context_id).is_some_and(|hold| *hold <= deadline) && c.working == Some(true) {
                        c.working = Some(false);
                    }
                }
                let idle = Arc::new(idle);
                let end = Endpoint {
                    epoch: from.epoch.clone(),
                    capture: from.capture.clone(),
                    reading: Reading {
                        wall: from.reading.wall + (tick - from.tick) as i64,
                        tick: from.reading.tick + (tick - from.tick),
                        boot: from.reading.boot.clone(),
                    },
                    tick,
                    state: idle.clone(),
                    witness: proof.clone(),
                    complete: from.complete,
                    at: deadline,
                    holds: from.holds.clone(),
                };
                from = self.span(
                    &mut records,
                    &from,
                    end,
                    Some(idle),
                    complete && from.complete && !changed && proof.is_some(),
                    proof.clone(),
                )?;
            }
            let next = (from.state != *state).then(|| state.clone());
            let end = self.span(
                &mut records,
                &from,
                endpoint,
                next,
                complete && from.complete && !changed && proof.is_some(),
                proof,
            )?;
            self.queue.append_transaction(records)?;
            self.previous = Some(end);
        } else {
            self.queue.append(state, Self::raw(&endpoint, &endpoint, None, false), witness)?;
            self.previous = Some(endpoint);
        }
        Ok(())
    }

    fn span(
        &mut self,
        records: &mut Vec<(Arc<State>, Raw, Option<String>)>,
        from: &Endpoint,
        mut to: Endpoint,
        next: Option<Arc<State>>,
        complete: bool,
        proof: Option<String>,
    ) -> io::Result<Endpoint> {
        to.capture = from.capture.clone();
        let mut raw = Self::raw(from, &to, next.clone(), complete);
        let bytes = serde_json::to_vec(&from.state).map_err(|_| io::ErrorKind::InvalidData)?.len()
            + serde_json::to_vec(&raw).map_err(|_| io::ErrorKind::InvalidData)?.len()
            + super::BODY_RESERVE_BYTES;
        if bytes > BODY_BYTES {
            raw.next_state = None;
            records.push((from.state.clone(), raw, proof.clone()));
            self.run = crate::config::random_hex();
            to.capture = self.run.clone();
            to.state = next.ok_or(io::ErrorKind::InvalidData)?;
            records.push((to.state.clone(), Self::raw(&to, &to, None, false), proof));
        } else {
            records.push((from.state.clone(), raw, proof));
            if let Some(next) = next {
                to.state = next;
            }
        }
        Ok(to)
    }

    fn raw(from: &Endpoint, to: &Endpoint, next_state: Option<Arc<State>>, complete: bool) -> Raw {
        Raw {
            seq: 0,
            capture_epoch: from.capture.clone(),
            clock_epoch: from.epoch.clone(),
            from_tick: from.tick,
            to_tick: to.tick,
            from_wall: from.reading.wall,
            to_wall: to.reading.wall,
            base_state_digest: from.state.digest(),
            next_state,
            complete,
        }
    }
}

#[cfg(test)]
impl Worker {
    /// Delivery fixtures exercise a captured state and the real privacy gate without a native scan.
    pub(super) fn with_capture(paths: Paths, privacy: String, capture: Capture) -> Self {
        Self {
            tx: None,
            thread: None,
            snapshot: Arc::new(Mutex::new(Some(Arc::new(capture)))),
            failed: Arc::new(AtomicBool::new(false)),
            retiring: Arc::new(AtomicBool::new(false)),
            paths,
            privacy,
            clock: Arc::new(Clock::new()),
        }
    }

    /// Only native scanning and clock input are stood in; queued controls use the production sampler.
    pub(super) fn with_outbox(
        paths: Paths,
        privacy: String,
        queue: Outbox,
        epoch: Epoch,
        capture: Capture,
    ) -> (Self, WriterFixture) {
        let (tx, rx) = mpsc::sync_channel(8);
        let scope = capture.latest.state.tracking.clone();
        let clock = Arc::new(Clock::fixed(capture.reading.clone()));
        let mut worker = Self::with_capture(paths.clone(), privacy, capture);
        worker.tx = Some(tx);
        worker.clock = clock.clone();
        let fixture = WriterFixture {
            sampler: Sampler {
                activity: Activity::new(paths.state, true),
                first_sequence: queue.next_sequence(),
                queue,
                clock,
                scope,
                accounts: BTreeMap::new(),
                salt: None,
                producers: HashMap::new(),
                run: crate::config::random_hex(),
                previous: None,
                legacy: false,
                fenced: false,
            },
            epoch,
            rx,
            shared: worker.snapshot.clone(),
        };
        (worker, fixture)
    }
}

#[cfg(test)]
pub(super) struct WriterFixture {
    sampler: Sampler,
    epoch: Epoch,
    rx: mpsc::Receiver<Control>,
    shared: Arc<Mutex<Option<Arc<Capture>>>>,
}

#[cfg(test)]
impl WriterFixture {
    pub fn process(&mut self) {
        let control = self.rx.try_recv().expect("queued writer control");
        self.sampler.control(control, &mut self.epoch).unwrap();
        self.sampler.publish_control(&self.shared, &self.epoch);
    }

    pub fn reading(&mut self, worker: &mut Worker, reading: Reading) {
        let clock = Arc::new(Clock::fixed(reading));
        worker.clock = clock.clone();
        self.sampler.clock = clock;
    }

    pub fn pending(&self) -> Batch {
        self.sampler.queue.prepare().unwrap()
    }
}
