//! Capture subdivisions share a fifteen-second judgement grid and a bounded cost allowance.

const GRID: u64 = 15_000;

pub(crate) struct Cadence {
    pub next: u64,
    pub judgement: u64,
    allowance: f64,
    tokens: f64,
    token_at: u64,
    estimate: f64,
    ewma: f64,
    recent: [f64; 4],
    observations: usize,
    idle_since: Option<u64>,
    origin: u64,
    first: bool,
    slots: u64,
}

impl Cadence {
    pub fn new() -> Self {
        Self {
            next: 0,
            judgement: GRID,
            allowance: 0.004,
            tokens: 0.0,
            token_at: 0,
            estimate: 0.0,
            ewma: 0.0,
            recent: [0.0; 4],
            observations: 0,
            idle_since: None,
            origin: 0,
            first: true,
            slots: 8,
        }
    }
    fn accrue(&mut self, now: u64) {
        self.tokens =
            (self.tokens + now.saturating_sub(self.token_at) as f64 * self.allowance).min(300_000.0 * self.allowance);
        self.token_at = now;
    }
    pub fn due(&mut self, now: u64) -> u64 {
        self.accrue(now);
        if self.observations == 0 || self.tokens >= self.estimate {
            return self.next;
        }
        let funded = now.saturating_add(((self.estimate - self.tokens) / self.allowance).ceil() as u64);
        let base = self.origin + (funded - self.origin) / GRID * GRID;
        let aligned = if funded == base {
            base
        } else {
            (1..=self.slots).map(|slot| base + slot * GRID / self.slots).find(|&at| at >= funded).unwrap_or(base + GRID)
        };
        // Cost pressure skips subdivisions, preserving the common judgement boundaries.
        self.next = self.next.max(aligned);
        self.next
    }
    pub fn completed(&mut self, now: u64, cost_ms: f64, empty: bool, idle: bool, pressure: bool) {
        self.accrue(now);
        self.tokens -= cost_ms;
        self.ewma = if self.observations == 0 { cost_ms } else { self.ewma * 0.875 + cost_ms * 0.125 };
        self.recent[self.observations % 4] = cost_ms;
        self.observations += 1;
        self.estimate = self.ewma.max(self.recent.iter().copied().fold(0.0, f64::max)).max(0.001);
        if idle {
            self.idle_since.get_or_insert(now);
        } else {
            self.idle_since = None;
        }
        self.allowance = if empty {
            0.0008
        } else if pressure {
            0.009
        } else {
            0.004
        };
        self.tokens = self.tokens.min(300_000.0 * self.allowance);
        let target = if empty {
            1
        } else if self.idle_since.is_some_and(|at| now.saturating_sub(at) >= 30_000) {
            3
        } else {
            8
        };
        let affordable = (GRID as f64 * self.allowance / self.estimate).floor() as u64;
        if affordable == 0 {
            self.slots = 1;
            let grids = (self.estimate / (GRID as f64 * self.allowance)).ceil() as u64;
            self.next = self.origin + ((now - self.origin) / GRID + grids.max(1)) * GRID;
        } else {
            let slots = target.min(affordable);
            self.slots = slots;
            let base = self.origin + (now - self.origin) / GRID * GRID;
            self.next = (1..=slots).map(|slot| base + slot * GRID / slots).find(|&at| at > now).unwrap_or(base + GRID);
        }
    }
    pub fn judged(&mut self, now: u64) {
        self.judgement = self.origin + ((now - self.origin) / GRID + 1) * GRID;
        self.first = false;
    }

    pub fn should_judge(&self, now: u64) -> bool {
        self.first || now >= self.judgement
    }
    pub fn reset_grid(&mut self, now: u64) {
        self.origin = now;
        self.next = now;
        self.judgement = now + GRID;
        self.first = true;
        self.idle_since = None;
    }

    pub fn control(&mut self, now: u64, cost_ms: f64) {
        self.accrue(now);
        self.tokens -= cost_ms;
        // Commands spend the same allowance, but are not repeated by every future capture.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fast_capture_keeps_a_separate_judgement_deadline_and_idle_empty_targets() {
        let mut c = Cadence::new();
        c.completed(0, 3.6, false, false, false);
        assert_eq!(c.next, 1875);
        assert_eq!(c.judgement, 15_000);
        c.completed(1875, 3.6, false, true, false);
        c.completed(31_875, 3.6, false, true, false);
        assert_eq!(c.next, 35_000);
        c.completed(35_000, 1.0, true, true, false);
        assert_eq!(c.next, 45_000);
    }
    #[test]
    fn sudden_pressure_reserves_future_cost_without_a_catch_up_loop() {
        let mut c = Cadence::new();
        assert_eq!(c.due(0), 0);
        c.completed(0, 65.0, false, false, true);
        assert_eq!(c.next, 7500);
        assert!(c.due(1) > 7500, "the one calibration burst is repaid");
        let due = c.due(1);
        assert_eq!(c.due(due), due);
        c.completed(due, 65.0, false, false, true);
        assert!(c.next > due);
    }
    #[test]
    fn one_time_binding_cost_does_not_postpone_an_affordable_judgement() {
        let mut c = Cadence::new();
        c.judged(0);
        c.completed(0, 7.0, false, false, false);
        c.control(2000, 25.0);
        let mut now = 2000;
        loop {
            let due = c.due(now);
            assert!(due <= 15_000, "a 53ms startup fits the 60ms fifteen-second allowance");
            if c.should_judge(due) {
                assert_eq!(due, 15_000);
                break;
            }
            c.completed(due, 7.0, false, false, false);
            now = due + 7;
        }
    }
}
