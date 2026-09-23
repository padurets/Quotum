//! Which coding agents run on this machine, and whether they are working: read from the
//! process table alone. Nothing of the clients is read or changed (no settings, hooks or
//! session files): a session is a client's process, and it works while it and what it
//! started (tools, builds, tests) spend CPU time.
//!
//! The agent may check this often, so a check is one pass over the process list for
//! names and parents; start times, CPU times and folders are read only for the clients'
//! own process trees. No program is started for it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::model::{Millis, Provider};

/// How much of one CPU core a client spends while working, at least. An idle client
/// waits for input and spends little (measured: Claude Code 1–3%, redrawing its screen;
/// Codex under 1%; Antigravity 1–2%); a working one streams, redraws its progress and runs
/// tools (Claude Code 10–25%, Codex 5–10%, Antigravity far more, in bursts).
fn working_share(provider: Provider) -> f64 {
    match provider {
        Provider::Claude => 0.06,
        Provider::Codex => 0.03,
        Provider::Antigravity => 0.04,
    }
}
/// A shorter look than this cannot tell working from idle.
const MIN_LOOK_MS: u128 = 1_000;
/// A session stays working this long after it last spent like one: a model's pause between
/// two steps is not idleness, and the state does not flicker.
const HOLD_MS: u128 = 60_000;

/// A running client: a coding agent's session on this machine.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub provider: Provider,
    pub pid: u32,
    pub started_at: Millis,
    /// The name of the folder it works in, when that is a project (not the home folder).
    pub project: Option<String>,
    /// Whether it is working, idle, or not yet known (seen once so far).
    pub working: Option<bool>,
}

/// A process as the list of all of them tells it.
#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

/// What the last look saw of a session.
struct Seen {
    /// CPU time of its tree, and when that was read.
    cpu: u64,
    at: Instant,
    /// When it last spent like a working session.
    busy_at: Option<Instant>,
    working: Option<bool>,
}

/// Looks at the running clients again and again; working or idle is told by the CPU time
/// spent between two looks.
pub struct Activity {
    home: PathBuf,
    /// Each session at the last look, by pid and start (pids are reused).
    last: HashMap<(u32, Millis), Seen>,
}

impl Activity {
    pub fn new(home: PathBuf) -> Activity {
        Activity { home, last: HashMap::new() }
    }

    pub fn look(&mut self) -> Vec<Session> {
        let now = Instant::now();
        let procs = sys::processes();
        let mut seen = HashMap::new();
        let sessions = sessions(&procs, std::process::id())
            .into_iter()
            // Other people's clients on a shared machine are theirs, and on their accounts.
            .filter(|&(_, pid, _)| sys::mine(pid))
            .filter_map(|(provider, pid, tree)| {
                let (started_at, _) = sys::times(pid)?;
                // What the tree spent, with what its finished processes spent (as far as the system keeps that).
                let cpu: u64 = tree.iter().filter_map(|&p| sys::times(p)).map(|(_, cpu)| cpu).sum();
                let key = (pid, started_at);
                let next = judged(self.last.get(&key), cpu, now, working_share(provider));
                let working = next.working;
                seen.insert(key, next);
                let project = sys::cwd(pid).and_then(|dir| project(&dir, &self.home));
                Some(Session { provider, pid, started_at, project, working })
            })
            .collect();
        self.last = seen;
        sessions
    }
}

/// A session seen again with its tree at `cpu` ms: working when it spent at least `share`
/// of a core since the look before, and for `HOLD_MS` after.
fn judged(before: Option<&Seen>, cpu: u64, now: Instant, share: f64) -> Seen {
    let Some(before) = before else { return Seen { cpu, at: now, busy_at: None, working: None } };
    let wall = now.duration_since(before.at).as_millis();
    if wall < MIN_LOOK_MS {
        // Looked again too soon: it stays as it was, measured from the earlier look.
        return Seen { cpu: before.cpu, at: before.at, busy_at: before.busy_at, working: before.working };
    }
    let busy = cpu.saturating_sub(before.cpu) as f64 / wall as f64 >= share;
    let busy_at = if busy { Some(now) } else { before.busy_at };
    let working = busy_at.is_some_and(|at| now.duration_since(at).as_millis() < HOLD_MS);
    Seen { cpu, at: now, busy_at, working: Some(working) }
}

/// The client a program name belongs to: the native `claude`, `codex` and `agy`.
fn provider_of(name: &str) -> Option<Provider> {
    let name = name.strip_suffix(".exe").unwrap_or(name).to_ascii_lowercase();
    match name.as_str() {
        "claude" => Some(Provider::Claude),
        "codex" => Some(Provider::Codex),
        "agy" | "antigravity" => Some(Provider::Antigravity),
        _ => None,
    }
}

/// The sessions among `procs`, each with the pids of its tree (itself and what it
/// started). Not sessions: clients started by the agent itself to measure (below this
/// process `own` or any `quotum`), and a client under another of the same kind (a
/// launcher and the program it runs). A session under a session of another kind is its
/// own, and its tree is not counted in the one above.
pub fn sessions(procs: &[Proc], own: u32) -> Vec<(Provider, u32, Vec<u32>)> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        children.entry(p.parent).or_default().push(p.pid);
    }
    // Every ancestor of `pid`, nearest first; a cycle of stale parents ends the walk.
    let ancestors = |pid: u32| {
        let mut list = Vec::new();
        let mut at = by_pid.get(&pid).map(|p| p.parent);
        while let Some(parent) = at.filter(|&a| a != 0 && a != pid && !list.contains(&a) && list.len() < 64) {
            list.push(parent);
            at = by_pid.get(&parent).map(|p| p.parent);
        }
        list
    };
    let session = |p: &Proc| -> Option<Provider> {
        let provider = provider_of(&p.name)?;
        let above = ancestors(p.pid);
        let measuring = above.iter().any(|&a| a == own || by_pid.get(&a).is_some_and(|q| is_quotum(&q.name)));
        let launched = above.iter().filter_map(|a| by_pid.get(a)).find_map(|q| provider_of(&q.name)) == Some(provider);
        (!measuring && !launched && p.pid != own).then_some(provider)
    };
    let found: HashMap<u32, Provider> = procs.iter().filter_map(|p| Some((p.pid, session(p)?))).collect();

    let mut list: Vec<(Provider, u32, Vec<u32>)> = found
        .iter()
        .map(|(&pid, &provider)| {
            let mut tree = vec![pid];
            let mut i = 0;
            while i < tree.len() && tree.len() < 4096 {
                for &child in children.get(&tree[i]).into_iter().flatten() {
                    if !found.contains_key(&child) && !tree.contains(&child) {
                        tree.push(child);
                    }
                }
                i += 1;
            }
            (provider, pid, tree)
        })
        .collect();
    list.sort_by_key(|(provider, pid, _)| (*provider, *pid));
    list
}

fn is_quotum(name: &str) -> bool {
    name.strip_suffix(".exe").unwrap_or(name).eq_ignore_ascii_case("quotum")
}

/// The folder's name, when it is a project: not the home folder, anything above it or
/// the temporary folder.
fn project(dir: &Path, home: &Path) -> Option<String> {
    if home.starts_with(dir) || dir.starts_with(std::env::temp_dir()) {
        return None;
    }
    dir.file_name().map(|name| name.to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
mod sys {
    //! /proc: one small file per process for the list.

    use std::fs;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use super::Proc;
    use crate::model::Millis;

    /// A process's name, parent and the fields after them in /proc/<pid>/stat.
    fn stat(pid: u32) -> Option<(String, Vec<u64>)> {
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The name is in parentheses and may itself hold spaces and parentheses.
        let (open, close) = (text.find('(')?, text.rfind(')')?);
        let name = text.get(open + 1..close)?.to_string();
        // After the name: state, then numbers; the state letter is kept as 0.
        let fields = text.get(close + 2..)?.split(' ').map(|f| f.parse().unwrap_or(0)).collect();
        Some((name, fields))
    }

    pub fn processes() -> Vec<Proc> {
        let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
        entries
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let (name, fields) = stat(pid)?;
                Some(Proc { pid, parent: *fields.get(1)? as u32, name })
            })
            .collect()
    }

    /// When it started and how much CPU time it and its finished children have spent, in
    /// milliseconds.
    pub fn times(pid: u32) -> Option<(Millis, u64)> {
        let (_, fields) = stat(pid)?;
        let tick = ticks_per_second();
        // utime, stime, cutime and cstime are fields 14–17 of stat, starttime field 22 (ticks after boot).
        let cpu = fields.get(11..15)?.iter().sum::<u64>() * 1000 / tick;
        let started = boot_time()? * 1000 + (fields.get(19)? * 1000 / tick) as Millis;
        Some((started, cpu))
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

    /// Whether this user runs it.
    pub fn mine(pid: u32) -> bool {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid cannot fail.
        let me = unsafe { libc::getuid() };
        fs::metadata(format!("/proc/{pid}")).is_ok_and(|m| m.uid() == me)
    }

    fn ticks_per_second() -> u64 {
        // SAFETY: sysconf only reads a system constant.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks > 0 { ticks as u64 } else { 100 }
    }

    /// Boot time in seconds, from /proc/stat: containers often show an uptime of their own
    /// in /proc/uptime, while start times count from the host's boot.
    fn boot_time() -> Option<Millis> {
        static BOOT: OnceLock<Option<Millis>> = OnceLock::new();
        *BOOT.get_or_init(|| {
            let text = fs::read_to_string("/proc/stat").ok()?;
            text.lines().find_map(|line| line.strip_prefix("btime ")?.trim().parse().ok())
        })
    }
}

#[cfg(target_os = "macos")]
mod sys {
    //! libproc: the list of pids, then a short record of each.

    use std::ffi::CStr;
    use std::mem;
    use std::os::raw::{c_int, c_void};
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use super::Proc;
    use crate::model::Millis;

    /// `flavor` of `pid` into a zeroed `T`, when the system gives all of it.
    fn info<T>(pid: u32, flavor: c_int) -> Option<T> {
        // SAFETY: T is a plain C struct of libproc; the call writes at most its size.
        unsafe {
            let mut value: T = mem::zeroed();
            let size = mem::size_of::<T>() as c_int;
            let written = libc::proc_pidinfo(pid as c_int, flavor, 0, (&raw mut value).cast::<c_void>(), size);
            (written == size).then_some(value)
        }
    }

    pub fn processes() -> Vec<Proc> {
        // SAFETY: with no buffer the call returns how many pids there are; then it fills
        // at most the buffer's size in bytes.
        let pids = unsafe {
            let count = libc::proc_listallpids(std::ptr::null_mut(), 0);
            let mut pids = vec![0 as c_int; count.max(0) as usize + 64];
            let size = (pids.len() * mem::size_of::<c_int>()) as c_int;
            let filled = libc::proc_listallpids(pids.as_mut_ptr().cast(), size);
            pids.truncate(filled.max(0) as usize);
            pids
        };
        pids.into_iter()
            .filter(|&pid| pid > 0)
            .filter_map(|pid| {
                let bsd: libc::proc_bsdinfo = info(pid as u32, libc::PROC_PIDTBSDINFO)?;
                // pbi_name is the longer name; pbi_comm is cut at 16 bytes.
                let raw = if bsd.pbi_name[0] != 0 { &bsd.pbi_name[..] } else { &bsd.pbi_comm[..] };
                // SAFETY: both are NUL-terminated within their arrays (zeroed first).
                let name = unsafe { CStr::from_ptr(raw.as_ptr()) }.to_string_lossy().into_owned();
                Some(Proc { pid: pid as u32, parent: bsd.pbi_ppid, name })
            })
            .collect()
    }

    pub fn times(pid: u32) -> Option<(Millis, u64)> {
        let bsd: libc::proc_bsdinfo = info(pid, libc::PROC_PIDTBSDINFO)?;
        let started = bsd.pbi_start_tvsec as Millis * 1000 + bsd.pbi_start_tvusec as Millis / 1000;
        // SAFETY: the call fills a plain struct of the version asked for.
        let usage = unsafe {
            let mut usage: libc::rusage_info_v2 = mem::zeroed();
            let asked = libc::proc_pid_rusage(pid as c_int, libc::RUSAGE_INFO_V2, (&raw mut usage).cast());
            (asked == 0).then_some(usage)
        }?;
        // With what its finished children spent. The times are in mach time units:
        // nanoseconds on Intel, not on Apple silicon.
        let total = usage.ri_user_time + usage.ri_system_time + usage.ri_child_user_time + usage.ri_child_system_time;
        let (numer, denom) = timebase();
        Some((started, (total as u128 * numer as u128 / denom as u128 / 1_000_000) as u64))
    }

    /// Whether this user runs it.
    pub fn mine(pid: u32) -> bool {
        // SAFETY: getuid cannot fail.
        let me = unsafe { libc::getuid() };
        info::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO).is_some_and(|bsd| bsd.pbi_uid == me)
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        let vnode: libc::proc_vnodepathinfo = info(pid, libc::PROC_PIDVNODEPATHINFO)?;
        let path = vnode.pvi_cdir.vip_path.as_flattened();
        // SAFETY: the path is NUL-terminated within its array (zeroed first).
        let text = unsafe { CStr::from_ptr(path.as_ptr()) }.to_string_lossy().into_owned();
        (!text.is_empty()).then(|| PathBuf::from(text))
    }

    fn timebase() -> (u32, u32) {
        static TIMEBASE: OnceLock<(u32, u32)> = OnceLock::new();
        *TIMEBASE.get_or_init(|| {
            // SAFETY: fills the two fields of the struct. The call is marked deprecated in libc
            // in favour of another crate; it is the system's own and stays.
            #[allow(deprecated)]
            unsafe {
                let mut base: libc::mach_timebase_info = mem::zeroed();
                if libc::mach_timebase_info(&mut base) == 0 && base.denom != 0 {
                    (base.numer, base.denom)
                } else {
                    (1, 1)
                }
            }
        })
    }
}

#[cfg(windows)]
mod sys {
    //! A snapshot of the process list, then the times of the few processes that matter.

    use std::mem;
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    use super::Proc;
    use crate::model::Millis;

    pub fn processes() -> Vec<Proc> {
        let mut list = Vec::new();
        // SAFETY: the snapshot handle is closed below; each entry is a plain struct with its size set.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return list;
            }
            let mut entry: PROCESSENTRY32W = mem::zeroed();
            entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                list.push(Proc { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, name });
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        list
    }

    /// Windows keeps no time of finished children: what a tool spent is counted while it runs.
    pub fn times(pid: u32) -> Option<(Millis, u64)> {
        let as_100ns = |t: FILETIME| (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64;
        // SAFETY: the handle is closed below; the times are plain structs.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) =
                (mem::zeroed(), mem::zeroed(), mem::zeroed(), mem::zeroed());
            let ok = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            CloseHandle(process);
            // FILETIME counts 100 ns since 1601; the Unix epoch is 11 644 473 600 s later.
            let started = (as_100ns(created) / 10_000) as Millis - 11_644_473_600_000;
            ok.then_some((started, (as_100ns(kernel) + as_100ns(user)) / 10_000))
        }
    }

    /// Another process's folder is not readable without reading its memory: not shown.
    pub fn cwd(_: u32) -> Option<PathBuf> {
        None
    }

    /// Whether it runs in this user's logon session.
    pub fn mine(pid: u32) -> bool {
        let session = |pid: u32| {
            let mut id = u32::MAX;
            // SAFETY: writes one u32.
            (unsafe { ProcessIdToSessionId(pid, &mut id) } != 0).then_some(id)
        };
        session(pid).is_some_and(|id| Some(id) == session(std::process::id()))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod sys {
    use std::path::PathBuf;

    use super::Proc;
    use crate::model::Millis;

    pub fn processes() -> Vec<Proc> {
        Vec::new()
    }
    pub fn times(_: u32) -> Option<(Millis, u64)> {
        None
    }
    pub fn cwd(_: u32) -> Option<PathBuf> {
        None
    }
    pub fn mine(_: u32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str) -> Proc {
        Proc { pid, parent, name: name.into() }
    }

    fn found(procs: &[Proc]) -> Vec<(Provider, u32, Vec<u32>)> {
        sessions(procs, 900)
    }

    #[test]
    fn clients_are_sessions_with_what_they_started() {
        let procs = [
            p(1, 0, "init"),
            p(10, 1, "zsh"),
            p(11, 10, "claude"),
            p(12, 11, "node"),
            p(13, 12, "cargo"),
            p(20, 1, "Codex.exe"),
            p(30, 1, "agy"),
            p(40, 1, "claudette"),
        ];
        assert_eq!(
            found(&procs),
            vec![
                (Provider::Claude, 11, vec![11, 12, 13]),
                (Provider::Codex, 20, vec![20]),
                (Provider::Antigravity, 30, vec![30])
            ]
        );
    }

    #[test]
    fn clients_the_agent_starts_to_measure_are_not_sessions() {
        let procs =
            [p(1, 0, "init"), p(900, 1, "quotum"), p(901, 900, "codex"), p(50, 1, "quotum"), p(51, 50, "claude")];
        assert!(found(&procs).is_empty(), "neither this agent's nor another running agent's");
    }

    #[test]
    fn a_launcher_and_the_client_it_runs_are_one_session() {
        let procs = [p(1, 0, "init"), p(10, 1, "codex"), p(11, 10, "codex"), p(12, 11, "bash")];
        assert_eq!(found(&procs), vec![(Provider::Codex, 10, vec![10, 11, 12])]);
    }

    #[test]
    fn a_client_started_by_another_kind_is_its_own_session() {
        let procs = [p(1, 0, "init"), p(10, 1, "claude"), p(11, 10, "codex"), p(12, 11, "bash")];
        assert_eq!(found(&procs), vec![(Provider::Claude, 10, vec![10]), (Provider::Codex, 11, vec![11, 12])]);
    }

    #[test]
    fn stale_parents_in_a_cycle_end_the_walk() {
        let procs = [p(10, 11, "sh"), p(11, 10, "sh"), p(12, 11, "claude")];
        assert_eq!(found(&procs), vec![(Provider::Claude, 12, vec![12])]);
    }

    #[test]
    fn only_project_folders_are_named() {
        let home = Path::new("/home/ann");
        assert_eq!(project(Path::new("/home/ann/dev/quotum"), home), Some("quotum".into()));
        assert_eq!(project(Path::new("/home/ann"), home), None);
        assert_eq!(project(Path::new("/"), home), None);
        assert_eq!(project(&std::env::temp_dir().join("scratch"), home), None);
    }

    #[test]
    fn a_session_works_while_it_spends_and_a_minute_after() {
        use std::time::Duration;
        let start = Instant::now();
        let at = |s: u64| start + Duration::from_secs(s);
        let first = judged(None, 1_000, at(0), 0.05);
        assert_eq!(first.working, None, "one look cannot tell");
        // 15 s at 10% of a core: working.
        let busy = judged(Some(&first), 2_500, at(15), 0.05);
        assert_eq!(busy.working, Some(true));
        assert_eq!(
            judged(Some(&busy), 2_600, at(15) + Duration::from_millis(300), 0.05).working,
            Some(true),
            "too soon to tell anew"
        );
        // Then quiet: still working for a minute, idle after.
        let pause = judged(Some(&busy), 2_510, at(45), 0.05);
        assert_eq!(pause.working, Some(true));
        let quiet = judged(Some(&pause), 2_520, at(80), 0.05);
        assert_eq!(quiet.working, Some(false));
    }

    #[test]
    fn this_machine_is_looked_at_twice_to_tell_working() {
        let mut activity = Activity::new(PathBuf::from("/nowhere"));
        let first = activity.look();
        assert!(first.iter().all(|s| s.working.is_none()), "one look cannot tell");
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let second = activity.look();
        assert!(second.iter().filter(|s| first.iter().any(|f| f.pid == s.pid)).all(|s| s.working.is_some()));
    }
}
