//! When to measure what. Clients run strictly one at a time; each provider has its
//! own interval (at least a minute), and providers are spread evenly across it so
//! their starts never pile up. Pure logic: the caller supplies time and randomness.

use crate::model::{ErrorKind, Millis, Outcome, STALE_LIMIT_MS};

/// Claude Code caches its answer for a minute; nothing changes faster than that.
pub const MIN_INTERVAL_MS: u64 = 60_000;
pub const DEFAULT_INTERVAL_MS: u64 = 120_000;
/// Eco mode never stretches an interval beyond this.
pub const ECO_CAP_MS: u64 = 15 * 60_000;
/// Measure this long after a known reset instead of long after it.
const RESET_GRACE_MS: u64 = 30_000;
/// Share of an interval used for random jitter, so machines do not synchronize.
const JITTER: f64 = 0.1;

#[derive(Clone, Debug)]
struct Slot {
    base_ms: u64,
    due: Millis,
    /// Current multiple of the base interval (eco mode doubles it while nothing happens).
    stretch: u64,
    failures: u32,
    /// Share of the interval this slot is offset by; applied on the first run and after sleep.
    phase: f64,
    phased: bool,
    last: Option<Vec<(String, i64)>>,
}

impl Slot {
    /// The base interval times the current stretch, never beyond the eco cap.
    fn interval(&self) -> u64 {
        (self.base_ms * self.stretch).min(ECO_CAP_MS.max(self.base_ms))
    }
}

#[derive(Clone, Debug)]
pub struct Schedule {
    slots: Vec<Slot>,
    eco: bool,
}

impl Schedule {
    /// All providers are measured right away, one after another; afterwards each keeps
    /// its own rhythm, offset by an equal share of its interval.
    /// One slot per interval, in the order the runner keeps its providers.
    pub fn new(intervals: &[u64], now: Millis, eco: bool) -> Schedule {
        let count = intervals.len().max(1) as f64;
        let slots = intervals
            .iter()
            .enumerate()
            .map(|(i, &interval)| Slot {
                base_ms: interval.max(MIN_INTERVAL_MS),
                due: now,
                stretch: 1,
                failures: 0,
                phase: i as f64 / count,
                phased: false,
                last: None,
            })
            .collect();
        Schedule { slots, eco }
    }

    /// The slot to run next and when; ties go to the earlier-listed provider.
    pub fn next(&self) -> Option<(usize, Millis)> {
        self.slots.iter().enumerate().min_by_key(|(i, s)| (s.due, *i)).map(|(i, s)| (i, s.due))
    }

    /// Records a finished measurement and plans the next one of that provider.
    /// `activity` tells whether the agent was used on this machine since the last run;
    /// `jitter` is a random number in [-1, 1].
    pub fn complete(&mut self, index: usize, now: Millis, outcome: &Outcome, activity: bool, jitter: f64) -> Millis {
        let eco = self.eco;
        let slot = &mut self.slots[index];
        let overslept = now - slot.due > slot.interval() as i64;
        if overslept {
            // After sleep or suspend: start over, so providers spread out again.
            slot.phased = false;
            slot.stretch = 1;
        }

        let delay = match outcome {
            Err(failure) => {
                slot.failures += 1;
                slot.stretch = 1;
                match failure.error {
                    ErrorKind::NotInstalled => 30 * 60_000,
                    ErrorKind::NotLoggedIn | ErrorKind::Unsupported => ECO_CAP_MS,
                    _ => (slot.base_ms << (slot.failures - 1).min(4)).min(ECO_CAP_MS.max(slot.base_ms)),
                }
            }
            Ok(snapshot) => {
                slot.failures = 0;
                // Rolling windows move their reset time with the clock, so only usage counts as change.
                let signature: Vec<(String, i64)> =
                    snapshot.windows.iter().map(|w| (w.id.clone(), (w.used_percent * 100.0) as i64)).collect();
                let changed = slot.last.as_ref() != Some(&signature);
                slot.last = Some(signature);
                slot.stretch = if eco && !changed && !activity { (slot.stretch * 2).min(16) } else { 1 };

                let interval = slot.interval();
                let mut delay = (interval as f64 * (1.0 + JITTER * jitter.clamp(-1.0, 1.0))) as u64;
                if !slot.phased {
                    delay += (slot.base_ms as f64 * slot.phase) as u64;
                }
                let reset = snapshot.windows.iter().filter_map(|w| w.resets_at).filter(|&r| r > now).min();
                if let Some(reset) = reset {
                    let after_reset = (reset - now) as u64 + RESET_GRACE_MS;
                    delay = delay.min(after_reset.max(MIN_INTERVAL_MS));
                }
                delay
            }
        };
        slot.phased = true;
        slot.due = now + delay.max(MIN_INTERVAL_MS) as i64;
        slot.due
    }

    /// Another device measures this provider's subscription: ask again at `until`
    /// (kept between 30 s and the eco cap from now), without measuring.
    pub fn postpone(&mut self, index: usize, now: Millis, until: Millis) -> Millis {
        let slot = &mut self.slots[index];
        slot.phased = true;
        slot.due = until.clamp(now + 30_000, now + ECO_CAP_MS as i64);
        slot.due
    }

    /// Moves every due time by `ms`, after the wall clock jumped by as much.
    pub fn shift(&mut self, ms: i64) {
        for slot in &mut self.slots {
            slot.due += ms;
        }
    }

    /// How long a measurement taken now stays representative: until the next one is due,
    /// with room for a slow client, but never beyond what a hub takes.
    pub fn stale_after_ms(&self, index: usize, now: Millis) -> u64 {
        let until_next = (self.slots[index].due - now).max(0) as u64;
        (until_next + until_next / 5 + 60_000).min(STALE_LIMIT_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Failure, Provider, Snapshot, Window};

    const MIN: i64 = 60_000;

    fn measured(used: f64, resets_at: Option<Millis>) -> Outcome {
        Ok(Snapshot {
            provider: Provider::Codex,
            account: None,
            account_name: None,
            plan: None,
            observed_at: 0,
            via: String::new(),
            client: None,
            stale_after_ms: 0,
            windows: vec![Window::new("weekly", Some(10_080), None, used, resets_at)],
            resets: None,
        })
    }

    fn all() -> Vec<u64> {
        vec![120_000; Provider::ALL.len()]
    }

    #[test]
    fn first_round_runs_now_then_providers_spread_across_the_interval() {
        let mut s = Schedule::new(&all(), 0, false);
        let mut dues = Vec::new();
        for _ in 0..3 {
            let (i, due) = s.next().unwrap();
            assert_eq!(due, 0);
            dues.push(s.complete(i, 5_000, &measured(1.0, None), false, 0.0));
        }
        assert_eq!(dues, [125_000, 165_000, 205_000]);
        // The next round keeps the spacing.
        let (i, _) = s.next().unwrap();
        assert_eq!(s.complete(i, 126_000, &measured(1.0, None), false, 0.0), 246_000);
    }

    #[test]
    fn intervals_never_go_below_a_minute() {
        let mut s = Schedule::new(&[10_000], 0, false);
        assert_eq!(s.complete(0, 0, &measured(1.0, None), false, -1.0), 60_000);
    }

    #[test]
    fn eco_mode_stretches_idle_providers_and_snaps_back_on_activity() {
        let mut s = Schedule::new(&[120_000], 0, true);
        let mut now = 0;
        let mut gaps = Vec::new();
        for round in 0..6 {
            let activity = round == 5;
            let due = s.complete(0, now, &measured(5.0, None), activity, 0.0);
            gaps.push((due - now) / MIN);
            now = due;
        }
        // 2 min (first value), then unchanged: 4, 8, 15 (cap), 15; activity → back to 2.
        assert_eq!(gaps, [2, 4, 8, 15, 15, 2]);
    }

    #[test]
    fn a_change_resets_the_stretch_and_a_known_reset_pulls_the_next_run_in() {
        let mut s = Schedule::new(&[120_000], 0, true);
        s.complete(0, 0, &measured(5.0, None), false, 0.0);
        s.complete(0, 2 * MIN, &measured(5.0, None), false, 0.0);
        let due = s.complete(0, 6 * MIN, &measured(6.0, None), false, 0.0);
        assert_eq!(due - 6 * MIN, 2 * MIN);
        // Idle and stretched to 15 minutes, but the window resets in 3.
        let mut s = Schedule::new(&[900_000], 0, false);
        let due = s.complete(0, 0, &measured(5.0, Some(3 * MIN)), false, 0.0);
        assert_eq!(due, 3 * MIN + 30_000);
    }

    #[test]
    fn failures_back_off_by_kind() {
        let mut s = Schedule::new(&[120_000], 0, false);
        let fail = |kind| Err(Failure::new(Provider::Antigravity, kind, ""));
        assert_eq!(s.complete(0, 0, &fail(ErrorKind::NotInstalled), false, 0.0), 30 * MIN);
        assert_eq!(s.complete(0, 30 * MIN, &fail(ErrorKind::Timeout), false, 0.0) - 30 * MIN, 4 * MIN);
        assert_eq!(s.complete(0, 34 * MIN, &fail(ErrorKind::Timeout), false, 0.0) - 34 * MIN, 8 * MIN);
        assert_eq!(s.complete(0, 42 * MIN, &measured(1.0, None), false, 0.0) - 42 * MIN, 2 * MIN);
    }

    #[test]
    fn waiting_for_another_device_is_bounded() {
        let mut s = Schedule::new(&all(), 0, true);
        assert_eq!(s.postpone(0, 0, 5 * MIN), 5 * MIN);
        assert_eq!(s.postpone(0, 0, 1_000), 30_000, "never a busy loop");
        assert_eq!(s.postpone(0, 0, 60 * MIN), 15 * MIN, "never longer than the eco cap");
    }

    #[test]
    fn after_a_long_sleep_providers_spread_out_again() {
        let mut s = Schedule::new(&all(), 0, false);
        for _ in 0..3 {
            let (i, _) = s.next().unwrap();
            s.complete(i, 0, &measured(1.0, None), false, 0.0);
        }
        // The machine slept for an hour; everything is overdue.
        let wake = 60 * MIN;
        let dues: Vec<_> = (0..3).map(|i| s.complete(i, wake, &measured(1.0, None), false, 0.0) - wake).collect();
        assert_eq!(dues, [120_000, 160_000, 200_000]);
        assert_eq!(s.stale_after_ms(0, wake), 120_000 + 24_000 + 60_000);
    }

    #[test]
    fn a_day_long_interval_stays_within_what_a_hub_takes() {
        let day = 24 * 60 * MIN;
        let mut s = Schedule::new(&[day as u64], 0, false);
        s.complete(0, 0, &measured(1.0, None), false, 1.0);
        assert_eq!(s.stale_after_ms(0, 0), STALE_LIMIT_MS);
    }

    #[test]
    fn a_clock_set_back_moves_every_due_time_with_it() {
        let mut s = Schedule::new(&all(), 0, false);
        for _ in 0..3 {
            let (i, _) = s.next().unwrap();
            s.complete(i, 0, &measured(1.0, None), false, 0.0);
        }
        s.shift(-60 * MIN);
        assert_eq!(s.next(), Some((0, 120_000 - 60 * MIN)));
    }
}
