//! Private boot-clock continuity. Native values never enter an activity request.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::{Anchor, SAFE_INTEGER, State};
use crate::model::{Millis, now_ms};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Reading {
    pub boot: Option<String>,
    pub tick: u64,
    pub wall: Millis,
}

pub(crate) struct Clock {
    fallback: Instant,
    #[cfg(test)]
    fixed: Option<Reading>,
}

impl Clock {
    pub fn new() -> Self {
        Self {
            fallback: Instant::now(),
            #[cfg(test)]
            fixed: None,
        }
    }
    #[cfg(test)]
    pub fn fixed(reading: Reading) -> Self {
        Self { fallback: Instant::now(), fixed: Some(reading) }
    }
    pub fn read(&self) -> Reading {
        #[cfg(test)]
        if let Some(reading) = &self.fixed {
            return reading.clone();
        }
        let wall = now_ms();
        match native() {
            Some((boot, tick)) => Reading { boot: Some(boot), tick, wall },
            None => Reading { boot: None, tick: self.fallback.elapsed().as_millis() as u64, wall },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Epoch {
    pub id: String,
    pub boot: Option<String>,
    pub zero_tick: u64,
    pub zero_wall: Millis,
    pub last_tick: u64,
    pub anchor: Option<Anchor>,
    #[serde(default)]
    pub wall_offset: Option<Millis>,
}

impl Epoch {
    pub fn new(reading: &Reading) -> Self {
        Self {
            id: crate::config::random_hex(),
            boot: reading.boot.clone(),
            zero_tick: reading.tick,
            zero_wall: reading.wall,
            last_tick: reading.tick,
            anchor: None,
            wall_offset: None,
        }
    }
    pub fn compatible(&self, reading: &Reading, restart: bool) -> bool {
        if restart && self.boot.is_none() || reading.tick < self.last_tick {
            return false;
        }
        self.same_basis(reading)
    }
    fn same_basis(&self, reading: &Reading) -> bool {
        if self.boot != reading.boot || reading.tick < self.zero_tick {
            return false;
        }
        let elapsed = i128::from(reading.tick) - i128::from(self.zero_tick);
        (i128::from(reading.wall) - i128::from(self.zero_wall) - elapsed).abs() <= 2_000
    }
    pub fn tick(&self, reading: &Reading) -> u64 {
        reading.tick.saturating_sub(self.zero_tick)
    }
    pub fn bind(&mut self, sent: &Reading, server: Millis) -> bool {
        // The independent sampler may already have captured beyond this historical send sample.
        if self.anchor.is_some() || !self.same_basis(sent) {
            return false;
        }
        let offset = if (server - sent.wall).abs() > 30_000 { server - sent.wall } else { 0 };
        self.restore(Anchor {
            clock_epoch: self.id.clone(),
            anchor_tick: self.tick(sent),
            anchor_at: sent.wall + offset,
        })
    }

    pub fn restore(&mut self, anchor: Anchor) -> bool {
        if self.anchor.is_some()
            || anchor.clock_epoch != self.id
            || anchor.anchor_tick > SAFE_INTEGER
            || !(0..=SAFE_INTEGER as i64).contains(&anchor.anchor_at)
        {
            return false;
        }
        // Context dates and frame ticks share one recoverable UTC mapping, including small wall drift.
        let offset = i128::from(anchor.anchor_at) - i128::from(self.zero_wall) - i128::from(anchor.anchor_tick);
        let Ok(offset) = Millis::try_from(offset) else { return false };
        self.wall_offset = Some(offset);
        self.anchor = Some(anchor);
        true
    }

    pub fn utc_state(&self, mut state: Arc<State>) -> Option<Arc<State>> {
        let anchor = self.anchor.as_ref()?;
        let offset = self.wall_offset.map(i128::from).unwrap_or_else(|| {
            i128::from(anchor.anchor_at) - i128::from(self.zero_wall) - i128::from(anchor.anchor_tick)
        });
        if offset == 0 {
            return Some(state);
        }
        let date = |at: Millis| {
            let at = i128::from(at) + offset;
            (0..=i128::from(SAFE_INTEGER)).contains(&at).then_some(at as Millis)
        };
        for context in &mut Arc::make_mut(&mut state).contexts {
            context.started_at = date(context.started_at)?;
            if let Some(at) = context.last_worked_at {
                context.last_worked_at = Some(date(at)?);
            }
        }
        Some(state)
    }
}

#[cfg(target_os = "linux")]
fn native() -> Option<(String, u64)> {
    use std::sync::OnceLock;
    static BOOT: OnceLock<Option<String>> = OnceLock::new();
    let boot = BOOT
        .get_or_init(|| {
            let value = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
            let value = value.trim();
            (value.len() == 36
                && value
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }))
            .then(|| value.to_string())
        })
        .as_ref()?;
    // SAFETY: a fixed scalar clock read writes only this owned timespec.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut time) } != 0 {
        return None;
    }
    let tick = u64::try_from(time.tv_sec)
        .ok()?
        .checked_mul(1000)?
        .checked_add(u64::try_from(time.tv_nsec).ok()? / 1_000_000)?;
    Some((boot.clone(), tick))
}

#[cfg(target_os = "macos")]
fn native() -> Option<(String, u64)> {
    use std::sync::OnceLock;
    static BOOT: OnceLock<Option<String>> = OnceLock::new();
    let boot = BOOT
        .get_or_init(|| {
            let mut bytes = [0u8; 64];
            let mut length = bytes.len();
            // SAFETY: constant sysctl name and an owned bounded output buffer.
            if unsafe {
                libc::sysctlbyname(
                    c"kern.bootsessionuuid".as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    &mut length,
                    std::ptr::null_mut(),
                    0,
                )
            } != 0
                || !(36..=37).contains(&length)
            {
                return None;
            }
            String::from_utf8(bytes[..36].to_vec()).ok()
        })
        .as_ref()?;
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> libc::c_int;
    }
    let mut scale = Timebase { numer: 0, denom: 0 };
    // SAFETY: the output is a fixed native clock conversion structure.
    if unsafe { mach_timebase_info(&mut scale) } != 0 || scale.denom == 0 {
        return None;
    }
    // SAFETY: the continuous clock has no inputs or pointers.
    let tick = unsafe { mach_continuous_time() } as u128 * scale.numer as u128 / scale.denom as u128 / 1_000_000;
    Some((boot.clone(), u64::try_from(tick).ok()?))
}

#[cfg(windows)]
fn native() -> Option<(String, u64)> {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    static BOOT: OnceLock<Option<String>> = OnceLock::new();
    let boot = BOOT.get_or_init(crate::activity::own_boot_witness).as_ref()?;
    type Query = unsafe extern "system" fn(*mut u64);
    // SAFETY: the system DLL and scalar API remain valid throughout the call.
    unsafe {
        let module = GetModuleHandleW(
            c"kernel32.dll".to_bytes().iter().map(|&b| b as u16).chain([0]).collect::<Vec<_>>().as_ptr(),
        );
        if module.is_null() {
            return None;
        }
        let address = GetProcAddress(module, c"QueryInterruptTimePrecise".as_ptr().cast())?;
        let query: Query = std::mem::transmute(address);
        let mut tick = 0;
        query(&mut tick);
        Some((boot.clone(), tick / 10_000))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn native() -> Option<(String, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_hello_sample_can_precede_later_captures_without_weakening_current_continuity() {
        let origin = Reading { boot: Some("fixture".into()), tick: 1_000, wall: 10_000 };
        let sent = Reading { tick: 2_000, wall: 11_000, ..origin.clone() };
        let mut epoch = Epoch::new(&origin);
        epoch.last_tick = 2_875;
        assert!(!epoch.compatible(&sent, false));
        assert!(epoch.compatible(&Reading { tick: 4_500, wall: 13_500, ..origin.clone() }, false));
        assert!(epoch.bind(&sent, 13_500));
        assert_eq!(epoch.anchor.unwrap().anchor_tick, 1_000);
        for bad in [
            Reading { tick: 999, wall: 9_999, ..origin.clone() },
            Reading { boot: Some("other".into()), ..sent.clone() },
            Reading { wall: sent.wall + 2_001, ..sent },
        ] {
            assert!(!Epoch::new(&origin).bind(&bad, bad.wall));
        }
    }

    #[test]
    fn a_recovered_anchor_restores_the_canonical_offset_even_with_small_wall_drift() {
        let first = Reading { boot: Some("boot".into()), tick: 1000, wall: 10_000 };
        let mut epoch = Epoch::new(&first);
        let mut backup = epoch.clone();
        let sent = Reading { tick: 11_000, wall: 20_500, ..first.clone() };
        assert!(epoch.bind(&sent, sent.wall));
        assert_eq!(epoch.wall_offset, Some(500));
        let anchor = epoch.anchor.clone().unwrap();
        assert!(backup.restore(anchor.clone()));
        assert_eq!(backup.wall_offset, epoch.wall_offset);
        assert_eq!(backup.anchor, epoch.anchor);
        assert!(!backup.restore(Anchor { anchor_at: anchor.anchor_at + 1, ..anchor }));
        let mut bad = Epoch::new(&first);
        assert!(!bad.restore(Anchor { clock_epoch: bad.id.clone(), anchor_at: 10_000, anchor_tick: u64::MAX }));
        assert!(bad.anchor.is_none());
    }

    #[test]
    fn restart_preserves_a_compatible_boot_basis_but_not_holds_or_clock_faults() {
        let first = Reading { boot: Some("boot".into()), tick: 1000, wall: 10_000 };
        let mut epoch = Epoch::new(&first);
        assert!(epoch.bind(&first, 10_000));
        let anchor = epoch.anchor.clone();
        let later = Reading { tick: 5000, wall: 14_000, ..first.clone() };
        assert!(epoch.compatible(&later, true));
        assert!(!epoch.bind(&later, 20_000));
        assert_eq!(epoch.anchor, anchor);
        assert!(!epoch.compatible(&Reading { wall: 17_000, ..later.clone() }, true));
        assert!(!epoch.compatible(&Reading { boot: Some("another".into()), ..later.clone() }, true));
        assert!(!epoch.compatible(&Reading { tick: 0, ..later }, true));
        let fallback = Epoch::new(&Reading { boot: None, ..first.clone() });
        assert!(!fallback.compatible(&Reading { boot: None, ..first }, true));
    }
}
