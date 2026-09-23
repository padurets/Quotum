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

/// A share of one CPU core above which a session counts as working. An idle client waits
/// for input and spends next to nothing; a working one streams, redraws its progress and
/// runs tools.
pub const WORKING_SHARE: f64 = 0.03;
/// A shorter look than this cannot tell working from idle.
const MIN_LOOK_MS: u128 = 1_000;

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

/// Looks at the running clients again and again; working or idle is told by the CPU time
/// spent between two looks.
pub struct Activity {
    home: PathBuf,
    /// CPU time of each session's tree at the last look, by pid and start (pids are reused).
    last: HashMap<(u32, Millis), (u64, Instant)>,
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
            .filter_map(|(provider, pid, tree)| {
                let (started_at, _) = sys::times(pid)?;
                let cpu: u64 = tree.iter().filter_map(|&p| sys::times(p)).map(|(_, cpu)| cpu).sum();
                let key = (pid, started_at);
                let working = self.last.get(&key).and_then(|&(before, at)| {
                    let wall = now.duration_since(at).as_millis();
                    (wall >= MIN_LOOK_MS).then(|| cpu.saturating_sub(before) as f64 / wall as f64 >= WORKING_SHARE)
                });
                seen.insert(key, (cpu, now));
                let project = sys::cwd(pid).and_then(|dir| project(&dir, &self.home));
                Some(Session { provider, pid, started_at, project, working })
            })
            .collect();
        self.last = seen;
        sessions
    }
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

    /// When it started and how much CPU time it has spent, in milliseconds.
    pub fn times(pid: u32) -> Option<(Millis, u64)> {
        let (_, fields) = stat(pid)?;
        let tick = ticks_per_second();
        // utime and stime are fields 14 and 15 of stat, starttime field 22 (ticks after boot).
        let cpu = (fields.get(11)? + fields.get(12)?) * 1000 / tick;
        let started = boot_time()? * 1000 + (fields.get(19)? * 1000 / tick) as Millis;
        Some((started, cpu))
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
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
        let task: libc::proc_taskinfo = info(pid, libc::PROC_PIDTASKINFO)?;
        let started = bsd.pbi_start_tvsec as Millis * 1000 + bsd.pbi_start_tvusec as Millis / 1000;
        // CPU times are in mach time units: nanoseconds on Intel, not on Apple silicon.
        let (numer, denom) = timebase();
        let cpu = (task.pti_total_user + task.pti_total_system) as u128 * numer as u128 / denom as u128 / 1_000_000;
        Some((started, cpu as u64))
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
    fn this_machine_is_looked_at_twice_to_tell_working() {
        let mut activity = Activity::new(PathBuf::from("/nowhere"));
        let first = activity.look();
        assert!(first.iter().all(|s| s.working.is_none()), "one look cannot tell");
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let second = activity.look();
        assert!(second.iter().filter(|s| first.iter().any(|f| f.pid == s.pid)).all(|s| s.working.is_some()));
    }
}
