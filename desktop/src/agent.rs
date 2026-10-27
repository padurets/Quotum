//! The agent of this machine, inside the app: the same settings, state and identity as
//! `quotum`, delivering to the app's own hub. It measures only while it holds the machine
//! (see quotum_core::holder). If `quotum run` holds it, the app asks once, in its window,
//! whether to take over; agreed, it takes over by itself on every start after. The app
//! never holds the machine without measuring or being able to: stopped for good (a panic,
//! the hub down for good, quitting), it lets it go, and a waiting `quotum` goes on.
//!
//! Two mutexes: `ops` puts the operations one after another (they join threads and wait
//! for `quotum` to make way), `data` is held only to read or write fields, so the board's
//! `app_state` never waits for an operation.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use quotum_core::clients::ClientId;
use quotum_core::collection::{AccountRef, CollectionOutcome, CollectionResult};
use quotum_core::config::{Config, Hub, IntervalSource, Paths, home, machine};
use quotum_core::holder::{Holder, LockError, RunLock, Running};
use quotum_core::model::{Millis, Outcome, Provider};
use quotum_core::runner::{Event, Runner};
use quotum_core::sink::HubSink;
use quotum_core::stop::{How, Stop};
use serde::Serialize;

use crate::files::Log;
use crate::hub::{HubState, Ready};
use crate::settings::{self, Patch};
use crate::shell::{self, Shell};
use crate::{autostart, window};

/// Where the agent is, as the board shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    Starting,
    TakingOver,
    Measuring,
    /// Collectors are off, but client activity is still reported.
    Tracking,
    /// Collectors and client activity are off: holding the machine, doing nothing.
    Idle,
    /// `quotum` holds the machine; `error` says why taking over failed, if it did.
    Held {
        holder: HolderInfo,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Failed {
        cause: Cause,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolderInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Where it delivers, as far as known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    /// It said it makes way (run.info): it waits while the app runs and goes on after.
    pub yields: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// config.toml cannot be read: fixing it starts the agent again.
    Config,
    /// The machine cannot be held.
    Lock,
    /// The agent stopped by itself.
    Panic,
}

/// The last measurement of a provider here.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Last {
    #[serde(skip)]
    status: &'static str,
    pub at: Millis,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<quotum_core::model::ErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLast {
    pub account: Option<AccountRef>,
    pub status: &'static str,
    pub completed_at: Millis,
    pub observed_at: Option<Millis>,
    pub error: Option<quotum_core::model::ErrorKind>,
}
type AccountLasts = Arc<Mutex<BTreeMap<(Provider, Option<AccountRef>), AccountLast>>>;

type Lasts = Arc<Mutex<BTreeMap<Provider, Last>>>;

/// A run of the agent on a thread of its own, for one start of the hub.
struct Run {
    stop: Stop,
    thread: JoinHandle<Option<String>>,
    /// The hub's generation it delivers to.
    generation: u64,
}

pub struct Agent {
    pub state: State,
    lock: Option<Arc<RunLock>>,
    /// Policy attempts pin the lock and are cancelled before ownership can pass on.
    policy_stop: Stop,
    run: Option<Run>,
    /// The settings in effect: the ones read last without an error.
    pub config: Config,
    /// config.toml as it was when read (modified, length): a change starts the agent again.
    seen: Option<(Option<SystemTime>, u64)>,
    pub clients: BTreeMap<ClientId, Option<PathBuf>>,
    pub last: Lasts,
    account_last: AccountLasts,
    /// Numbers the saves: only the last of several quick ones restarts the agent.
    saves: u64,
    /// A stopped worker still owns its spool until delivery has finished.
    restart_pending: bool,
    started: bool,
    privacy: quotum_core::observed::PrivacyUpdate,
    privacy_reported: (bool, bool, u64),
}

impl Agent {
    pub fn new() -> Agent {
        Agent {
            state: State::Starting,
            lock: None,
            policy_stop: Stop::new(),
            run: None,
            config: Config::default(),
            seen: None,
            clients: BTreeMap::new(),
            last: Arc::default(),
            account_last: Arc::default(),
            saves: 0,
            restart_pending: false,
            started: false,
            privacy: Default::default(),
            privacy_reported: (false, false, 0),
        }
    }

    /// Whether the app holds the machine and so reads its settings (and may measure).
    fn holds(&self) -> bool {
        self.lock.is_some()
    }

    fn hold(&mut self, lock: RunLock) {
        self.policy_stop.request(How::Exit);
        self.policy_stop = Stop::new();
        self.lock = Some(Arc::new(lock));
    }

    fn release(&mut self) {
        self.policy_stop.request(How::Exit);
        self.lock.take();
    }
}

/// What the app does when `quotum` holds the machine at its start.
#[derive(Debug, PartialEq)]
pub enum OnHeld {
    /// Agreed before: take over without asking.
    TakeOver,
    /// Ask in the window.
    Ask,
    /// Started at login with no window: nobody would see the question, and the app does
    /// not hold the machine without an answer. It quits until it is opened.
    Quit,
}

pub fn on_held(confirmed: bool, window_open: bool) -> OnHeld {
    match (confirmed, window_open) {
        (true, _) => OnHeld::TakeOver,
        (false, true) => OnHeld::Ask,
        (false, false) => OnHeld::Quit,
    }
}

/// Whether closing the window quits the app: while it asks, closing it is the answer no.
pub fn closing_quits(state: &State, confirmed: bool) -> bool {
    matches!(state, State::Held { .. }) && !confirmed
}

/// Native close events must not decide from Starting while startup is about to publish
/// Held. Run after that operation, off the native event loop, and recheck any later open.
pub fn window_closed(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || {
        if close_requires_exit(
            &shell.agent,
            &shell.agent_ops,
            || window::is_open_or_opening(&shell),
            || shell.take_over_confirmed(),
        ) {
            shell::quit(&shell);
        }
    });
}

fn close_requires_exit(
    agent: &Mutex<Agent>,
    operations: &Mutex<()>,
    visible: impl FnOnce() -> bool,
    confirmed: impl FnOnce() -> bool,
) -> bool {
    let _ops = operations.lock().unwrap_or_else(|e| e.into_inner());
    !visible() && closing_quits(&agent.lock().unwrap_or_else(|e| e.into_inner()).state, confirmed())
}

/// config.toml as it is now: changed or not since it was read.
fn stat(paths: &Paths) -> Option<(Option<SystemTime>, u64)> {
    fs::metadata(&paths.config).ok().map(|m| (m.modified().ok(), m.len()))
}

fn clients(config: &Config) -> BTreeMap<ClientId, Option<PathBuf>> {
    let home = home();
    ClientId::ALL
        .into_iter()
        .map(|p| (p, config.client_program(p).map(PathBuf::from).or_else(|| p.find(&home))))
        .collect()
}

/// Who holds the machine, as the question about taking over names them.
fn holder_info(paths: &Paths, running: Running) -> HolderInfo {
    match paths.run_info() {
        Some(info) if Some(info.pid) == running.pid => HolderInfo { pid: running.pid, hub: info.hub, yields: true },
        // `quotum` 0.3.0 or older: where it delivers is known only from its settings (it may have got --hub).
        _ => {
            let hub = Config::load(&paths.config).ok().and_then(|c| c.hub_or_connected(paths)).map(|h| h.url);
            HolderInfo { pid: running.pid, hub, yields: false }
        }
    }
}

fn describe(error: LockError) -> String {
    match error {
        LockError::Held(Running { app: true, .. }) => "another copy of the Quotum app measures this machine".into(),
        LockError::Held(Running { pid, .. }) => {
            format!("`quotum`{} still measures this machine", pid.map(|p| format!(" (pid {p})")).unwrap_or_default())
        }
        LockError::Io(e) => e,
    }
}

impl Shell {
    fn agent(&self) -> MutexGuard<'_, Agent> {
        self.agent.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_agent(&self, state: State) {
        self.agent().state = state;
        self.wake();
    }
}

/// The hub's first start is ready: the agent takes the machine, or finds who has it.
pub fn start(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    if shell.exiting() || std::mem::replace(&mut shell.agent().started, true) {
        return;
    }
    // Readable by this user only, even where `quotum` never ran: the spool and client logs are there.
    if let Err(e) = shell.paths.ensure() {
        shell.set_agent(State::Failed { cause: Cause::Lock, error: format!("{}: {e}", shell.paths.state.display()) });
        return;
    }
    match shell.paths.lock_run(Holder::App) {
        Ok(lock) => {
            shell.agent().hold(lock);
            begin(shell);
        }
        Err(LockError::Held(running)) if !running.app => {
            let window_open = window::is_open_or_opening(shell);
            match on_held(shell.take_over_confirmed(), window_open) {
                OnHeld::TakeOver => {
                    drop(_ops);
                    let _ = take_over(shell);
                }
                OnHeld::Ask => shell.set_agent(State::Held { holder: holder_info(&shell.paths, running), error: None }),
                OnHeld::Quit => {
                    shell.agent_log.line("app: `quotum` measures this machine; the app quits until it is opened");
                    shell::quit(shell);
                }
            }
        }
        Err(e) => shell.set_agent(State::Failed { cause: Cause::Lock, error: describe(e) }),
    }
}

/// With the machine held: reads the settings and measures, or is idle, or says the settings are broken.
fn begin(shell: &Arc<Shell>) {
    let _settings = shell.settings_ops.lock().unwrap_or_else(|e| e.into_inner());
    let seen = stat(&shell.paths);
    let loaded = load_settings(&shell.paths, &shell.agent);
    report_privacy(shell);
    let mut agent = shell.agent();
    agent.restart_pending = false;
    agent.seen = seen;
    match loaded {
        Ok(config) => {
            agent.clients = clients(&config);
            for id in config.unknown_clients() {
                shell.agent_log.line(&format!("warning: unknown client `{id}` is ignored"));
            }

            let measuring = Provider::ALL.iter().any(|p| config.enabled(*p));
            let tracking = config.sessions() && quotum_core::clients::ClientId::ALL.iter().any(|c| config.tracks(*c));
            let idle = !measuring && !tracking;
            agent.config = config;
            agent.state = if measuring {
                State::Measuring
            } else if tracking {
                State::Tracking
            } else {
                State::Idle
            };
            drop(agent);
            shell.wake();
            if !idle {
                run(shell);
            }
            autostart::by_default(shell);
        }
        Err(error) => {
            agent.state = State::Failed { cause: Cause::Config, error };
            shell.wake();
        }
    }
}

/// Starts measuring for the hub's current start, if it is ready (else its `Ready` will).
fn run(shell: &Arc<Shell>) {
    let (hub, generation) = shell.hub();
    let HubState::Ready(ready) = hub else { return };
    let mut agent = shell.agent();
    // Only under the machine's lock, never twice, and for the start of the hub decided on.
    if !agent.holds() || agent.run.is_some() || shell.generation() != generation || shell.exiting() {
        return;
    }
    let stop = Stop::new();
    let (config, paths, log, last) = (
        (agent.config.clone(), agent.privacy.pending()),
        shell.paths.clone(),
        shell.agent_log.clone(),
        agent.last.clone(),
    );
    let account_last = agent.account_last.clone();
    let (measuring, asked) = (shell.clone(), stop.clone());
    let thread = thread::spawn(move || measure(config, paths, asked, ready, log, (last, account_last), measuring));
    agent.run = Some(Run { stop, thread, generation });
}

/// One run of the agent: measures on the schedule and delivers to the app's hub.
fn measure(
    settings: (Config, bool),
    paths: Paths,
    stop: Stop,
    ready: Ready,
    log: Arc<Log>,
    history: (Lasts, AccountLasts),
    shell: Arc<Shell>,
) -> Option<String> {
    let (last, account_last) = history;
    let (config, defer_activity) = settings;
    let hub = Hub { url: ready.origin(), token: ready.token };
    let identity = machine(&paths, &config);
    let delivered = log.clone();
    let mut sink = HubSink::new(
        &hub,
        identity,
        paths.state.join("app-spool.jsonl"),
        Box::new(move |line: &str| delivered.line(line)),
    );
    let mut runner = Runner::new(config, paths, &[], stop);
    if defer_activity {
        runner.defer_activity();
    }
    let mut failing = BTreeMap::new();
    runner.run(&mut sink, |event| match event {
        Event::Measured(..) => {}
        Event::Collected(result, _) => {
            record_collection(&last, &account_last, result);
            let outcome = match &result.outcome {
                CollectionOutcome::Observed(s) => Some(Ok(s.clone())),
                CollectionOutcome::Failed(f) => Some(Err(f.clone())),
                CollectionOutcome::NoNewData => None,
            };
            shell.wake();
            if let (Some(Ok(_)), Some(smoke)) = (&outcome, &shell.smoke) {
                smoke.measured(&shell);
            }
            let key = (result.provider, result.account.clone());
            let message = outcome.as_ref().map(|o| summary(o).1).unwrap_or_else(|| "no new data".into());
            let repeated = if matches!(&result.outcome, CollectionOutcome::Failed(_)) {
                failing.insert(key.clone(), message.clone()).as_ref() == Some(&message)
            } else {
                failing.remove(&key);
                false
            };
            if !repeated {
                log.line(&format!(
                    "{} {}: {message}",
                    result.provider.id(),
                    quotum_core::collection::account_label(result.account.as_ref())
                ));
            }
        }
        Event::Diagnostic(d) => log.line(&d.to_string()),
        Event::Waiting(provider, _) => {
            log.line(&format!("{}: another device measures this subscription", provider.id()))
        }
    })
}

fn record_account(last: &AccountLasts, result: &CollectionResult) {
    let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
    let key = (result.provider, result.account.clone());
    let observed = match &result.outcome {
        CollectionOutcome::Observed(s) => Some(s.observed_at),
        _ => last.get(&key).and_then(|l| l.observed_at),
    };
    let (status, error) = match &result.outcome {
        CollectionOutcome::Observed(_) => ("observed", None),
        CollectionOutcome::NoNewData => ("no_new_data", None),
        CollectionOutcome::Failed(f) => ("failed", Some(f.error)),
    };
    last.insert(
        key,
        AccountLast {
            account: result.account.clone(),
            status,
            completed_at: result.completed_at,
            observed_at: observed,
            error,
        },
    );
}

fn summary(outcome: &Outcome) -> (Provider, String) {
    match outcome {
        Ok(s) => {
            let windows: Vec<String> =
                s.windows.iter().map(|w| format!("{} {:.0}% left", w.id, w.remaining())).collect();
            (s.provider, windows.join(", "))
        }
        Err(f) => {
            let detail = f.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default();
            (f.provider, format!("{}{detail}", f.error.describe()))
        }
    }
}

/// Provider summary follows event order, including equal completion times in one batch.
fn record_collection(last: &Lasts, accounts: &AccountLasts, result: &CollectionResult) {
    record_account(accounts, result);
    let (status, error, detail) = match &result.outcome {
        CollectionOutcome::Observed(_) => ("observed", None, None),
        CollectionOutcome::NoNewData => ("no_new_data", None, None),
        CollectionOutcome::Failed(f) => ("failed", Some(f.error), f.detail.clone()),
    };
    last.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(result.provider, Last { status, at: result.completed_at, ok: error.is_none(), error, detail });
}

/// A delivery may outlast the wait. Keep its worker registered until it has finished:
/// starting another would give two independent queues ownership of the same spool.
fn finish_run(agent: &Mutex<Agent>, limit: Duration) -> bool {
    {
        let agent = agent.lock().unwrap_or_else(|e| e.into_inner());
        let Some(run) = &agent.run else { return true };
        run.stop.request(How::Exit);
    }
    let until = Instant::now() + limit;
    loop {
        let finished = {
            let mut agent = agent.lock().unwrap_or_else(|e| e.into_inner());
            if agent.run.as_ref().is_none_or(|run| run.thread.is_finished()) { Some(agent.run.take()) } else { None }
        };
        if let Some(run) = finished {
            if let Some(run) = run {
                let _ = run.thread.join();
            }
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn halt(shell: &Arc<Shell>, limit: Duration) -> bool {
    finish_run(&shell.agent, limit)
}

/// Measures anew: the settings read again, or the hub started again.
fn restart(shell: &Arc<Shell>) {
    shell.agent().restart_pending = true;
    if !halt(shell, Duration::from_secs(5)) {
        return;
    }
    if shell.agent().holds() && !shell.exiting() {
        begin(shell);
    }
}

/// The hub is ready (started again, maybe): the agent delivers to this start of it, with
/// its token. The events of the hub may come here out of order: what counts is the
/// generation of the run against the hub's current one.
pub fn hub_ready(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    let current = shell.generation();
    let resume = {
        let agent = shell.agent();
        agent.holds()
            && matches!(agent.state, State::Measuring | State::Tracking)
            && agent.run.as_ref().is_none_or(|run| run.generation != current)
    };
    if resume {
        restart(shell);
    }
}

/// The hub stopped (its start of `generation`): nothing goes to its port any more. The
/// machine stays held.
pub fn hub_starting(shell: &Arc<Shell>, generation: u64) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    if shell.agent().run.as_ref().is_some_and(|run| run.generation < generation) {
        halt(shell, Duration::from_secs(5));
    }
}

/// The hub is down for good: the app measures no more and lets the machine go.
pub fn hub_down(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    halt(shell, Duration::from_secs(5));
    shell.agent().release();
}

/// Quitting: the agent stops within `limit` and the machine is let go.
pub fn quit(shell: &Arc<Shell>, limit: Duration) {
    halt(shell, limit);
    shell.agent().release();
}

/// Takes the machine over from `quotum`: asks it to make way (one that knows how lets go at
/// once and waits; an older one stops), then holds it and measures. Only then the answer
/// is remembered: from now on the app takes over without asking.
pub fn take_over(shell: &Arc<Shell>) -> Result<(), String> {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut agent = shell.agent();
        if agent.holds() {
            return Ok(());
        }
        agent.state = State::TakingOver;
    }
    shell.wake();
    let taken = shell.paths.stop_running(How::Yield).and_then(|_| shell.paths.lock_run(Holder::App).map_err(describe));
    if shell.exiting() {
        return Ok(());
    }
    match taken {
        Ok(lock) => {
            shell.agent().hold(lock);
            shell.confirm_take_over();
            shell.agent_log.line("app: took the machine over from `quotum`");
            begin(shell);
            Ok(())
        }
        Err(error) => {
            let holder = shell.paths.running().map(|r| holder_info(&shell.paths, r));
            let holder = holder.unwrap_or(HolderInfo { pid: None, hub: None, yields: false });
            shell.agent_log.line(&format!("app: could not take the machine over: {error}"));
            shell.set_agent(State::Held { holder, error: Some(error.clone()) });
            Err(error)
        }
    }
}

/// Every five seconds, window or not: takes a machine let go, follows config.toml, and
/// notices an agent that stopped by itself.
pub fn tick(shell: &Arc<Shell>) {
    let Ok(_ops) = shell.agent_ops.try_lock() else { return };
    if shell.exiting() || matches!(shell.hub().0, HubState::Down) {
        return;
    }
    let state = shell.agent().state.clone();
    match state {
        State::Held { error, .. } => match shell.paths.lock_run(Holder::App) {
            Ok(lock) => {
                shell.agent().hold(lock);
                shell.agent_log.line("app: `quotum` let the machine go; measuring");
                begin(shell);
            }
            Err(LockError::Held(running)) if !running.app => {
                shell.set_agent(State::Held { holder: holder_info(&shell.paths, running), error })
            }
            Err(_) => {}
        },
        State::Measuring | State::Tracking | State::Idle | State::Failed { cause: Cause::Config, .. }
            if shell.agent().holds() =>
        {
            let panicked = {
                let mut agent = shell.agent();
                match &agent.run {
                    Some(run) if run.thread.is_finished() && !run.stop.requested() => agent.run.take(),
                    _ => None,
                }
            };
            if let Some(run) = panicked {
                let why = match run.thread.join() {
                    Ok(Some(reason)) => reason,
                    Ok(None) => "it ended".into(),
                    Err(_) => "it panicked".into(),
                };
                shell.agent_log.line(&format!("app: the agent stopped unexpectedly: {why}"));
                let mut agent = shell.agent();
                agent.state = State::Failed {
                    cause: Cause::Panic,
                    error: "the agent stopped unexpectedly; see agent.log".into(),
                };
                // It measures no more: the machine is let go, and a waiting `quotum` goes on.
                agent.release();
                shell.wake();
                return;
            }
            let now = stat(&shell.paths);
            let changed = {
                let mut agent = shell.agent();
                agent.clients = clients(&agent.config);
                let changed = agent.seen != now;
                agent.seen = now;
                changed
            };
            if changed {
                shell.agent_log.line("app: config.toml changed; reading it again");
                restart(shell);
            } else if shell.agent().restart_pending {
                restart(shell);
            } else {
                let recovered = retry_privacy(&shell.paths, &shell.agent, &shell.settings_ops);
                report_privacy(shell);
                if recovered {
                    restart(shell);
                }
            }
        }
        _ => {}
    }
}

fn report_privacy(shell: &Arc<Shell>) {
    let health = {
        let mut agent = shell.agent();
        let health = agent.privacy.health().clone();
        let state = (health.unavailable, health.terminal, health.recoveries);
        if state == agent.privacy_reported {
            return;
        }
        agent.privacy_reported = state;
        health
    };
    if let Some(failure) = health.last {
        let state = if health.unavailable { if health.terminal { "stopped" } else { "retrying" } } else { "recovered" };
        shell.agent_log.line(&format!(
            "activity: privacy {state}; kind={:?}; os={:?}; failures={}",
            failure.kind, failure.os_code, health.failures
        ));
    }
}

fn retry_privacy(paths: &Paths, state: &Mutex<Agent>, writes: &Mutex<()>) -> bool {
    let Ok(_settings) = writes.try_lock() else { return false };
    let (mut privacy, config, stop, _owner) = {
        let mut agent = state.lock().unwrap_or_else(|e| e.into_inner());
        (std::mem::take(&mut agent.privacy), agent.config.clone(), agent.policy_stop.clone(), agent.lock.clone())
    };
    #[cfg(test)]
    PRIVACY_RETRY_PAUSE.with(|pause| {
        if let Some((entered, release)) = pause.borrow_mut().take() {
            entered.send(()).unwrap();
            release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    });
    let recovered = privacy.retry(paths, &config, &stop);
    state.lock().unwrap_or_else(|e| e.into_inner()).privacy = privacy;
    recovered
}

/// Changes the settings in config.toml; the agent measures with them in a moment.
pub fn save_settings(shell: &Arc<Shell>, patch: &Patch) -> Result<(), String> {
    let accepted = accept_settings(&shell.paths, &shell.agent, &shell.settings_ops, patch);
    report_privacy(shell);
    shell.wake();
    let number = accepted?;
    let shell = shell.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1500));
        let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
        let current = {
            let agent = shell.agent();
            agent.saves == number
                && agent.holds()
                && matches!(
                    agent.state,
                    State::Measuring | State::Tracking | State::Idle | State::Failed { cause: Cause::Config, .. }
                )
        };
        if current {
            restart(&shell);
        }
    });
    Ok(())
}

/// File replacement and its published snapshot form one transaction, also when the
/// native command transport runs several saves concurrently.
fn accept_settings(paths: &Paths, state: &Mutex<Agent>, writes: &Mutex<()>, patch: &Patch) -> Result<u64, String> {
    let _settings = writes.lock().unwrap_or_else(|e| e.into_inner());
    settings::save(&paths.config, patch)?;
    let config = load_settings(paths, state)?;
    let mut agent = state.lock().unwrap_or_else(|e| e.into_inner());
    // Publish accepted settings now; replacing the running worker is debounced.
    agent.config = config;
    // Its own write is no change to follow: the ticker would restart once more.
    agent.seen = stat(paths);
    agent.saves += 1;
    if agent.privacy.pending() {
        agent.restart_pending = true;
        Err("could not persist activity privacy settings".into())
    } else {
        Ok(agent.saves)
    }
}

/// File watchers and native saves accept the same durable privacy barrier, including Idle.
fn load_settings(paths: &Paths, state: &Mutex<Agent>) -> Result<Config, String> {
    let config = Config::load(&paths.config)?;
    let (mut privacy, tightens, stop, _owner) = {
        let mut agent = state.lock().unwrap_or_else(|e| e.into_inner());
        let tightens = agent.config.sessions() && !config.sessions()
            || agent.config.projects() && !config.projects()
            || ClientId::ALL.into_iter().any(|client| {
                agent.config.tracks(client) && !config.tracks(client)
                    || agent.config.routes(client) && !config.routes(client)
            });
        if tightens && let Some(run) = &agent.run {
            run.stop.request(How::Exit);
        }
        (std::mem::take(&mut agent.privacy), tightens, agent.policy_stop.clone(), agent.lock.clone())
    };
    let result = privacy.accept(paths, &config, tightens, &stop);
    let terminal = result.is_err_and(|failure| !failure.retryable);
    state.lock().unwrap_or_else(|e| e.into_inner()).privacy = privacy;
    if terminal {
        return Err("could not persist activity privacy settings".into());
    }
    Ok(config)
}

/// The board's view of the agent (`app_state`). The intervals are always there, `null`
/// when not set: with a hub, no interval of a provider means the hub measures it as often
/// as needed, and the board offers that choice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provided {
    pub id: &'static str,
    pub enabled: bool,
    /// The most often it is measured, and where that is set.
    pub interval_s: Option<u64>,
    pub interval_from: Option<&'static str>,
    /// The interval set for all providers, and where.
    pub inherited_s: Option<u64>,
    pub inherited_from: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Last>,
    pub accounts: Vec<AccountLast>,
    pub collector: bool,
    pub latest_status: Option<&'static str>,
}

#[derive(Serialize)]
pub struct Tracked {
    pub id: &'static str,
    pub enabled: bool,
    pub route: bool,
    pub path: Option<String>,
}

pub fn snapshot(shell: &Arc<Shell>) -> (State, Vec<Provided>, Vec<Tracked>, bool) {
    project(&shell.agent())
}

fn project(agent: &Agent) -> (State, Vec<Provided>, Vec<Tracked>, bool) {
    let account_last = agent.account_last.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let last = agent.last.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let providers = Provider::ALL
        .into_iter()
        .map(|p| Provided {
            id: p.id(),
            enabled: agent.config.enabled(p),
            interval_s: agent.config.min_interval_ms(p).map(|ms| ms / 1000),
            interval_from: agent.config.interval_source(p).map(source_id),
            inherited_s: agent.config.global_interval().map(|(ms, _)| ms / 1000),
            inherited_from: agent.config.global_interval().map(|(_, source)| source_id(source)),
            account: agent.config.account_name(p).map(str::to_string),
            client: agent.clients.get(&ClientId::from(p)).cloned().flatten().map(|c| c.display().to_string()),
            last: last.get(&p).cloned(),
            accounts: account_last
                .iter()
                .filter(|((provider, _), _)| *provider == p)
                .map(|(_, last)| last.clone())
                .collect(),
            collector: agent.config.providers.get(&p).is_some_and(|settings| settings.hooks.collect.is_some()),
            latest_status: last.get(&p).map(|last| last.status),
        })
        .collect();
    let clients = ClientId::ALL
        .into_iter()
        .map(|id| Tracked {
            id: id.id(),
            enabled: agent.config.tracks(id),
            route: agent.config.clients.get(id.id()).and_then(|c| c.route).unwrap_or(true),
            path: agent.clients.get(&id).cloned().flatten().map(|p| p.display().to_string()),
        })
        .collect();
    (agent.state.clone(), providers, clients, agent.config.sessions())
}

/// Where an interval is set, as the board names it.
fn source_id(source: IntervalSource) -> &'static str {
    match source {
        IntervalSource::Provider => "provider",
        IntervalSource::File => "file",
        IntervalSource::Env => "env",
    }
}

#[cfg(test)]
thread_local! {
    static PRIVACY_RETRY_PAUSE: std::cell::RefCell<Option<(
        std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>
    )>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_projection_finishes_with_empty_and_populated_account_history() {
        let (send, receive) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || {
            let agent = Agent::new();
            assert!(project(&agent).1.iter().all(|p| p.accounts.is_empty() && p.latest_status.is_none()));
            let account = AccountRef::Supplier { account: "a".repeat(24) };
            record_collection(
                &agent.last,
                &agent.account_last,
                &CollectionResult {
                    version: 1,
                    provider: Provider::Codex,
                    account: Some(account),
                    attempt_id: "fixture".into(),
                    stage: "measure",
                    completed_at: 20,
                    outcome: CollectionOutcome::NoNewData,
                },
            );
            let (_, providers, _, _) = project(&agent);
            let codex = providers.iter().find(|p| p.id == "codex").unwrap();
            assert_eq!(codex.latest_status, Some("no_new_data"));
            assert_eq!(codex.accounts.len(), 1);
            assert_eq!(codex.accounts[0].observed_at, None);
            assert!(agent.account_last.try_lock().is_ok(), "projection releases its history guard");
            send.send(()).unwrap();
        });
        receive.recv_timeout(Duration::from_secs(2)).expect("app_state projection must not deadlock");
        worker.join().unwrap();
    }

    #[test]
    fn intervals_not_set_go_to_the_board_as_null() {
        let provided = Provided {
            id: "codex",
            enabled: true,
            interval_s: None,
            interval_from: None,
            inherited_s: None,
            inherited_from: None,
            account: None,
            client: None,
            last: None,
            accounts: vec![],
            collector: false,
            latest_status: None,
        };
        let json = serde_json::to_value(&provided).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "codex", "enabled": true, "intervalS": null, "intervalFrom": null, "inheritedS": null, "inheritedFrom": null, "accounts": [], "collector": false, "latestStatus": null})
        );
        let set =
            Provided { interval_s: Some(300), interval_from: Some(source_id(IntervalSource::Provider)), ..provided };
        assert_eq!(serde_json::to_value(&set).unwrap()["intervalFrom"], "provider");
    }

    #[test]
    fn a_slow_stopped_worker_keeps_ownership_until_it_finishes() {
        use quotum_core::model::{ErrorKind, Failure, Machine};
        use quotum_core::sink::Sink;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let dir = std::env::temp_dir().join(format!("quotum-spool-handover-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let spool = dir.join("app-spool.jsonl");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let hub = Hub { url: format!("http://{}", listener.local_addr().unwrap()), token: "qt_m_test".into() };
        let identity =
            Machine { id: "0123456789abcdef".into(), name: "test".into(), os: "linux".into(), arch: "x86_64".into() };
        let (release, held) = std::sync::mpsc::channel();
        let (entered, request) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap();
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(5)).unwrap();
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let mut sink = HubSink::new(&hub, identity.clone(), spool.clone(), Box::new(|_| {}));
        let mut agent = Agent::new();
        let stop = Stop::new();
        let observed = stop.clone();
        agent.run = Some(Run {
            stop,
            thread: thread::spawn(move || {
                sink.deliver(&Err(Failure::new(Provider::Codex, ErrorKind::Failed, "before restart")));
                None
            }),
            generation: 1,
        });
        let agent = Mutex::new(agent);
        request.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(!finish_run(&agent, Duration::ZERO));
        assert!(observed.requested());
        assert!(agent.lock().unwrap().run.is_some(), "the spool is still owned by the old worker");
        release.send(()).unwrap();
        assert!(finish_run(&agent, Duration::from_secs(2)));
        assert!(agent.lock().unwrap().run.is_none());
        server.join().unwrap();
        // The successor opens the queue only after the old delivery persisted it.
        let mut next = HubSink::new(&hub, identity, spool.clone(), Box::new(|_| {}));
        next.deliver(&Err(Failure::new(Provider::Codex, ErrorKind::Failed, "after restart")));
        let persisted = fs::read_to_string(&spool).unwrap();
        assert!(persisted.contains("before restart") && persisted.contains("after restart"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_patches_are_both_saved_and_published_before_restart() {
        let dir = std::env::temp_dir().join(format!("quotum-accepted-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let state = Mutex::new(Agent::new());
        let writes = Mutex::new(());
        let first: Patch = serde_json::from_str(r#"{"sessions":false}"#).unwrap();
        let second: Patch = serde_json::from_str(r#"{"providers":{"antigravity":{"account":"changed"}}}"#).unwrap();
        let ready = std::sync::Barrier::new(2);
        thread::scope(|scope| {
            for patch in [&first, &second] {
                let (paths, state, writes, ready) = (&paths, &state, &writes, &ready);
                scope.spawn(move || {
                    ready.wait();
                    accept_settings(paths, state, writes, patch).unwrap();
                });
            }
        });
        let agent = state.lock().unwrap();
        assert_eq!(agent.saves, 2);
        assert!(!agent.config.sessions());
        assert_eq!(agent.config.account_name(Provider::Antigravity), Some("changed"));
        let saved = Config::load(&paths.config).unwrap();
        assert!(!saved.sessions());
        assert_eq!(saved.account_name(Provider::Antigravity), Some("changed"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tracking_opt_out_persists_without_a_runner_and_survives_a_debounced_reenable() {
        let dir = std::env::temp_dir().join(format!("quotum-settings-privacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let text = "[providers.claude]\nenabled=false\n[providers.codex]\nenabled=false\n[providers.antigravity]\nenabled=false\n";
        let config = Config::parse(text).unwrap();
        fs::write(&paths.config, text).unwrap();
        let state = Mutex::new(Agent::new());
        state.lock().unwrap().config = config.clone();
        let before = quotum_core::observed::update_privacy(&paths, &config).unwrap();
        let writes = Mutex::new(());
        let off: Patch = serde_json::from_str(r#"{"sessions":false}"#).unwrap();
        let on: Patch = serde_json::from_str(r#"{"sessions":true}"#).unwrap();
        accept_settings(&paths, &state, &writes, &off).unwrap();
        assert!(state.lock().unwrap().run.is_none());
        let policy = || {
            serde_json::from_slice::<serde_json::Value>(&fs::read(paths.state.join("activity-policy.json")).unwrap())
                .unwrap()
        };
        let saved = policy();
        assert_eq!(saved["enabled"], false);
        let disabled = saved["revision"].as_str().unwrap().to_string();
        assert_ne!(disabled, before);
        accept_settings(&paths, &state, &writes, &on).unwrap();
        let saved = policy();
        assert_eq!(saved["enabled"], true);
        let resumed = saved["revision"].as_str().unwrap();
        assert_eq!(resumed, disabled);
        assert_eq!(state.lock().unwrap().saves, 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn externally_loaded_opt_out_persists_before_an_idle_run_can_be_skipped() {
        let dir = std::env::temp_dir().join(format!("quotum-external-privacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let providers = "[providers.claude]\nenabled=false\n[providers.codex]\nenabled=false\n[providers.antigravity]\nenabled=false\n";
        fs::write(&paths.config, providers).unwrap();
        let state = Mutex::new(Agent::new());
        let initial = load_settings(&paths, &state).unwrap();
        state.lock().unwrap().config = initial;
        let policy = || {
            serde_json::from_slice::<serde_json::Value>(&fs::read(paths.state.join("activity-policy.json")).unwrap())
                .unwrap()
        };
        let before = policy()["revision"].clone();
        // The watcher reads these external file edits; no native settings save or Runner is involved.
        fs::write(&paths.config, format!("sessions=false\n{providers}")).unwrap();
        let disabled = load_settings(&paths, &state).unwrap();
        assert!(!disabled.sessions());
        assert!(!Provider::ALL.into_iter().any(|p| disabled.enabled(p)));
        let saved = policy();
        assert_eq!(saved["enabled"], false);
        assert_ne!(saved["revision"], before);
        state.lock().unwrap().config = disabled;
        fs::write(&paths.config, providers).unwrap();
        load_settings(&paths, &state).unwrap();
        assert_eq!(policy()["enabled"], true);
        assert_eq!(policy()["revision"], saved["revision"]);
        assert!(state.lock().unwrap().run.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn waiting_for_activity_privacy_does_not_hold_the_published_agent_state() {
        let dir = std::env::temp_dir().join(format!("quotum-settings-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { config: dir.join("config.toml"), state: dir.clone(), work: dir.join("work") };
        quotum_core::observed::update_privacy(&paths, &Config::default()).unwrap();
        let held = quotum_core::config::lock_file(&dir.join("activity-policy.lock")).unwrap();
        let stop = Stop::new();
        let mut agent = Agent::new();
        agent.run = Some(Run { stop: stop.clone(), thread: thread::spawn(|| None), generation: 1 });
        let state = Arc::new(Mutex::new(agent));
        let other = state.clone();
        let writing_paths = paths.clone();
        let saving = thread::spawn(move || {
            let patch: Patch = serde_json::from_str(r#"{"sessions":false}"#).unwrap();
            assert!(accept_settings(&writing_paths, &other, &Mutex::new(()), &patch).is_err());
        });
        let until = Instant::now() + Duration::from_secs(2);
        while !stop.requested() {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        let responsive = loop {
            if state.try_lock().is_ok() {
                break true;
            }
            if Instant::now() >= until {
                break false;
            }
            thread::sleep(Duration::from_millis(5));
        };
        while !saving.is_finished() {
            assert!(Instant::now() < until, "a held policy lock cannot block a settings save");
            thread::sleep(Duration::from_millis(5));
        }
        saving.join().unwrap();
        drop(held);
        assert!(responsive, "an outstanding HTTP request must not block app_state readers");
        assert!(state.lock().unwrap().privacy.pending());
        let until = Instant::now() + Duration::from_secs(3);
        while !retry_privacy(&paths, &state, &Mutex::new(())) {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!state.lock().unwrap().privacy.pending());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unavailable_privacy_storage_retains_valid_config_and_recovers_without_a_file_edit_or_runner() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("quotum-app-policy-repair-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = Paths { config: root.join("config.toml"), state: root.clone(), work: root.join("work") };
        let text = "sessions=false\n[providers.claude]\nenabled=false\n[providers.codex]\nenabled=false\n[providers.antigravity]\nenabled=false\n";
        fs::write(&paths.config, text).unwrap();
        // Opening the existing publication temporary file fails, without corrupting policy evidence.
        let temporary = root.join("activity-policy.tmp");
        fs::write(&temporary, "").unwrap();
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o0)).unwrap();
        let state = Mutex::new(Agent::new());
        let config = load_settings(&paths, &state).unwrap();
        assert!(!config.sessions() && !Provider::ALL.into_iter().any(|p| config.enabled(p)));
        state.lock().unwrap().config = config;
        assert!(state.lock().unwrap().privacy.pending());
        let seen = stat(&paths);
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        while !retry_privacy(&paths, &state, &Mutex::new(())) {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(stat(&paths), seen);
        assert!(state.lock().unwrap().run.is_none());
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("activity-policy.json")).unwrap()).unwrap();
        assert_eq!(saved["enabled"], false);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_pending_policy_attempt_cannot_outlive_its_machine_ownership() {
        let root = std::env::temp_dir().join(format!("quotum-policy-handoff-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let paths = Paths { config: root.join("config.toml"), state: root.clone(), work: root.join("work") };
        paths.ensure().unwrap();
        let text = "[providers.claude]\nenabled=false\n[providers.codex]\nenabled=false\n[providers.antigravity]\nenabled=false\n";
        fs::write(&paths.config, text).unwrap();
        let config = Config::load(&paths.config).unwrap();
        let original = quotum_core::observed::update_privacy(&paths, &config).unwrap();
        let mut agent = Agent::new();
        agent.hold(paths.lock_run(Holder::App).unwrap());
        agent.config = config;
        let state = Arc::new(Mutex::new(agent));
        let writes = Arc::new(Mutex::new(()));
        let held = quotum_core::config::lock_file(&root.join("activity-policy.lock")).unwrap();
        for on in [false, true] {
            let patch: Patch = serde_json::from_value(serde_json::json!({"sessions":on})).unwrap();
            assert!(accept_settings(&paths, &state, &writes, &patch).is_err());
        }
        // begin() clears restart_pending even when its policy attempt is still unavailable.
        let config = load_settings(&paths, &state).unwrap();
        {
            let mut agent = state.lock().unwrap();
            agent.config = config;
            agent.restart_pending = false;
            assert!(agent.privacy.pending());
        }
        drop(held);
        // The normal tick is five seconds later; all three prior failed attempts are due by then.
        thread::sleep(Duration::from_millis(5100));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let state_for_retry = state.clone();
        let writes_for_retry = writes.clone();
        let paths_for_retry = paths.clone();
        let retry = thread::spawn(move || {
            PRIVACY_RETRY_PAUSE.with(|pause| *pause.borrow_mut() = Some((entered_tx, release_rx)));
            retry_privacy(&paths_for_retry, &state_for_retry, &writes_for_retry)
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // This is agent::quit's complete body: finish the run, then release RunLock.
        assert!(finish_run(&state, Duration::ZERO));
        state.lock().unwrap().release();
        assert!(
            matches!(paths.lock_run(Holder::Cli), Err(LockError::Held(_))),
            "an in-flight policy attempt must keep ownership until it observes cancellation"
        );
        release_tx.send(()).unwrap();
        assert!(!retry.join().unwrap(), "a cancelled attempt cannot publish a policy");
        let successor = paths.lock_run(Holder::Cli).unwrap();
        let config = Config::load(&paths.config).unwrap();
        let successor_revision = quotum_core::observed::update_privacy(&paths, &config).unwrap();
        assert_eq!(successor_revision, original);
        let after_late_retry = quotum_core::observed::update_privacy(&paths, &config).unwrap();
        drop(successor);
        state.lock().unwrap().hold(paths.lock_run(Holder::App).unwrap());
        let off: Patch = serde_json::from_value(serde_json::json!({"sessions":false})).unwrap();
        accept_settings(&paths, &state, &writes, &off).unwrap();
        assert!(!state.lock().unwrap().privacy.pending(), "new ownership has a fresh cancellation token");
        state.lock().unwrap().release();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            after_late_retry, successor_revision,
            "an app retry paused before publication must not rotate the live CLI's original delivery revision after handoff"
        );
    }

    #[test]
    fn quotum_holding_the_machine_is_asked_about_only_in_the_window() {
        assert_eq!(on_held(true, false), OnHeld::TakeOver, "agreed before: without a question");
        assert_eq!(on_held(false, true), OnHeld::Ask);
        assert_eq!(on_held(false, false), OnHeld::Quit, "no window, no question: the app goes");
    }

    #[test]
    fn closing_the_window_while_asked_is_the_answer_no() {
        let held = State::Held { holder: HolderInfo { pid: Some(1), hub: None, yields: true }, error: None };
        assert!(closing_quits(&held, false));
        assert!(!closing_quits(&held, true), "held after agreeing: a failed take-over, retried in the background");
        assert!(!closing_quits(&State::Measuring, false));
    }

    #[test]
    fn closing_during_startup_waits_for_the_takeover_decision() {
        let agent = Arc::new(Mutex::new(Agent::new()));
        let operations = Arc::new(Mutex::new(()));
        let (seen, open_seen) = std::sync::mpsc::channel();
        let (publish, held) = std::sync::mpsc::channel();
        let (result, closed) = std::sync::mpsc::channel();
        let (starting, serial) = (agent.clone(), operations.clone());
        let startup = thread::spawn(move || {
            let _ops = serial.lock().unwrap();
            // Startup has seen a foreground window, but is still reading holder info.
            seen.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(3)).unwrap();
            starting.lock().unwrap().state =
                State::Held { holder: HolderInfo { pid: Some(42), hub: None, yields: true }, error: None };
        });
        open_seen.recv_timeout(Duration::from_secs(3)).unwrap();
        let (closing, serial) = (agent.clone(), operations.clone());
        let closer = thread::spawn(move || {
            result.send(close_requires_exit(&closing, &serial, || false, || false)).unwrap();
        });
        assert!(closed.recv_timeout(Duration::from_millis(50)).is_err(), "no decision from Starting");
        publish.send(()).unwrap();
        assert!(closed.recv_timeout(Duration::from_secs(3)).unwrap(), "the invisible question is declined");
        startup.join().unwrap();
        closer.join().unwrap();
        assert!(!close_requires_exit(&agent, &operations, || true, || false), "a later open stays");
        assert!(!close_requires_exit(&agent, &operations, || false, || true), "consent was already given");
    }

    #[test]
    fn provider_outcome_follows_event_order_in_mixed_batches_with_equal_times() {
        use quotum_core::model::{ErrorKind, Failure, Snapshot};
        for names in [["z", "a"], ["a", "z"]] {
            for no_data_last in [false, true] {
                let agent = Agent::new();
                let make = |name: &str, outcome, completed_at| CollectionResult {
                    version: 1,
                    provider: Provider::Antigravity,
                    account: Some(AccountRef::Declared { account_name: Some(name.into()) }),
                    attempt_id: "same-batch".into(),
                    stage: "measure",
                    completed_at,
                    outcome,
                };
                for name in names {
                    record_collection(
                        &agent.last,
                        &agent.account_last,
                        &make(
                            name,
                            CollectionOutcome::Observed(Snapshot {
                                provider: Provider::Antigravity,
                                account: None,
                                account_name: Some(name.into()),
                                plan: None,
                                observed_at: 5,
                                via: "fixture".into(),
                                client: None,
                                stale_after_ms: 120000,
                                windows: vec![],
                                resets: None,
                                resource_status: None,
                                balances: None,
                            }),
                            8,
                        ),
                    );
                }
                for (i, name) in names.into_iter().enumerate() {
                    let no_data = (i == 1) == no_data_last;
                    let outcome = if no_data {
                        CollectionOutcome::NoNewData
                    } else {
                        CollectionOutcome::Failed(Failure::new(Provider::Antigravity, ErrorKind::Timeout, ""))
                    };
                    record_collection(&agent.last, &agent.account_last, &make(name, outcome, 10));
                }
                let (_, providers, _, _) = project(&agent);
                let provided = providers.iter().find(|p| p.id == "antigravity").unwrap();
                let expected = if no_data_last { "no_new_data" } else { "failed" };
                assert_eq!(provided.latest_status, Some(expected), "names={names:?}");
                assert_eq!(provided.last.as_ref().unwrap().ok, no_data_last);
                assert_eq!(provided.last.as_ref().unwrap().at, 10);
                assert_eq!(provided.accounts.len(), 2);
                assert!(provided.accounts.iter().all(|a| a.observed_at == Some(5)));
                let json = serde_json::to_value(provided).unwrap();
                assert_eq!(json["latestStatus"], expected);
                assert!(json["last"].get("status").is_none(), "Last wire shape stays narrow");
                assert_eq!(provided.accounts[0].account, Some(AccountRef::Declared { account_name: Some("a".into()) }));
                assert_eq!(provided.accounts[1].account, Some(AccountRef::Declared { account_name: Some("z".into()) }));
            }
        }
    }

    #[test]
    fn account_outcomes_retain_observation_dates_and_sibling_failures() {
        let last = AccountLasts::default();
        let make = |account: &str, outcome| CollectionResult {
            version: 1,
            provider: Provider::Codex,
            account: Some(AccountRef::Supplier { account: account.into() }),
            attempt_id: "fixture".into(),
            stage: "measure",
            completed_at: 10,
            outcome,
        };
        record_account(
            &last,
            &make(
                "b",
                CollectionOutcome::Failed(quotum_core::model::Failure::new(
                    Provider::Codex,
                    quotum_core::model::ErrorKind::Timeout,
                    "",
                )),
            ),
        );
        let snapshot = quotum_core::model::Snapshot {
            provider: Provider::Codex,
            account: Some("a".into()),
            account_name: None,
            plan: None,
            observed_at: 5,
            via: "fixture".into(),
            client: None,
            stale_after_ms: 120000,
            windows: vec![],
            resets: None,
            resource_status: None,
            balances: None,
        };
        record_account(&last, &make("a", CollectionOutcome::Observed(snapshot.clone())));
        record_account(&last, &make("a", CollectionOutcome::NoNewData));
        let states = last.lock().unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[&(Provider::Codex, Some(AccountRef::Supplier { account: "a".into() }))].observed_at, Some(5));
        assert_eq!(states[&(Provider::Codex, Some(AccountRef::Supplier { account: "b".into() }))].status, "failed");
    }

    #[test]
    fn the_board_reads_the_state_in_its_own_words() {
        let held = State::Held {
            holder: HolderInfo { pid: Some(42), hub: Some("https://q.example".into()), yields: true },
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            serde_json::json!({"state": "held", "holder": {"pid": 42, "hub": "https://q.example", "yields": true}})
        );
        let failed = State::Failed { cause: Cause::Config, error: "x".into() };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({"state": "failed", "cause": "config", "error": "x"})
        );
        assert_eq!(serde_json::to_value(State::TakingOver).unwrap(), serde_json::json!({"state": "taking_over"}));
        let last = Last {
            status: "failed",
            at: 1,
            ok: false,
            error: Some(quotum_core::model::ErrorKind::NotLoggedIn),
            detail: None,
        };
        assert_eq!(
            serde_json::to_value(&last).unwrap(),
            serde_json::json!({"at": 1, "ok": false, "error": "not_logged_in"})
        );
    }
}
