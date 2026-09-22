//! Drives the adapters: once for a status check, or continuously on the schedule.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime};

use crate::config::{Config, Paths, home, jitter};
use crate::model::{Millis, Outcome, Provider, now_ms};
use crate::providers::{Adapter, Context, adapter, last_activity};
use crate::schedule::Schedule;
use crate::sink::Sink;
use crate::stop;

/// A single measurement may take this long before the client is killed.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
/// The loop wakes at least this often, to notice a stop request or a jump of the clock.
const TICK: Duration = Duration::from_secs(1);

pub struct Runner {
    config: Config,
    paths: Paths,
    home: PathBuf,
    adapters: Vec<Box<dyn Adapter>>,
}

impl Runner {
    /// Adapters for the enabled providers, cheapest first: Codex, Claude, Antigravity.
    pub fn new(config: Config, paths: Paths, only: &[Provider]) -> Runner {
        let order = [Provider::Codex, Provider::Claude, Provider::Antigravity];
        let adapters = order
            .into_iter()
            .filter(|p| config.enabled(*p) && (only.is_empty() || only.contains(p)))
            .map(adapter)
            .collect();
        Runner { config, paths, home: home(), adapters }
    }

    pub fn providers(&self) -> Vec<Provider> {
        self.adapters.iter().map(|a| a.provider()).collect()
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

    /// Measures every provider once, one after another, reporting each as it finishes.
    pub fn measure_all(&mut self, mut each: impl FnMut(&Outcome)) {
        for index in 0..self.adapters.len() {
            let mut outcome = self.measure(index);
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = self.config.interval_ms(snapshot.provider);
            }
            each(&outcome);
        }
    }

    /// Measures on the schedule until a stop is requested or the hub refuses this device
    /// for good (then its reason is returned). Before each measurement the device checks
    /// in with the hub (when there is one): if another device measures the same
    /// subscription, this one only waits.
    pub fn run(&mut self, sink: &mut dyn Sink, mut each: impl FnMut(Event)) -> Option<String> {
        let intervals: Vec<u64> = self.adapters.iter().map(|a| self.config.interval_ms(a.provider())).collect();
        let mut schedule = Schedule::new(&intervals, now_ms(), self.config.eco());
        let activity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.activity_paths(&self.home)).collect();
        let identity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.identity_paths(&self.home)).collect();
        let mut seen: Vec<Option<SystemTime>> = vec![None; self.adapters.len()];
        // The account each provider last reported, and the state of its sign-in files then.
        let mut accounts: Vec<Option<(Option<String>, Option<SystemTime>)>> = vec![None; self.adapters.len()];

        while !stop::requested() {
            if let Some(reason) = sink.refused() {
                return Some(reason.to_string());
            }
            let (index, due) = schedule.next()?;
            let wait = due - now_ms();
            if wait > 0 {
                thread::sleep(Duration::from_millis(wait as u64).min(TICK));
                continue;
            }
            let adapter = &self.adapters[index];
            let provider = adapter.provider();
            let before = seen[index];
            let latest = last_activity(&activity_paths[index]);
            let active = before.is_some() && latest > before;
            seen[index] = latest.or(Some(SystemTime::UNIX_EPOCH));

            // Which subscription this is, if known without starting the client.
            let signed_in = last_activity(&identity_paths[index]);
            let account = if !adapter.identifies_account() {
                Some(None)
            } else if let Some(local) = adapter.local_account(&self.home) {
                Some(Some(local))
            } else {
                accounts[index].clone().filter(|(_, at)| *at == signed_in).map(|(account, _)| account)
            };
            if let Some(account) = account {
                let name = self.config.account_name(provider);
                if let Some(until) =
                    sink.checkin(provider, account.as_deref(), name.filter(|_| account.is_none()), active)
                {
                    let next = schedule.postpone(index, now_ms(), until);
                    each(Event::Waiting(provider, next));
                    continue;
                }
            }

            let mut outcome = self.measure(index);
            if stop::requested() {
                break;
            }
            // Taken after the measurement, so the client's own writes do not count as use.
            seen[index] = last_activity(&activity_paths[index]).or(Some(SystemTime::UNIX_EPOCH));
            if let Ok(snapshot) = &outcome {
                accounts[index] = Some((snapshot.account.clone(), signed_in));
            }

            let now = now_ms();
            let next = schedule.complete(index, now, &outcome, active, jitter());
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = schedule.stale_after_ms(index, now);
            }
            sink.deliver(&outcome);
            each(Event::Measured(&outcome, next));
        }
        None
    }
}

/// What happened to one scheduled slot.
pub enum Event<'a> {
    /// Measured (or failed); the next run is due at the given time.
    Measured(&'a Outcome, Millis),
    /// Another device measures this subscription; ask again at the given time.
    Waiting(Provider, Millis),
}
