//! Extra captures are paced; judgement captures use the actual bounded CPU horizon.

const GRID: u64 = 15_000;
const HORIZON: u64 = 300_000;
const STALE: u64 = HORIZON + GRID;

#[derive(Clone, Copy, Default)]
struct Bucket {
    expiry: u64,
    spent: f64,
}

pub(crate) struct Cadence {
    pub next: u64,
    pub judgement: u64,
    full_due: u64,
    allowance: f64,
    balance: f64,
    at: u64,
    buckets: [Bucket; 21],
    estimate: f64,
    ewma: f64,
    recent: [f64; 4],
    recent_index: usize,
    last_capture: Option<u64>,
    idle_since: Option<u64>,
    origin: u64,
    first: bool,
    slots: u64,
    planned: bool,
    interrupted_deadline: Option<u64>,
    recovery_price: f64,
    last_recovery: Option<u64>,
}

impl Cadence {
    pub fn pressure(contributors: usize, roots: usize) -> bool {
        // Each root also needs its own classifier, context and durable state.
        contributors >= 256 || roots >= 128
    }

    pub fn new() -> Self {
        Self {
            next: 0,
            judgement: GRID,
            full_due: 0,
            allowance: 0.004,
            balance: 0.0,
            at: 0,
            buckets: [Bucket::default(); 21],
            estimate: 0.0,
            ewma: 0.0,
            recent: [0.0; 4],
            recent_index: 0,
            last_capture: None,
            idle_since: None,
            origin: 0,
            first: true,
            slots: 8,
            planned: false,
            interrupted_deadline: None,
            recovery_price: 0.0,
            last_recovery: None,
        }
    }

    fn balance_at(&self, at: u64) -> f64 {
        (self.balance + at.saturating_sub(self.at) as f64).min(HORIZON as f64)
    }

    fn accrue(&mut self, now: u64) {
        self.balance = self.balance_at(now);
        self.at = self.at.max(now);
    }

    fn spent_at(&self, at: u64) -> f64 {
        self.buckets.iter().filter(|b| b.expiry > at).map(|b| b.spent).sum()
    }

    fn stale(&self, at: u64) -> bool {
        self.last_capture.is_none_or(|last| at.saturating_sub(last) >= STALE)
    }

    fn charge(&mut self, cost: f64) {
        self.balance -= cost;
        // The origin is the worker's clock, independent of evidence/grid resets.
        let index = self.at / GRID;
        let expiry = (index + 1) * GRID + HORIZON;
        let bucket = &mut self.buckets[(index % 21) as usize];
        if bucket.expiry != expiry {
            debug_assert!(bucket.expiry <= self.at);
            *bucket = Bucket { expiry, spent: 0.0 };
        }
        bucket.spent += cost;
        self.planned = false;
    }

    fn affordable_judgement(&self, at: u64) -> bool {
        let spent = self.spent_at(at);
        if self.stale(at) {
            self.balance_at(at) >= 0.0 && spent < HORIZON as f64
        } else {
            spent + self.estimate <= HORIZON as f64
        }
    }

    fn grid_at_or_after(&self, at: u64) -> u64 {
        self.origin + at.saturating_sub(self.origin).div_ceil(GRID) * GRID
    }

    pub fn due(&mut self, now: u64) -> u64 {
        self.accrue(now);
        if self.planned {
            // Keep an admitted deadline, including when the OS wakes us late.
            return self.next;
        }
        let full = self.full_due;
        if !self.first && full == self.judgement && self.next < full {
            let base = full - GRID;
            for slot in 1..self.slots {
                let candidate = base + slot * GRID / self.slots;
                let at = candidate.max(self.at);
                if candidate >= self.next
                    && self.balance_at(at) >= self.estimate
                    && self.spent_at(at) + 2.0 * self.estimate <= HORIZON as f64
                {
                    self.next = candidate;
                    self.planned = true;
                    return candidate;
                }
            }
        }
        self.next = if self.affordable_judgement(full.max(self.at)) {
            full
        } else {
            // Only expiry or a repaid stale calibration can change a denied full look.
            // Future projection never removes actual charges or resets the predictor.
            let repaid = self.at.saturating_add((-self.balance).max(0.0).ceil() as u64);
            let calibration = self.last_capture.map_or(self.at, |last| last.saturating_add(STALE)).max(repaid);
            self.buckets
                .iter()
                .map(|b| b.expiry)
                .chain(std::iter::once(calibration))
                .map(|at| self.grid_at_or_after(at.max(self.at).max(full)))
                .filter(|&at| self.affordable_judgement(at))
                .min()
                .expect("repaid and expired spending permits a new calibration")
        };
        if self.next >= full {
            self.full_due = self.next;
        }
        self.planned = true;
        self.next
    }

    pub fn completed(&mut self, now: u64, cost_ms: f64, empty: bool, idle: bool, pressure: bool) {
        self.accrue(now);
        self.interrupted_deadline = None;
        self.allowance = if empty {
            0.0008
        } else if pressure {
            0.009
        } else {
            0.004
        };
        let cost = cost_ms / self.allowance;
        if self.stale(self.at) {
            self.ewma = cost;
            self.recent = [0.0; 4];
            self.recent_index = 0;
        } else {
            self.ewma = self.ewma * 0.875 + cost * 0.125;
        }
        self.recent[self.recent_index] = cost;
        self.recent_index = (self.recent_index + 1) % 4;
        self.estimate = self.ewma.max(self.recent.iter().copied().fold(0.0, f64::max)).max(0.001);
        self.last_capture = Some(self.at);
        self.charge(cost);
        if idle {
            self.idle_since.get_or_insert(self.at);
        } else {
            self.idle_since = None;
        }
        let target = if empty {
            1
        } else if self.idle_since.is_some_and(|at| self.at.saturating_sub(at) >= 30_000) {
            3
        } else {
            8
        };
        self.slots = target.min((GRID as f64 / self.estimate).floor() as u64).max(1);
        let base = self.origin + (self.at - self.origin) / GRID * GRID;
        self.next = (1..=self.slots)
            .map(|slot| base + slot * GRID / self.slots)
            .find(|&at| at > self.at)
            .unwrap_or(base + GRID);
    }

    pub fn judged(&mut self, now: u64) {
        self.accrue(now);
        self.judgement = self.origin + ((self.at - self.origin) / GRID + 1) * GRID;
        self.full_due = self.judgement;
        self.first = false;
    }

    pub fn should_judge(&self, now: u64) -> bool {
        self.first || now.max(self.at) >= self.judgement
    }

    pub fn deadline(&self) -> u64 {
        self.interrupted_deadline.map_or(self.next, |at| at.min(self.next))
    }

    pub fn reset_grid(&mut self, now: u64) {
        self.accrue(now);
        self.origin = self.at;
        self.next = self.at;
        self.judgement = self.at + GRID;
        self.full_due = self.at;
        self.first = true;
        self.idle_since = None;
        self.planned = false;
        self.interrupted_deadline = None;
    }

    pub fn control(&mut self, now: u64, cost_ms: f64) {
        self.accrue(now);
        if self.planned && self.next <= self.at {
            // Admission may change after a command, but a missed wakeup still breaks evidence.
            self.interrupted_deadline = Some(self.deadline());
        }
        // Commands spend actual budget, but are not repeated by every future capture.
        self.charge(cost_ms / self.allowance);
    }

    pub fn maintenance(&mut self, now: u64, cost_ms: f64) {
        self.control(now, cost_ms);
        self.recovery_price = (cost_ms / self.allowance).max(self.recovery_price * 0.875);
        self.last_recovery = Some(self.at);
    }

    pub fn recovery_due(&mut self, now: u64) -> u64 {
        self.accrue(now);
        let repaid = self.at.saturating_add((-self.balance).max(0.0).ceil() as u64);
        let affordable = |at: u64| {
            if self.last_recovery.is_none_or(|last| at.saturating_sub(last) >= STALE) {
                self.spent_at(at) < HORIZON as f64
            } else {
                self.spent_at(at) + self.recovery_price <= HORIZON as f64
            }
        };
        if affordable(repaid) {
            return repaid;
        }
        self.buckets
            .iter()
            .map(|bucket| bucket.expiry)
            .chain(self.last_recovery.map(|last| last.saturating_add(STALE)))
            .filter(|&at| at >= repaid && affordable(at))
            .min()
            .expect("repaid and expired maintenance permits calibration")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expensive_reopens_and_failed_captures_share_the_run_ledger_across_generations() {
        let mut cadence = Cadence::new();
        let mut now = 0;
        let mut events = Vec::new();
        for _ in 0..30 {
            now = cadence.recovery_due(now);
            cadence.maintenance(now, 100.0);
            events.push((now, 100.0));
            now = cadence.recovery_due(now);
            cadence.reset_grid(now);
            let due = cadence.due(now);
            now = due.max(now);
            // A failed ordinary append still spends its native scan and journal cost.
            capture(&mut cadence, now, 80, false, false, false);
            now += 80;
            events.push((now, 80.0));
            assert!(moving_cost(&events, now) <= 0.004 * HORIZON as f64);
            assert!(cadence.recovery_due(now) > now, "a new generation cannot erase debt");
        }
    }

    fn capture(c: &mut Cadence, start: u64, cost: u64, empty: bool, idle: bool, pressure: bool) {
        if c.should_judge(start) {
            c.judged(start);
        }
        c.completed(start + cost, cost as f64, empty, idle, pressure);
    }

    fn moving_cost(events: &[(u64, f64)], end: u64) -> f64 {
        events.iter().filter(|&&(at, _)| at <= end && end - at < HORIZON).map(|&(_, cost)| cost).sum()
    }

    #[test]
    fn fast_capture_keeps_a_separate_judgement_deadline_and_idle_empty_targets() {
        let mut c = Cadence::new();
        assert_eq!(c.due(0), 0);
        capture(&mut c, 0, 3, false, false, false);
        assert_eq!(c.due(3), 1875);
        assert_eq!(c.judgement, 15_000);
        capture(&mut c, 1875, 3, false, true, false);
        capture(&mut c, 31_875, 3, false, true, false);
        assert_eq!(c.due(31_878), 35_000);
        capture(&mut c, 35_000, 1, true, true, false);
        assert_eq!(c.due(35_001), 45_000);
        assert_eq!(c.judgement, 45_000);
    }

    #[test]
    fn sudden_pressure_paces_extras_without_postponing_an_affordable_judgement() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 65, false, false, true);
        assert_eq!(c.next, 7500);
        assert_eq!(c.due(65), GRID, "extra slots repay calibration debt");
        assert_eq!(c.due(GRID + 2500), GRID, "an admitted deadline still exposes an OS delay");
        capture(&mut c, GRID, 65, false, false, true);
        assert!(c.due(GRID + 65) > GRID);
    }

    #[test]
    fn one_time_binding_cost_does_not_postpone_an_affordable_judgement() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 7, false, false, false);
        c.control(2000, 25.0);
        let mut now = 2000;
        loop {
            let due = c.due(now);
            assert!(due <= GRID, "one command must not become a repeated capture price");
            if c.should_judge(due) {
                assert_eq!(due, GRID);
                break;
            }
            capture(&mut c, due, 7, false, false, false);
            now = due + 7;
        }
    }

    #[test]
    fn transient_capture_peak_preserves_full_grids_within_actual_completion_windows() {
        let mut c = Cadence::new();
        let costs = [70, 80, 90, 100, 110, 90, 613];
        let mut events = Vec::new();
        let mut starts = Vec::new();
        let mut now = 0;
        for index in 0..44 {
            let due = c.due(now);
            let start = due.max(now);
            starts.push(start);
            let cost = costs.get(index).copied().unwrap_or(70);
            capture(&mut c, start, cost, false, false, true);
            events.push((start + cost, cost as f64));
            // Commands are actual costs too, without becoming the price of future captures.
            now = start + cost + 100;
            c.control(now, 0.5);
            events.push((now, 0.5));
        }
        assert!(starts.windows(2).all(|p| p[1] - p[0] <= GRID), "transient cost lost full grids: {starts:?}");
        assert_eq!(starts[20], 300_000, "every affordable full boundary must be observed");
        let max = events.iter().map(|&(at, _)| moving_cost(&events, at)).fold(0.0, f64::max);
        assert!(max > 2063.0, "completion windows must include the overlapping twenty-first capture");
        assert!(max <= 0.009 * HORIZON as f64, "actual captures and controls spent {max}ms");
    }

    #[test]
    fn sustained_expensive_captures_exhaust_the_horizon_and_leave_a_real_gap() {
        let mut c = Cadence::new();
        let mut starts = Vec::new();
        let mut events = Vec::new();
        let mut now = 0;
        loop {
            let due = c.due(now);
            if due >= HORIZON {
                assert_eq!(due, 315_000, "wait for completion bucket expiry, not every missed grid");
                assert_eq!(c.judgement, 60_000, "denial must not advance the classifier clock");
                assert!(due - c.judgement > 3750, "the worker must reset stale holds and endpoints");
                let balance = c.balance;
                c.reset_grid(due);
                assert!(c.balance >= balance, "only elapsed time repays debt");
                assert_eq!(c.due(due), due);
                break;
            }
            starts.push(due);
            capture(&mut c, due, 613, false, false, true);
            events.push((due + 613, 613.0));
            now = due + 613;
        }
        assert_eq!(starts, [0, 15_000, 30_000, 45_000]);
        assert_eq!(moving_cost(&events, HORIZON), 2452.0);
    }

    #[test]
    fn forced_control_spending_blocks_the_horizon_without_multiplying_capture_price() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 70, false, false, true);
        let price = c.estimate;
        c.control(1000, 2600.0);
        assert_eq!(c.estimate, price);
        assert!(c.spent_at(1000) + price > HORIZON as f64);
        let deferred = c.due(1000);
        assert_eq!(deferred, 315_000);
        assert_eq!(c.due(1001), deferred);
        assert!(c.spent_at(1001) > 296_000.0, "projection must not expire actual control spending early");
        c.control(2000, 0.5);
        assert_eq!(c.due(2000), deferred, "control interrupts must retain the planned budget wait");
        assert_eq!(c.judgement, GRID);
    }

    #[test]
    fn completion_buckets_expire_conservatively_and_aggregate_without_growth() {
        let mut c = Cadence::new();
        // A capture spanning a bucket boundary belongs wholly to its completion bucket.
        c.judged(14_990);
        c.completed(15_010, 20.0, false, false, true);
        c.control(15_020, 7.0);
        assert_eq!(c.buckets.iter().filter(|b| b.spent > 0.0).count(), 1);
        assert!((c.spent_at(330_000 - 1) * 0.009 - 27.0).abs() < 1e-9);
        assert_eq!(c.spent_at(330_000), 0.0);
        let expiry = c.buckets.iter().map(|b| b.expiry).max().unwrap();
        let retained_for = expiry - c.last_capture.unwrap();
        assert!(retained_for > HORIZON && retained_for <= STALE);
        // A completion exactly at a bucket boundary is retained for all 315 seconds.
        c.control(30_000, 1.0);
        assert!(c.spent_at(345_000 - 1) > 0.0);
        assert_eq!(c.spent_at(345_000), 0.0);
        for at in (45_000..=900_000).step_by(GRID as usize) {
            c.control(at, 0.1);
        }
        assert_eq!(c.buckets.iter().filter(|b| b.expiry > 900_000).count(), 21);
    }

    #[test]
    fn mode_and_grid_changes_preserve_historical_units_and_negative_debt() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 613, false, false, true);
        c.control(1000, 100.0);
        let pressure_spend = 713.0 / 0.009;
        c.reset_grid(2000);
        assert!((c.spent_at(2000) - pressure_spend).abs() < 1e-8);
        assert!((c.balance - (2000.0 - pressure_spend)).abs() < 1e-8);
        let estimate = c.estimate;
        capture(&mut c, 2000, 1, true, false, false);
        let quiet_spend = pressure_spend + 1.0 / 0.0008;
        assert!((c.spent_at(2001) - quiet_spend).abs() < 1e-8);
        assert_eq!(c.estimate, estimate, "mode changes do not reinterpret historical prices");
        c.control(2002, 1.0);
        capture(&mut c, 2002, 9, false, false, true);
        assert!((c.spent_at(2011) - (quiet_spend + 1.0 / 0.0008 + 9.0 / 0.009)).abs() < 1e-8);
        let balance = c.balance;
        c.control(100, 0.0);
        assert_eq!(c.at, 2011);
        assert_eq!(c.balance, balance, "backward scalar input creates no credit");
    }

    #[test]
    fn oversized_actual_cost_requires_aging_and_full_debt_repayment_before_one_probe() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 6000, false, false, true);
        assert!(c.spent_at(6000) > 666_000.0, "unexpected actual cost is never clipped");
        let price = c.estimate;
        let debt = c.balance;
        let due = c.due(6000);
        assert_eq!(due, 675_000, "expiry alone does not repay oversized paced debt");
        assert_eq!(c.estimate, price, "future calibration cannot reset the predictor");
        assert_eq!(c.balance, debt);
        assert_eq!(c.due(320_000), due);
        assert_eq!(c.due(due), due);
        c.reset_grid(due);
        capture(&mut c, due, 70, false, false, true);
        assert!(c.estimate < 8000.0, "only the completed calibration replaces the stale price");
        assert_eq!(c.due(due + 70), due + GRID, "new calibration repays its own debt");
    }

    #[test]
    fn startup_controls_are_repaid_before_unknown_calibration_and_long_iterations_stay_late() {
        let mut c = Cadence::new();
        c.control(0, 80.0);
        assert_eq!(c.due(0), 30_000, "unknown startup does not ignore control debt");
        assert_eq!(c.due(20_000), 30_000);
        capture(&mut c, 30_000, 1, false, false, false);
        let mut slow = Cadence::new();
        capture(&mut slow, 0, 20_000, false, false, true);
        // The next affordable deadline follows budget expiry; the missed classifier
        // clock remains visible even though the long iteration crossed its boundary.
        assert_eq!(slow.judgement, GRID);
        assert!(slow.due(20_000) > GRID);
        let mut io = Cadence::new();
        io.judged(0);
        io.completed(20_000, 1.0, false, false, false);
        assert_eq!(io.due(20_000), GRID, "low CPU does not mask long wall-time lateness");
        assert!(20_000 - io.judgement > 3750);
    }

    #[test]
    fn commands_revalidate_admission_but_cannot_hide_an_already_missed_deadline() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 3, false, false, false);
        assert_eq!(c.due(3), 1875);
        c.control(5000, 20.0);
        assert!(c.balance < 0.0);
        let due = c.due(5000);
        assert!(due > 5000, "optional capture must still repay command debt");
        assert_eq!(c.deadline(), 1875, "the worker must see lateness despite a new admission time");
        assert!(due - c.deadline() > 2000);
        c.control(5500, 0.1);
        assert_eq!(c.deadline(), 1875);
        c.reset_grid(due);
        assert_eq!(c.deadline(), due);
        capture(&mut c, due, 3, false, false, false);
        assert!(c.deadline() > due);

        let mut early = Cadence::new();
        capture(&mut early, 0, 3, false, false, false);
        assert_eq!(early.due(3), 1875);
        early.control(1000, 1500.0);
        let due = early.due(1000);
        assert_eq!(due, 315_000, "a command before the deadline revalidates actual horizon capacity");
        assert_eq!(early.deadline(), due, "planned budget waits are not external lateness");
    }

    #[test]
    fn a_stale_price_cannot_probe_through_continuing_control_pressure() {
        let mut c = Cadence::new();
        capture(&mut c, 0, 70, false, false, true);
        c.control(314_000, 2700.0);
        let price = c.estimate;
        assert_eq!(c.due(314_000), 615_000);
        assert_eq!(c.due(330_000), 615_000);
        assert_eq!(c.estimate, price);
        assert!(c.spent_at(614_999) >= HORIZON as f64);
        assert_eq!(c.spent_at(615_000), 0.0);
        c.reset_grid(615_000);
        capture(&mut c, 615_000, 3000, false, false, true);
        assert!(c.due(618_000) >= 945_000, "another oversized probe must repay its new actual debt");
    }

    #[test]
    fn a_full_roster_keeps_complete_windows_and_constant_modes_respect_their_budgets() {
        for (cost, empty, idle, pressure, allowance) in [
            (1, true, false, false, 0.0008),
            (7, false, false, false, 0.004),
            (90, false, true, Cadence::pressure(200, 200), 0.009),
        ] {
            let mut c = Cadence::new();
            let mut now = 0;
            let mut starts = Vec::new();
            let mut events = Vec::new();
            loop {
                let due = c.due(now);
                if due > 900_000 {
                    break;
                }
                starts.push(due);
                capture(&mut c, due, cost, empty, idle, pressure);
                events.push((due + cost, cost as f64));
                now = due + cost;
            }
            let steady: Vec<_> = starts.into_iter().filter(|&at| at >= 30_000).collect();
            assert!(steady.len() >= 58);
            assert!(steady.windows(2).all(|p| p[1] - p[0] <= GRID));
            for &(end, _) in &events {
                assert!(moving_cost(&events, end) <= allowance * HORIZON as f64);
            }
        }
    }
}
