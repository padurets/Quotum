//! A suspend-aware observation barrier, shared by the reader and native delivery.
use std::sync::Mutex;

#[derive(Clone, Copy, Debug)]
pub struct Reading {
    pub awake_before: i128,
    pub awake_after: i128,
    pub boot: i128,
    pub wall: i128,
    pub resolution: i128,
}

#[derive(Debug, Default)]
struct State {
    epoch: u64,
    interval: Option<(i128, i128)>,
    previous: Option<Reading>,
    reader: Option<i128>,
    ready: bool,
}

#[derive(Debug, Default)]
pub struct Gate(Mutex<State>);
impl Gate {
    pub fn invalidate(&self) -> u64 {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.epoch += 1;
        state.ready = false;
        state.interval = None;
        state.previous = None;
        state.reader = None;
        state.epoch
    }
    /// A reader passage establishes progress; a sink only checks it.
    pub fn check(&self, reader: bool) -> Option<u64> {
        self.observe(read(), reader)
    }
    fn observe(&self, reading: Option<Reading>, reader: bool) -> Option<u64> {
        let Some(r) = reading else {
            self.invalidate();
            return None;
        };
        if r.awake_after < r.awake_before || r.awake_after - r.awake_before > 1_000_000_000 {
            self.invalidate();
            return None;
        }
        let interval = (r.boot - r.awake_after - r.resolution, r.boot - r.awake_before + r.resolution);
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let incompatible = s.interval.is_some_and(|old| interval.0 > old.1 || interval.1 < old.0);
        let paused = s.reader.is_some_and(|last| r.boot - last > 5_000_000_000);
        let changed_clock = s.previous.is_some_and(|last| {
            r.boot < last.boot || ((r.wall - last.wall) - (r.boot - last.boot)).abs() > 1_000_000_000
        });
        if incompatible || paused || changed_clock {
            s.epoch += 1;
            s.ready = false;
            s.interval = None;
        }
        s.interval = Some(s.interval.map_or(interval, |old| (old.0.max(interval.0), old.1.min(interval.1))));
        s.previous = Some(r);
        if reader {
            s.reader = Some(r.boot);
        }
        Some(s.epoch)
    }
    pub fn baseline(&self, epoch: u64) -> bool {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.epoch != epoch || s.interval.is_none() {
            return false;
        }
        s.ready = true;
        true
    }
    pub fn allows(&self, epoch: u64) -> bool {
        if self.check(false) != Some(epoch) {
            return false;
        }
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.ready && s.epoch == epoch
    }
}

#[cfg(target_os = "linux")]
fn read() -> Option<Reading> {
    fn clock(id: libc::clockid_t) -> Option<i128> {
        let mut time: libc::timespec = unsafe { std::mem::zeroed() };
        if unsafe { libc::clock_gettime(id, &mut time) } != 0 {
            return None;
        }
        Some(i128::from(time.tv_sec) * 1_000_000_000 + i128::from(time.tv_nsec))
    }
    let awake_before = clock(libc::CLOCK_MONOTONIC)?;
    let boot = clock(libc::CLOCK_BOOTTIME)?;
    let wall = clock(libc::CLOCK_REALTIME)?;
    let awake_after = clock(libc::CLOCK_MONOTONIC)?;
    let mut resolution: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_getres(libc::CLOCK_BOOTTIME, &mut resolution) } != 0 {
        return None;
    }
    Some(Reading {
        awake_before,
        awake_after,
        boot,
        wall,
        resolution: i128::from(resolution.tv_sec) * 1_000_000_000 + i128::from(resolution.tv_nsec),
    })
}
#[cfg(windows)]
fn read() -> Option<Reading> {
    use windows_sys::Win32::System::WindowsProgramming::{
        QueryInterruptTimePrecise, QueryUnbiasedInterruptTimePrecise,
    };
    let (mut before, mut boot, mut after) = (0, 0, 0);
    unsafe {
        QueryUnbiasedInterruptTimePrecise(&mut before);
        QueryInterruptTimePrecise(&mut boot);
        QueryUnbiasedInterruptTimePrecise(&mut after);
    }
    let wall = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos() as i128;
    Some(Reading {
        awake_before: i128::from(before) * 100,
        awake_after: i128::from(after) * 100,
        boot: i128::from(boot) * 100,
        wall,
        resolution: 100,
    })
}
#[cfg(not(any(target_os = "linux", windows)))]
fn read() -> Option<Reading> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(awake: i128, sleep: i128) -> Option<Reading> {
        Some(Reading {
            awake_before: awake,
            awake_after: awake + 10,
            boot: awake + sleep + 5,
            wall: awake + sleep,
            resolution: 1,
        })
    }
    #[test]
    fn short_sleep_and_paused_reader_invalidate_before_late_callbacks() {
        let gate = Gate::default();
        let epoch = gate.observe(r(0, 0), true).unwrap();
        assert!(gate.baseline(epoch));
        assert_eq!(gate.observe(r(1_000_000_000, 0), true), Some(epoch));
        let slept = gate.observe(r(2_000_000_000, 20_000_000_000), false).unwrap();
        assert_ne!(slept, epoch);
        assert!(!gate.baseline(epoch));
        let paused = gate.observe(r(20_000_000_000, 20_000_000_000), true).unwrap();
        assert_ne!(paused, slept);
    }
    #[test]
    fn clock_failure_and_wall_jump_need_a_new_baseline() {
        let gate = Gate::default();
        let epoch = gate.observe(r(0, 0), true).unwrap();
        gate.baseline(epoch);
        assert_eq!(gate.observe(None, true), None);
        assert!(!gate.baseline(epoch));
        let new = gate.observe(r(1, 0), true).unwrap();
        assert!(gate.baseline(new));
        let mut jump = r(2, 0).unwrap();
        jump.wall += 2_000_000_000;
        assert_ne!(gate.observe(Some(jump), true), Some(new));
    }
    #[test]
    fn reading_intervals_overlap_without_false_suspend() {
        let gate = Gate::default();
        let epoch = gate.observe(r(0, 0), true).unwrap();
        let mut next = r(100, 0).unwrap();
        next.awake_after += 100;
        assert_eq!(gate.observe(Some(next), true), Some(epoch));
    }
}
