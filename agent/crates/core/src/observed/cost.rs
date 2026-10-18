//! Waiting for durable I/O delays an observation without spending its CPU allowance.

use std::time::Duration;

pub(crate) struct Cost(Option<Duration>);

impl Cost {
    pub fn start() -> Self {
        Self(cpu())
    }

    pub fn elapsed_ms(self, wall: Duration) -> f64 {
        self.0.and_then(|before| cpu()?.checked_sub(before)).unwrap_or(wall).as_secs_f64() * 1000.0
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn cpu() -> Option<Duration> {
    // SAFETY: the fixed scalar clock writes only this owned timespec.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } != 0 {
        return None;
    }
    let seconds = u64::try_from(time.tv_sec).ok()?;
    let nanos = u32::try_from(time.tv_nsec).ok()?;
    (nanos < 1_000_000_000).then(|| Duration::new(seconds, nanos))
}

#[cfg(windows)]
pub(crate) fn cpu() -> Option<Duration> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentThread, GetThreadTimes};
    let mut created = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    // SAFETY: the current thread's pseudo-handle and four owned scalar output structures.
    if unsafe { GetThreadTimes(GetCurrentThread(), &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    let ticks = ticks(kernel).checked_add(ticks(user))?;
    Some(Duration::new(ticks / 10_000_000, ((ticks % 10_000_000) * 100) as u32))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn cpu() -> Option<Duration> {
    None
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos", windows)))]
mod tests {
    use super::*;
    use crate::observed::cadence::Cadence;
    use std::time::Instant;

    #[test]
    fn waiting_for_io_does_not_postpone_an_affordable_judgement() {
        let at = Instant::now();
        let cost = Cost::start();
        assert!(cost.0.is_some(), "supported platforms provide the current thread's CPU clock");
        std::thread::sleep(Duration::from_millis(100));
        let wall = at.elapsed();
        let measured = cost.elapsed_ms(wall);
        let mut cadence = Cadence::new();
        cadence.judged(0);
        cadence.completed(wall.as_millis() as u64, measured, false, false, false);
        assert!(cadence.due(wall.as_millis() as u64) <= 15_000, "waiting spent {measured}ms of CPU allowance");
    }

    #[test]
    fn unavailable_or_backward_thread_clocks_charge_elapsed_wall_time() {
        let wall = Duration::from_millis(123);
        assert_eq!(Cost(None).elapsed_ms(wall), 123.0);
        assert_eq!(Cost(Some(Duration::MAX)).elapsed_ms(wall), 123.0);
    }
}
