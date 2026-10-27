//! Drives the adapters: once for a status check, or continuously on the schedule.

use crate::collection::{AccountRef, CollectionOutcome, CollectionResult, Completion, CompletionOutcome};
use crate::hooks::Identity;
pub use crate::observers::Diagnostic;
use crate::observers::Observers;
use crate::sink::AccountRoster;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::activity::Activity;
use crate::clients::{ClientId, Inventory};
use crate::config::{Config, Paths, home, jitter};
use crate::measurement_policy::MeasurementPolicy;
use crate::model::{
    ClientSession, ClientSource, ErrorKind, Millis, Outcome, Provider, RunningSession, SessionReport, Tracking, now_ms,
};
use crate::providers::{Collector, Context, adapter, find_client, last_activity};
use crate::schedule::Schedule;
use crate::sink::{Ask, Directive, Sink};
use crate::stop::Stop;

/// A single measurement may take this long before the client is killed.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
/// The loop wakes at least this often, to notice a stop request or a jump of the clock.
const TICK: Duration = Duration::from_secs(1);
/// A wall clock set back by less than this is not worth correcting for.
const CLOCK_SLACK_MS: Millis = 2_000;

/// How often the agent looks at which coding agents run here, and how often it tells the
/// hub at least while any run (the hub keeps a list for five minutes).
const LOOK_EVERY: Duration = Duration::from_secs(15);
const REPORT_EVERY: Duration = Duration::from_secs(120);

/// Which coding agents run on this machine, told to the hub when that changes.
struct Watch {
    activity: Activity,
    looked: Option<Instant>,
    reported: Option<(Instant, SessionReport)>,
    inventory: Inventory,
    continuity_fault: bool,
}

impl Watch {
    /// The captured list cannot close coverage across a clock discontinuity.
    fn clocked_witness(
        &mut self,
        report: &mut SessionReport,
        captured: bool,
        clock: &mut Clock,
        wall: Millis,
    ) -> Millis {
        let back = clock.went_back(wall);
        self.continuity_fault |= clock.discontinuous;
        self.witness(report, captured);
        back
    }

    /// Whether `now` is a new list to send: the first one, a change, or one repeated in time.
    fn worth_sending(&self, report: &SessionReport) -> bool {
        if self.continuity_fault {
            return true;
        }
        match &self.reported {
            None => true,
            Some((at, before)) => {
                before != report
                    || ((!report.sessions.is_empty()
                        || !report.client_sessions.is_empty()
                        || report.tracking.as_ref().is_some_and(|t| !t.clients.is_empty()))
                        && at.elapsed() >= REPORT_EVERY)
            }
        }
    }

    fn witness(&mut self, report: &mut SessionReport, captured: bool) {
        let Some(tracking) = &mut report.tracking else { return };
        if !captured
            || !tracking.complete
            || self.reported.as_ref().is_some_and(|(_, before)| {
                before
                    .tracking
                    .as_ref()
                    .is_none_or(|t| t.clients != tracking.clients || t.route_disabled != tracking.route_disabled)
            })
        {
            self.continuity_fault = true;
        }
        tracking.complete &= !self.continuity_fault;
    }

    fn acknowledged(&mut self, report: SessionReport, accepted: bool) {
        if accepted {
            // A false witness must reach the hub before continuity can start anew.
            if report.tracking.as_ref().is_some_and(|t| !t.complete) {
                self.continuity_fault = false;
            }
            self.reported = Some((Instant::now(), report));
        } else {
            self.continuity_fault = true;
        }
    }
}

/// The wall clock as last seen, with the monotonic clock at that moment.
struct Clock {
    at: Instant,
    wall: Millis,
    discontinuous: bool,
}

impl Clock {
    fn new(wall: Millis) -> Clock {
        Clock { at: Instant::now(), wall, discontinuous: false }
    }

    /// How far the wall clock went back since the last look, measured against the
    /// monotonic clock; 0 when it did not. A jump forward is left alone: after a
    /// sleep everything is overdue anyway.
    fn went_back(&mut self, wall: Millis) -> Millis {
        let back = self.at.elapsed().as_millis() as Millis - (wall - self.wall);
        *self = Clock::new(wall);
        self.discontinuous = back.abs() > CLOCK_SLACK_MS;
        if back > CLOCK_SLACK_MS { back } else { 0 }
    }
}

pub struct Runner {
    config: Config,
    paths: Paths,
    home: PathBuf,
    adapters: Vec<Box<dyn Collector>>,
    hooks: Vec<crate::hooks::Hook>,
    clients: Vec<ClientId>,
    /// Ends this run, a measurement under way included.
    stop: Stop,
    policy_contact_every: Duration,
    activity_deferred: bool,
}

impl Runner {
    /// Collectors for the enabled providers, cheapest first: Codex, Claude, Antigravity.
    pub fn new(config: Config, paths: Paths, only: &[ClientId], stop: Stop) -> Runner {
        let order = [Provider::Codex, Provider::Claude, Provider::Antigravity];
        let adapters = order
            .into_iter()
            .filter(|p| {
                config.enabled(*p)
                    && config.providers.get(p).is_none_or(|settings| settings.hooks.collect.is_none())
                    && (only.is_empty() || only.contains(&ClientId::from(*p)))
            })
            .map(adapter)
            .collect();
        let mut runner = Runner::with_adapters(config, paths, adapters, home(), stop);
        runner.clients.retain(|c| only.is_empty() || only.contains(c));
        runner.hooks.retain(|h| only.is_empty() || only.contains(&ClientId::from(h.provider())));
        runner
    }

    /// A runner of the given adapters, in the order they are measured, with `home` as the user's.
    pub fn with_adapters(
        config: Config,
        paths: Paths,
        adapters: Vec<Box<dyn Collector>>,
        home: PathBuf,
        stop: Stop,
    ) -> Runner {
        let clients = ClientId::ALL.into_iter().filter(|c| config.tracks(*c)).collect();
        Runner {
            hooks: crate::hooks::Hook::configured(&config),
            config,
            paths,
            home,
            adapters,
            clients,
            stop,
            policy_contact_every: Duration::from_secs(60),
            activity_deferred: false,
        }
    }

    /// Keep quota collection running while the app persists its latest privacy restriction.
    pub fn defer_activity(&mut self) {
        self.activity_deferred = true;
    }

    pub fn clients(&self) -> &[ClientId] {
        &self.clients
    }

    pub fn providers(&self) -> Vec<Provider> {
        self.adapters.iter().map(|a| a.provider()).chain(self.hooks.iter().map(|h| h.provider())).collect()
    }

    fn measure(&mut self, index: usize) -> Outcome {
        let adapter = &mut self.adapters[index];
        let provider = adapter.provider();
        let ctx = Context {
            home: &self.home,
            work_dir: &self.paths.work,
            state_dir: &self.paths.state,
            program: self.config.program(provider),
            timeout: CLIENT_TIMEOUT,
            stop: &self.stop,
        };
        let mut outcome = adapter.measure(&ctx);
        if let Ok(snapshot) = &mut outcome {
            if snapshot.account.is_none() {
                snapshot.account_name = self.config.account_name(provider).map(str::to_string);
            }
            snapshot.tidy();
        }
        outcome
    }

    /// Whether the provider's client is on this machine: a device checks in only for
    /// what it can measure, or it would keep duty from one that can.
    fn installed(&self, index: usize) -> bool {
        let adapter = &self.adapters[index];
        match self.config.program(adapter.provider()) {
            Some(path) => path.exists(),
            None => find_client(adapter.as_ref(), &self.home).is_some(),
        }
    }

    /// Measures every provider once, one after another, reporting each as it finishes.
    pub fn measure_all(&mut self, mut each: impl FnMut(&Outcome)) {
        self.collect_all(|result| match &result.outcome {
            CollectionOutcome::Observed(snapshot) => each(&Ok(snapshot.clone())),
            CollectionOutcome::Failed(failure) => each(&Err(failure.clone())),
            CollectionOutcome::NoNewData => {}
        });
    }

    /// All local outcomes, including successful attempts without fresh observations.
    pub fn collect_all(&mut self, mut each: impl FnMut(&CollectionResult)) {
        self.collect_events(|event| {
            if let Event::Collected(result, _) = event {
                each(result)
            }
        });
    }

    pub fn collect_events(&mut self, mut each: impl FnMut(Event)) {
        let mut observers = Observers::new(&self.paths, &self.stop);
        for index in 0..self.adapters.len() {
            if self.stop.requested() {
                break;
            }
            let mut outcome = self.measure(index);
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = self.config.interval_ms(snapshot.provider).min(crate::model::STALE_LIMIT_MS);
            }
            if self.stop.requested() {
                break;
            }
            let result = local_result(self.adapters[index].provider(), None, outcome, attempt_id(), "measure");
            if let Some(diagnostic) = observers.enqueue(&self.config, &result, &self.stop) {
                each(Event::Diagnostic(&diagnostic));
            }
            each(Event::Collected(&result, 0));
        }
        for hook in &self.hooks {
            if self.stop.requested() {
                break;
            }
            let attempt = attempt_id();
            match hook.discover(&self.paths, &self.stop) {
                Ok(identities) => {
                    let (outcomes, invalid) =
                        hook.measure(&identities, &self.paths, &self.stop, self.config.interval_ms(hook.provider));
                    if self.stop.requested() {
                        break;
                    }
                    if invalid {
                        let d = Diagnostic {
                            provider: hook.provider,
                            hook: "collect",
                            account: None,
                            code: "invalid_output",
                        };
                        each(Event::Diagnostic(&d));
                    }
                    for (id, outcome) in identities.into_iter().zip(outcomes) {
                        let result = CollectionResult {
                            version: 1,
                            provider: hook.provider,
                            account: Some(id.account),
                            attempt_id: attempt.clone(),
                            stage: "measure",
                            completed_at: now_ms(),
                            outcome,
                        };
                        if let Some(diagnostic) = observers.enqueue(&self.config, &result, &self.stop) {
                            each(Event::Diagnostic(&diagnostic));
                        }
                        each(Event::Collected(&result, 0));
                    }
                }
                Err(failure) if !self.stop.requested() => {
                    let result = local_result(hook.provider, None, Err(failure), attempt, "discover");
                    if let Some(diagnostic) = observers.enqueue(&self.config, &result, &self.stop) {
                        each(Event::Diagnostic(&diagnostic));
                    }
                    each(Event::Collected(&result, 0));
                }
                Err(_) => {}
            }
        }
        observers.finish(!self.stop.requested());
        while let Ok(diagnostic) = observers.diagnostics.try_recv() {
            each(Event::Diagnostic(&diagnostic));
        }
    }

    /// Measures on the schedule until its stop is requested or the hub refuses this device
    /// for good (then its reason is returned). When it is time, the device checks in with
    /// the hub (when there is one) about every provider due, in one request: the hub says
    /// which to measure now and when to ask again. While the hub sets the pace of a
    /// provider, it is asked often and the provider measured only when told; if another
    /// device measures the same subscription, this one only waits.
    pub fn run(&mut self, sink: &mut dyn Sink, mut each: impl FnMut(Event)) -> Option<String> {
        sink.require_collections(!self.hooks.is_empty());
        let intervals: Vec<u64> = self.adapters.iter().map(|a| self.config.interval_ms(a.provider())).collect();
        let least: Vec<Option<u64>> = self.adapters.iter().map(|a| self.config.min_interval_ms(a.provider())).collect();
        let mut schedule = Schedule::new(&intervals, now_ms(), self.config.eco());
        let mut hook_runs: Vec<HookRun> = self
            .hooks
            .iter()
            .map(|hook| HookRun {
                provider: hook.provider,
                admission: self.stop.child(),
                due: 0,
                failures: 0,
                ready: false,
                slots: BTreeMap::new(),
            })
            .collect();
        let mut observers = Observers::new(&self.paths, &self.stop);
        let mut native_admission: Vec<Stop> = self.adapters.iter().map(|_| self.stop.child()).collect();
        let mut admission_policy: Option<MeasurementPolicy> = None;
        let mut native_rosters: BTreeMap<Provider, AccountRef> = BTreeMap::new();
        let mut active: Option<ActiveCollection> = None;
        // A terminal sink response fences both workers before either is joined.
        macro_rules! check_refusal {
            () => {
                if let Some(reason) = sink.refused().map(str::to_owned) {
                    cancel_collection(&mut active, &mut observers);
                    return Some(reason);
                }
            };
        }
        check_refusal!();

        let activity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.activity_paths(&self.home)).collect();
        let identity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.identity_paths(&self.home)).collect();
        let mut seen: Vec<Option<SystemTime>> = vec![None; self.adapters.len()];
        // Whether each provider was used here since it was last looked at, for its own rhythm.
        let mut used = vec![false; self.adapters.len()];
        // The account each provider last reported, and the state of its sign-in files then.
        let mut accounts: Vec<Option<(Option<String>, Option<SystemTime>)>> = vec![None; self.adapters.len()];
        let providers = self.adapters.iter().map(|a| a.provider()).collect::<Vec<_>>();
        let collectors = self.providers();
        let mut policy: Option<MeasurementPolicy> = None;
        let mut commands: Vec<Option<String>> = vec![None; self.adapters.len()];
        let mut command_accounts: Vec<Option<String>> = vec![None; self.adapters.len()];
        let mut policy_contact = Instant::now();
        let target = if !self.stop.requested() && !self.activity_deferred { sink.activity_target() } else { None };
        check_refusal!();
        let observed = target.is_some() || self.activity_deferred;
        let enabled = self.config.sessions() && !self.clients.is_empty();
        let mut activity_delivery = target.and_then(|target| {
            let mut clients = self.clients.iter().filter(|_| enabled).map(|c| c.id().to_string()).collect::<Vec<_>>();
            clients.sort();
            let mut route_disabled = ClientId::ALL
                .into_iter()
                .filter(|c| !self.config.routes(*c))
                .map(|c| c.id().to_string())
                .collect::<Vec<_>>();
            route_disabled.sort();
            crate::observed::worker::Worker::start(crate::observed::worker::Start {
                paths: self.paths.clone(),
                home: self.home.clone(),
                clients: self.clients.clone(),
                scope: crate::observed::Scope { version: 1, clients, route_disabled, complete: true },
                namespace: target.namespace,
                credential_scope: target.credential_scope,
                projects: self.config.projects(),
                stop: self.stop.clone(),
                privacy: String::new(),
            })
            .map_err(|_| sink.activity_failed())
            .ok()
            .map(crate::observed::delivery::Delivery::new)
        });
        check_refusal!();
        let mut observed_inventory = Inventory::default();
        let mut inventory_at: Option<Instant> = None;
        let mut inventory = Vec::new();
        if sink.managed() {
            policy = sink.checkin_managed(&[], &collectors).policy;
            check_refusal!();
            sink.flush();
            check_refusal!();
            for (index, provider) in providers.iter().enumerate() {
                schedule.block(index, !sink.allows_measurement(*provider), now_ms());
            }
        }
        let mut clock = Clock::new(now_ms());
        let mut watch = (self.config.sessions() && !observed).then(|| Watch {
            activity: Activity::new(self.home.clone(), self.config.projects()),
            looked: None,
            reported: None,
            inventory: Inventory::default(),
            continuity_fault: true,
        });

        if let Some(watch) = &mut watch {
            watch.activity.track(&self.clients);
        }

        check_refusal!();
        while !self.stop.requested() {
            check_refusal!();
            sync_admission(
                &mut schedule,
                &policy,
                &mut admission_policy,
                &mut native_admission,
                &providers,
                &mut hook_runs,
                &self.stop,
            );
            while let Ok(diagnostic) = observers.diagnostics.try_recv() {
                each(Event::Diagnostic(&diagnostic));
            }
            if let Some(job) = &active {
                if !job.admitted(&policy, sink) {
                    job.stop.request(crate::stop::How::Exit);
                }
            }
            let ready = match active.as_ref().map(|job| job.receive.try_recv()) {
                Some(Ok(result)) => Some(result),
                Some(Err(std::sync::mpsc::TryRecvError::Disconnected)) => {
                    return Some("collection worker stopped unexpectedly".into());
                }
                _ => None,
            };
            if let Some(result) = ready {
                let mut job = active.take().unwrap();
                if let Some(worker) = job.worker.take() {
                    let _ = worker.join();
                }
                let admitted = job.admitted(&policy, sink) && !job.stop.requested();
                match (job.kind.clone(), result) {
                    (CollectionJob::Discover { hook: hi, id }, BackendResult::Discovered(result)) => {
                        if admitted {
                            match result {
                                Ok(identities) => {
                                    let run = &mut hook_runs[hi];
                                    let mut old = std::mem::take(&mut run.slots);
                                    for identity in identities {
                                        let mut slot = old.remove(&identity.account).unwrap_or_else(|| AccountSlot {
                                            identity: identity.clone(),
                                            index: schedule.insert(self.config.interval_ms(job.provider), now_ms()),
                                            admission: run.admission.child(),
                                            command: None,
                                            target: None,
                                        });
                                        slot.identity = identity;
                                        run.slots.insert(slot.identity.account.clone(), slot);
                                    }
                                    for slot in old.values() {
                                        slot.admission.request(crate::stop::How::Exit);
                                        schedule.remove(slot.index);
                                    }
                                    run.ready = true;
                                    run.failures = 0;
                                    run.due = now_ms() + self.config.interval_ms(job.provider) as i64;
                                }
                                Err(failure) => {
                                    let run = &mut hook_runs[hi];
                                    run.ready = false;
                                    run.failures += 1;
                                    run.due = now_ms()
                                        + (self
                                            .config
                                            .interval_ms(job.provider)
                                            .saturating_mul(1 << run.failures.saturating_sub(1).min(4)))
                                        .min(900_000) as i64;
                                    let result = local_result(job.provider, None, Err(failure), id, "discover");
                                    if let Some(d) = observers.enqueue(&self.config, &result, &run.admission) {
                                        each(Event::Diagnostic(&d));
                                    }
                                    each(Event::Collected(&result, run.due));
                                }
                            }
                            let mut rosters: Vec<_> = hook_runs
                                .iter()
                                .enumerate()
                                .filter(|(_, run)| run.ready)
                                .map(|(i, run)| AccountRoster {
                                    provider: self.hooks[i].provider,
                                    accounts: run.slots.keys().cloned().collect(),
                                })
                                .collect();
                            rosters.extend(native_rosters.iter().map(|(&provider, account)| AccountRoster {
                                provider,
                                accounts: vec![account.clone()],
                            }));
                            sink.account_rosters(&rosters);
                            check_refusal!();
                            let answer = sink.checkin_managed(&[], &collectors);
                            check_refusal!();
                            policy = answer.policy.or(policy);
                            sync_admission(
                                &mut schedule,
                                &policy,
                                &mut admission_policy,
                                &mut native_admission,
                                &providers,
                                &mut hook_runs,
                                &self.stop,
                            );
                            check_refusal!();
                            policy_contact = Instant::now();
                        }
                    }
                    (CollectionJob::Accounts { launches, id }, BackendResult::Accounts(outcomes, diagnostic)) => {
                        let completed_at = now_ms();
                        if admitted && diagnostic {
                            let d = Diagnostic {
                                provider: job.provider,
                                hook: "collect",
                                account: None,
                                code: "invalid_output",
                            };
                            each(Event::Diagnostic(&d));
                        }
                        for (launch, mut outcome) in launches.into_iter().zip(outcomes) {
                            let AccountLaunch { index, next, account, attempt, admission } = launch;
                            schedule.busy(index, false);
                            if !admitted || admission.requested() {
                                continue;
                            }
                            let now = completed_at;
                            let next = finish_schedule(&mut schedule, index, now, next, &mut outcome, false);
                            let result = CollectionResult {
                                version: 1,
                                provider: job.provider,
                                account: Some(account),
                                attempt_id: id.clone(),
                                stage: "measure",
                                completed_at: now,
                                outcome,
                            };
                            finish_collection(
                                &self.config,
                                &observers,
                                sink,
                                &mut each,
                                Finished { result: &result, next, attempt: attempt.as_ref(), admission: &admission },
                            );
                            check_refusal!();
                        }
                    }
                    (
                        CollectionJob::Native { index, next, attempt, id, signed_in, admission },
                        BackendResult::Native(adapter, outcome),
                    ) => {
                        self.adapters[index] = adapter;
                        schedule.busy(index, false);
                        if admitted && !admission.requested() {
                            seen[index] = last_activity(&activity_paths[index]).or(Some(SystemTime::UNIX_EPOCH));
                            let same_identity = last_activity(&identity_paths[index]) == signed_in;
                            let failure_account = if same_identity {
                                target_ref(job.provider, attempt.as_ref(), self.config.account_name(job.provider))
                            } else {
                                None
                            };
                            let mut result = local_result(job.provider, failure_account, outcome, id, "measure");
                            let delivery_attempt = if matches!(&result.outcome, CollectionOutcome::Failed(_)) {
                                failure_context(attempt.as_ref(), same_identity)
                            } else {
                                attempt.clone()
                            };
                            if let CollectionOutcome::Observed(snapshot) = &result.outcome {
                                accounts[index] = Some((snapshot.account.clone(), signed_in));
                                if let Some(reference) = AccountRef::of(snapshot).filter(|_| sink.managed()) {
                                    native_rosters.insert(snapshot.provider, reference);
                                    let mut rosters: Vec<_> = hook_runs
                                        .iter()
                                        .enumerate()
                                        .filter(|(_, run)| run.ready)
                                        .map(|(i, run)| AccountRoster {
                                            provider: self.hooks[i].provider,
                                            accounts: run.slots.keys().cloned().collect(),
                                        })
                                        .collect();
                                    rosters.extend(native_rosters.iter().map(|(&provider, account)| AccountRoster {
                                        provider,
                                        accounts: vec![account.clone()],
                                    }));
                                    sink.account_rosters(&rosters);
                                    check_refusal!();
                                    let answer = sink.checkin_managed(&[], &collectors);
                                    check_refusal!();
                                    policy = answer.policy.or(policy);
                                    sync_admission(
                                        &mut schedule,
                                        &policy,
                                        &mut admission_policy,
                                        &mut native_admission,
                                        &providers,
                                        &mut hook_runs,
                                        &self.stop,
                                    );
                                    check_refusal!();
                                    policy_contact = Instant::now();
                                }
                            }
                            if stamp(&policy, job.provider) == job.policy && sink.allows_measurement(job.provider) {
                                let next = finish_schedule(
                                    &mut schedule,
                                    index,
                                    now_ms(),
                                    next,
                                    &mut result.outcome,
                                    used[index],
                                );
                                finish_collection(
                                    &self.config,
                                    &observers,
                                    sink,
                                    &mut each,
                                    Finished {
                                        result: &result,
                                        next,
                                        attempt: delivery_attempt.as_ref(),
                                        admission: &admission,
                                    },
                                );
                                check_refusal!();
                                let legacy = match &result.outcome {
                                    CollectionOutcome::Observed(s) => Ok(s.clone()),
                                    CollectionOutcome::Failed(f) => Err(f.clone()),
                                    CollectionOutcome::NoNewData => unreachable!(),
                                };
                                each(Event::Measured(&legacy, next));
                            }
                        }
                    }
                    _ => {}
                }
            }
            if active.is_none() && !schedule.has_cleared() {
                let measurement_due = schedule.next().map(|(_, due)| due).unwrap_or(Millis::MAX);
                if let Some(hi) = self
                    .hooks
                    .iter()
                    .enumerate()
                    .find(|(hi, hook)| {
                        sink.allows_measurement(hook.provider)
                            && sink.supports_collections()
                            && now_ms() >= hook_runs[*hi].due
                            && hook_runs[*hi].due <= measurement_due
                    })
                    .map(|(hi, _)| hi)
                {
                    let hook = self.hooks[hi].clone();
                    let paths = self.paths.clone();
                    check_refusal!();
                    active = Some(ActiveCollection::spawn(
                        hook.provider,
                        CollectionJob::Discover { hook: hi, id: attempt_id() },
                        &policy,
                        &hook_runs[hi].admission,
                        move |stop| BackendResult::Discovered(hook.discover(&paths, &stop)),
                    ));
                }
            }
            if active.is_some() && policy_contact.elapsed() >= self.policy_contact_every.min(Duration::from_secs(15)) {
                let answer = sink.checkin_managed(&[], &collectors);
                check_refusal!();
                policy = answer.policy.or(policy);
                sync_admission(
                    &mut schedule,
                    &policy,
                    &mut admission_policy,
                    &mut native_admission,
                    &providers,
                    &mut hook_runs,
                    &self.stop,
                );
                check_refusal!();
                policy_contact = Instant::now();
                sink.flush();
                check_refusal!();
                if let Some(job) = &active {
                    if !job.admitted(&policy, sink) {
                        job.stop.request(crate::stop::How::Exit);
                    }
                }
            }
            for (hi, run) in hook_runs.iter().enumerate() {
                for slot in run.slots.values() {
                    schedule.block(
                        slot.index,
                        !run.ready || !sink.allows_measurement(self.hooks[hi].provider) || !sink.supports_collections(),
                        now_ms(),
                    );
                }
            }

            check_refusal!();
            if let Some(delivery) = &mut activity_delivery {
                #[cfg(all(feature = "activity-bench", target_os = "linux"))]
                let context_cpu = crate::observed::probe::cpu();
                delivery.accounts(if enabled {
                    self.activity_accounts(&accounts, &identity_paths)
                } else {
                    Default::default()
                });
                #[cfg(all(feature = "activity-bench", target_os = "linux"))]
                crate::observed::probe::CONTEXT_CPU_NS
                    .fetch_add(crate::observed::probe::cpu() - context_cpu, std::sync::atomic::Ordering::Relaxed);
                if inventory_at.is_none_or(|at| at.elapsed() >= LOOK_EVERY) {
                    if let Some(capture) = delivery.worker.snapshot() {
                        inventory = observed_inventory.look_running(
                            &self.config,
                            &self.clients,
                            &self.home,
                            &self.paths.work,
                            &self.stop,
                            &capture.paths,
                        );
                        inventory_at = Some(Instant::now());
                    }
                }
                delivery.turn(sink, &inventory);
                check_refusal!();
            }
            // Only while the list can go somewhere: no looking for a hub that does not take it
            // (now: an older one is asked again later, and looking starts over then).
            if let Some(watch) = watch.as_mut().filter(|_| !sink.takes_sessions()) {
                watch.looked = None;
                watch.continuity_fault = true;
            }
            if let Some(watch) =
                watch.as_mut().filter(|w| sink.takes_sessions() && w.looked.is_none_or(|at| at.elapsed() >= LOOK_EVERY))
            {
                let first = watch.looked.is_none();
                if watch.looked.is_some_and(|at| at.elapsed() > Duration::from_millis(200_000)) {
                    watch.continuity_fault = true;
                }
                watch.looked = Some(Instant::now());
                let seen = watch.activity.look();
                // The first look cannot tell working from idle: the list goes out from the second.
                if !first {
                    let mut report = self.report(seen, &accounts, &identity_paths);
                    report.clients = watch.inventory.look_running(
                        &self.config,
                        &self.clients,
                        &self.home,
                        &self.paths.work,
                        &self.stop,
                        &watch.activity.client_paths(),
                    );
                    let back = watch.clocked_witness(&mut report, watch.activity.complete(), &mut clock, now_ms());
                    if back > 0 {
                        schedule.shift(-back);
                        for hook in &mut hook_runs {
                            hook.due -= back;
                        }
                    }
                    // A list the hub did not take goes out again at the next look.
                    if watch.worth_sending(&report) {
                        let accepted = sink.report(&report);
                        check_refusal!();
                        watch.acknowledged(report, accepted);
                    }
                }
            }
            check_refusal!();
            // A clock set back (by hand, or synced after a wrong start) would leave every
            // due time far ahead: move them back with it.
            let back = clock.went_back(now_ms());
            if clock.discontinuous {
                if let Some(watch) = &mut watch {
                    watch.continuity_fault = true;
                }
            }
            if back > 0 {
                schedule.shift(-back);
                for hook in &mut hook_runs {
                    hook.due -= back;
                }
                if let Some(watch) = &mut watch {
                    watch.continuity_fault = true;
                }
            }

            // One recovery contact in the existing loop, including with sessions and every collector off.
            if !collectors.is_empty()
                && sink.needs_policy_contact()
                && policy_contact.elapsed() >= self.policy_contact_every
                && !schedule.has_cleared()
                && schedule.asks(now_ms()).is_empty()
            {
                let current = self.current_accounts(&accounts, &identity_paths);
                let mut indices: Vec<usize> = providers
                    .iter()
                    .enumerate()
                    .filter(|(i, p)| {
                        schedule.paced(*i)
                            && sink.allows_measurement(**p)
                            && current[*i].is_some()
                            && self.installed(*i)
                    })
                    .map(|(i, _)| i)
                    .collect();
                indices.sort_by_key(|i| (schedule.due(*i), *i));
                indices.truncate(1);
                let asks: Vec<Ask> = indices
                    .iter()
                    .map(|&i| Ask {
                        provider: providers[i],
                        account: current[i].as_ref().and_then(|a| a.as_deref()),
                        account_name: self.config.account_name(providers[i]),
                        active: used[i],
                        min_interval_ms: least[i],
                    })
                    .collect();
                let answer = sink.checkin_managed(&asks, &collectors);
                check_refusal!();
                sink.flush();
                check_refusal!();
                policy_contact = Instant::now();
                policy = answer.policy.or(policy);
                sync_admission(
                    &mut schedule,
                    &policy,
                    &mut admission_policy,
                    &mut native_admission,
                    &providers,
                    &mut hook_runs,
                    &self.stop,
                );
                check_refusal!();
                for (index, provider) in providers.iter().enumerate() {
                    schedule.block(index, !sink.allows_measurement(*provider), now_ms());
                }
                let directives: Vec<_> = indices.iter().copied().zip(answer.directives).collect();
                for (position, &i) in indices.iter().enumerate() {
                    commands[i] = answer.commands.get(position).cloned().flatten();
                    command_accounts[i] = answer.accounts.get(position).cloned().flatten();
                }
                schedule.answer(&directives, now_ms());
            }

            // What the last answer cleared is measured first, one after another.
            if active.is_none() {
                if let Some((index, next_in_ms)) = schedule.take_cleared() {
                    if self.stop.requested() {
                        break;
                    }
                    if index >= self.adapters.len() {
                        let Some((hi, _key)) = hook_runs.iter().enumerate().find_map(|(hi, run)| {
                            run.slots.iter().find(|(_, slot)| slot.index == index).map(|(key, _)| (hi, key.clone()))
                        }) else {
                            continue;
                        };
                        let hook = self.hooks[hi].clone();
                        if !sink.allows_measurement(hook.provider) || !sink.supports_collections() {
                            continue;
                        }
                        let indices = hook_runs[hi].slots.values().map(|slot| slot.index).collect::<Vec<_>>();
                        let mut granted = vec![(index, next_in_ms)];
                        granted.extend(schedule.take_cleared_for(&indices));
                        let mut selected = Vec::new();
                        let mut launches = Vec::new();
                        for (index, next) in granted {
                            let Some(slot) = hook_runs[hi].slots.values_mut().find(|slot| slot.index == index) else {
                                continue;
                            };
                            if slot.admission.requested() {
                                continue;
                            }
                            let attempt = policy
                                .as_ref()
                                .map(|p| p.attempt(hook.provider, slot.target.clone(), slot.command.take()));
                            launches.push(AccountLaunch {
                                index,
                                next,
                                account: slot.identity.account.clone(),
                                attempt,
                                admission: slot.admission.clone(),
                            });
                            selected.push(slot.identity.clone());
                            schedule.busy(index, true);
                        }
                        if selected.is_empty() {
                            continue;
                        }
                        let admission = Stop::linked(&launches.iter().map(|l| l.admission.clone()).collect::<Vec<_>>());
                        let kind = CollectionJob::Accounts { launches, id: attempt_id() };
                        let paths = self.paths.clone();
                        let interval = self.config.interval_ms(hook.provider);
                        check_refusal!();
                        active = Some(ActiveCollection::spawn(hook.provider, kind, &policy, &admission, move |stop| {
                            let (outcomes, diagnostic) = hook.measure(&selected, &paths, &stop, interval);
                            BackendResult::Accounts(outcomes, diagnostic)
                        }));
                    } else {
                        let provider = providers[index];
                        if !sink.allows_measurement(provider) {
                            schedule.block(index, true, now_ms());
                            continue;
                        }
                        let signed_in = last_activity(&identity_paths[index]);
                        let target = measurement_account(
                            self.adapters[index].local_account(&self.home),
                            &accounts[index],
                            signed_in,
                            command_accounts[index].clone(),
                        );
                        let attempt = policy.as_ref().map(|p| p.attempt(provider, target, commands[index].take()));
                        let suspended = Suspended {
                            provider,
                            activity: activity_paths[index].clone(),
                            identity: identity_paths[index].clone(),
                            witness: signed_in,
                            account: self.adapters[index].local_account(&self.home),
                            identifies: self.adapters[index].identifies_account(),
                        };
                        let mut backend = std::mem::replace(&mut self.adapters[index], Box::new(suspended));
                        let paths = self.paths.clone();
                        let home = self.home.clone();
                        let config = self.config.clone();
                        let kind = CollectionJob::Native {
                            index,
                            next: next_in_ms,
                            attempt,
                            id: attempt_id(),
                            signed_in,
                            admission: native_admission[index].clone(),
                        };
                        schedule.busy(index, true);
                        check_refusal!();
                        active = Some(ActiveCollection::spawn(
                            provider,
                            kind,
                            &policy,
                            &native_admission[index],
                            move |stop| {
                                let ctx = Context {
                                    home: &home,
                                    work_dir: &paths.work,
                                    state_dir: &paths.state,
                                    program: config.program(provider),
                                    timeout: CLIENT_TIMEOUT,
                                    stop: &stop,
                                };
                                let mut outcome = backend.measure(&ctx);
                                if let Ok(snapshot) = &mut outcome {
                                    if snapshot.account.is_none() {
                                        snapshot.account_name = config.account_name(provider).map(str::to_string);
                                    }
                                    snapshot.tidy();
                                }
                                BackendResult::Native(backend, outcome)
                            },
                        ));
                    }
                }
            }

            if self.stop.requested() {
                break;
            }
            check_refusal!();
            // A hook's check-in may have learned a new whole-device gate.
            for (index, provider) in providers.iter().enumerate() {
                schedule.block(index, !sink.allows_measurement(*provider), now_ms());
            }
            if active.is_some() {
                thread::sleep(Duration::from_millis(25).min(self.policy_contact_every));
                continue;
            }
            let now = now_ms();
            let mut due = schedule.asks(now);
            due.sort_by_key(|i| (schedule.due(*i), *i));
            if let Some(first) = due.first().copied() {
                if first < self.adapters.len() {
                    due.truncate(1);
                } else if let Some(run) =
                    hook_runs.iter().find(|run| run.slots.values().any(|slot| slot.index == first))
                {
                    due.retain(|index| run.slots.values().any(|slot| slot.index == *index));
                }
            }
            if due.is_empty() {
                let due = schedule.next().map(|(_, due)| due).unwrap_or(now + TICK.as_millis() as Millis);
                let wait = due - now_ms();
                if wait > 0 {
                    thread::sleep(Duration::from_millis(wait as u64).min(TICK).min(self.policy_contact_every));
                }
                continue;
            }
            let mut asked: Vec<(usize, Option<String>)> = Vec::new();
            for index in due {
                if index >= self.adapters.len() {
                    if let Some(slot) =
                        hook_runs.iter().flat_map(|run| run.slots.values()).find(|slot| slot.index == index)
                    {
                        asked.push((index, slot.identity.account.account().map(str::to_string)));
                    }
                    continue;
                }
                let adapter = &self.adapters[index];
                let before = seen[index];
                let latest = last_activity(&activity_paths[index]);
                used[index] = before.is_some() && latest > before;
                seen[index] = latest.or(Some(SystemTime::UNIX_EPOCH));
                // Which subscription this is, if known without starting the client.
                let account = if !self.installed(index) {
                    // Measured right away: it fails without starting anything and is asked less often.
                    None
                } else if !adapter.identifies_account() {
                    Some(None)
                } else {
                    let signed_in = last_activity(&identity_paths[index]);
                    ask_account(&schedule, index, adapter.local_account(&self.home), &accounts[index], signed_in)
                };
                match account {
                    Some(account) => asked.push((index, account)),
                    None => schedule.leave_out(index),
                }
            }
            if asked.is_empty() {
                continue;
            }
            let current = self.current_accounts(&accounts, &identity_paths);
            for (index, _) in &asked {
                if *index >= self.adapters.len() {
                    continue;
                }
                let provider = providers[*index];
                let reference = match &current[*index] {
                    Some(Some(account)) => Some(AccountRef::Supplier { account: account.clone() }),
                    Some(None) if provider == Provider::Antigravity => Some(AccountRef::Declared {
                        account_name: self.config.account_name(provider).map(|name| name.trim().to_lowercase()),
                    }),
                    _ => None,
                };
                if let Some(reference) = reference {
                    native_rosters.insert(provider, reference);
                }
            }
            let mut rosters = hook_runs
                .iter()
                .filter(|run| run.ready)
                .map(|run| AccountRoster { provider: run.provider, accounts: run.slots.keys().cloned().collect() })
                .collect::<Vec<_>>();
            rosters.extend(
                native_rosters
                    .iter()
                    .map(|(&provider, reference)| AccountRoster { provider, accounts: vec![reference.clone()] }),
            );
            sink.account_rosters(&rosters);
            check_refusal!();
            let asks: Vec<Ask> = asked
                .iter()
                .map(|(index, account)| {
                    if *index >= self.adapters.len() {
                        let (hi, slot) = hook_runs
                            .iter()
                            .enumerate()
                            .find_map(|(hi, run)| {
                                run.slots.values().find(|slot| slot.index == *index).map(|slot| (hi, slot))
                            })
                            .unwrap();
                        return Ask {
                            provider: self.hooks[hi].provider,
                            account: slot.identity.account.account(),
                            account_name: slot.identity.account.name(),
                            active: false,
                            min_interval_ms: self.config.min_interval_ms(self.hooks[hi].provider),
                        };
                    }
                    let provider = self.adapters[*index].provider();
                    Ask {
                        provider,
                        account: account.as_deref(),
                        account_name: self.config.account_name(provider).filter(|_| account.is_none()),
                        active: used[*index],
                        min_interval_ms: least[*index],
                    }
                })
                .collect();
            let answer = sink.checkin_managed(&asks, &collectors);
            check_refusal!();
            policy_contact = Instant::now();
            policy = answer.policy.or(policy);
            sync_admission(
                &mut schedule,
                &policy,
                &mut admission_policy,
                &mut native_admission,
                &providers,
                &mut hook_runs,
                &self.stop,
            );
            check_refusal!();
            for (index, provider) in providers.iter().enumerate() {
                schedule.block(index, !sink.allows_measurement(*provider), now_ms());
            }
            for (position, (i, _)) in asked.iter().enumerate() {
                if *i < self.adapters.len() {
                    commands[*i] = answer.commands.get(position).cloned().flatten();
                    command_accounts[*i] = answer.accounts.get(position).cloned().flatten();
                } else if let Some(slot) =
                    hook_runs.iter_mut().flat_map(|run| run.slots.values_mut()).find(|slot| slot.index == *i)
                {
                    slot.command = answer.commands.get(position).cloned().flatten();
                    slot.target = answer.accounts.get(position).cloned().flatten();
                }
            }
            let directives = answer.directives;
            // Refused just now: measuring would only start a client for nothing.
            check_refusal!();
            // The hub answers again: what it did not take before goes now, or it would take the provider for silent.
            if directives.iter().any(|d| *d != Directive::Unanswered) {
                sink.flush();
                check_refusal!();
            }
            let answers: Vec<(usize, Directive)> = asked.iter().map(|(index, _)| *index).zip(directives).collect();
            for index in schedule.answer(&answers, now_ms()) {
                if index < self.adapters.len() {
                    each(Event::Waiting(self.adapters[index].provider(), schedule.due(index)));
                }
            }
        }
        cancel_collection(&mut active, &mut observers);
        None
    }
}

impl Runner {
    /// The coding agents seen running, as the hub is told: of the providers measured here,
    /// each with its subscription as far as it is known, the project's name only if allowed.
    #[cfg(test)]
    fn running(
        &self,
        seen: Vec<crate::activity::Session>,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> Vec<RunningSession> {
        self.running_with(seen, &self.current_accounts(accounts, identity_paths))
    }

    fn current_accounts(
        &self,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> Vec<Option<Option<String>>> {
        self.adapters
            .iter()
            .enumerate()
            .map(|(i, a)| {
                if a.identifies_account() {
                    current_account(a.local_account(&self.home), &accounts[i], last_activity(&identity_paths[i]))
                } else {
                    Some(None)
                }
            })
            .collect()
    }

    fn activity_accounts(
        &self,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> std::collections::BTreeMap<ClientId, crate::observed::worker::Account> {
        let mut result = std::collections::BTreeMap::new();
        for &client in &self.clients {
            let Some(provider) = client.collector() else {
                continue;
            };
            let index = self.adapters.iter().position(|a| a.provider() == provider);
            let account = if let Some(i) = index {
                self.activity_account(self.adapters[i].as_ref(), &accounts[i], identity_paths[i].clone(), true)
            } else {
                let collector = adapter(provider);
                let paths = collector.identity_paths(&self.home);
                self.activity_account(collector.as_ref(), &None, paths, false)
            };
            result.insert(client, account);
        }
        result
    }

    fn activity_account(
        &self,
        collector: &dyn Collector,
        measured: &Option<(Option<String>, Option<SystemTime>)>,
        paths: Vec<PathBuf>,
        legacy: bool,
    ) -> crate::observed::worker::Account {
        let provider = collector.provider();
        let identity = last_activity(&paths);
        let account = if collector.identifies_account() {
            current_account(collector.local_account(&self.home), measured, identity).flatten()
        } else {
            None
        };
        // The resolved account and its reusable witness must describe the same sign-in.
        let source = (identity == last_activity(&paths)
            && (account.is_some() || (legacy && !collector.identifies_account())))
        .then(|| crate::observed::Source {
            provider: provider.id().into(),
            account,
            account_name: legacy
                .then_some(self.config.account_name(provider))
                .flatten()
                .map(|name| name.chars().take(120).collect()),
        });
        let by = source.as_ref().map(|s| if s.account.is_some() { "login" } else { "inferred" }.into());
        crate::observed::worker::Account { source, by, identity, paths, legacy }
    }

    fn running_with(
        &self,
        seen: Vec<crate::activity::Session>,
        contexts: &[Option<Option<String>>],
    ) -> Vec<RunningSession> {
        let salt = crate::session_identity::salt(&self.paths);
        let sessions = seen
            .into_iter()
            .filter(|session| self.clients.contains(&session.client))
            .filter_map(|session| {
                let index = self.adapters.iter().position(|a| Some(a.provider()) == session.client.collector())?;
                let adapter = &self.adapters[index];
                let (account, account_name) = if adapter.identifies_account() {
                    (contexts[index].clone()?, None)
                } else {
                    (None, self.config.account_name(session.client.collector()?).map(str::to_string))
                };
                let (project, folder) = names(session.project, session.folder, self.config.projects());
                Some(RunningSession {
                    session_id: session.native_birth.as_deref().and_then(|native| {
                        salt.as_ref().map(|salt| crate::session_identity::identify(salt, session.client, native))
                    }),
                    provider: session.client.collector()?,
                    account,
                    account_name,
                    origin: session.origin.id(),
                    project,
                    folder,
                    started_at: session.started_at,
                    last_worked_at: session.last_worked,
                    working: session.working == Some(true),
                })
            })
            .collect();
        capped(sessions)
    }

    fn report(
        &self,
        seen: Vec<crate::activity::Session>,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> SessionReport {
        let complete = seen.iter().filter(|s| self.clients.contains(&s.client)).all(|s| s.working.is_some())
            && seen.iter().filter(|s| self.clients.contains(&s.client)).count() <= MAX_SESSIONS;
        let contexts = self.current_accounts(accounts, identity_paths);
        let sessions = self.running_with(seen.clone(), &contexts);
        let salt = crate::session_identity::salt(&self.paths);
        let mut supplemental = Vec::new();
        for session in seen.into_iter().filter(|s| self.clients.contains(&s.client)) {
            let collector = session.client.collector();
            let index = self.adapters.iter().position(|a| Some(a.provider()) == collector);
            if let Some(index) = index {
                if contexts[index].is_some() {
                    // Includes all legacy candidates, even those clipped by the legacy cap.
                    continue;
                }
            }
            // Disabled collectors can provide positive local login evidence, but never
            // an account inferred from an earlier measurement or the hub's device binding.
            let source = if index.is_none() {
                collector.and_then(|p| {
                    adapter(p).local_account(&self.home).map(|account| ClientSource {
                        provider: p,
                        account: Some(account),
                        account_name: None,
                    })
                })
            } else {
                None
            };
            let (project, folder) = names(session.project, session.folder, self.config.projects());
            supplemental.push(ClientSession {
                client_id: session.client,
                session_id: session.native_birth.as_deref().and_then(|native| {
                    salt.as_ref().map(|salt| crate::session_identity::identify(salt, session.client, native))
                }),
                source,
                origin: session.origin.id(),
                project,
                folder,
                started_at: session.started_at,
                last_worked_at: session.last_worked,
                working: session.working == Some(true),
            });
        }
        let left = MAX_SESSIONS - sessions.len();
        if supplemental.len() > left {
            supplemental.sort_by_key(|s| {
                std::cmp::Reverse((s.working, if s.working { None } else { s.last_worked_at }, s.started_at))
            });
            supplemental.truncate(left);
        }
        SessionReport {
            sessions,
            client_sessions: supplemental,
            clients: Vec::new(),
            tracking: Some(Tracking {
                version: 1,
                clients: self.clients.clone(),
                route_disabled: ClientId::ALL.into_iter().filter(|c| !self.config.routes(*c)).collect(),
                complete,
            }),
        }
    }
}

/// The names a session is reported with: none when project names are turned off; its
/// folder only where it is not its project. Each as long as a hub takes it (spec: text
/// fields); the hub would cut it too.
pub(crate) fn names(
    project: Option<String>,
    folder: Option<String>,
    allowed: bool,
) -> (Option<String>, Option<String>) {
    if !allowed {
        return (None, None);
    }
    let cut = |name: String| name.chars().take(120).collect::<String>();
    let (project, folder) = (project.map(cut), folder.map(cut));
    let folder = folder.filter(|folder| project.as_ref() != Some(folder));
    (project, folder)
}

/// A hub takes at most this many sessions of a machine at once (spec: Reporting running agents).
const MAX_SESSIONS: usize = 200;

/// A list the hub can take: working first, then those that worked most recently, then the newest.
fn capped(mut sessions: Vec<RunningSession>) -> Vec<RunningSession> {
    if sessions.len() > MAX_SESSIONS {
        sessions.sort_by_key(|s| {
            std::cmp::Reverse((s.working, if s.working { None } else { s.last_worked_at }, s.started_at))
        });
        sessions.truncate(MAX_SESSIONS);
    }
    sessions
}

/// The account the client is signed in to now: the one it names on this machine, else
/// the one it last reported while its sign-in files are as they were then; no account
/// (`Some(None)`) when it named none or has not been measured yet, and the hub takes the
/// one this machine last delivered. A sign-in since the measurement makes it unknown
/// (`None`) until measured again.
fn current_account(
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
) -> Option<Option<String>> {
    match (local, measured) {
        (Some(local), _) => Some(Some(local)),
        (None, None) => Some(None),
        (None, Some((account, at))) => (*at == signed_in).then(|| account.clone()),
    }
}

/// A command's account remains launch evidence only while the client's identity files are unchanged.
fn measurement_account(
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
    commanded: Option<String>,
) -> Option<String> {
    current_account(local, measured, signed_in)
        .flatten()
        .or_else(|| measured.as_ref().filter(|(_, before)| *before == signed_in).and(commanded))
}

/// The account to check in with, when known without starting the client: the one it
/// names on this machine, else the one it last reported while its sign-in files are as
/// they were then. While the hub sets the pace, the last one reported stands even after a
/// sign-in: the measurement the hub asks for shows which account it is now.
fn ask_account(
    schedule: &Schedule,
    index: usize,
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
) -> Option<Option<String>> {
    if local.is_some() {
        return Some(local);
    }
    let (account, at) = measured.as_ref()?;
    (schedule.paced(index) || *at == signed_in).then(|| account.clone())
}

type PolicyStamp = Option<(String, u64, bool)>;
fn stamp(policy: &Option<MeasurementPolicy>, provider: Provider) -> PolicyStamp {
    policy.as_ref().map(|p| (p.authority.clone(), p.collectors[&provider].epoch, p.allows(provider)))
}
#[derive(Clone)]
enum CollectionJob {
    Discover {
        hook: usize,
        id: String,
    },
    Accounts {
        launches: Vec<AccountLaunch>,
        id: String,
    },
    Native {
        index: usize,
        next: Option<u64>,
        attempt: Option<crate::measurement_policy::AttemptContext>,
        id: String,
        signed_in: Option<SystemTime>,
        admission: Stop,
    },
}
#[derive(Clone)]
struct AccountLaunch {
    index: usize,
    next: Option<u64>,
    account: AccountRef,
    attempt: Option<crate::measurement_policy::AttemptContext>,
    admission: Stop,
}
enum BackendResult {
    Discovered(Result<Vec<Identity>, crate::model::Failure>),
    Accounts(Vec<CollectionOutcome>, bool),
    Native(Box<dyn Collector>, Outcome),
}
struct ActiveCollection {
    provider: Provider,
    policy: PolicyStamp,
    kind: CollectionJob,
    stop: Stop,
    receive: std::sync::mpsc::Receiver<BackendResult>,
    worker: Option<thread::JoinHandle<()>>,
}
impl ActiveCollection {
    fn spawn(
        provider: Provider,
        kind: CollectionJob,
        policy: &Option<MeasurementPolicy>,
        parent: &Stop,
        run: impl FnOnce(Stop) -> BackendResult + Send + 'static,
    ) -> Self {
        let stop = parent.child();
        let worker_stop = stop.clone();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let _ = send.send(run(worker_stop));
        });
        Self { provider, policy: stamp(policy, provider), kind, stop, receive, worker: Some(worker) }
    }
    fn admitted(&self, policy: &Option<MeasurementPolicy>, sink: &dyn Sink) -> bool {
        sink.refused().is_none()
            && sink.allows_measurement(self.provider)
            && (matches!(self.kind, CollectionJob::Native { .. }) || sink.supports_collections())
            && stamp(policy, self.provider) == self.policy
    }
}
impl Drop for ActiveCollection {
    fn drop(&mut self) {
        self.stop.request(crate::stop::How::Exit);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn cancel_collection(active: &mut Option<ActiveCollection>, observers: &mut Observers) {
    observers.cancel();
    if let Some(job) = active.as_ref() {
        job.stop.request(crate::stop::How::Exit);
    }
    active.take();
    observers.finish(false);
}
// The idle coordinator keeps metadata-only discovery available while an adapter is owned by the worker.
struct Suspended {
    provider: Provider,
    activity: Vec<PathBuf>,
    identity: Vec<PathBuf>,
    witness: Option<SystemTime>,
    account: Option<String>,
    identifies: bool,
}
impl Collector for Suspended {
    fn provider(&self) -> Provider {
        self.provider
    }
    fn measure(&mut self, _: &Context) -> Outcome {
        Err(crate::model::Failure::new(self.provider, ErrorKind::Failed, "collector is busy"))
    }
    fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
        self.activity.clone()
    }
    fn identity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
        self.identity.clone()
    }
    fn identifies_account(&self) -> bool {
        self.identifies
    }
    fn local_account(&self, _: &std::path::Path) -> Option<String> {
        if last_activity(&self.identity) == self.witness { self.account.clone() } else { None }
    }
}
fn finish_schedule(
    schedule: &mut Schedule,
    index: usize,
    now: Millis,
    paced: Option<u64>,
    outcome: &mut CollectionOutcome,
    used: bool,
) -> Millis {
    let gone = matches!(outcome,CollectionOutcome::Failed(f) if f.error==ErrorKind::NotInstalled);
    if let Some(interval) = paced.filter(|_| !gone) {
        let stale = schedule.measured_paced(index, now, interval);
        if let CollectionOutcome::Observed(s) = outcome {
            s.stale_after_ms = stale;
        }
        return now + interval as i64;
    }
    schedule.unpace(index);
    let next = match outcome {
        CollectionOutcome::Observed(s) => schedule.complete(index, now, &Ok(s.clone()), used, jitter()),
        CollectionOutcome::Failed(f) => schedule.complete(index, now, &Err(f.clone()), used, jitter()),
        CollectionOutcome::NoNewData => schedule.no_new_data(index, now),
    };
    if let CollectionOutcome::Observed(s) = outcome {
        s.stale_after_ms = schedule.stale_after_ms(index, now);
    }
    next
}

struct HookRun {
    provider: Provider,
    admission: Stop,
    due: Millis,
    failures: u32,
    ready: bool,
    slots: BTreeMap<AccountRef, AccountSlot>,
}
struct AccountSlot {
    identity: Identity,
    index: usize,
    admission: Stop,
    command: Option<String>,
    target: Option<String>,
}
fn attempt_id() -> String {
    let h = crate::config::random_hex();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}
fn local_result(
    provider: Provider,
    failure_account: Option<AccountRef>,
    outcome: Outcome,
    attempt_id: String,
    stage: &'static str,
) -> CollectionResult {
    let account = match &outcome {
        Ok(s) => AccountRef::of(s),
        Err(_) => failure_account,
    };
    CollectionResult {
        version: 1,
        provider,
        account,
        attempt_id,
        stage,
        completed_at: now_ms(),
        outcome: match outcome {
            Ok(s) => CollectionOutcome::Observed(s),
            Err(f) => CollectionOutcome::Failed(f),
        },
    }
}
/// Derive a conservative error scope from the immutable launch, preserving its authority and epoch.
/// A changed login proves neither the old account nor its command; the original capture stays untouched.
fn failure_context(
    context: Option<&crate::measurement_policy::AttemptContext>,
    same_identity: bool,
) -> Option<crate::measurement_policy::AttemptContext> {
    context.cloned().map(|mut value| {
        if !same_identity {
            value.target = crate::measurement_policy::AttemptTarget::Unknown;
            value.command_id = None;
        }
        value
    })
}
fn target_ref(
    provider: Provider,
    attempt: Option<&crate::measurement_policy::AttemptContext>,
    name: Option<&str>,
) -> Option<AccountRef> {
    if provider == Provider::Antigravity {
        return attempt
            .filter(|a| matches!(a.target, crate::measurement_policy::AttemptTarget::Verified { .. }))
            .map(|_| AccountRef::Declared { account_name: name.map(|name| name.trim().to_lowercase()) });
    }
    attempt.and_then(|a| match &a.target {
        crate::measurement_policy::AttemptTarget::Verified { account_key } => {
            Some(AccountRef::Supplier { account: account_key.clone() })
        }
        _ => None,
    })
}
struct Finished<'a> {
    result: &'a CollectionResult,
    next: Millis,
    attempt: Option<&'a crate::measurement_policy::AttemptContext>,
    admission: &'a Stop,
}
fn finish_collection(
    config: &Config,
    observers: &Observers,
    sink: &mut dyn Sink,
    each: &mut impl FnMut(Event),
    finished: Finished<'_>,
) {
    let Finished { result, next, attempt, admission } = finished;
    if admission.requested() || sink.refused().is_some() || !sink.allows_measurement(result.provider) {
        return;
    }
    if let Some(d) = observers.enqueue(config, result, admission) {
        each(Event::Diagnostic(&d));
    }
    match &result.outcome {
        CollectionOutcome::Observed(s) => sink.deliver_scoped(&Ok(s.clone()), attempt),
        CollectionOutcome::Failed(f) => {
            let custom = config.providers.get(&result.provider).is_some_and(|s| s.hooks.collect.is_some());
            if custom {
                sink.deliver_scoped(&Err(f.clone()), attempt)
            } else {
                sink.deliver_attempt(&Err(f.clone()), attempt)
            }
        }
        CollectionOutcome::NoNewData => {
            if let Some(attempt) = attempt {
                sink.complete_collection(&Completion {
                    provider: result.provider,
                    outcome: CompletionOutcome::NoNewData,
                    completed_at: result.completed_at,
                    attempt_context: attempt.clone(),
                });
            }
        }
    }
    if sink.refused().is_some() {
        observers.cancel();
    }
    each(Event::Collected(result, next));
}
fn sync_admission(
    schedule: &mut Schedule,
    policy: &Option<MeasurementPolicy>,
    before: &mut Option<MeasurementPolicy>,
    native: &mut [Stop],
    providers: &[Provider],
    runs: &mut [HookRun],
    root: &Stop,
) {
    let changed = |provider| {
        before.as_ref().map(|p| (&p.authority, p.enabled, p.collectors.get(&provider)))
            != policy.as_ref().map(|p| (&p.authority, p.enabled, p.collectors.get(&provider)))
    };
    for (i, provider) in providers.iter().enumerate() {
        if changed(*provider) {
            schedule.block(i, true, now_ms());
            schedule.block(i, false, now_ms());
            native[i].request(crate::stop::How::Exit);
            native[i] = root.child();
        }
    }
    for run in runs.iter_mut() {
        if changed(run.provider) {
            run.admission.request(crate::stop::How::Exit);
            run.admission = root.child();
            for slot in run.slots.values_mut() {
                schedule.block(slot.index, true, now_ms());
                schedule.block(slot.index, false, now_ms());
                slot.admission.request(crate::stop::How::Exit);
                slot.admission = run.admission.child();
                slot.command = None;
                slot.target = None;
            }
        }
    }
    *before = policy.clone();
}

/// What happened to one scheduled slot.
pub enum Event<'a> {
    Collected(&'a CollectionResult, Millis),
    Diagnostic(&'a Diagnostic),
    /// Measured (or failed); the next run is due at the given time.
    Measured(&'a Outcome, Millis),
    /// Another device measures this subscription; ask again at the given time.
    Waiting(Provider, Millis),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn discovery_observers_are_cancelled_by_provider_policy_before_any_accounts_exist() {
        use crate::config::HookSettings;
        use crate::measurement_policy::CollectorPolicy;
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        struct Control {
            root: Stop,
            failures: Arc<AtomicUsize>,
            count: usize,
            started: PathBuf,
            release: PathBuf,
            denied: Option<Instant>,
            change: &'static str,
        }
        impl Sink for Control {
            fn deliver(&mut self, _: &Outcome) {
                panic!("discovery has no data delivery")
            }
            fn managed(&self) -> bool {
                true
            }
            fn needs_policy_contact(&self) -> bool {
                true
            }
            fn allows_measurement(&self, provider: Provider) -> bool {
                self.change != "disable" || self.denied.is_none() || provider != Provider::Codex
            }
            fn checkin_managed(&mut self, asks: &[Ask], _: &[Provider]) -> crate::sink::CheckinAnswer {
                assert!(asks.is_empty());
                if self.failures.load(Ordering::SeqCst) == self.count && self.denied.is_none() {
                    let until = Instant::now() + Duration::from_secs(2);
                    while !self.started.exists() && Instant::now() < until {
                        thread::sleep(Duration::from_millis(1));
                    }
                    assert!(self.started.exists(), "the first callback must be executing");
                    self.denied = Some(Instant::now());
                    let release = self.release.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(500));
                        std::fs::write(release, "release").unwrap();
                    });
                }
                if self.denied.is_some_and(|at| at.elapsed() > Duration::from_millis(750)) {
                    self.root.request(crate::stop::How::Exit);
                }
                crate::sink::CheckinAnswer {
                    directives: vec![],
                    commands: vec![],
                    accounts: vec![],
                    policy: Some(MeasurementPolicy {
                        version: 1,
                        authority: if self.denied.is_some() && self.change == "authority" {
                            "22222222-2222-4222-8222-222222222222"
                        } else {
                            "11111111-1111-4111-8111-111111111111"
                        }
                        .into(),
                        revision: u64::from(self.denied.is_some()),
                        enabled: true,
                        collectors: Provider::ALL
                            .into_iter()
                            .map(|p| {
                                (
                                    p,
                                    CollectorPolicy {
                                        enabled: self.allows_measurement(p),
                                        epoch: u64::from(
                                            self.denied.is_some() && self.change == "epoch" && p == Provider::Codex,
                                        ),
                                        requires_epoch: false,
                                        changed_at: None,
                                    },
                                )
                            })
                            .collect(),
                    }),
                }
            }
        }
        for queued in [false, true] {
            for change in ["disable", "epoch", "authority"] {
                let dir = std::env::temp_dir().join(format!("quotum-discovery-{}", crate::config::random_hex()));
                std::fs::create_dir(&dir).unwrap();
                let started = dir.join("started");
                let release = dir.join("release");
                let completed = dir.join("completed");
                let mut config = Config::parse("sessions=false").unwrap();
                for provider in if queued { vec![Provider::Claude, Provider::Codex] } else { vec![Provider::Codex] } {
                    let hooks = &mut config.providers.entry(provider).or_default().hooks;
                    hooks.collect =
                        Some(HookSettings { path: "/bin/sh".into(), args: vec!["-c".into(), "exit 1".into()] });
                    let script = if queued && provider == Provider::Codex {
                        "cat >/dev/null; printf done > \"$3\""
                    } else {
                        "cat >/dev/null; printf started > \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.01; done; printf done > \"$3\""
                    };
                    let output = if queued && provider == Provider::Claude {
                        dir.join("first-completed")
                    } else {
                        completed.clone()
                    };
                    hooks.on_collection_failed = Some(HookSettings {
                        path: "/bin/sh".into(),
                        args: vec![
                            "-c".into(),
                            script.into(),
                            "fixture".into(),
                            started.to_str().unwrap().into(),
                            release.to_str().unwrap().into(),
                            output.to_str().unwrap().into(),
                        ],
                    });
                }
                let root = Stop::new();
                let failures = Arc::new(AtomicUsize::new(0));
                let paths = Paths { config: dir.join("config"), state: dir.clone(), work: dir.clone() };
                let mut runner = Runner::with_adapters(config, paths, vec![], dir.clone(), root.clone());
                runner.policy_contact_every = Duration::from_millis(10);
                let mut control = Control {
                    root,
                    failures: failures.clone(),
                    count: if queued { 2 } else { 1 },
                    started,
                    release,
                    denied: None,
                    change,
                };
                assert!(
                    runner
                        .run(&mut control, |event| {
                            if let Event::Collected(result, _) = event {
                                assert_eq!(result.stage, "discover");
                                assert!(result.account.is_none());
                                failures.fetch_add(1, Ordering::SeqCst);
                            }
                        })
                        .is_none()
                );
                assert_eq!(failures.load(Ordering::SeqCst), control.count);
                assert!(!completed.exists(), "{change} must cancel queued={queued} discovery callbacks");
                std::fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_flush_fences_discovery_before_dispatch() {
        use crate::config::HookSettings;
        struct RefusingFlush {
            terminal: bool,
            started: PathBuf,
        }
        impl Sink for RefusingFlush {
            fn managed(&self) -> bool {
                true
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("no delivery")
            }
            fn flush(&mut self) {
                self.terminal = true;
            }
            fn refused(&self) -> Option<&str> {
                if !self.terminal {
                    return None;
                }
                // Give a wrongly dispatched worker time to enter its real process, rather
                // than letting pre-stop cancellation hide a launch after known refusal.
                let until = Instant::now() + Duration::from_millis(200);
                while !self.started.exists() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(1));
                }
                Some("revoked")
            }
        }
        let dir = std::env::temp_dir().join(format!("quotum-flush-{}", crate::config::random_hex()));
        std::fs::create_dir(&dir).unwrap();
        let started = dir.join("started");
        let mut config = Config::parse("sessions=false").unwrap();
        config.providers.entry(Provider::Codex).or_default().hooks.collect = Some(HookSettings {
            path: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "printf started > \"$1\"; exit 1".into(),
                "fixture".into(),
                started.to_str().unwrap().into(),
            ],
        });
        let paths = Paths { config: dir.join("config"), state: dir.clone(), work: dir.clone() };
        let mut runner = Runner::with_adapters(config, paths, vec![], dir.clone(), Stop::new());
        let mut sink = RefusingFlush { terminal: false, started: started.clone() };
        assert_eq!(runner.run(&mut sink, |_| panic!("no events after refusal")).as_deref(), Some("revoked"));
        assert!(!started.exists(), "terminal flush must prevent discovery dispatch");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_one_shot_observations_use_the_configured_interval_and_stale_limit() {
        struct Native;
        impl Collector for Native {
            fn provider(&self) -> Provider {
                Provider::Antigravity
            }
            fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
                vec![]
            }
            fn measure(&mut self, _: &Context) -> Outcome {
                snapshot()
            }
        }
        for (seconds, expected) in [(300, 300_000), (172_800, crate::model::STALE_LIMIT_MS)] {
            let mut config = Config::parse("sessions=false").unwrap();
            // Embedders can supply Config directly; retain the wire clamp as well as parser bounds.
            config.interval = Some(seconds);
            let paths = Paths { config: "/unused".into(), state: std::env::temp_dir(), work: std::env::temp_dir() };
            let mut runner =
                Runner::with_adapters(config, paths, vec![Box::new(Native)], std::env::temp_dir(), Stop::new());
            let mut measured = 0;
            runner.collect_all(|result| {
                let CollectionOutcome::Observed(snapshot) = &result.outcome else { panic!("expected observation") };
                assert_eq!(snapshot.stale_after_ms, expected);
                assert_eq!(serde_json::to_value(snapshot).unwrap()["staleAfterMs"], expected);
                measured += 1;
            });
            assert_eq!(measured, 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn collector_roster_and_due_subset_share_one_process_with_independent_commands() {
        use crate::config::HookSettings;
        use crate::measurement_policy::{AttemptContext, AttemptTarget, CollectorPolicy};
        let dir = std::env::temp_dir().join(format!("quotum-collector-{}", crate::config::random_hex()));
        std::fs::create_dir(&dir).unwrap();
        let request_log = dir.join("requests");
        let body = r#"IFS= read -r request
printf '%s\n' "$request" >> "$1"
case "$request" in
  *'"action":"discover"'*) printf '%s' '{"version":1,"accounts":[{"identity":{"accountId":"a"}},{"identity":{"accountId":"b"}},{"identity":{"accountId":"c"}},{"identity":{"accountId":"d"}}]}' ;;
  *) printf '%s' '{"version":1,"results":[{"identity":{"accountId":"a"},"status":"observed","observedAt":"2026-01-01T00:00:00Z","windows":[{"id":"session","kind":"session","usedPercent":5}]},{"identity":{"accountId":"b"},"status":"no_new_data"},{"identity":{"accountId":"c"},"status":"failed","error":"timeout"}]}' ;;
esac"#;
        let mut config = Config::parse("sessions=false").unwrap();
        config.providers.entry(Provider::Codex).or_default().hooks.collect = Some(HookSettings {
            path: "/bin/sh".into(),
            args: vec!["-c".into(), body.into(), "fixture".into(), request_log.to_str().unwrap().into()],
        });
        #[derive(Default)]
        struct Select {
            roster: Vec<AccountRoster>,
            expected: BTreeMap<String, String>,
            delivered: Vec<(Outcome, AttemptContext)>,
            completed: Vec<Completion>,
        }
        impl Sink for Select {
            fn managed(&self) -> bool {
                true
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("batch uses captured attempts")
            }
            fn deliver_attempt(&mut self, outcome: &Outcome, context: Option<&AttemptContext>) {
                self.delivered.push((outcome.clone(), context.unwrap().clone()));
            }
            fn complete_collection(&mut self, completion: &Completion) {
                self.completed.push(completion.clone());
            }
            fn account_rosters(&mut self, roster: &[AccountRoster]) {
                self.roster = roster.to_vec();
            }
            fn checkin_managed(&mut self, asks: &[Ask], _: &[Provider]) -> crate::sink::CheckinAnswer {
                let mut commands = Vec::new();
                let directives = asks
                    .iter()
                    .enumerate()
                    .map(|(i, ask)| {
                        if ask.account == Some(crate::model::pseudonym(Provider::Codex, "d").as_str()) {
                            commands.push(None);
                            Directive::Wait { ask_at: now_ms() + 120000, on_duty: false }
                        } else {
                            let command = format!("00000000-0000-4000-8000-{:012}", i + 1);
                            self.expected.insert(ask.account.unwrap().into(), command.clone());
                            commands.push(Some(command));
                            Directive::Measure { paced: None }
                        }
                    })
                    .collect();
                crate::sink::CheckinAnswer {
                    directives,
                    commands,
                    accounts: asks.iter().map(|a| a.account.map(str::to_string)).collect(),
                    policy: Some(MeasurementPolicy {
                        version: 1,
                        authority: "11111111-1111-4111-8111-111111111111".into(),
                        revision: 0,
                        enabled: true,
                        collectors: Provider::ALL
                            .into_iter()
                            .map(|p| {
                                (
                                    p,
                                    CollectorPolicy {
                                        enabled: true,
                                        epoch: 0,
                                        requires_epoch: false,
                                        changed_at: None,
                                    },
                                )
                            })
                            .collect(),
                    }),
                }
            }
        }
        let stop = Stop::new();
        let signal = stop.clone();
        let watchdog = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            watchdog.request(crate::stop::How::Exit);
        });
        let paths = Paths { config: dir.join("config"), work: dir.clone(), state: dir.clone() };
        let mut runner = Runner::with_adapters(config, paths, vec![], dir.clone(), stop);
        let mut sink = Select::default();
        let mut results = Vec::new();
        runner.run(&mut sink, |event| {
            if let Event::Collected(result, _) = event {
                results.push(result.clone());
                if results.len() == 3 {
                    signal.request(crate::stop::How::Exit);
                }
            }
        });
        assert_eq!(results.len(), 3);
        assert_eq!(sink.roster[0].accounts.len(), 4);
        assert_eq!(sink.delivered.len(), 2);
        assert_eq!(sink.completed.len(), 1);
        assert_eq!(results.iter().filter(|r| matches!(r.outcome, CollectionOutcome::Observed(_))).count(), 1);
        assert_eq!(results.iter().filter(|r| matches!(r.outcome, CollectionOutcome::NoNewData)).count(), 1);
        assert_eq!(results.iter().filter(|r| matches!(r.outcome, CollectionOutcome::Failed(_))).count(), 1);
        assert!(results.iter().all(|r| r.attempt_id == results[0].attempt_id));
        for context in sink.delivered.iter().map(|(_, c)| c).chain(sink.completed.iter().map(|c| &c.attempt_context)) {
            let AttemptTarget::Verified { account_key } = &context.target else { panic!("verified account expected") };
            assert_eq!(context.command_id.as_ref(), sink.expected.get(account_key));
        }
        assert_eq!(sink.expected.values().collect::<std::collections::BTreeSet<_>>().len(), 3);
        let text = std::fs::read_to_string(request_log).unwrap();
        let requests =
            text.lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        let selected = requests[1]["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["identity"]["accountId"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(selected, std::collections::BTreeSet::from(["a", "b", "c"]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_changed_native_login_keeps_failure_unknown_without_rebinding_the_launch() {
        use crate::measurement_policy::{AttemptContext, AttemptTarget};
        let launch = AttemptContext {
            version: 1,
            authority: "authority".into(),
            collector_epoch: 7,
            target: AttemptTarget::Verified { account_key: "a".repeat(24) },
            command_id: Some("command-a".into()),
        };
        let unknown = failure_context(Some(&launch), false).unwrap();
        assert_eq!(unknown.target, AttemptTarget::Unknown);
        assert_eq!(unknown.command_id, None);
        assert_eq!(unknown.collector_epoch, 7);
        assert!(matches!(launch.target, AttemptTarget::Verified { .. }));
        assert_eq!(failure_context(Some(&launch), true), Some(launch));
    }

    #[test]
    fn native_codex_bootstraps_past_a_persisted_roster_without_inheriting_its_account() {
        use crate::measurement_policy::{AttemptTarget, CollectorPolicy};
        struct Native;
        impl Collector for Native {
            fn provider(&self) -> Provider {
                Provider::Codex
            }
            fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
                vec![]
            }
            fn measure(&mut self, _: &Context) -> Outcome {
                let mut value = snapshot().unwrap();
                value.provider = Provider::Codex;
                value.account = Some("b".repeat(24));
                Ok(value)
            }
        }
        struct Previous {
            roster: Vec<AccountRoster>,
            delivered: bool,
        }
        impl Sink for Previous {
            fn managed(&self) -> bool {
                true
            }
            fn account_rosters(&mut self, roster: &[AccountRoster]) {
                self.roster = roster.to_vec();
            }
            fn checkin_managed(&mut self, asks: &[Ask], _: &[Provider]) -> crate::sink::CheckinAnswer {
                assert!(asks.is_empty(), "unknown native identity is discovered without claiming a subscription");
                crate::sink::CheckinAnswer {
                    directives: vec![],
                    commands: vec![],
                    accounts: vec![],
                    policy: Some(MeasurementPolicy {
                        version: 1,
                        authority: "11111111-1111-4111-8111-111111111111".into(),
                        revision: 0,
                        enabled: true,
                        collectors: Provider::ALL
                            .into_iter()
                            .map(|p| {
                                (
                                    p,
                                    CollectorPolicy {
                                        enabled: true,
                                        epoch: 0,
                                        requires_epoch: false,
                                        changed_at: None,
                                    },
                                )
                            })
                            .collect(),
                    }),
                }
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("attempt context is required")
            }
            fn deliver_attempt(
                &mut self,
                outcome: &Outcome,
                context: Option<&crate::measurement_policy::AttemptContext>,
            ) {
                assert_eq!(outcome.as_ref().unwrap().account.as_deref(), Some("bbbbbbbbbbbbbbbbbbbbbbbb"));
                assert_eq!(context.unwrap().target, AttemptTarget::Unknown);
                assert!(context.unwrap().command_id.is_none());
                assert_eq!(self.roster[0].accounts, vec![AccountRef::Supplier { account: "b".repeat(24) }]);
                self.delivered = true;
            }
        }
        let config =
            Config::parse(&format!("sessions=false\n[providers.codex]\npath={:?}", std::env::current_exe().unwrap()))
                .unwrap();
        let paths = Paths { config: "unused".into(), work: std::env::temp_dir(), state: std::env::temp_dir() };
        let stop = Stop::new();
        let signal = stop.clone();
        let mut runner = Runner::with_adapters(config, paths, vec![Box::new(Native)], std::env::temp_dir(), stop);
        let mut sink = Previous {
            roster: vec![AccountRoster {
                provider: Provider::Codex,
                accounts: vec![AccountRef::Supplier { account: "a".repeat(24) }],
            }],
            delivered: false,
        };
        runner.run(&mut sink, |event| {
            if let Event::Collected(result, _) = event {
                assert_eq!(result.account, Some(AccountRef::Supplier { account: "b".repeat(24) }));
                signal.request(crate::stop::How::Exit);
            }
        });
        assert!(sink.delivered);
    }

    #[test]
    fn delayed_collection_keeps_control_contact_and_cancels_on_known_gate_or_refusal() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        };
        struct Delayed {
            started: Arc<AtomicBool>,
            finished: Arc<AtomicBool>,
        }
        impl Collector for Delayed {
            fn provider(&self) -> Provider {
                Provider::Antigravity
            }
            fn identifies_account(&self) -> bool {
                false
            }
            fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
                vec![]
            }
            fn measure(&mut self, ctx: &Context) -> Outcome {
                self.started.store(true, Ordering::SeqCst);
                let until = Instant::now() + Duration::from_secs(2);
                while !ctx.stop.requested() && Instant::now() < until {
                    thread::sleep(Duration::from_millis(5));
                }
                self.finished.store(true, Ordering::SeqCst);
                snapshot()
            }
        }
        struct Control {
            root: Stop,
            started: Arc<AtomicBool>,
            finished: Arc<AtomicBool>,
            denied: bool,
            refuse: bool,
            asks: Arc<AtomicUsize>,
            contacts: usize,
        }
        impl Sink for Control {
            fn managed(&self) -> bool {
                true
            }
            fn needs_policy_contact(&self) -> bool {
                true
            }
            fn allows_measurement(&self, _: Provider) -> bool {
                !self.denied
            }
            fn refused(&self) -> Option<&str> {
                (self.denied && self.refuse).then_some("device revoked")
            }
            fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
                if !asks.is_empty() {
                    self.asks.fetch_add(1, Ordering::SeqCst);
                }
                if self.started.load(Ordering::SeqCst) {
                    assert!(asks.is_empty(), "busy command cannot be replaced");
                    self.contacts += 1;
                    self.denied = true;
                }
                if self.finished.load(Ordering::SeqCst) {
                    self.root.request(crate::stop::How::Exit);
                }
                asks.iter().map(|_| Directive::Measure { paced: None }).collect()
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("cancelled result delivered")
            }
        }
        for refuse in [false, true] {
            let started = Arc::new(AtomicBool::new(false));
            let finished = Arc::new(AtomicBool::new(false));
            let asks = Arc::new(AtomicUsize::new(0));
            let root = Stop::new();
            let paths =
                Paths { config: PathBuf::from("/unused"), state: std::env::temp_dir(), work: std::env::temp_dir() };
            let config = Config::parse(&format!(
                "sessions=false\n[providers.antigravity]\npath={:?}",
                std::env::current_exe().unwrap()
            ))
            .unwrap();
            let mut runner = Runner::with_adapters(
                config,
                paths,
                vec![Box::new(Delayed { started: started.clone(), finished: finished.clone() })],
                std::env::temp_dir(),
                root.clone(),
            );
            runner.policy_contact_every = Duration::from_millis(10);
            let mut sink = Control {
                root,
                started,
                finished: finished.clone(),
                denied: false,
                refuse,
                asks: asks.clone(),
                contacts: 0,
            };
            let began = Instant::now();
            let result = runner.run(&mut sink, |_| panic!("cancelled event"));
            assert_eq!(result.is_some(), refuse);
            assert!(began.elapsed() < Duration::from_secs(1));
            assert!(finished.load(Ordering::SeqCst));
            assert!(sink.contacts >= 1);
            assert_eq!(asks.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn corrected_shared_sessions_keep_native_ids_through_the_wire() {
        let state = std::env::temp_dir().join(format!("quotum-attribution-ids-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir(&state).unwrap();
        let salt = "0123456789abcdef0123456789abcdef";
        std::fs::write(state.join("session-salt"), salt).unwrap();
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state: state.clone() };
        let runner = Runner::new(Config::default(), paths, &[ClientId::Codex], Stop::new());
        let observed = crate::activity::attribution::corrected_sessions();
        let expected: Vec<_> = observed
            .iter()
            .map(|s| crate::session_identity::identify(salt, s.client, s.native_birth.as_deref().unwrap()))
            .collect();
        let accounts = [Some((Some("4b7e0c1d2e3f4a5b6c7d8e9f".into()), None))];
        let reported = runner.running(observed.clone(), &accounts, &[Vec::new()]);
        let request = crate::sink::tests::capture_sessions(&reported);
        for (i, id) in expected.iter().enumerate() {
            assert_eq!(request["sessions"][i]["sessionId"], *id);
        }
        let mut changed = observed;
        changed[0].working = Some(true);
        changed[0].project = Some("another-project".into());
        assert_eq!(runner.running(changed, &accounts, &[Vec::new()])[0].session_id.as_ref(), Some(&expected[0]));
        std::fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn corrected_collector_sessions_reach_the_full_wire_report() {
        // No state directory means the optional identity capability is unavailable.
        // The report fixture is shared with the hub's future-credit acceptance test.
        let state = std::env::temp_dir().join(format!("quotum-attribution-wire-{}", std::process::id()));
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let runner = Runner::new(Config::default(), paths, &[ClientId::Codex], Stop::new());
        let observed = crate::activity::attribution::corrected_sessions();
        let reported =
            runner.running(observed, &[Some((Some("4b7e0c1d2e3f4a5b6c7d8e9f".into()), None))], &[Vec::new()]);
        assert_eq!(reported.len(), 3);
        let mut request = crate::sink::tests::capture_sessions(&reported);
        // Only the send clock is fixed; sessions came through collector, Runner and HTTP.
        request["sentAt"] = serde_json::json!(crate::model::ts::format(1_790_000_015_000));
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/shared-runtime-report.json")).unwrap();
        assert_eq!(crate::sink::tests::legacy_sessions(&request["sessions"]), expected["sessions"]);
        assert_eq!(request["machine"], expected["machine"]);
        assert_eq!(request["version"], expected["version"]);
    }

    #[test]
    fn client_report_preserves_legacy_priority_and_delivers_unknown_work() {
        let state = std::env::temp_dir().join(format!("quotum-client-report-{}", std::process::id()));
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut config = Config::default();
        config
            .providers
            .insert(Provider::Claude, crate::config::ProviderSettings { enabled: Some(false), ..Default::default() });
        let mut runner = Runner::new(config, paths, &[], Stop::new());
        runner.home = std::env::temp_dir().join("quotum-client-report-no-home");
        let mut observed = crate::activity::attribution::corrected_sessions();
        let mut opencode = observed[0].clone();
        opencode.client = ClientId::OpenCode;
        let mut disabled = opencode.clone();
        disabled.client = ClientId::Claude;
        observed.extend([opencode, disabled]);
        let contexts = vec![Some((Some("4b7e0c1d2e3f4a5b6c7d8e9f".into()), None)), None];
        let paths = vec![Vec::new(), Vec::new()];
        let legacy = runner.running(observed.clone(), &contexts, &paths);
        let report = runner.report(observed, &contexts, &paths);
        assert_eq!(report.sessions, legacy);
        assert_eq!(report.client_sessions.len(), 2);
        assert_eq!(report.client_sessions[0].client_id, ClientId::OpenCode);
        assert_eq!(report.client_sessions[0].source, None);
        let wire = crate::sink::tests::capture_report(&report);
        assert_eq!(wire["clientSessions"][0]["clientId"], "opencode");
        assert_eq!(wire["sessions"][0]["clientId"], "codex");
        assert_eq!(wire["tracking"]["version"], 1);
        assert!(
            wire["tracking"]["clients"].as_array().unwrap().contains(&serde_json::json!("claude")),
            "disabled measurement collectors remain in the tracking scope"
        );
        let many = (0..201)
            .map(|i| {
                let mut s = crate::activity::attribution::corrected_sessions()[0].clone();
                s.started_at += i;
                s
            })
            .chain([{
                let mut s = crate::activity::attribution::corrected_sessions()[0].clone();
                s.client = ClientId::OpenCode;
                s
            }])
            .collect();
        let full = runner.report(many, &contexts, &paths);
        assert_eq!(full.sessions.len(), 200);
        assert!(full.client_sessions.is_empty());
        assert!(!full.tracking.unwrap().complete, "truncation cannot certify complete observation");
    }

    #[test]
    fn a_changed_sign_in_leaves_the_legacy_subset_and_preserves_private_work() {
        let dir = std::env::temp_dir().join(format!("quotum-client-sign-in-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = dir.join("identity");
        std::fs::write(&identity, "stand-in metadata").unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let mut runner = Runner::new(Config::default(), paths, &[ClientId::Codex], Stop::new());
        runner.home = dir.clone();
        let measured = [Some((Some("4b7e0c1d2e3f4a5b6c7d8e9f".into()), None))];
        let sessions = crate::activity::attribution::corrected_sessions();
        assert_eq!(runner.report(sessions.clone(), &measured, &[Vec::new()]).sessions.len(), 3);
        let changed = runner.report(sessions.clone(), &measured, &[vec![identity]]);
        assert!(changed.sessions.is_empty());
        assert_eq!(changed.client_sessions.len(), sessions.len());
        assert!(changed.client_sessions.iter().all(|s| s.source.is_none()));
        assert_eq!(changed.client_sessions[1].working, sessions[1].working == Some(true));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_long_list_keeps_the_working_sessions_and_then_the_newest() {
        let session = |working, started_at| RunningSession {
            session_id: None,
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at,
            last_worked_at: None,
            working,
        };
        let list: Vec<_> = (0..250).map(|i| session(i % 50 == 0, i)).collect();
        let mut recent = session(false, 1);
        recent.last_worked_at = Some(300);
        let mut older = session(false, 2);
        older.last_worked_at = Some(290);
        let kept = capped([list, vec![older, recent]].concat());
        assert_eq!(kept.len(), MAX_SESSIONS);
        assert_eq!(kept.iter().filter(|s| s.working).count(), 5, "every working one");
        assert_eq!(kept[0].started_at, 200, "newest working first");
        assert_eq!(kept[5].last_worked_at, Some(300), "recent work precedes newer sessions never seen working");
        assert_eq!(kept[6].last_worked_at, Some(290));
        assert_eq!(kept.last().map(|s| s.started_at), Some(54), "then the newest idle ones");
        assert_eq!(capped(vec![session(false, 1)]).len(), 1, "a short list as it is");
    }

    #[test]
    fn a_session_is_reported_with_its_folder_only_where_that_is_not_its_project() {
        let some = |name: &str| Some(name.to_string());
        assert_eq!(names(some("quotum"), some("hub"), false), (None, None), "turned off");
        assert_eq!(names(some("quotum"), some("quotum"), true), (some("quotum"), None));
        assert_eq!(names(some("quotum"), some("hub"), true), (some("quotum"), some("hub")));
        assert_eq!(names(None, some("scratch"), true), (None, some("scratch")), "a folder of no project");
        let long = "й".repeat(130);
        let cut = "й".repeat(120);
        assert_eq!(names(some(&long), some(&format!("{long}-feat")), true), (Some(cut), None), "alike once cut");
    }

    #[test]
    fn a_session_is_filed_under_the_account_signed_in_now() {
        let then = Some(SystemTime::UNIX_EPOCH);
        let later = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let measured = Some((Some("a".to_string()), then));
        assert_eq!(
            current_account(Some("b".into()), &measured, later),
            Some(Some("b".into())),
            "what the client names now"
        );
        assert_eq!(current_account(None, &measured, then), Some(Some("a".into())), "measured, and not signed in since");
        assert_eq!(current_account(None, &measured, later), None, "signed in again since: not known");
        assert_eq!(current_account(None, &None, later), Some(None), "not measured yet: the hub's guess");
        assert_eq!(current_account(None, &Some((None, then)), then), Some(None), "measured, and named no account");
    }

    mod observed_accounts {
        use super::*;
        use std::path::Path;

        const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaa";
        const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbb";

        fn first() -> SystemTime {
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000)
        }
        fn second() -> SystemTime {
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_060)
        }

        #[derive(Clone, Copy)]
        enum Read {
            Local,
            Measured,
            LocalThenSignIn,
            MeasuredThenSignIn,
        }

        struct AccountCollector {
            path: PathBuf,
            read: Read,
        }
        impl Collector for AccountCollector {
            fn provider(&self) -> Provider {
                Provider::Codex
            }
            fn measure(&mut self, _: &Context) -> Outcome {
                panic!("account capture must not invoke a client");
            }
            fn activity_paths(&self, _: &Path) -> Vec<PathBuf> {
                Vec::new()
            }
            fn local_account(&self, _: &Path) -> Option<String> {
                let account = match self.read {
                    Read::Local | Read::LocalThenSignIn => Some(std::fs::read_to_string(&self.path).unwrap()),
                    _ => None,
                };
                if matches!(self.read, Read::LocalThenSignIn | Read::MeasuredThenSignIn) {
                    // Publish another login after reading A, before returning it to Runner.
                    identity(&self.path, B, second());
                }
                account
            }
        }

        struct Stand(PathBuf);
        impl Stand {
            fn new() -> Self {
                let path =
                    std::env::temp_dir().join(format!("quotum-account-snapshot-{}", crate::config::random_hex()));
                std::fs::create_dir(&path).unwrap();
                Self(path)
            }
            fn runner(&self, adapters: Vec<Box<dyn Collector>>) -> Runner {
                let paths =
                    Paths { config: self.0.join("config.toml"), state: self.0.clone(), work: self.0.join("work") };
                Runner::with_adapters(Config::default(), paths, adapters, self.0.clone(), Stop::new())
            }
        }
        impl Drop for Stand {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        fn identity(path: &Path, contents: &str, at: SystemTime) {
            std::fs::write(path, contents).unwrap();
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(at))
                .unwrap();
        }

        fn durable(
            accounts: std::collections::BTreeMap<ClientId, crate::observed::worker::Account>,
            client: ClientId,
            expected: Option<&str>,
        ) {
            let batch = crate::observed::worker::captured_accounts(accounts, client);
            let checkpoint = batch.checkpoint.unwrap();
            assert_eq!(checkpoint.contexts.len(), 1);
            let context = &checkpoint.contexts[0];
            assert_eq!(context.client_id, client.id());
            assert_eq!(context.source.as_ref().and_then(|s| s.account.as_deref()), expected);
            assert_eq!(context.account_by.as_deref(), expected.map(|_| "login"));
            assert_eq!(context.working, Some(true));
            assert_eq!(
                context.session_id,
                Some(crate::session_identity::identify("0123456789abcdef0123456789abcdef", client, &[4, 2])),
                "funding uncertainty preserves the captured producer"
            );
            assert!(batch.frames.iter().all(|frame| frame.next_state.is_none()));
            assert_eq!(batch.frames.iter().map(|frame| frame.to_tick - frame.from_tick).sum::<u64>(), 15_000);
        }

        #[test]
        fn observed_account_resolution_rejects_mid_read_sign_in_and_keeps_stable_evidence() {
            for (read, contents, at, expected) in [
                (Read::Local, A, first(), Some(A)),
                (Read::Local, B, second(), Some(B)),
                (Read::Measured, A, first(), Some(A)),
                (Read::Measured, B, second(), None),
                (Read::LocalThenSignIn, A, first(), None),
                (Read::MeasuredThenSignIn, A, first(), None),
            ] {
                let stand = Stand::new();
                let path = stand.0.join("identity");
                identity(&path, contents, at);
                let collector = AccountCollector { path: path.clone(), read };
                let mut runner = stand.runner(vec![Box::new(collector)]);
                runner.clients = vec![ClientId::Codex];
                let accounts = runner.activity_accounts(&[Some((Some(A.into()), Some(first())))], &[vec![path]]);
                let account = accounts.get(&ClientId::Codex).unwrap();
                let witness = account.identity;
                assert!(account.legacy);
                durable(accounts, ClientId::Codex, expected);
                assert_eq!(witness, Some(at), "measured lookup and published witness use the pre-read stat");
            }
        }

        #[test]
        fn observed_account_snapshot_guard_also_applies_without_a_measurement_collector() {
            let stand = Stand::new();
            let path = stand.0.join("identity");
            identity(&path, A, first());
            let runner = stand.runner(Vec::new());
            let collector = AccountCollector { path: path.clone(), read: Read::LocalThenSignIn };
            let account = runner.activity_account(&collector, &None, vec![path], false);
            assert!(account.source.is_none() && account.by.is_none());
            assert_eq!(account.identity, Some(first()));
            assert!(!account.legacy);
            durable(std::collections::BTreeMap::from([(ClientId::Codex, account)]), ClientId::Codex, None);
        }

        #[test]
        fn observed_accounts_from_a_disabled_claude_collector_follow_local_sign_in_only() {
            let stand = Stand::new();
            let path = stand.0.join(".claude.json");
            let mut runner = stand.runner(Vec::new());
            runner.clients = vec![ClientId::Claude];
            for (email, at) in [("a@example.com", first()), ("b@example.com", second())] {
                identity(
                    &path,
                    &format!(r#"{{"oauthAccount":{{"emailAddress":"{email}","organizationName":"Fixture"}}}}"#),
                    at,
                );
                let expected = crate::model::pseudonym(Provider::Claude, &format!("{email}/Fixture"));
                let accounts = runner.activity_accounts(&[], &[]);
                let account = accounts.get(&ClientId::Claude).unwrap();
                assert_eq!(account.identity, Some(at));
                assert!(!account.legacy);
                durable(accounts, ClientId::Claude, Some(&expected));
            }
            identity(&path, "{}", second() + Duration::from_secs(60));
            durable(runner.activity_accounts(&[], &[]), ClientId::Claude, None);
        }
    }

    #[test]
    fn claude_logout_cannot_reuse_the_measured_or_commanded_account() {
        for removed in [false, true] {
            let home = std::env::temp_dir().join(format!("quotum-claude-logout-{}-{removed}", std::process::id()));
            std::fs::create_dir_all(&home).unwrap();
            let config = home.join(".claude.json");
            std::fs::write(
                &config,
                r#"{"oauthAccount":{"emailAddress":"fixture@example.com","organizationName":"Fixture"}}"#,
            )
            .unwrap();
            let first = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&config)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(first))
                .unwrap();
            let client = adapter(Provider::Claude);
            let account = client.local_account(&home).unwrap();
            let paths = client.identity_paths(&home);
            let measured = Some((Some(account.clone()), last_activity(&paths)));
            assert_eq!(
                measurement_account(
                    client.local_account(&home),
                    &measured,
                    last_activity(&paths),
                    Some(account.clone())
                ),
                Some(account.clone())
            );
            if removed {
                std::fs::remove_file(&config).unwrap();
            } else {
                std::fs::write(&config, "{}").unwrap();
                std::fs::OpenOptions::new()
                    .write(true)
                    .open(&config)
                    .unwrap()
                    .set_times(std::fs::FileTimes::new().set_modified(first + Duration::from_secs(1)))
                    .unwrap();
            }
            assert_eq!(client.local_account(&home), None);
            let target =
                measurement_account(client.local_account(&home), &measured, last_activity(&paths), Some(account));
            std::fs::remove_dir_all(&home).unwrap();
            assert_eq!(
                target, None,
                "clearing or removing the account invalidates the launch target: removed={removed}"
            );
        }
    }

    #[test]
    fn a_list_of_running_agents_goes_out_first_on_change_and_then_in_time() {
        let session = |working| RunningSession {
            session_id: None,
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at: 0,
            last_worked_at: None,
            working,
        };
        let report = |sessions: Vec<RunningSession>| SessionReport { sessions, ..SessionReport::default() };
        let mut watch = Watch {
            activity: Activity::new(PathBuf::from("/nowhere"), true),
            looked: None,
            reported: None,
            inventory: Inventory::default(),
            continuity_fault: false,
        };
        assert!(
            watch.worth_sending(&SessionReport::default()),
            "the first, even empty: the hub may still hold an older one"
        );
        watch.reported = Some((Instant::now(), report(vec![session(true)])));
        assert!(!watch.worth_sending(&report(vec![session(true)])));
        assert!(watch.worth_sending(&report(vec![session(false)])));
        assert!(watch.worth_sending(&SessionReport::default()), "none runs any more");
        let mut idle = session(false);
        idle.last_worked_at = Some(15_000);
        watch.reported = Some((Instant::now(), report(vec![idle.clone()])));
        assert!(!watch.worth_sending(&report(vec![idle.clone()])), "a remembered date stays equal on later idle looks");
        idle.last_worked_at = None;
        assert!(watch.worth_sending(&report(vec![idle.clone()])), "a clock correction can send one changed list");
        watch.reported = Some((Instant::now(), report(vec![idle.clone()])));
        assert!(!watch.worth_sending(&report(vec![idle])), "then idle dates stay unknown until new work");
        watch.reported = Some((Instant::now() - REPORT_EVERY, report(vec![session(true)])));
        assert!(watch.worth_sending(&report(vec![session(true)])), "in time, so the hub keeps it");
        watch.reported = Some((Instant::now() - REPORT_EVERY, report(vec![])));
        assert!(!watch.worth_sending(&SessionReport::default()), "an empty list said once is enough");
    }

    #[test]
    fn continuity_requires_an_accepted_false_witness_and_empty_scope_heartbeats() {
        let mut watch = Watch {
            activity: Activity::new(PathBuf::from("/nowhere"), false),
            looked: None,
            reported: None,
            inventory: Inventory::default(),
            continuity_fault: true,
        };
        let report = || SessionReport {
            tracking: Some(Tracking {
                version: 1,
                clients: vec![ClientId::OpenCode],
                route_disabled: vec![ClientId::Codex],
                complete: true,
            }),
            ..SessionReport::default()
        };
        let mut first = report();
        watch.witness(&mut first, true);
        assert!(!first.tracking.as_ref().unwrap().complete);
        watch.acknowledged(first, false);
        let mut lost = report();
        watch.witness(&mut lost, true);
        assert!(!lost.tracking.as_ref().unwrap().complete);
        assert!(watch.worth_sending(&lost));
        watch.acknowledged(lost, true);
        let mut recovered = report();
        watch.witness(&mut recovered, true);
        assert!(recovered.tracking.as_ref().unwrap().complete);
        assert!(watch.worth_sending(&recovered));
        watch.acknowledged(recovered.clone(), true);
        assert!(!watch.worth_sending(&recovered));
        watch.reported.as_mut().unwrap().0 = Instant::now() - REPORT_EVERY;
        assert!(watch.worth_sending(&recovered), "configured empty scope must report in time");
        let mut incomplete = report();
        watch.witness(&mut incomplete, false);
        watch.acknowledged(incomplete, false);
        let mut retry = report();
        watch.witness(&mut retry, true);
        assert!(!retry.tracking.as_ref().unwrap().complete, "recovery cannot erase failed delivery");
        watch.acknowledged(retry, true);
        let mut changed = report();
        changed.tracking.as_mut().unwrap().clients.push(ClientId::Claude);
        watch.witness(&mut changed, true);
        assert!(!changed.tracking.as_ref().unwrap().complete, "scope changes break continuity");
    }

    #[test]
    fn a_due_complete_list_checks_clock_continuity_before_its_witness() {
        for jump in [-3_600_000, 3_600_000] {
            let start = 10 * 3_600_000;
            let mut report = SessionReport {
                tracking: Some(Tracking {
                    version: 1,
                    clients: vec![ClientId::OpenCode],
                    route_disabled: vec![],
                    complete: true,
                }),
                ..SessionReport::default()
            };
            let mut watch = Watch {
                activity: Activity::new(PathBuf::from("/nowhere"), false),
                looked: Some(Instant::now()),
                reported: Some((Instant::now() - REPORT_EVERY, report.clone())),
                inventory: Inventory::default(),
                continuity_fault: false,
            };
            assert!(watch.worth_sending(&report));
            let mut clock = Clock::new(start);
            clock.at = Instant::now() - REPORT_EVERY;
            let back =
                watch.clocked_witness(&mut report, true, &mut clock, start + REPORT_EVERY.as_millis() as Millis + jump);
            assert_eq!(back > 0, jump < 0);
            assert!(!report.tracking.as_ref().unwrap().complete);
            watch.acknowledged(report.clone(), false);
            report.tracking.as_mut().unwrap().complete = true;
            watch.clocked_witness(&mut report, true, &mut clock, start + REPORT_EVERY.as_millis() as Millis + jump);
            assert!(!report.tracking.as_ref().unwrap().complete, "a lost false witness stays latched");
        }
    }

    #[test]
    fn a_clock_set_back_is_noticed_and_a_jump_forward_is_not() {
        let start = 10 * 3_600_000;
        let mut clock = Clock::new(start);
        assert_eq!(clock.went_back(start + 5), 0);
        let back = clock.went_back(start - 3_600_000);
        assert!((3_600_000..3_601_000).contains(&back), "{back}");
        assert_eq!(clock.went_back(start + 3_600_000), 0);
    }

    /// A hub that refuses the device at its first check-in.
    #[derive(Default)]
    struct Refusing {
        delivered: usize,
        refused: Option<String>,
    }

    impl Sink for Refusing {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered += 1;
        }

        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.refused = Some("removed".into());
            vec![Directive::Unanswered; asks.len()]
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_device_refused_at_check_in_starts_no_client() {
        // Any file that exists stands for the client: it is never started.
        let client = std::env::current_exe().unwrap();
        let config: Config = toml::from_str(&format!("[providers.antigravity]\npath = {:?}", client)).unwrap();
        let state = std::env::temp_dir().join("quotum-runner-refused");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[ClientId::Antigravity], Stop::new());
        let mut sink = Refusing::default();
        let mut events = 0;
        assert_eq!(runner.run(&mut sink, |_| events += 1).as_deref(), Some("removed"));
        assert_eq!((events, sink.delivered), (0, 0));
    }

    /// Counts check-ins; the first delivery ends the run.
    #[derive(Default)]
    struct Counting {
        checkins: usize,
        refused: Option<String>,
    }

    impl Sink for Counting {
        fn deliver(&mut self, _: &Outcome) {
            self.refused = Some("done".into());
        }

        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.checkins += 1;
            vec![Directive::Measure { paced: None }; asks.len()]
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_client_that_is_not_there_is_not_checked_in_for() {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join("quotum-runner-missing");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[ClientId::Antigravity], Stop::new());
        let mut sink = Counting::default();
        assert_eq!(runner.run(&mut sink, |_| {}).as_deref(), Some("done"));
        assert_eq!(sink.checkins, 0, "no duty is claimed for a client this machine lacks");
    }

    /// Takes whatever it is given, and counts what it delivers.
    #[derive(Default)]
    struct Taking {
        delivered: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Sink for Taking {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A runner of one provider whose client is not there: it measures (and fails) at
    /// once, without starting anything, and then waits for the next time.
    fn missing_client(name: &str, stop: Stop) -> Runner {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join(name);
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        Runner::new(config, paths, &[ClientId::Antigravity], stop)
    }

    #[test]
    fn a_stopped_run_ends_and_a_new_run_with_a_new_stop_measures_again() {
        for round in 0..2 {
            let stop = Stop::new();
            let mut runner = missing_client("quotum-runner-stop", stop.clone());
            let sink = Taking::default();
            let delivered = sink.delivered.clone();
            let (done, ended) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let mut sink = sink;
                let _ = done.send(runner.run(&mut sink, |_| {}));
            });
            let until = Instant::now() + Duration::from_secs(3);
            while delivered.load(std::sync::atomic::Ordering::SeqCst) == 0 && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 1, "round {round}: measured");
            stop.request(crate::stop::How::Exit);
            let result = ended.recv_timeout(Duration::from_secs(3));
            assert!(matches!(result, Ok(None)), "round {round}: the run ended on its stop");
        }
    }

    /// A client that answers what it is told to, and counts how often it was started.
    struct Scripted {
        outcome: fn() -> Outcome,
        runs: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// What changes when someone uses it.
        activity: Vec<PathBuf>,
    }

    impl Collector for Scripted {
        fn provider(&self) -> Provider {
            Provider::Antigravity
        }
        fn measure(&mut self, _: &Context) -> Outcome {
            self.runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            (self.outcome)()
        }
        fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
            self.activity.clone()
        }
        fn identifies_account(&self) -> bool {
            false
        }
    }

    fn snapshot() -> Outcome {
        Ok(crate::model::Snapshot {
            provider: Provider::Antigravity,
            account: None,
            account_name: None,
            plan: None,
            observed_at: now_ms(),
            via: "scripted".into(),
            client: None,
            stale_after_ms: 0,
            windows: vec![crate::model::Window::new("weekly", Some(10_080), None, 5.0, None)],
            resets: None,
            resource_status: None,
            balances: None,
        })
    }

    /// A hub that answers every check-in with `directive`, and keeps what it gets.
    struct Pacing {
        directive: fn(Millis) -> Directive,
        checkins: usize,
        flushed: usize,
        delivered: Vec<Outcome>,
        /// What each check-in said of the first subscription: whether in use, the least interval, its name.
        asked: Vec<(bool, Option<u64>, Option<String>)>,
    }

    impl Sink for Pacing {
        fn deliver(&mut self, outcome: &Outcome) {
            self.delivered.push(outcome.clone());
        }
        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.checkins += 1;
            self.asked.push((asks[0].active, asks[0].min_interval_ms, asks[0].account_name.map(str::to_string)));
            asks.iter().map(|_| (self.directive)(now_ms())).collect()
        }
        fn flush(&mut self) {
            self.flushed += 1;
        }
    }

    /// Runs a scripted client against `directive` until the first measurement, or for at
    /// most `for_ms`; returns the hub, how often the client ran and the events' next times.
    fn paced_run(
        directive: fn(Millis) -> Directive,
        outcome: fn() -> Outcome,
        for_ms: u64,
    ) -> (Pacing, usize, Vec<(bool, Millis)>) {
        let client = std::env::current_exe().unwrap();
        let config: Config = toml::from_str(&format!("[providers.antigravity]\npath = {:?}", client)).unwrap();
        let state = std::env::temp_dir().join("quotum-runner-paced");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let adapter: Box<dyn Collector> = Box::new(Scripted { outcome, runs: runs.clone(), activity: Vec::new() });
        let stop = Stop::new();
        let mut runner = Runner::with_adapters(config, paths, vec![adapter], std::env::temp_dir(), stop.clone());
        let timer = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(for_ms));
            timer.request(crate::stop::How::Exit);
        });
        let mut sink = Pacing { directive, checkins: 0, flushed: 0, delivered: Vec::new(), asked: Vec::new() };
        let mut events = Vec::new();
        runner.run(&mut sink, |event| {
            match event {
                Event::Measured(_, next) => events.push((true, next)),
                Event::Waiting(_, next) => events.push((false, next)),
                Event::Collected(..) | Event::Diagnostic(..) => {}
            }
            stop.request(crate::stop::How::Exit);
        });
        (sink, runs.load(std::sync::atomic::Ordering::SeqCst), events)
    }

    fn paced(now: Millis) -> Directive {
        Directive::Measure { paced: Some(crate::sink::Paced { ask_at: now + 15_000, next_in_ms: 240_000 }) }
    }

    #[test]
    fn on_duty_but_not_yet_it_starts_no_client_and_says_nothing() {
        let (sink, runs, events) =
            paced_run(|now| Directive::Wait { ask_at: now + 15_000, on_duty: true }, snapshot, 1_500);
        assert_eq!((runs, sink.checkins), (0, 1));
        assert!(events.is_empty(), "waiting at the hub's pace is not news");
        assert_eq!(sink.flushed, 1, "the hub answered: what it did not take goes now");
    }
    #[test]
    fn a_privacy_initialization_failure_is_reported_without_stopping_quota_checkins() {
        struct Recording {
            stop: Stop,
            warnings: usize,
            checkins: usize,
        }
        impl Sink for Recording {
            fn managed(&self) -> bool {
                true
            }
            fn activity_target(&self) -> Option<crate::observed::Target> {
                Some(crate::observed::Target { namespace: "a".repeat(64), credential_scope: "b".repeat(64) })
            }
            fn activity_failed(&mut self) {
                self.warnings += 1;
                self.stop.request(crate::stop::How::Exit);
            }
            fn checkin_managed(&mut self, _: &[Ask], _: &[Provider]) -> crate::sink::CheckinAnswer {
                self.checkins += 1;
                crate::sink::CheckinAnswer {
                    directives: Vec::new(),
                    commands: Vec::new(),
                    accounts: Vec::new(),
                    policy: None,
                }
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("no collectors were configured");
            }
            fn activity_request(&mut self, _: &serde_json::Value, _: bool) -> crate::observed::Answer {
                panic!("a broken privacy barrier must not send activity");
            }
        }
        for lock_is_directory in [false, true] {
            let root = std::env::temp_dir().join(format!("quotum-runner-privacy-{}", crate::config::random_hex()));
            std::fs::create_dir_all(&root).unwrap();
            if lock_is_directory {
                std::fs::create_dir(root.join("activity-policy.lock")).unwrap();
            } else {
                std::fs::write(root.join("activity-policy.json"), "{}").unwrap();
            }
            let stop = Stop::new();
            let timeout = stop.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                timeout.request(crate::stop::How::Exit);
            });
            let paths = Paths { config: root.join("config.toml"), work: root.join("work"), state: root.clone() };
            let mut runner = Runner::with_adapters(Config::default(), paths, Vec::new(), root.clone(), stop.clone());
            let mut sink = Recording { stop, warnings: 0, checkins: 0 };
            runner.run(&mut sink, |_| panic!("no collector events"));
            assert_eq!((sink.warnings, sink.checkins), (1, 1));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn deferred_activity_keeps_quota_contact_without_capture_or_legacy_fallback() {
        struct Deferred {
            stop: Stop,
            checkins: usize,
        }
        impl Sink for Deferred {
            fn managed(&self) -> bool {
                true
            }
            fn activity_target(&self) -> Option<crate::observed::Target> {
                panic!("policy is not durable yet")
            }
            fn takes_sessions(&self) -> bool {
                panic!("deferred activity cannot use legacy sessions")
            }
            fn checkin_managed(&mut self, _: &[Ask], _: &[Provider]) -> crate::sink::CheckinAnswer {
                self.checkins += 1;
                self.stop.request(crate::stop::How::Exit);
                crate::sink::CheckinAnswer {
                    directives: Vec::new(),
                    commands: Vec::new(),
                    accounts: Vec::new(),
                    policy: None,
                }
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("no collectors")
            }
        }
        let root = std::env::temp_dir().join(format!("quotum-deferred-policy-{}", crate::config::random_hex()));
        let paths = Paths { config: root.join("config"), state: root.clone(), work: root.join("work") };
        let stop = Stop::new();
        let mut sink = Deferred { stop: stop.clone(), checkins: 0 };
        let mut runner = Runner::with_adapters(Config::default(), paths, Vec::new(), root.clone(), stop);
        runner.defer_activity();
        assert!(runner.run(&mut sink, |_| panic!("no measurements")).is_none());
        assert_eq!(sink.checkins, 1);
        assert!(!root.exists());
    }

    #[test]
    fn an_empty_local_scope_is_declared_once_without_starting_a_recovery_loop() {
        struct Empty {
            checkins: usize,
        }
        impl Sink for Empty {
            fn managed(&self) -> bool {
                true
            }
            fn needs_policy_contact(&self) -> bool {
                true
            }
            fn checkin_managed(&mut self, asks: &[Ask], collectors: &[Provider]) -> crate::sink::CheckinAnswer {
                assert!(asks.is_empty());
                assert!(collectors.is_empty());
                self.checkins += 1;
                crate::sink::CheckinAnswer {
                    directives: Vec::new(),
                    commands: Vec::new(),
                    accounts: Vec::new(),
                    policy: None,
                }
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("empty scope delivered");
            }
        }
        let stop = Stop::new();
        let watchdog = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            watchdog.request(crate::stop::How::Exit);
        });
        let state = std::env::temp_dir().join(format!("quotum-empty-scope-{}", std::process::id()));
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::with_adapters(
            Config::parse("sessions = false").unwrap(),
            paths,
            Vec::new(),
            std::env::temp_dir(),
            stop,
        );
        let mut sink = Empty { checkins: 0 };
        runner.policy_contact_every = Duration::ZERO;
        runner.run(&mut sink, |_| panic!("empty scope measured"));
        assert_eq!(sink.checkins, 1);
    }

    #[test]
    fn hub_denial_is_learned_before_unknown_account_discovery_with_sessions_off() {
        struct Denied {
            checkins: usize,
        }
        impl Sink for Denied {
            fn managed(&self) -> bool {
                true
            }
            fn allows_measurement(&self, _: Provider) -> bool {
                false
            }
            fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
                assert!(asks.is_empty(), "bootstrap contains no invented account");
                self.checkins += 1;
                Vec::new()
            }
            fn deliver(&mut self, _: &Outcome) {
                panic!("blocked collector delivered");
            }
        }
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let state = std::env::temp_dir().join(format!("quotum-denial-{}", std::process::id()));
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let adapter: Box<dyn Collector> =
            Box::new(Scripted { outcome: snapshot, runs: runs.clone(), activity: Vec::new() });
        let stop = Stop::new();
        let timer = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            timer.request(crate::stop::How::Exit);
        });
        let mut runner = Runner::with_adapters(
            Config::parse("sessions = false").unwrap(),
            paths,
            vec![adapter],
            std::env::temp_dir(),
            stop,
        );
        let mut sink = Denied { checkins: 0 };
        runner.run(&mut sink, |_| panic!("blocked collector measured"));
        assert_eq!(sink.checkins, 1);
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn policy_contact_keeps_local_backoff_and_flushes_without_an_enabled_collector() {
        struct Contact {
            stop: Stop,
            checkins: usize,
            flushed: usize,
            enabled: bool,
        }
        impl Sink for Contact {
            fn managed(&self) -> bool {
                true
            }
            fn needs_policy_contact(&self) -> bool {
                true
            }
            fn allows_measurement(&self, _: Provider) -> bool {
                self.enabled
            }
            fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
                self.checkins += 1;
                if self.checkins > 2 {
                    assert!(asks.is_empty(), "local backoff is not a measuring request");
                }
                if self.checkins == 4 {
                    self.stop.request(crate::stop::How::Exit);
                }
                vec![Directive::Unanswered; asks.len()]
            }
            fn flush(&mut self) {
                self.flushed += 1;
            }
            fn deliver(&mut self, _: &Outcome) {}
        }
        fn unsupported() -> Outcome {
            Err(crate::model::Failure::new(Provider::Antigravity, ErrorKind::Unsupported, "fixture"))
        }
        for enabled in [true, false] {
            let config: Config = toml::from_str(&format!(
                "sessions = false\n[providers.antigravity]\npath = {:?}",
                std::env::current_exe().unwrap()
            ))
            .unwrap();
            let state = std::env::temp_dir().join(format!("quotum-control-{}-{enabled}", std::process::id()));
            let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
            let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let stop = Stop::new();
            let timeout = stop.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(5));
                timeout.request(crate::stop::How::Exit);
            });
            let adapter: Box<dyn Collector> =
                Box::new(Scripted { outcome: unsupported, runs: runs.clone(), activity: Vec::new() });
            let mut runner = Runner::with_adapters(config, paths, vec![adapter], std::env::temp_dir(), stop.clone());
            // Zero advances control turns deterministically without waiting a real minute.
            runner.policy_contact_every = Duration::ZERO;
            let mut sink = Contact { stop, checkins: 0, flushed: 0, enabled };
            runner.run(&mut sink, |event| {
                if let Event::Measured(_, next) = event {
                    assert!(next - now_ms() > 10 * 60_000);
                }
            });
            assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), usize::from(enabled));
            assert!(sink.flushed >= 3, "bootstrap and control turns drain delivery independently");
        }
    }

    #[test]
    fn told_to_measure_it_measures_once_and_promises_the_next_as_the_hub_did() {
        let started = now_ms();
        let (sink, runs, events) = paced_run(paced, snapshot, 5_000);
        assert_eq!(runs, 1);
        let Ok(snapshot) = &sink.delivered[0] else { panic!("{:?}", sink.delivered) };
        assert_eq!(snapshot.stale_after_ms, 240_000 + 48_000 + 60_000);
        let (measured, next) = events[0];
        assert!(measured && next >= started + 240_000 && next <= now_ms() + 240_000);
    }

    #[test]
    fn a_failed_paced_measurement_is_delivered_and_waited_out_by_the_hub() {
        let started = now_ms();
        let timeout = || Err(crate::model::Failure::new(Provider::Antigravity, ErrorKind::Timeout, ""));
        let (sink, _, events) = paced_run(paced, timeout, 5_000);
        assert!(matches!(&sink.delivered[0], Err(f) if f.error == ErrorKind::Timeout));
        let promise = started + 240_000;
        assert!(events[0].1 >= promise && events[0].1 < promise + 5_000, "the hub's promise, not a local back-off");

        // A client gone since it was asked for is not the hub's business: its own rhythm, half an hour.
        let gone = || Err(crate::model::Failure::new(Provider::Antigravity, ErrorKind::NotInstalled, ""));
        let (_, _, events) = paced_run(paced, gone, 5_000);
        assert!(events[0].1 >= started + 30 * 60_000);
    }

    #[test]
    fn a_check_in_says_whether_the_client_was_used_since_the_last_one_and_how_often_at_most_to_measure() {
        let dir = std::env::temp_dir().join(format!("quotum-runner-asks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let history = dir.join("history");
        std::fs::write(&history, "").unwrap();
        let client = std::env::current_exe().unwrap();
        let settings = format!("[providers.antigravity]\npath = {client:?}\ninterval = 300\naccount = \"live\"");
        let config: Config = toml::from_str(&settings).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let adapter: Box<dyn Collector> =
            Box::new(Scripted { outcome: snapshot, runs, activity: vec![history.clone()] });
        let stop = Stop::new();
        let mut runner = Runner::with_adapters(config, paths, vec![adapter], dir.clone(), stop.clone());
        let timer = stop.clone();
        thread::spawn(move || {
            // Used between the first question and the next, which comes 10 s later.
            thread::sleep(Duration::from_secs(3));
            std::fs::write(&history, "used").unwrap();
            thread::sleep(Duration::from_secs(9));
            timer.request(crate::stop::How::Exit);
        });
        let wait = |now| Directive::Wait { ask_at: now, on_duty: true };
        let mut sink = Pacing { directive: wait, checkins: 0, flushed: 0, delivered: Vec::new(), asked: Vec::new() };
        runner.run(&mut sink, |_| {});
        let _ = std::fs::remove_dir_all(&dir);
        let live = Some("live".to_string());
        assert_eq!(sink.asked, [(false, Some(300_000), live.clone()), (true, Some(300_000), live)]);
    }

    #[test]
    fn another_device_on_duty_is_said_once_with_when_to_ask_again() {
        let started = now_ms();
        let other = |now| Directive::Wait { ask_at: now + 10 * 60_000, on_duty: false };
        let (_, runs, events) = paced_run(other, snapshot, 3_000);
        assert_eq!(runs, 0);
        assert_eq!(events.len(), 1, "{events:?}");
        let (measured, next) = events[0];
        assert!(!measured && next >= started + 10 * 60_000 && next <= now_ms() + 10 * 60_000);
    }

    #[test]
    fn an_unanswered_check_in_is_not_followed_by_sending_the_spool() {
        let (sink, runs, _) = paced_run(|_| Directive::Unanswered, snapshot, 5_000);
        assert_eq!((sink.flushed, runs), (0, 1), "measured as without a hub, nothing flushed");
    }

    #[test]
    fn a_paced_provider_checks_in_with_the_account_it_last_measured_even_after_a_sign_in() {
        let then = Some(SystemTime::UNIX_EPOCH);
        let later = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let measured = Some((Some("a".to_string()), then));
        // Slot 0 follows the hub's pace, slot 1 does not.
        let mut schedule = Schedule::new(&[120_000, 120_000], 0, true);
        schedule.answer(&[(0, Directive::Wait { ask_at: 15_000, on_duty: true })], 0);
        let (paced, own) = (0, 1);
        let ask = |index, local: Option<&str>, measured, signed_in| {
            ask_account(&schedule, index, local.map(str::to_string), measured, signed_in)
        };
        assert_eq!(ask(paced, None, &measured, later), Some(Some("a".into())), "the measurement will tell");
        assert_eq!(ask(own, None, &measured, later), None, "not known: measured without asking");
        assert_eq!(ask(own, None, &measured, then), Some(Some("a".into())));
        assert_eq!(ask(paced, Some("b"), &measured, later), Some(Some("b".into())), "what the client names");
        assert_eq!(ask(paced, None, &None, later), None, "never measured");
    }

    #[test]
    fn a_run_asked_to_stop_measures_nothing_more() {
        let stop = Stop::new();
        stop.request(crate::stop::How::Yield);
        let mut runner = missing_client("quotum-runner-stopped", stop);
        let mut sink = Taking::default();
        assert_eq!(runner.run(&mut sink, |_| {}), None);
        assert_eq!(sink.delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
