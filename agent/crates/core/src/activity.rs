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
    pub origin: Origin,
}

/// Where a session runs. An editor or the app runs one client per window for all its chats,
/// so there a session is a window, idle while it is only open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Terminal,
    Editor,
    App,
}

impl Origin {
    pub fn id(self) -> &'static str {
        match self {
            Origin::Terminal => "terminal",
            Origin::Editor => "editor",
            Origin::App => "app",
        }
    }
}

/// A process as the list of all of them tells it.
#[derive(Clone, Debug)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    /// Its start and CPU time, when the list gives them at no extra cost (Linux).
    pub times: Option<(Millis, u64)>,
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
    /// Folders that are not projects, as given and as the system resolves them.
    homes: Vec<PathBuf>,
    temps: Vec<PathBuf>,
    /// Each session at the last look, by pid and start (pids are reused).
    last: HashMap<(u32, Millis), Seen>,
}

impl Activity {
    pub fn new(home: PathBuf) -> Activity {
        // A client's folder comes resolved (/private/var/… on macOS for /var/…).
        let both = |dir: PathBuf| [dir.canonicalize().ok(), Some(dir)].into_iter().flatten().collect::<Vec<_>>();
        let mut temps = both(std::env::temp_dir());
        temps.extend(["/tmp", "/private/tmp", "/var/tmp"].map(PathBuf::from));
        Activity { homes: both(home), temps, last: HashMap::new() }
    }

    pub fn look(&mut self) -> Vec<Session> {
        let now = Instant::now();
        let procs = sys::processes();
        let listed: HashMap<u32, Option<(Millis, u64)>> = procs.iter().map(|p| (p.pid, p.times)).collect();
        let times = |pid: u32| listed.get(&pid).copied().flatten().or_else(|| sys::times(pid));
        let mut seen = HashMap::new();
        let sessions = sessions(&procs, std::process::id())
            .into_iter()
            // Other people's clients on a shared machine are theirs, and on their accounts.
            .filter(|found| sys::mine(found.pid))
            .filter_map(|Found { provider, pid, origin, tree }| {
                // What the tree spent, with what its finished processes spent (as far as the
                // system keeps that). A session of another kind it started and that ended
                // shows up there too, for a minute: rare, since the one that started it is
                // working on its result then.
                let measured: Vec<Option<(Millis, u64)>> = tree.iter().map(|&p| times(p)).collect();
                let (started_at, _) = (*measured.first()?)?;
                let cpu: u64 = measured.iter().flatten().map(|&(_, cpu)| cpu).sum();
                let key = (pid, started_at);
                let next = judged(self.last.get(&key), cpu, now, working_share(provider));
                let working = next.working;
                seen.insert(key, next);
                let project = sys::cwd(pid).and_then(|dir| project(&dir, &self.homes, &self.temps));
                Some(Session { provider, pid, started_at, project, working, origin })
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

/// The client a program name belongs to: `claude`, `codex` and `agy` as they are named,
/// in lower case. The windows of desktop apps are named in capitals (`Claude`, `Codex`)
/// and are not sessions: the client an app starts for its chats is.
fn provider_of(name: &str) -> Option<Provider> {
    match name.strip_suffix(".exe").unwrap_or(name) {
        "claude" => Some(Provider::Claude),
        "codex" => Some(Provider::Codex),
        // `antigravity` is the editor, not the client.
        "agy" => Some(Provider::Antigravity),
        _ => None,
    }
}

/// The sessions among `procs`. Not sessions: clients started by the agent itself to measure (below this
/// process `own` or any `quotum`), and a client under another of the same kind (a
/// launcher and the program it runs). A session under a session of another kind is its
/// own, and its tree is not counted in the one above.
pub fn sessions(procs: &[Proc], own: u32) -> Vec<Found> {
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
    let session = |p: &Proc| -> Option<(Provider, Origin)> {
        let provider = provider_of(&p.name)?;
        let above: Vec<&Proc> = ancestors(p.pid).iter().filter_map(|a| by_pid.get(a).copied()).collect();
        let measuring = p.pid == own || above.iter().any(|q| q.pid == own || is_quotum(&q.name));
        let launched = above.iter().find_map(|q| provider_of(&q.name)) == Some(provider);
        (!measuring && !launched).then(|| (provider, origin(&above)))
    };
    let found: HashMap<u32, (Provider, Origin)> = procs.iter().filter_map(|p| Some((p.pid, session(p)?))).collect();

    let mut list: Vec<Found> = found
        .iter()
        .map(|(&pid, &(provider, origin))| {
            let mut tree = vec![pid];
            let mut i = 0;
            while i < tree.len() && tree.len() < 4096 {
                // Each process has one parent, so going down reaches a process again only
                // through a cycle back to the session itself, which is in `found`.
                for &child in children.get(&tree[i]).into_iter().flatten() {
                    if !found.contains_key(&child) {
                        tree.push(child);
                    }
                }
                i += 1;
            }
            Found { provider, pid, origin, tree }
        })
        .collect();
    list.sort_by_key(|found| (found.provider, found.pid));
    list
}

/// A session found in the process list, with the pids of its tree (itself and what it started).
#[derive(Debug, PartialEq)]
pub struct Found {
    pub provider: Provider,
    pub pid: u32,
    pub origin: Origin,
    pub tree: Vec<u32>,
}

/// Where a client runs, from the programs above it: an editor, the desktop app of its
/// provider, or else a terminal (a shell, a multiplexer, ssh).
fn origin(above: &[&Proc]) -> Origin {
    const EDITORS: [&str; 6] = ["code", "code-insiders", "codium", "cursor", "windsurf", "antigravity"];
    const HELPERS: [&str; 5] =
        ["code helper", "code - insiders", "cursor helper", "windsurf helper", "antigravity helper"];
    above
        .iter()
        .find_map(|p| {
            let bare = p.name.strip_suffix(".exe").unwrap_or(&p.name);
            let name = bare.to_ascii_lowercase();
            if EDITORS.contains(&name.as_str()) || HELPERS.iter().any(|helper| name.starts_with(helper)) {
                Some(Origin::Editor)
            } else if ["chatgpt", "codex", "claude"].contains(&name.as_str()) && bare != name {
                // A capitalised name of a provider: its desktop app (a client of the same name is lower case).
                Some(Origin::App)
            } else {
                None
            }
        })
        .unwrap_or(Origin::Terminal)
}

/// The client a program is, told by its path, where its name is not the client's: macOS
/// names a process after the file a link leads to (the Claude Code installer links
/// `claude` to `…/claude/versions/2.1.281`, Homebrew links `codex` to `codex-aarch64-apple-darwin`).
pub fn client_by_path(path: &str) -> Option<&'static str> {
    let file = path.rsplit('/').next().unwrap_or(path);
    if path.contains("/claude/versions/") {
        Some("claude")
    } else if file.starts_with("codex-") && !file.starts_with("codex-code-mode") {
        Some("codex")
    } else {
        None
    }
}

fn is_quotum(name: &str) -> bool {
    name.strip_suffix(".exe").unwrap_or(name).eq_ignore_ascii_case("quotum")
}

/// The folder's name, when it is a project: not a home folder, anything above it or a
/// temporary folder.
fn project(dir: &Path, homes: &[PathBuf], temps: &[PathBuf]) -> Option<String> {
    if homes.iter().any(|home| home.starts_with(dir)) || temps.iter().any(|temp| dir.starts_with(temp)) {
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

    /// A process from /proc/<pid>/stat: its name, parent, start and the CPU time it and its
    /// finished children have spent, in milliseconds.
    fn stat(pid: u32) -> Option<Proc> {
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The name is in parentheses and may itself hold spaces and parentheses.
        let (open, close) = (text.find('(')?, text.rfind(')')?);
        let name = text.get(open + 1..close)?;
        // After the name come fields 3 (state), 4 (parent), …, 14–17 (utime, stime, cutime,
        // cstime) and 22 (start, in ticks after boot).
        let mut fields = text.get(close + 2..)?.split(' ').skip(1).map(|field| field.parse::<u64>().ok());
        let parent = fields.next()??;
        let cpu = [fields.nth(9)??, fields.next()??, fields.next()??, fields.next()??].iter().sum::<u64>();
        let start = fields.nth(4)??;
        let tick = ticks_per_second();
        let started = boot_time().map(|boot| boot * 1000 + (start * 1000 / tick) as Millis);
        let times = started.map(|at| (at, cpu * 1000 / tick));
        Some(Proc { pid, parent: parent as u32, name: name.to_string(), times })
    }

    pub fn processes() -> Vec<Proc> {
        let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
        entries.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok()).filter_map(stat).collect()
    }

    pub fn times(pid: u32) -> Option<(Millis, u64)> {
        stat(pid)?.times
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
                let mut name = unsafe { CStr::from_ptr(raw.as_ptr()) }.to_string_lossy().into_owned();
                // A name the file a link led to gave (a version, a platform): the path tells the client.
                if (name.starts_with(|c: char| c.is_ascii_digit()) || name.starts_with("codex-"))
                    && let Some(client) = path(pid as u32).as_deref().and_then(super::client_by_path)
                {
                    name = client.to_string();
                }
                Some(Proc { pid: pid as u32, parent: bsd.pbi_ppid, name, times: None })
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

    /// The path of its program.
    fn path(pid: u32) -> Option<String> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: writes at most the buffer's size.
        let written = unsafe { libc::proc_pidpath(pid as c_int, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        (written > 0).then(|| String::from_utf8_lossy(&buffer[..written as usize]).into_owned())
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
                list.push(Proc { pid: entry.th32ProcessID, parent: entry.th32ParentProcessID, name, times: None });
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

    /// Whether it runs in this user's logon session (another account's process started in it,
    /// say with runas, counts too).
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
        Proc { pid, parent, name: name.into(), times: None }
    }

    fn found(procs: &[Proc]) -> Vec<(Provider, u32, Vec<u32>)> {
        sessions(procs, 900).into_iter().map(|f| (f.provider, f.pid, f.tree)).collect()
    }

    fn origins(procs: &[Proc]) -> Vec<(u32, Origin)> {
        sessions(procs, 900).into_iter().map(|f| (f.pid, f.origin)).collect()
    }

    #[test]
    fn clients_are_sessions_with_what_they_started() {
        let procs = [
            p(1, 0, "init"),
            p(10, 1, "zsh"),
            p(11, 10, "claude"),
            p(12, 11, "node"),
            p(13, 12, "cargo"),
            p(20, 1, "codex.exe"),
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

    /// Codex on one Linux machine: in terminals, in VS Code windows and in the desktop app.
    #[test]
    fn terminal_editor_and_app_sessions_are_told_apart() {
        let procs = [
            p(1, 0, "systemd"),
            p(16333, 1, "herdr"),
            p(17822, 16333, "zsh"),
            p(19988, 17822, "codex"),
            p(23452, 19988, "MainThread"),
            p(4400, 1, "code"),
            p(7146, 4400, "code"),
            p(10195, 7146, "codex"),
            p(1097639, 1, "ChatGPT"),
            p(1097652, 1097639, "ChatGPT"),
            p(1098247, 1097639, "codex"),
            p(1114779, 1098247, "codex-code-mode"),
            p(3000, 1, "Claude"),
            p(3001, 3000, "Claude"),
        ];
        assert_eq!(origins(&procs), vec![(10195, Origin::Editor), (19988, Origin::Terminal), (1098247, Origin::App)]);
        let app = sessions(&procs, 900).into_iter().find(|f| f.pid == 1098247).unwrap();
        assert_eq!(app.tree, vec![1098247, 1114779], "the app's windows are not counted in its client");
    }

    #[test]
    fn only_project_folders_are_named() {
        let activity = Activity::new(PathBuf::from("/home/ann"));
        let named = |dir: &str| project(Path::new(dir), &activity.homes, &activity.temps);
        assert_eq!(named("/home/ann/dev/quotum"), Some("quotum".into()));
        assert_eq!(named("/home/ann"), None);
        assert_eq!(named("/"), None);
        assert_eq!(named("/private/tmp/scratch"), None, "a temporary folder, resolved");
        assert_eq!(project(&std::env::temp_dir().join("scratch"), &activity.homes, &activity.temps), None);
    }

    #[test]
    fn the_antigravity_editor_is_an_editor_and_agy_in_it_a_session() {
        let procs =
            [p(1, 0, "init"), p(10, 1, "antigravity"), p(11, 10, "antigravity"), p(12, 11, "zsh"), p(13, 12, "agy")];
        assert_eq!(origins(&procs), vec![(13, Origin::Editor)]);
    }

    #[test]
    fn on_windows_a_client_under_another_is_no_app() {
        let procs = [
            p(1, 0, "explorer.exe"),
            p(10, 1, "claude.exe"),
            p(11, 10, "codex.exe"),
            p(20, 1, "Claude.exe"),
            p(21, 20, "claude.exe"),
        ];
        assert_eq!(origins(&procs), vec![(10, Origin::Terminal), (21, Origin::App), (11, Origin::Terminal)]);
    }

    #[test]
    fn a_client_named_after_the_file_a_link_leads_to_is_told_by_its_path() {
        assert_eq!(client_by_path("/Users/ann/.local/share/claude/versions/2.1.281"), Some("claude"));
        assert_eq!(client_by_path("/opt/homebrew/Caskroom/codex/0.156.1/codex-aarch64-apple-darwin"), Some("codex"));
        assert_eq!(client_by_path("/opt/homebrew/Caskroom/codex/0.156.1/codex-code-mode-host"), None);
        assert_eq!(client_by_path("/usr/local/bin/python3"), None);
    }

    /// The system calls of each platform, on this very process: runs wherever the tests do.
    #[test]
    fn this_process_is_seen_as_it_is() {
        let me = std::process::id();
        let own = sys::processes().into_iter().find(|p| p.pid == me).expect("in the list");
        #[cfg(unix)]
        assert_eq!(own.parent, std::os::unix::process::parent_id());
        let (started, cpu) = own.times.or_else(|| sys::times(me)).expect("its times");
        let now = crate::model::now_ms();
        assert!(started <= now + 1_000 && now - started < 3_600_000, "started within the hour: {started} vs {now}");
        let spin = Instant::now();
        let mut spun = 0u64;
        while spin.elapsed().as_millis() < 300 {
            spun = std::hint::black_box(spun.wrapping_add(1));
        }
        let (_, later) = sys::times(me).expect("its times again");
        assert!(later > cpu, "CPU time grows: {cpu} then {later}");
        assert!(sys::mine(me));
        #[cfg(unix)]
        assert_eq!(
            sys::cwd(me).and_then(|dir| dir.canonicalize().ok()),
            std::env::current_dir().ok().and_then(|dir| dir.canonicalize().ok())
        );
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
