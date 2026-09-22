//! Drives the adapters: once for a status check, or continuously on the schedule.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};

use crate::config::{Config, Paths, home, jitter};
use crate::model::{Millis, Outcome, Provider, now_ms};
use crate::providers::{Adapter, Context, adapter, last_activity};
use crate::schedule::Schedule;
use crate::sink::Sink;

/// A single measurement may take this long before the client is killed.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
/// The loop wakes at least this often, to notice a stop request or a jump of the clock.
const TICK: Duration = Duration::from_secs(5);

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

    /// Measures on the schedule until `stop` is set. `each` sees every outcome and when
    /// that provider is measured next.
    pub fn run(&mut self, sink: &mut dyn Sink, stop: &AtomicBool, mut each: impl FnMut(&Outcome, Millis)) {
        let entries: Vec<(Provider, u64)> =
            self.adapters.iter().map(|a| (a.provider(), self.config.interval_ms(a.provider()))).collect();
        let mut schedule = Schedule::new(&entries, now_ms(), self.config.eco());
        let activity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.activity_paths(&self.home)).collect();
        let mut seen: Vec<Option<SystemTime>> = vec![None; self.adapters.len()];

        while !stop.load(Ordering::Relaxed) {
            let Some((index, due)) = schedule.next() else { return };
            let wait = due - now_ms();
            if wait > 0 {
                thread::sleep(Duration::from_millis(wait as u64).min(TICK));
                continue;
            }
            let before = seen[index];
            let active = before.is_some() && last_activity(&activity_paths[index]) > before;
            let mut outcome = self.measure(index);
            // Taken after the measurement, so the client's own writes do not count as use.
            seen[index] = last_activity(&activity_paths[index]).or(Some(SystemTime::UNIX_EPOCH));

            let now = now_ms();
            let next = schedule.complete(index, now, &outcome, active, jitter());
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = schedule.stale_after_ms(index, now);
            }
            sink.deliver(&outcome);
            each(&outcome, next);
        }
    }
}
