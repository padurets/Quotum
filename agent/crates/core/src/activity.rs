//! Which coding agents run on this machine, and whether they are working: read from the
//! process metadata alone. No client settings, hooks or session files are read or changed:
//! a session is a client's process, and it works while its owned process tree spends CPU.
//! Proven service/shared branches have their own accounting and no inherited project.
//! Reaped CPU of their ancestors is ambiguous and excluded for those process births.
//!
//! The agent may check this often, so a check is one pass over the process list for
//! names and parents; start times, CPU times and folders are read only for the clients'
//! own process trees. On Linux, a bounded invocation prefix of this user's Codex processes
//! distinguishes known service roles; no program is started for it.
//!
//! A session's project is the git repository its folder is in, found once per session and
//! folder by the `.git` above it (see [`place`]); git is not run and none of its settings
//! is read.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
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
#[derive(Clone, PartialEq)]
pub struct Session {
    pub provider: Provider,
    pub pid: u32,
    pub(crate) native_birth: Option<Vec<u8>>,
    pub started_at: Millis,
    /// The project it works in: the repository its folder belongs to, else the folder itself.
    pub project: Option<String>,
    /// The name of the folder it works in, when that is not a home or temporary folder.
    pub folder: Option<String>,
    /// Whether it is working, idle, or not yet known (seen once so far).
    pub working: Option<bool>,
    /// When an idle session last spent CPU like a working one, if seen on reliable clocks.
    pub last_worked: Option<Millis>,
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
#[derive(Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    /// Its start and CPU time, when the list gives them at no extra cost (Linux).
    pub times: Option<Times>,
    pub(crate) native_birth: Option<Vec<u8>>,
    /// Linux process session, not a coding-agent session identity.
    pub sid: Option<u32>,
    /// Executable file identity on Linux; no executable contents are read.
    pub image: Option<(u64, u64)>,
    /// Bounded invocation classification; unavailable metadata proves no new boundary.
    pub role: Role,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Unknown,
    Unavailable,
    Service,
    Runtime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Times {
    pub started: Millis,
    pub own: u64,
    pub reaped: u64,
}

impl Proc {
    fn key(&self) -> Option<(u32, Vec<u8>)> {
        Some(cache_key(self.pid, self.times?.started, self.native_birth.as_deref()))
    }

    fn same_process(&self, other: &Proc) -> bool {
        self.pid == other.pid
            && self.name == other.name
            && self.parent == other.parent
            && self.sid == other.sid
            && self.image == other.image
            && self.native_birth == other.native_birth
            && (self.native_birth.is_some() || self.times.map(|t| t.started) == other.times.map(|t| t.started))
    }
}

/// Read only enough of a NUL-separated invocation to recognise a known service role.
/// There is no read-ahead, no argument dump, and nothing after the role is read. Unknown
/// options or a partial/unreadable prefix keep the process eligible to be a session.
#[cfg(any(target_os = "linux", test))]
fn codex_role(mut input: impl Read) -> Role {
    let mut byte = [0];
    // argv[0] is the executable's name, not a role. Bound even that skip.
    let mut ended = false;
    for _ in 0..2048 {
        if input.read_exact(&mut byte).is_err() {
            return Role::Unavailable;
        }
        if byte[0] == 0 {
            ended = true;
            break;
        }
    }
    if !ended {
        return Role::Unavailable;
    }
    match invocation_word(&mut input, &[b"app-server\0"]) {
        Ok(Some(0)) => (),
        Ok(_) => return Role::Unknown,
        Err(_) => return Role::Unavailable,
    }
    match input.read_exact(&mut byte) {
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Role::Runtime,
        Err(_) => return Role::Unavailable,
        Ok(()) if byte[0] == b'-' => return Role::Runtime,
        Ok(()) => (),
    }
    // Replay the first byte of the subcommand without reading any argument values.
    let mut input = byte.as_slice().chain(input);
    match invocation_word(&mut input, &[b"proxy\0", b"daemon\0"]) {
        Ok(Some(0)) => Role::Service,
        Ok(Some(1)) => match invocation_word(&mut input, &[b"pid-update-loop\0"]) {
            Ok(Some(0)) => Role::Service,
            Ok(_) => Role::Unknown,
            Err(_) => Role::Unavailable,
        },
        Ok(_) => Role::Unknown,
        Err(_) => Role::Unavailable,
    }
}

#[cfg(any(target_os = "linux", test))]
fn invocation_word(input: &mut impl Read, words: &[&[u8]]) -> std::io::Result<Option<usize>> {
    let mut possible: Vec<usize> = (0..words.len()).collect();
    for at in 0..words.iter().map(|word| word.len()).max().unwrap_or(0) {
        let mut byte = [0];
        input.read_exact(&mut byte)?;
        possible.retain(|&i| words[i].get(at) == Some(&byte[0]));
        if possible.is_empty() {
            return Ok(None);
        }
        if byte[0] == 0 {
            return Ok(possible.first().copied());
        }
    }
    Ok(None)
}

#[cfg(any(target_os = "linux", test))]
fn with_role(mut before: Proc, role: Role, after: Option<Proc>) -> Option<Proc> {
    let after = after?;
    if !before.same_process(&after) {
        return None;
    }
    before.role = role;
    Some(before)
}

fn cache_key(pid: u32, wall: Millis, native: Option<&[u8]>) -> (u32, Vec<u8>) {
    let mut key = vec![u8::from(native.is_some())];
    key.extend_from_slice(native.unwrap_or(&wall.to_be_bytes()));
    (pid, key)
}

/// What the last look saw of a session.
struct Seen {
    /// CPU time of its owned tree on the current accounting basis, and when it was read.
    cpu: u64,
    at: Instant,
    wall: Millis,
    /// When it last spent like a working session.
    busy_at: Option<Instant>,
    busy_wall: Option<Millis>,
    working: Option<bool>,
}

impl Seen {
    fn last_worked(&self, started_at: Millis, now: Millis) -> Option<Millis> {
        self.busy_wall.filter(|&at| self.working == Some(false) && started_at <= at && at <= now)
    }
}

type ProcessKey = (u32, Vec<u8>);

#[derive(Default)]
struct Lifetime {
    name: String,
    image: Option<(u64, u64)>,
    role: Option<Role>,
    shared: bool,
    reaped_unsafe: bool,
}

#[derive(PartialEq, Eq)]
struct Basis {
    shared: bool,
    unsafe_processes: Vec<ProcessKey>,
}

/// The accounting owner of a birth on one look, including excluded processes.
struct Scope {
    owner: Option<ProcessKey>,
    name: String,
    provider: Option<Provider>,
    image: Option<(u64, u64)>,
    role: Role,
}

/// Looks at the running clients again and again; working or idle is told by the CPU time
/// spent between two looks.
pub struct Activity {
    /// Folders that are not projects, as given and as the system resolves them.
    homes: Vec<PathBuf>,
    temps: Vec<PathBuf>,
    /// Folders not to be looked into for a repository (macOS guards them).
    shielded: Vec<PathBuf>,
    /// Each session at the last look, by pid and start (pids are reused).
    last: HashMap<(u32, Vec<u8>), Seen>,
    /// Each session's folder at the last look, and where that placed it.
    places: HashMap<(u32, Vec<u8>), (PathBuf, Place)>,
    /// Whether sessions are placed at all: with project names turned off, no folder is looked at.
    placing: bool,
    /// Shared authority and unsafe reaping survive reparenting and missing metadata.
    lifetimes: HashMap<ProcessKey, Lifetime>,
    /// Changing ownership invalidates a delta and hold computed from the old tree.
    bases: HashMap<ProcessKey, Basis>,
    scopes: HashMap<ProcessKey, Scope>,
    pending_unsafe: HashSet<ProcessKey>,
}

impl Activity {
    /// Looks at the clients of this user; `placing` whether to tell their folders and projects.
    pub fn new(home: PathBuf, placing: bool) -> Activity {
        // A client's folder comes resolved (/private/var/… on macOS for /var/…).
        let both = |dir: PathBuf| [dir.canonicalize().ok(), Some(dir)].into_iter().flatten().collect::<Vec<_>>();
        let mut temps = both(std::env::temp_dir());
        temps.extend(["/tmp", "/private/tmp", "/var/tmp"].map(PathBuf::from));
        // Merely looking inside these may make macOS ask the person to allow it, on behalf of
        // a tool that promises to read nothing of theirs.
        let shielded = if cfg!(target_os = "macos") {
            ["Desktop", "Documents", "Downloads", "Library/Mobile Documents"]
                .iter()
                .map(|dir| home.join(dir))
                .chain([PathBuf::from("/Volumes")])
                .flat_map(both)
                .collect()
        } else {
            Vec::new()
        };
        Activity {
            homes: both(home),
            temps,
            shielded,
            last: HashMap::new(),
            places: HashMap::new(),
            placing,
            lifetimes: HashMap::new(),
            bases: HashMap::new(),
            scopes: HashMap::new(),
            pending_unsafe: HashSet::new(),
        }
    }

    pub fn look(&mut self) -> Vec<Session> {
        let now = Instant::now();
        let wall = crate::model::now_ms();
        let procs = sys::processes();
        let gone: HashSet<_> = self
            .lifetimes
            .keys()
            .chain(self.pending_unsafe.iter())
            .filter(|(pid, _)| sys::gone(*pid))
            .cloned()
            .collect();
        self.lifetimes.retain(|key, _| !gone.contains(key));
        self.scopes.retain(|key, _| !gone.contains(key));
        self.pending_unsafe.retain(|key| !gone.contains(key));
        self.observe(&procs, std::process::id(), now, wall, &sys::verified, &sys::cwd, &sys::exe, &sys::mine)
    }

    /// The production sampling path with process metadata supplied by the OS or stand-ins.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn observe(
        &mut self,
        procs: &[Proc],
        own: u32,
        now: Instant,
        wall: Millis,
        read: &dyn Fn(&Proc) -> Option<Proc>,
        cwd: &dyn Fn(u32) -> Option<PathBuf>,
        exe: &dyn Fn(u32) -> Option<String>,
        mine: &dyn Fn(u32) -> bool,
    ) -> Vec<Session> {
        let by_pid: HashMap<_, _> = procs.iter().map(|p| (p.pid, p)).collect();
        let mut relevant = HashSet::new();
        for p in procs.iter().filter(|p| provider_of(&p.name).is_some() && mine(p.pid)) {
            relevant.insert(p.pid);
            relevant.extend(ancestors(p.pid, &by_pid));
        }
        // Descendants are CPU contributors, even when their name is not a client.
        let mut tree: Vec<_> = relevant
            .iter()
            .copied()
            .filter(|pid| by_pid.get(pid).is_some_and(|p| provider_of(&p.name).is_some()))
            .collect();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for p in procs {
            children.entry(p.parent).or_default().push(p.pid);
        }
        let mut at = 0;
        while at < tree.len() && tree.len() < 4096 {
            for &pid in children.get(&tree[at]).into_iter().flatten() {
                if tree.len() < 4096 && relevant.insert(pid) {
                    tree.push(pid);
                }
            }
            at += 1;
        }
        let mut validated: Vec<_> = procs.iter().filter(|p| relevant.contains(&p.pid)).filter_map(read).collect();
        for p in &mut validated {
            let Some(key) = p.key() else { continue };
            // A reused PID proves the older birth ended; absence alone proves nothing.
            self.lifetimes.retain(|old, _| old.0 != p.pid || *old == key);
            self.scopes.retain(|old, _| old.0 != p.pid || *old == key);
            self.pending_unsafe.retain(|old| old.0 != p.pid || *old == key);
            let lifetime = self.lifetimes.entry(key).or_default();
            let replaced_image = lifetime.image.zip(p.image).is_some_and(|(before, after)| before != after);
            if lifetime.name != p.name || replaced_image {
                lifetime.shared = false;
                lifetime.role = None;
            }
            lifetime.name = p.name.clone();
            // Missing file metadata is not proof of exec, nor a replacement for the
            // last known image. A later readable different inode is positive evidence.
            if p.image.is_some() {
                lifetime.image = p.image;
            }
            if p.role == Role::Unavailable {
                // The OS snapshot already bracketed this role read with birth checks.
                // Losing a later read does not revoke its proven boundary.
                let listed_role = by_pid.get(&p.pid).filter(|listed| listed.same_process(p)).map(|p| p.role);
                p.role = listed_role
                    .filter(|role| *role != Role::Unavailable)
                    .or(lifetime.role)
                    .unwrap_or(Role::Unavailable);
            }
            if p.role != Role::Unavailable {
                if lifetime.role != Some(p.role) {
                    lifetime.shared = false;
                }
                lifetime.role = Some(p.role);
            }
        }
        let mut shared: HashSet<_> = validated
            .iter()
            .filter_map(|p| {
                let key = p.key()?;
                self.lifetimes.get(&key)?.shared.then_some(p.pid)
            })
            .collect();
        // Read each possible remote editor path once, on a checked birth. Missing
        // host information is unknown ownership, not evidence of a shared runtime.
        let mut paths = HashMap::new();
        for p in procs.iter().filter(|p| remote_node(&p.name)) {
            let path = validated.iter().find(|q| q.pid == p.pid).and_then(|listed| {
                let before = read(listed)?;
                let path = exe(p.pid)?;
                let after = read(&before)?;
                before.same_process(&after).then_some(path)
            });
            paths.insert(p.pid, path);
        }
        let checked_exe = |pid| paths.get(&pid).cloned().flatten();
        let available: HashSet<_> = validated.iter().map(|p| p.pid).collect();
        let unproven: HashSet<_> = procs
            .iter()
            .filter(|p| p.role == Role::Runtime || validated.iter().any(|q| q.pid == p.pid && q.role == Role::Runtime))
            .filter(|p| {
                ancestors(p.pid, &by_pid).iter().any(|pid| {
                    by_pid.contains_key(pid)
                        && (!available.contains(pid)
                            || by_pid.get(pid).is_some_and(|p| remote_node(&p.name))
                                && paths.get(pid).is_none_or(Option::is_none))
                })
            })
            .map(|p| p.pid)
            .collect();
        let planned = sessions_with(procs, own, &checked_exe, &shared, &unproven);
        // The original graph proves measurement ancestry even if an intermediate
        // parent becomes unreadable during the additional identity checks.
        let measuring: HashSet<_> = procs
            .iter()
            .filter(|p| {
                p.pid == own
                    || is_quotum(&p.name)
                    || ancestors(p.pid, &by_pid)
                        .iter()
                        .any(|pid| *pid == own || by_pid.get(pid).is_some_and(|p| is_quotum(&p.name)))
            })
            .map(|p| p.pid)
            .collect();
        // Preserve an initially proven shared boundary for identity-valid roots.
        // Losing its parent metadata does not grant inherited cwd authority.
        for f in planned.iter().filter(|f| f.authority == Authority::Shared) {
            if validated.iter().any(|p| {
                p.pid == f.pid
                    && by_pid[&p.pid].same_process(p)
                    && (by_pid[&p.pid].role == Role::Unavailable || by_pid[&p.pid].role == p.role)
            }) {
                shared.insert(f.pid);
            }
        }
        let found: Vec<_> = sessions_with(&validated, own, &checked_exe, &shared, &unproven)
            .into_iter()
            .filter(|f| !measuring.contains(&f.pid))
            .collect();
        let original = by_pid;
        let by_pid: HashMap<_, _> = validated.iter().map(|p| (p.pid, p)).collect();
        let incomplete: HashSet<_> =
            planned.iter().filter(|f| f.tree.iter().any(|pid| !by_pid.contains_key(pid))).map(|f| f.pid).collect();
        // A boundary proven in the initial snapshot may already have exited or exec'd
        // by validation. Its old branch can still be reaped into validated ancestors.
        for pid in procs
            .iter()
            .filter(|p| p.role == Role::Service)
            .map(|p| p.pid)
            .chain(planned.iter().filter(|f| f.authority == Authority::Shared).map(|f| f.pid))
        {
            for ancestor in ancestors(pid, &original) {
                if let Some(key) = original.get(&ancestor).and_then(|p| p.key()) {
                    // The snapshot pins the fact to this birth. Apply it only when
                    // that same birth is validated, including after a metadata gap.
                    self.pending_unsafe.insert(key);
                }
            }
        }
        for p in &validated {
            if let Some(key) = p.key().filter(|key| self.pending_unsafe.remove(key)) {
                self.lifetimes.entry(key).or_default().reaped_unsafe = true;
            }
        }
        let barriers: HashSet<_> = validated
            .iter()
            .filter(|p| p.role == Role::Service)
            .map(|p| p.pid)
            .chain(found.iter().filter(|f| f.authority == Authority::Shared).map(|f| f.pid))
            .chain(
                validated
                    .iter()
                    .filter(|p| p.key().is_some_and(|key| self.lifetimes.get(&key).is_some_and(|l| l.reaped_unsafe)))
                    .map(|p| p.pid),
            )
            .collect();
        for &pid in &barriers {
            for ancestor in ancestors(pid, &by_pid) {
                if let Some(key) = by_pid.get(&ancestor).and_then(|p| p.key()) {
                    self.lifetimes.entry(key).or_default().reaped_unsafe = true;
                }
            }
        }
        for f in &found {
            if f.authority == Authority::Shared {
                if let Some(key) = by_pid[&f.pid].key() {
                    self.lifetimes.entry(key).or_default().shared = true;
                }
            }
        }
        let mut scopes: HashMap<_, _> = validated
            .iter()
            .filter_map(|p| {
                let key = p.key()?;
                let image = self.lifetimes.get(&key).and_then(|l| l.image);
                Some((
                    key,
                    Scope { owner: None, name: p.name.clone(), provider: provider_of(&p.name), image, role: p.role },
                ))
            })
            .collect();
        for f in found.iter().filter(|f| mine(f.pid)) {
            let Some(owner) = by_pid[&f.pid].key() else { continue };
            for pid in f.tree.iter().filter(|&&pid| mine(pid)) {
                if let Some(scope) = by_pid[pid].key().and_then(|key| scopes.get_mut(&key)) {
                    scope.owner = Some(owner.clone());
                }
            }
        }
        let mut changed = HashSet::new();
        for (key, scope) in &scopes {
            let Some(before) = self.scopes.get(key) else { continue };
            let changed_authority = (before.provider.is_some() || scope.provider.is_some())
                && (before.name != scope.name
                    || before.provider != scope.provider
                    || before.image.zip(scope.image).is_some_and(|(a, b)| a != b)
                    || (scope.role != Role::Unavailable && before.role != scope.role));
            if before.owner != scope.owner || changed_authority {
                changed.extend(before.owner.clone());
                changed.extend(scope.owner.clone());
            }
        }
        let mut seen = HashMap::new();
        let mut bases = HashMap::new();
        let mut folders = Vec::new();
        let mut result = Vec::new();
        for f in found.into_iter().filter(|f| mine(f.pid)) {
            let root = by_pid[&f.pid];
            let Some(key) = root.key() else { continue };
            let mut cpu = 0u64;
            let mut unsafe_processes = Vec::new();
            // Recheck every contributor, not only the root. A failed read is no busy evidence.
            let mut complete = !incomplete.contains(&f.pid);
            for pid in &f.tree {
                if !mine(*pid) {
                    continue;
                }
                let p = by_pid[pid];
                let Some(current) =
                    read(p).filter(|q| p.same_process(q) && (q.role == Role::Unavailable || p.role == q.role))
                else {
                    complete = false;
                    continue;
                };
                let Some(times) = current.times else {
                    complete = false;
                    continue;
                };
                let unsafe_reaped =
                    p.key().is_some_and(|key| self.lifetimes.get(&key).is_some_and(|l| l.reaped_unsafe));
                cpu = cpu.saturating_add(times.own);
                if unsafe_reaped {
                    unsafe_processes.extend(p.key());
                } else {
                    cpu = cpu.saturating_add(times.reaped);
                }
            }
            unsafe_processes.sort();
            let basis = Basis { shared: f.authority != Authority::Owned, unsafe_processes };
            let before = self
                .last
                .get(&key)
                .filter(|_| self.bases.get(&key) == Some(&basis) && complete && !changed.contains(&key));
            let next = judged(before, cpu, now, wall, working_share(f.provider));
            let started_at = root.times.unwrap().started;
            let working = if complete { next.working } else { None };
            let last_worked = next.last_worked(started_at, wall);
            if complete {
                seen.insert(key.clone(), next);
                bases.insert(key.clone(), basis);
            }
            if f.authority != Authority::Owned {
                self.places.remove(&key);
            } else {
                folders.push((key.clone(), f.pid));
            }
            result.push(Session {
                provider: f.provider,
                pid: f.pid,
                native_birth: root.native_birth.clone(),
                started_at,
                project: None,
                folder: None,
                working,
                last_worked,
                origin: f.origin,
            });
        }
        let placed = self.placed(folders.clone(), cwd);
        let places: HashMap<_, _> = folders.into_iter().map(|(_, pid)| pid).zip(placed).collect();
        result.retain_mut(|session| {
            let root = by_pid[&session.pid];
            let valid = read(root)
                .is_some_and(|p| root.same_process(&p) && (p.role == Role::Unavailable || root.role == p.role));
            if !valid {
                if let Some(key) = root.key() {
                    seen.remove(&key);
                    bases.remove(&key);
                    self.places.remove(&key);
                }
            } else if let Some(place) = places.get(&session.pid) {
                session.folder = place.folder.clone();
                session.project = place.project.clone();
            }
            valid
        });
        self.last = seen;
        self.bases = bases;
        // Missing metadata never proves a birth ended. Positive replacement is
        // pruned above; the OS exit check in look prunes finished births.
        self.scopes.extend(scopes);
        result
    }

    /// Where the sessions of a look are, by their folders now (`cwd` tells a process's, none
    /// when not known) and where the last look placed them, which is kept for the next one:
    /// a session's folder is looked into once, and again when it changes. Not placing, no
    /// folder is read at all.
    fn placed(&mut self, sessions: Vec<((u32, Vec<u8>), u32)>, cwd: &dyn Fn(u32) -> Option<PathBuf>) -> Vec<Place> {
        if !self.placing {
            self.places.clear();
            return sessions.iter().map(|_| Place::default()).collect();
        }
        let mut kept = HashMap::new();
        let found = sessions
            .into_iter()
            .map(|(key, pid)| {
                let Some(dir) = cwd(pid) else { return Place::default() };
                let known = self.places.get(&key);
                let entry = match placing(&dir, known.map(|(dir, _)| dir.as_path()), &self.shielded) {
                    Placing::Kept => known.cloned(),
                    Placing::Anew => {
                        let place = place(&dir, &self.homes, &self.temps, &self.shielded);
                        Some((dir, place))
                    }
                    Placing::Named => {
                        let folder = named(&dir, &self.homes, &self.temps);
                        Some((dir, Place { project: folder.clone(), folder }))
                    }
                    Placing::Unknown => None,
                };
                kept.extend(entry.clone().map(|entry| (key.clone(), entry)));
                entry.map(|(_, place)| place).unwrap_or_default()
            })
            .collect();
        self.places = kept;
        found
    }
}

/// What a look does about a session's folder: keep what it placed the session in last
/// time, place it anew, name it by the folder alone, or leave it without folder and project.
#[derive(Debug, PartialEq)]
enum Placing {
    Kept,
    Anew,
    Named,
    Unknown,
}

/// The same folder as before is placed as before. A folder removed under a session (a
/// worktree removed while an agent works in it) keeps where it was; so does one the agent
/// cannot see any more. Linux tells a removed one by ` (deleted)` after its path, which is
/// not there: never a name to send, so without an earlier place it is unknown. A folder the
/// agent cannot see at all (a client in a container of its own) is named by itself, as it
/// was before projects were recognised. A guarded folder is not checked for being there.
fn placing(dir: &Path, known: Option<&Path>, shielded: &[PathBuf]) -> Placing {
    if known == Some(dir) {
        return Placing::Kept;
    }
    if !matches!(probe(dir, shielded), Look::Missing) {
        return Placing::Anew;
    }
    match known {
        Some(_) => Placing::Kept,
        None if dir.to_string_lossy().ends_with(" (deleted)") => Placing::Unknown,
        None => Placing::Named,
    }
}

/// A session seen again with its tree at `cpu` ms: working when it spent at least `share`
/// of a core since the look before, and for `HOLD_MS` after.
fn judged(before: Option<&Seen>, cpu: u64, now: Instant, wall: Millis, share: f64) -> Seen {
    let Some(before) = before else {
        return Seen { cpu, at: now, wall, busy_at: None, busy_wall: None, working: None };
    };
    let elapsed = now.duration_since(before.at).as_millis();
    // A clock correction invalidates the remembered date, but never working or its hold.
    let continuous = ((wall as i128 - before.wall as i128) - elapsed as i128).abs() <= 2_000;
    let busy_wall = before.busy_wall.filter(|_| continuous);
    if elapsed < MIN_LOOK_MS {
        // Looked again too soon: it stays as it was, measured from the earlier look.
        return Seen {
            cpu: before.cpu,
            at: before.at,
            wall: before.wall,
            busy_at: before.busy_at,
            busy_wall,
            working: before.working,
        };
    }
    let busy = cpu.saturating_sub(before.cpu) as f64 / elapsed as f64 >= share;
    let busy_at = if busy { Some(now) } else { before.busy_at };
    let busy_wall = if busy { Some(wall) } else { busy_wall };
    let working = busy_at.is_some_and(|at| now.duration_since(at).as_millis() < HOLD_MS);
    Seen { cpu, at: now, wall, busy_at, busy_wall, working: Some(working) }
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

/// The sessions among `procs`. Not sessions: clients started by the agent itself to
/// measure (below this process `own` or any `quotum`), known service roles, and a client
/// under another of the same kind (a launcher and the program it runs). A session under a session of another kind is its
/// own, and its tree is not counted in the one above. Proven service and shared runtime
/// boundaries stop folding and CPU ownership, but never measurement ancestry exclusion.
/// `exe` identifies editor ancestors whose names alone do not tell their origin.
fn ancestors(pid: u32, by_pid: &HashMap<u32, &Proc>) -> Vec<u32> {
    let mut list = Vec::new();
    let mut at = by_pid.get(&pid).map(|p| p.parent);
    while let Some(parent) = at.filter(|&a| a != 0 && a != pid && !list.contains(&a) && list.len() < 64) {
        list.push(parent);
        at = by_pid.get(&parent).map(|p| p.parent);
    }
    list
}

pub fn sessions(procs: &[Proc], own: u32, exe: &dyn Fn(u32) -> Option<String>) -> Vec<Found> {
    sessions_with(procs, own, exe, &HashSet::new(), &HashSet::new())
}

fn sessions_with(
    procs: &[Proc],
    own: u32,
    exe: &dyn Fn(u32) -> Option<String>,
    shared: &HashSet<u32>,
    unproven: &HashSet<u32>,
) -> Vec<Found> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        children.entry(p.parent).or_default().push(p.pid);
    }
    let mut boundaries: HashSet<u32> =
        procs.iter().filter(|p| p.role == Role::Service).map(|p| p.pid).chain(shared.iter().copied()).collect();
    for p in procs.iter().filter(|p| p.role == Role::Runtime) {
        let above = ancestors(p.pid, &by_pid);
        let owner = above.iter().filter_map(|pid| by_pid.get(pid)).find(|p| provider_of(&p.name).is_some());
        if owner.is_some_and(|owner| p.sid.zip(owner.sid).is_some_and(|(a, b)| a != b)) {
            boundaries.insert(p.pid);
        }
    }
    let client = |p: &Proc| (p.role != Role::Service).then(|| provider_of(&p.name)).flatten();
    let mut found = HashMap::new();
    let mut uncertain = unproven.clone();
    // Newly found unowned/shared roots are barriers in this very observation,
    // including for other-provider descendants. Each pass only adds a boundary.
    loop {
        found.clear();
        let mut added = false;
        for p in procs {
            let Some(provider) = client(p) else { continue };
            let ancestry = ancestors(p.pid, &by_pid);
            let above: Vec<&Proc> = ancestry.iter().filter_map(|pid| by_pid.get(pid).copied()).collect();
            if p.pid == own || is_quotum(&p.name) || ancestry.contains(&own) || above.iter().any(|p| is_quotum(&p.name))
            {
                continue;
            }
            let separated = boundaries.contains(&p.pid) || above.iter().any(|p| boundaries.contains(&p.pid));
            let incomplete = uncertain.contains(&p.pid) || above.iter().any(|p| uncertain.contains(&p.pid));
            let owner = above
                .iter()
                .take_while(|p| !boundaries.contains(&p.pid) && !uncertain.contains(&p.pid))
                .find_map(|p| client(p));
            if !separated && !incomplete && owner == Some(provider) {
                continue;
            }
            let origin = origin(&above, exe);
            let authority = if separated {
                Authority::Shared
            } else if incomplete {
                Authority::Unproven
            } else if p.role == Role::Runtime && owner.is_none() && origin == Origin::Terminal {
                Authority::Shared
            } else {
                Authority::Owned
            };
            match authority {
                Authority::Shared => added |= boundaries.insert(p.pid),
                Authority::Unproven => added |= uncertain.insert(p.pid),
                Authority::Owned => (),
            }
            found.insert(p.pid, (provider, origin, authority));
        }
        if !added {
            break;
        }
    }
    let mut list: Vec<_> = found
        .iter()
        .map(|(&pid, &(provider, origin, authority))| {
            let mut tree = vec![pid];
            let mut at = 0;
            while at < tree.len() && tree.len() < 4096 {
                for &child in children.get(&tree[at]).into_iter().flatten() {
                    if !found.contains_key(&child)
                        && !boundaries.contains(&child)
                        && !uncertain.contains(&child)
                        && tree.len() < 4096
                    {
                        tree.push(child);
                    }
                }
                at += 1;
            }
            Found { provider, pid, origin, tree, authority }
        })
        .collect();
    list.sort_by_key(|f| (f.provider, f.pid));
    list
}

/// A process session and its owned CPU tree. Shared roots have no placement authority.
#[derive(Debug, PartialEq)]
pub struct Found {
    pub provider: Provider,
    pub pid: u32,
    pub origin: Origin,
    pub tree: Vec<u32>,
    pub authority: Authority,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    Owned,
    Unproven,
    Shared,
}

fn remote_node(name: &str) -> bool {
    ["node", "mainthread"].contains(&name.strip_suffix(".exe").unwrap_or(name).to_ascii_lowercase().as_str())
}

/// Where a client runs, from the programs above it: an editor, the desktop app of its
/// provider, or else a terminal (a shell, a multiplexer, ssh). An editor's server on a
/// remote machine (VS Code over SSH, Cursor, code-server) is a Node.js found by its path:
/// named `node`, or `MainThread` on Linux since Node 24 (the name of its main thread).
fn origin(above: &[&Proc], exe: &dyn Fn(u32) -> Option<String>) -> Origin {
    const SERVERS: [&str; 6] = [
        ".vscode-server",
        ".vscodium-server",
        ".cursor-server",
        ".windsurf-server",
        ".antigravity-server",
        "code-server",
    ];
    const EDITORS: [&str; 6] = ["code", "code-insiders", "codium", "cursor", "windsurf", "antigravity"];
    const HELPERS: [&str; 5] =
        ["code helper", "code - insiders", "cursor helper", "windsurf helper", "antigravity helper"];
    above
        .iter()
        .find_map(|p| {
            let bare = p.name.strip_suffix(".exe").unwrap_or(&p.name);
            let name = bare.to_ascii_lowercase();
            let server = || {
                ["node", "mainthread"].contains(&name.as_str())
                    && exe(p.pid).is_some_and(|path| SERVERS.iter().any(|s| path.contains(s)))
            };
            if EDITORS.contains(&name.as_str()) || HELPERS.iter().any(|helper| name.starts_with(helper)) || server() {
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

/// The folder's name, when it may name anything: not a home folder, anything above it or
/// a temporary folder.
fn named(dir: &Path, homes: &[PathBuf], temps: &[PathBuf]) -> Option<String> {
    if homes.iter().any(|home| home.starts_with(dir)) || temps.iter().any(|temp| dir.starts_with(temp)) {
        return None;
    }
    dir.file_name().map(|name| name.to_string_lossy().into_owned())
}

/// The names a session's folder gives it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Place {
    folder: Option<String>,
    project: Option<String>,
}

/// Where a session working in `dir` is: its folder, and its project, the git repository the
/// folder is in (for a worktree, the repository it belongs to), else the folder. A
/// repository whose main folder is a home or temporary folder names no project.
///
/// The repository is found by the `.git` in the folder or above it, not in the home folder
/// or above (a home kept in git is not one project). A `.git` folder makes its folder the
/// main one. A `.git` file (`gitdir: <path>`) is a worktree when that git folder has a
/// `commondir`, which leads to the main repository's git folder; else (a submodule, a
/// separate git folder, an unreadable file) its folder is the main one. Only these two
/// small files are read, and nothing in the `shielded` folders, through a path or a link
/// that leads there (see [`probe`]).
///
/// Known to go wrong (a person merges or renames such projects on the hub):
/// - with `--separate-git-dir` and worktrees, the main checkout is named after its folder
///   and its worktrees after the git folder (only `core.worktree` in its config tells);
/// - a submodule added with a `--name` other than its path: it is named after its folder,
///   its worktrees after its name;
/// - a main checkout whose `.git` is a link (`quotum/.git → store/q-git`) is named after
///   its folder, its worktrees after the git folder (`q-git`);
/// - a folder the system guards on macOS is a project of its own, not its repository's;
/// - the check for guarded folders reads paths as written: a hand-made chain of links, or
///   a link inside a path, may still lead there, and macOS may ask for access.
fn place(dir: &Path, homes: &[PathBuf], temps: &[PathBuf], shielded: &[PathBuf]) -> Place {
    let folder = named(dir, homes, temps);
    let project = match repository(dir, homes, shielded) {
        Some((main, bare)) => named(&main, homes, temps)
            .map(|name| if bare { name.strip_suffix(".git").map(str::to_string).unwrap_or(name) } else { name }),
        None => folder.clone(),
    };
    Place { folder, project }
}

/// The main folder of the repository `dir` is in, and whether that is a bare repository
/// named `<name>.git`; none found, or not to be looked for.
fn repository(dir: &Path, homes: &[PathBuf], shielded: &[PathBuf]) -> Option<(PathBuf, bool)> {
    for folder in dir.ancestors() {
        if homes.iter().any(|home| home.starts_with(folder)) {
            return None;
        }
        match probe(&folder.join(".git"), shielded) {
            // In a guarded folder, or a link that leads into one: not looked at further.
            Look::Shielded => return None,
            Look::Missing => continue,
            Look::Found((Kind::Folder, _)) => return Some((folder.to_path_buf(), false)),
            Look::Found((Kind::File, file)) => return worktree(folder, &file, shielded),
        }
    }
    None
}

/// The main folder of the repository whose `.git` in `folder` is the file `file`.
fn worktree(folder: &Path, file: &Path, shielded: &[PathBuf]) -> Option<(PathBuf, bool)> {
    let own = Some((folder.to_path_buf(), false));
    let text = match read_small(file, shielded) {
        Look::Found(text) => text,
        Look::Missing => return own,
        Look::Shielded => return None,
    };
    let Some(gitdir) = text.lines().next().and_then(|line| line.strip_prefix("gitdir:")).map(str::trim) else {
        return own;
    };
    if gitdir.is_empty() {
        return own;
    }
    let gitdir = normal(&folder.join(gitdir));
    match read_small(&gitdir.join("commondir"), shielded) {
        Look::Found(common) => Some(repo_folder(&normal(&gitdir.join(common.trim())))),
        Look::Missing => own,
        // Its git folder is guarded: not looked into, and so not known.
        Look::Shielded => None,
    }
}

/// The main folder of the repository whose git folder is `common`, and whether that is a
/// bare repository named `<name>.git`.
fn repo_folder(common: &Path) -> (PathBuf, bool) {
    let name = common.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let parent = || common.parent().unwrap_or(common).to_path_buf();
    if name == ".git" {
        (parent(), false)
    } else if name.len() > 4 && name.ends_with(".git") {
        (common.to_path_buf(), true)
    } else if name.starts_with('.') {
        // `.bare` beside the worktrees.
        (parent(), false)
    } else {
        // A bare repository by another name, or a submodule's git folder (`.git/modules/<name>`).
        (common.to_path_buf(), false)
    }
}

/// The path with `.` and `..` worked out as written, without asking the file system.
fn normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other),
        }
    }
    out
}

// Recognising a project touches the file system only through the functions below, and
// each first checks the path it is given: nothing inside a guarded folder is touched.

/// What a look at a path found.
#[derive(Debug, PartialEq)]
enum Look<T> {
    /// The path is in a guarded folder, or a link leads there: nothing was touched.
    Shielded,
    /// Nothing there, or not readable.
    Missing,
    Found(T),
}

#[derive(Debug, PartialEq)]
enum Kind {
    Folder,
    File,
}

fn guarded(path: &Path, shielded: &[PathBuf]) -> bool {
    let path = normal(path);
    shielded.iter().any(|dir| path.starts_with(dir))
}

/// A folder or a file at `path`, following a link as git does, and where it is: the link's
/// target, which is checked before the link is followed.
fn probe(path: &Path, shielded: &[PathBuf]) -> Look<(Kind, PathBuf)> {
    if guarded(path, shielded) {
        return Look::Shielded;
    }
    let Ok(own) = fs::symlink_metadata(path) else { return Look::Missing };
    let mut at = path.to_path_buf();
    if own.file_type().is_symlink() {
        let Ok(target) = fs::read_link(path) else { return Look::Missing };
        at = normal(&path.parent().unwrap_or(path).join(target));
        if guarded(&at, shielded) {
            return Look::Shielded;
        }
    }
    match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Look::Found((Kind::Folder, at)),
        Ok(meta) if meta.is_file() => Look::Found((Kind::File, at)),
        // Missing, a broken link or a loop, a pipe or a socket.
        _ => Look::Missing,
    }
}

/// The start of a small file (4 KiB), itself a file and not a link: a pipe would hang the
/// agent, and a link could lead anywhere. What is opened is checked once open, as it may
/// have been replaced since it was looked at (by someone else, in a folder they share).
fn read_small(path: &Path, shielded: &[PathBuf]) -> Look<String> {
    if guarded(path, shielded) {
        return Look::Shielded;
    }
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file()) {
        return Look::Missing;
    }
    let Ok(file) = open_plain(path) else { return Look::Missing };
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Look::Missing;
    }
    let mut text = Vec::new();
    match file.take(4096).read_to_end(&mut text) {
        Ok(_) => Look::Found(String::from_utf8_lossy(&text).into_owned()),
        Err(_) => Look::Missing,
    }
}

/// Opens a path for reading without following a link at its end, and without waiting: a
/// pipe opened to read waits for a writer. Windows has no such pipes among files.
fn open_plain(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    options.open(path)
}

#[cfg(target_os = "linux")]
mod sys {
    //! /proc: one small file per process for the list.

    use std::fs;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::MetadataExt;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use super::{Proc, Role, Times};
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
        let _group = fields.next()??;
        let sid = fields.next()??;
        let own = fields.nth(7)?? + fields.next()??;
        let reaped = fields.next()?? + fields.next()??;
        let start = fields.nth(4)??;
        let tick = ticks_per_second();
        let started = boot_time().map(|boot| boot * 1000 + (start * 1000 / tick) as Millis);
        let times = started.map(|started| Times { started, own: own * 1000 / tick, reaped: reaped * 1000 / tick });
        Some(Proc {
            pid,
            parent: parent as u32,
            sid: Some(sid as u32),
            image: fs::metadata(format!("/proc/{pid}/exe")).ok().map(|m| (m.dev(), m.ino())),
            name: name.to_string(),
            times,
            native_birth: boot_id().map(|boot| crate::session_identity::birth(boot.as_bytes(), pid, start)),
            role: Role::Unknown,
        })
    }

    pub fn processes() -> Vec<Proc> {
        let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
        entries
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(stat)
            .filter_map(|p| {
                if super::provider_of(&p.name) != Some(crate::model::Provider::Codex)
                    || !mine(p.pid)
                    || p.times.is_none()
                {
                    return Some(p);
                }
                let role = fs::File::open(format!("/proc/{}/cmdline", p.pid))
                    .map(super::codex_role)
                    .unwrap_or(Role::Unavailable);
                // The role must belong to the process we listed, even if it exited and its
                // pid was reused during the read. Never cache a role by pid alone.
                let pid = p.pid;
                super::with_role(p, role, stat(pid))
            })
            .collect()
    }

    pub fn verified(listed: &Proc) -> Option<Proc> {
        let before = stat(listed.pid)?;
        if !listed.same_process(&before) {
            return None;
        }
        let role = if super::provider_of(&before.name) == Some(crate::model::Provider::Codex) && mine(before.pid) {
            fs::File::open(format!("/proc/{}/cmdline", before.pid)).map(super::codex_role).unwrap_or(Role::Unavailable)
        } else {
            Role::Unknown
        };
        let after = stat(before.pid);
        super::with_role(before, role, after)
    }

    pub fn gone(pid: u32) -> bool {
        fs::metadata(format!("/proc/{pid}")).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    }

    #[cfg(test)]
    pub fn times(pid: u32) -> Option<Times> {
        stat(pid)?.times
    }

    #[cfg(test)]
    pub fn birth(pid: u32) -> Option<Vec<u8>> {
        stat(pid)?.native_birth
    }

    fn boot_id() -> Option<&'static str> {
        static BOOT: OnceLock<Option<String>> = OnceLock::new();
        BOOT.get_or_init(|| {
            let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
            let boot = boot.trim();
            (boot.len() == 36
                && boot
                    .bytes()
                    .enumerate()
                    .all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }))
            .then(|| boot.to_string())
        })
        .as_deref()
    }

    pub fn cwd(pid: u32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }

    pub fn exe(pid: u32) -> Option<String> {
        Some(fs::read_link(format!("/proc/{pid}/exe")).ok()?.to_string_lossy().into_owned())
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

    use super::{Proc, Role, Times};
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

    fn process_name(pid: u32, bsd: &libc::proc_bsdinfo) -> String {
        // pbi_name is the longer name; pbi_comm is cut at 16 bytes.
        let raw = if bsd.pbi_name[0] != 0 { &bsd.pbi_name[..] } else { &bsd.pbi_comm[..] };
        // SAFETY: both are NUL-terminated within their arrays (zeroed first).
        let mut name = unsafe { CStr::from_ptr(raw.as_ptr()) }.to_string_lossy().into_owned();
        // A name the file a link led to gave (a version, a platform): the path tells the client.
        let linked = name.starts_with(|c: char| c.is_ascii_digit()) || name.starts_with("codex-");
        if let Some(client) = linked.then(|| path(pid)).flatten().as_deref().and_then(super::client_by_path) {
            name = client.to_string();
        }
        name
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
        // SAFETY: getuid only reads this process's real user ID.
        let own = unsafe { libc::getuid() };
        pids.into_iter()
            .filter(|&pid| pid > 0)
            .filter_map(|pid| {
                let bsd: libc::proc_bsdinfo = info(pid as u32, libc::PROC_PIDTBSDINFO)?;
                let name = process_name(pid as u32, &bsd);
                // A second native read belongs only to our candidate clients, not to
                // every process on the machine. Re-read their names inside that token.
                let native_birth =
                    (super::provider_of(&name).is_some() && bsd.pbi_uid == own).then(|| birth(pid as u32)).flatten();
                if native_birth.is_some() {
                    let checked: libc::proc_bsdinfo = info(pid as u32, libc::PROC_PIDTBSDINFO)?;
                    if bsd.pbi_ppid != checked.pbi_ppid
                        || bsd.pbi_start_tvsec != checked.pbi_start_tvsec
                        || bsd.pbi_start_tvusec != checked.pbi_start_tvusec
                        || process_name(pid as u32, &checked) != name
                    {
                        return None;
                    }
                }
                if native_birth.is_some() && birth(pid as u32) != native_birth {
                    return None;
                }
                Some(Proc {
                    pid: pid as u32,
                    parent: bsd.pbi_ppid,
                    sid: None,
                    image: None,
                    name,
                    times: None,
                    native_birth,
                    role: Role::Unknown,
                })
            })
            .collect()
    }

    pub fn verified(listed: &Proc) -> Option<Proc> {
        let before: libc::proc_bsdinfo = info(listed.pid, libc::PROC_PIDTBSDINFO)?;
        let native_birth = birth(listed.pid);
        let times = times(listed.pid)?;
        let after: libc::proc_bsdinfo = info(listed.pid, libc::PROC_PIDTBSDINFO)?;
        let current = Proc {
            times: Some(times),
            native_birth: native_birth.clone(),
            name: process_name(listed.pid, &after),
            parent: after.pbi_ppid,
            ..listed.clone()
        };
        let stable = before.pbi_start_tvsec == after.pbi_start_tvsec
            && before.pbi_start_tvusec == after.pbi_start_tvusec
            && before.pbi_ppid == after.pbi_ppid
            && process_name(listed.pid, &before) == current.name
            && native_birth == birth(listed.pid)
            && times.started == after.pbi_start_tvsec as Millis * 1000 + after.pbi_start_tvusec as Millis / 1000;
        (stable
            && listed.name == current.name
            && listed.parent == current.parent
            && listed.native_birth.as_ref().is_none_or(|birth| Some(birth) == native_birth.as_ref())
            && listed.times.is_none_or(|t| t.started == times.started))
        .then_some(current)
    }

    pub fn gone(pid: u32) -> bool {
        // SAFETY: signal zero observes existence only; denied access is not proof of exit.
        (unsafe { libc::kill(pid as libc::pid_t, 0) }) != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    pub fn times(pid: u32) -> Option<Times> {
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
        let (numer, denom) = timebase();
        let millis = |time: u64| (time as u128 * numer as u128 / denom as u128 / 1_000_000) as u64;
        Some(Times {
            started,
            own: millis(usage.ri_user_time + usage.ri_system_time),
            reaped: millis(usage.ri_child_user_time + usage.ri_child_system_time),
        })
    }

    pub fn birth(pid: u32) -> Option<Vec<u8>> {
        static BOOT: OnceLock<Option<Vec<u8>>> = OnceLock::new();
        let boot = BOOT
            .get_or_init(|| {
                let mut bytes = [0u8; 64];
                let mut length = bytes.len();
                // SAFETY: fixed writable buffer and its byte length, a constant sysctl name.
                let ok = unsafe {
                    libc::sysctlbyname(
                        c"kern.bootsessionuuid".as_ptr(),
                        bytes.as_mut_ptr().cast(),
                        &mut length,
                        std::ptr::null_mut(),
                        0,
                    )
                } == 0;
                (ok && (36..=37).contains(&length)).then(|| bytes[..36].to_vec())
            })
            .as_ref()?;
        // SAFETY: the versioned call fills only this plain fixed structure.
        let usage = unsafe {
            let mut usage: libc::rusage_info_v2 = mem::zeroed();
            (libc::proc_pid_rusage(pid as c_int, libc::RUSAGE_INFO_V2, (&raw mut usage).cast()) == 0).then_some(usage)
        }?;
        (usage.ri_proc_start_abstime != 0)
            .then(|| crate::session_identity::birth(boot, pid, usage.ri_proc_start_abstime))
    }

    /// Whether this user runs it.
    pub fn mine(pid: u32) -> bool {
        // SAFETY: getuid cannot fail.
        let me = unsafe { libc::getuid() };
        info::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO).is_some_and(|bsd| bsd.pbi_uid == me)
    }

    pub fn exe(pid: u32) -> Option<String> {
        path(pid)
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

    use super::{Proc, Role, Times};
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
                list.push(Proc {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    sid: None,
                    image: None,
                    name: name.clone(),
                    times: None,
                    native_birth: super::provider_of(&name)
                        .filter(|_| mine(entry.th32ProcessID))
                        .and_then(|_| named_birth(entry.th32ProcessID, &name)),
                    role: Role::Unknown,
                });
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
        }
        list
    }

    fn named_process(pid: u32, listed_name: &str) -> bool {
        use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
        // SAFETY: the handle is closed and the image-name buffer has a fixed bound.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut buffer = [0u16; 512];
            let mut length = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) != 0;
            CloseHandle(process);
            ok && std::path::Path::new(&String::from_utf16_lossy(&buffer[..length.min(512) as usize]))
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(listed_name))
        }
    }

    fn named_birth(pid: u32, listed_name: &str) -> Option<Vec<u8>> {
        let before = birth(pid)?;
        (named_process(pid, listed_name) && birth(pid).as_ref() == Some(&before)).then_some(before)
    }

    /// A bounded optional native identity capability. No telemetry offsets or tails
    /// are interpreted; APIs demanding a larger buffer remain unsupported here.
    pub fn birth(pid: u32) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
        type Query = unsafe extern "system" fn(HANDLE, u32, *mut core::ffi::c_void, u32, *mut u32) -> i32;
        #[repr(C, align(8))]
        struct Header([u8; 96]);
        // SAFETY: the loaded system DLL stays loaded; the export has NtQueryInformationProcess's
        // ABI. The sole call owns its fixed aligned writable buffer and process handle.
        unsafe {
            let module = GetModuleHandleW(
                c"ntdll.dll".to_bytes().iter().map(|&b| b as u16).chain([0]).collect::<Vec<_>>().as_ptr(),
            );
            if module.is_null() {
                return None;
            }
            let address = GetProcAddress(module, c"NtQueryInformationProcess".as_ptr().cast())?;
            let query: Query = mem::transmute(address);
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut header = Header([0; 96]);
            let mut returned = 0;
            let status = query(process, 64, header.0.as_mut_ptr().cast(), 96, &mut returned);
            CloseHandle(process);
            if status < 0 {
                return None;
            }
            telemetry_birth(&header.0, returned, pid)
        }
    }

    fn telemetry_birth(bytes: &[u8; 96], returned: u32, pid: u32) -> Option<Vec<u8>> {
        let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let size = u32_at(0);
        if !(64..=96).contains(&size) || returned < size || returned > 96 || u32_at(4) != pid {
            return None;
        }
        let sequence = u64_at(40);
        let start_key = u64_at(8);
        if sequence == 0 || start_key == 0 {
            return None;
        }
        let mut boot = u32_at(60).to_be_bytes().to_vec();
        boot.extend_from_slice(&start_key.to_be_bytes());
        Some(crate::session_identity::birth(&boot, pid, sequence))
    }

    pub fn verified(listed: &Proc) -> Option<Proc> {
        let before = times(listed.pid)?;
        let native_birth = named_birth(listed.pid, &listed.name);
        // Without telemetry, still verify the executable name and creation timestamp.
        if native_birth.is_none() && !named_process(listed.pid, &listed.name) {
            return None;
        }
        let after = times(listed.pid)?;
        let current = Proc { times: Some(after), native_birth: native_birth.clone(), ..listed.clone() };
        (before.started == after.started
            && native_birth == birth(listed.pid)
            && listed.native_birth.as_ref().is_none_or(|birth| Some(birth) == native_birth.as_ref())
            && listed.times.is_none_or(|t| t.started == after.started))
        .then_some(current)
    }

    pub fn gone(pid: u32) -> bool {
        // Access denial and unsupported telemetry do not prove exit.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if !process.is_null() {
                CloseHandle(process);
                return false;
            }
            windows_sys::Win32::Foundation::GetLastError() == 87
        }
    }

    /// Windows keeps no time of finished children: what a tool spent is counted while it runs.
    pub fn times(pid: u32) -> Option<Times> {
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
            ok.then_some(Times { started, own: (as_100ns(kernel) + as_100ns(user)) / 10_000, reaped: 0 })
        }
    }

    /// Another process's folder is not readable without reading its memory: not shown.
    pub fn cwd(_: u32) -> Option<PathBuf> {
        None
    }

    /// Editors' remote servers run on Linux and macOS: not looked for here.
    pub fn exe(_: u32) -> Option<String> {
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

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn bounded_telemetry_validates_prefix_without_chasing_tails() {
            let mut bytes = [0u8; 96];
            bytes[..4].copy_from_slice(&96u32.to_le_bytes());
            bytes[4..8].copy_from_slice(&7u32.to_le_bytes());
            bytes[8..16].copy_from_slice(&123u64.to_le_bytes());
            bytes[40..48].copy_from_slice(&456u64.to_le_bytes());
            assert!(telemetry_birth(&bytes, 96, 7).is_some());
            for length in [0, 63, 95, 97, u32::MAX] {
                assert!(telemetry_birth(&bytes, length, 7).is_none());
            }
            assert!(telemetry_birth(&bytes, 96, 8).is_none());
            bytes[..4].copy_from_slice(&97u32.to_le_bytes());
            assert!(telemetry_birth(&bytes, 96, 7).is_none());
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod sys {
    use std::path::PathBuf;

    use super::{Proc, Times};
    use crate::model::Millis;

    pub fn processes() -> Vec<Proc> {
        Vec::new()
    }
    pub fn verified(_: &Proc) -> Option<Proc> {
        None
    }
    pub fn gone(_: u32) -> bool {
        false
    }
    pub fn times(_: u32) -> Option<Times> {
        None
    }
    pub fn birth(_: u32) -> Option<Vec<u8>> {
        None
    }
    pub fn cwd(_: u32) -> Option<PathBuf> {
        None
    }
    pub fn exe(_: u32) -> Option<String> {
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
        Proc {
            pid,
            parent,
            name: name.into(),
            times: None,
            native_birth: None,
            sid: None,
            image: None,
            role: Role::Unknown,
        }
    }

    fn found(procs: &[Proc]) -> Vec<(Provider, u32, Vec<u32>)> {
        sessions(procs, 900, &|_| None).into_iter().map(|f| (f.provider, f.pid, f.tree)).collect()
    }

    fn origins(procs: &[Proc]) -> Vec<(u32, Origin)> {
        sessions(procs, 900, &|_| None).into_iter().map(|f| (f.pid, f.origin)).collect()
    }

    fn codex(pid: u32, parent: u32, invocation: &[u8]) -> Proc {
        Proc { role: codex_role(invocation), ..p(pid, parent, "codex") }
    }

    #[test]
    fn shared_work_does_not_activate_its_idle_launcher() {
        let rows = [
            p(10, 1, "codex"),
            codex(11, 10, b"codex\0app-server\0daemon\0pid-update-loop\0"),
            codex(12, 11, b"codex\0app-server\0"),
            p(13, 12, "bash"),
            p(20, 1, "codex"),
        ];
        let found = sessions(&rows, 900, &|_| None);
        let launcher = found.iter().find(|f| f.pid == 10).unwrap();
        assert_eq!(launcher.tree, vec![10], "service nodes themselves are accounting barriers");
        let cpu = launcher
            .tree
            .iter()
            .map(|pid| match pid {
                12 => 600,
                13 => 900,
                _ => 0,
            })
            .sum();
        let now = Instant::now();
        let first = judged(None, 0, now, 0, working_share(Provider::Codex));
        let next =
            judged(Some(&first), cpu, now + std::time::Duration::from_secs(15), 15_000, working_share(Provider::Codex));
        assert_eq!(next.working, Some(false), "foreign tools must not activate the idle launcher");
    }

    #[test]
    fn codex_services_are_not_sessions_but_their_real_clients_are() {
        let procs = [
            p(1, 0, "init"),
            codex(10, 1, b"codex\0app-server\0daemon\0pid-update-loop\0"),
            // An updater can restart a server that actually serves remote work.
            codex(11, 10, b"codex\0app-server\0--listen\0unix://\0--managed-daemon\0"),
            p(12, 11, "bash"),
            codex(20, 1, b"codex\0app-server\0proxy\0--sock\0local.sock\0"),
            p(30, 1, "codex"),
            codex(31, 30, b"codex\0app-server\0--listen\0unix://\0--managed-daemon\0"),
            codex(32, 30, b"codex\0app-server\0proxy\0"),
            p(40, 1, "code"),
            codex(41, 40, b"codex\0app-server\0"),
            p(50, 1, "ChatGPT"),
            codex(51, 50, b"codex\0app-server\0"),
            p(900, 1, "quotum"),
            codex(901, 900, b"codex\0app-server\0"),
        ];
        assert_eq!(
            origins(&procs),
            vec![(11, Origin::Terminal), (30, Origin::Terminal), (41, Origin::Editor), (51, Origin::App)]
        );
        assert_eq!(
            found(&procs),
            vec![
                (Provider::Codex, 11, vec![11, 12]),
                (Provider::Codex, 30, vec![30, 31]),
                (Provider::Codex, 41, vec![41]),
                (Provider::Codex, 51, vec![51]),
            ]
        );
    }

    #[test]
    fn a_service_role_is_an_exact_invocation_prefix() {
        for invocation in [b"codex\0app-server\0daemon\0pid-update-loop\0".as_slice(), b"codex\0app-server\0proxy\0"] {
            assert_eq!(codex_role(invocation), Role::Service);
            for end in 0..invocation.len() {
                assert_ne!(codex_role(&invocation[..end]), Role::Service, "partial prefix at {end}");
            }
        }
        for invocation in [
            b"codex\0exec\0app-server daemon pid-update-loop\0".as_slice(),
            b"codex\0app-server daemon pid-update-loop\0",
            b"codex\0--config\0app-server\0daemon\0pid-update-loop\0",
            b"codex\0--\0app-server\0daemon\0pid-update-loop\0",
            b"codex\0app-server\0daemon\0pid-update-loop-later\0",
            b"codex\0app-server\0proxying\0",
            b"codex\0app-server\0daemon\0restart\0",
        ] {
            let proc = codex(10, 1, invocation);
            assert_eq!(proc.role, Role::Unknown);
            assert_eq!(found(&[proc]), vec![(Provider::Codex, 10, vec![10])]);
        }
        let long = vec![b'x'; 2048];
        assert_eq!(codex_role(long.as_slice()), Role::Unavailable);
    }

    #[test]
    fn reading_a_role_stops_before_other_arguments_and_on_the_first_unknown_byte() {
        use std::io::Cursor;
        let prefix = b"codex\0app-server\0daemon\0pid-update-loop\0";
        let bytes = [prefix.as_slice(), b"--restore-release\0value\0"].concat();
        let mut input = Cursor::new(bytes);
        assert_eq!(codex_role(&mut input), Role::Service);
        assert_eq!(input.position(), prefix.len() as u64);
        let mut input = Cursor::new(b"codex\0private user task\0");
        assert_eq!(codex_role(&mut input), Role::Unknown);
        assert_eq!(input.position(), b"codex\0p".len() as u64);
        let mut input = Cursor::new(vec![b'x'; 4096]);
        assert_eq!(codex_role(&mut input), Role::Unavailable);
        assert_eq!(input.position(), 2048);
        struct Denied;
        impl Read for Denied {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            }
        }
        assert_eq!(codex_role(Denied), Role::Unavailable);
    }

    #[test]
    fn a_role_is_not_attached_to_an_exited_or_reused_process() {
        let before = Proc { times: Some(Times { started: 100, own: 20, reaped: 0 }), ..p(10, 1, "codex") };
        assert!(with_role(before.clone(), Role::Service, None).is_none());
        let reused = Proc { times: Some(Times { started: 200, own: 0, reaped: 0 }), ..before.clone() };
        assert!(with_role(before.clone(), Role::Service, Some(reused)).is_none());
        let replaced = Proc { name: "bash".into(), ..before.clone() };
        assert!(with_role(before.clone(), Role::Service, Some(replaced)).is_none());
        let later = Proc { times: Some(Times { started: 100, own: 50, reaped: 0 }), ..before.clone() };
        assert_eq!(with_role(before.clone(), Role::Unknown, Some(later.clone())).unwrap().role, Role::Unknown);
        assert_eq!(with_role(before, Role::Service, Some(later)).unwrap().role, Role::Service);
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
        let app = sessions(&procs, 900, &|_| None).into_iter().find(|f| f.pid == 1098247).unwrap();
        assert_eq!(app.tree, vec![1098247, 1114779], "the app's windows are not counted in its client");
    }

    /// Claude Code in VS Code over SSH: the editor's server is a Node.js in ~/.vscode-server,
    /// named after its main thread on Linux since Node 24.
    #[test]
    fn a_remote_editors_server_is_an_editor() {
        let procs = [
            p(1, 0, "systemd"),
            p(200, 1, "sshd"),
            p(210, 200, "MainThread"),
            p(220, 210, "MainThread"),
            p(230, 220, "claude"),
            p(240, 200, "node"),
            p(250, 240, "codex"),
            p(300, 200, "bash"),
            p(310, 300, "node"),
            p(320, 310, "codex"),
        ];
        let exe = |pid: u32| match pid {
            210 | 220 => Some("/home/ann/.vscode-server/cli/servers/Stable-abc/server/node".to_string()),
            240 => Some("/home/ann/.cursor-server/bin/abc/node".to_string()),
            310 => Some("/usr/bin/node".to_string()),
            _ => None,
        };
        let origins: Vec<_> = sessions(&procs, 900, &exe).into_iter().map(|f| (f.pid, f.origin)).collect();
        assert_eq!(
            origins,
            vec![(230, Origin::Editor), (250, Origin::Editor), (320, Origin::Terminal)],
            "a node of its own is not an editor"
        );
    }

    #[test]
    fn only_project_folders_are_named() {
        let activity = Activity::new(PathBuf::from("/home/ann"), true);
        let name = |dir: &str| named(Path::new(dir), &activity.homes, &activity.temps);
        assert_eq!(name("/home/ann/dev/quotum"), Some("quotum".into()));
        assert_eq!(name("/home/ann"), None);
        assert_eq!(name("/"), None);
        assert_eq!(name("/private/tmp/scratch"), None, "a temporary folder, resolved");
        assert_eq!(named(&std::env::temp_dir().join("scratch"), &activity.homes, &activity.temps), None);
    }

    /// Folders laid out for a test in a temporary folder of its own, with a home and a
    /// temporary folder inside it; removed after.
    struct Stand(PathBuf);

    impl Stand {
        fn new(name: &str) -> Stand {
            let root = std::env::temp_dir().join(format!("quotum-place-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Stand(root)
        }

        fn at(&self, path: &str) -> PathBuf {
            self.0.join(path)
        }

        /// The path as git writes it into a `.git` file: absolute, with `/` between folders.
        fn abs(&self, path: &str) -> String {
            self.at(path).to_string_lossy().replace('\\', "/")
        }

        fn dir(&self, path: &str) -> &Stand {
            fs::create_dir_all(self.at(path)).unwrap();
            self
        }

        fn file(&self, path: &str, text: &str) -> &Stand {
            let at = self.at(path);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            fs::write(at, text).unwrap();
            self
        }

        #[cfg(unix)]
        fn link(&self, path: &str, target: &str) -> &Stand {
            let at = self.at(path);
            fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, at).unwrap();
            self
        }

        /// A worktree `path` of the git folder `common`, its own git folder at `gitdir`,
        /// as `git worktree add` makes one.
        fn worktree(&self, path: &str, gitdir: &str, written: &str) -> &Stand {
            self.dir(path).file(&format!("{path}/.git"), &format!("gitdir: {written}\n"));
            self.file(&format!("{gitdir}/commondir"), "../..\n")
        }

        fn shielded(&self, shielded: &[&str]) -> Vec<PathBuf> {
            shielded.iter().map(|dir| self.at(dir)).collect()
        }

        /// The folder and project of a session in `dir`.
        fn place(&self, dir: &str, shielded: &[&str]) -> (Option<String>, Option<String>) {
            let Place { folder, project } =
                place(&self.at(dir), &[self.at("home")], &[self.at("tmp")], &self.shielded(shielded));
            (folder, project)
        }
    }

    impl Drop for Stand {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn both(folder: Option<&str>, project: Option<&str>) -> (Option<String>, Option<String>) {
        (folder.map(str::to_string), project.map(str::to_string))
    }

    #[test]
    fn a_folder_in_a_repository_is_its_project() {
        let stand = Stand::new("repo");
        stand.dir("home/dev/quotum/.git").dir("home/dev/quotum/hub");
        assert_eq!(stand.place("home/dev/quotum", &[]), both(Some("quotum"), Some("quotum")), "its root");
        assert_eq!(stand.place("home/dev/quotum/hub", &[]), both(Some("hub"), Some("quotum")), "a folder in it");
        stand.dir("home/notes");
        assert_eq!(stand.place("home/notes", &[]), both(Some("notes"), Some("notes")), "no repository");
        assert_eq!(stand.place("home", &[]), both(None, None), "the home folder");
        stand.file("home/dev/odd/.git", "not a link to a git folder\n").dir("home/dev/odd/src");
        assert_eq!(stand.place("home/dev/odd/src", &[]), both(Some("src"), Some("odd")), "a .git file of another kind");
    }

    #[test]
    fn a_home_kept_in_git_is_not_one_project() {
        let stand = Stand::new("home");
        stand.dir("home/.git").dir("home/notes");
        assert_eq!(stand.place("home/notes", &[]), both(Some("notes"), Some("notes")));
    }

    #[test]
    fn a_worktree_belongs_to_its_repository() {
        let stand = Stand::new("worktree");
        stand.dir("home/dev/quotum/.git");
        let gitdir = "home/dev/quotum/.git/worktrees/feat-18";
        stand.worktree("home/dev/quotum.feat-18", gitdir, &stand.abs(gitdir)).dir("home/dev/quotum.feat-18/hub");
        let feat = both(Some("quotum.feat-18"), Some("quotum"));
        assert_eq!(stand.place("home/dev/quotum.feat-18", &[]), feat, "gitdir written in full");
        assert_eq!(
            stand.place("home/dev/quotum.feat-18/hub", &[]),
            both(Some("hub"), Some("quotum")),
            "a folder in it"
        );
        stand.worktree(
            "home/dev/quotum.feat-19",
            "home/dev/quotum/.git/worktrees/feat-19",
            "../quotum/.git/worktrees/feat-19",
        );
        assert_eq!(
            stand.place("home/dev/quotum.feat-19", &[]),
            both(Some("quotum.feat-19"), Some("quotum")),
            "relative"
        );
        // Written on Windows: a line ends in CRLF.
        let gitdir = "home/dev/quotum/.git/worktrees/feat-20";
        stand.file(&format!("{gitdir}/commondir"), "../..\r\n");
        stand.file("home/dev/quotum.feat-20/.git", &format!("gitdir: {}\r\n", stand.abs(gitdir)));
        assert_eq!(stand.place("home/dev/quotum.feat-20", &[]), both(Some("quotum.feat-20"), Some("quotum")), "CRLF");
        // Only the start of commondir is read: what a file holds past 4 KiB is not.
        let gitdir = "home/dev/quotum/.git/worktrees/feat-21";
        stand.file(&format!("{gitdir}/commondir"), &format!("../..{}junk", " ".repeat(5000)));
        stand.file("home/dev/quotum.feat-21/.git", &format!("gitdir: {}\n", stand.abs(gitdir)));
        assert_eq!(stand.place("home/dev/quotum.feat-21", &[]), both(Some("quotum.feat-21"), Some("quotum")), "4 KiB");
    }

    #[test]
    fn a_repository_is_not_looked_for_at_home_or_above_it() {
        let stand = Stand::new("above");
        // A folder outside home, with a repository around the whole stand: the home folder
        // is not on its way up, yet the search stops above home all the same.
        stand.dir(".git").dir("srv/x");
        assert_eq!(stand.place("srv/x", &[]), both(Some("x"), Some("x")));
    }

    #[cfg(unix)]
    #[test]
    fn a_git_that_is_neither_folder_nor_file_is_passed_by() {
        let stand = Stand::new("sock");
        stand.dir("home/o/.git").dir("home/o/x");
        let _socket = std::os::unix::net::UnixListener::bind(stand.at("home/o/x/.git")).unwrap();
        assert_eq!(stand.place("home/o/x", &[]), both(Some("x"), Some("o")), "the repository above");
    }

    #[test]
    fn a_bare_repository_names_the_project_of_its_worktrees() {
        let stand = Stand::new("bare");
        stand.dir("home/src/quotum.git/worktrees/main");
        stand.worktree(
            "home/src/main",
            "home/src/quotum.git/worktrees/main",
            &stand.abs("home/src/quotum.git/worktrees/main"),
        );
        assert_eq!(stand.place("home/src/main", &[]), both(Some("main"), Some("quotum")), "quotum.git, without .git");
        stand.dir("home/dev/quotum/.bare/worktrees/main");
        stand.worktree("home/dev/quotum/main", "home/dev/quotum/.bare/worktrees/main", "../.bare/worktrees/main");
        assert_eq!(stand.place("home/dev/quotum/main", &[]), both(Some("main"), Some("quotum")), "a .bare beside it");
    }

    #[test]
    fn a_submodule_is_a_project_of_its_own() {
        let stand = Stand::new("submodule");
        stand
            .dir("home/dev/app/.git/modules/lib")
            .file("home/dev/app/vendor/lib/.git", "gitdir: ../../.git/modules/lib\n")
            .dir("home/dev/app/vendor/lib/src");
        assert_eq!(stand.place("home/dev/app/vendor/lib/src", &[]), both(Some("src"), Some("lib")), "no commondir");
        let gitdir = "home/dev/app/.git/modules/lib/worktrees/libwt";
        stand.worktree("home/dev/libwt", gitdir, &stand.abs(gitdir));
        assert_eq!(stand.place("home/dev/libwt", &[]), both(Some("libwt"), Some("lib")), "its worktree");
    }

    #[test]
    fn a_commondir_that_is_no_file_is_no_worktree() {
        let stand = Stand::new("commondir");
        let gitdir = "home/dev/quotum/.git/worktrees/feat-18";
        stand.dir(&format!("{gitdir}/commondir")).dir("home/dev/quotum.feat-18");
        stand.file("home/dev/quotum.feat-18/.git", &format!("gitdir: {}\r\n", stand.abs(gitdir)));
        assert_eq!(stand.place("home/dev/quotum.feat-18", &[]), both(Some("quotum.feat-18"), Some("quotum.feat-18")));
    }

    #[test]
    fn temporary_folders_name_nothing_but_their_repository_may() {
        let stand = Stand::new("temp");
        stand.dir("home/dev/quotum/.git");
        let gitdir = "home/dev/quotum/.git/worktrees/wt-1";
        stand.worktree("tmp/wt-1", gitdir, &stand.abs(gitdir));
        assert_eq!(stand.place("tmp/wt-1", &[]), both(None, Some("quotum")), "a worktree in a temporary folder");
        stand.dir("tmp/scratch/.git");
        assert_eq!(stand.place("tmp/scratch", &[]), both(None, None), "a clone in one");
        stand.dir("tmp/q/.git");
        stand.worktree("home/dev/q.wt", "tmp/q/.git/worktrees/q.wt", &stand.abs("tmp/q/.git/worktrees/q.wt"));
        assert_eq!(stand.place("home/dev/q.wt", &[]), both(Some("q.wt"), None), "a worktree of a repository in one");
    }

    #[test]
    fn guarded_folders_are_not_looked_into() {
        let stand = Stand::new("guarded");
        stand.dir("home/Documents/quotum/.git").dir("home/Documents/quotum/hub");
        let documents = ["home/Documents"];
        assert_eq!(stand.place("home/Documents/quotum/hub", &documents), both(Some("hub"), Some("hub")), "in one");
        assert_eq!(stand.place("home/Documents/quotum/hub", &[]), both(Some("hub"), Some("quotum")), "unguarded");
        // A worktree outside, of a repository inside: its git folder is not read.
        let gitdir = "home/Documents/quotum/.git/worktrees/feat";
        stand.worktree("home/wt/feat", gitdir, &stand.abs(gitdir)).dir("home/wt/feat/hub");
        assert_eq!(stand.place("home/wt/feat/hub", &documents), both(Some("hub"), Some("hub")), "through gitdir");
        assert_eq!(stand.place("home/wt/feat/hub", &[]), both(Some("hub"), Some("quotum")), "unguarded");
    }

    #[cfg(unix)]
    #[test]
    fn a_git_link_is_followed_unless_it_leads_into_a_guarded_folder() {
        let stand = Stand::new("link");
        stand
            .dir("home/dev/outer/.git")
            .dir("store/inner-git")
            .link("home/dev/outer/inner/.git", "../../../../store/inner-git");
        assert_eq!(stand.place("home/dev/outer/inner", &[]), both(Some("inner"), Some("inner")), "to a git folder");

        stand.dir("home/src/quotum/.git").dir("home/dev/.git");
        let gitdir = "home/src/quotum/.git/worktrees/x";
        stand.file(&format!("{gitdir}/commondir"), "../..\n");
        stand.file("home/Documents/x-git", &format!("gitdir: {}\n", stand.abs(gitdir)));
        stand.dir("home/dev/x").link("home/dev/x/.git", "../../Documents/x-git");
        assert_eq!(stand.place("home/dev/x", &["home/Documents"]), both(Some("x"), Some("x")), "into a guarded one");
        assert_eq!(stand.place("home/dev/x", &[]), both(Some("x"), Some("quotum")), "unguarded");

        // A link to a git folder inside one: not followed, so not even looked at.
        stand.dir("home/Documents/y-git").dir("home/dev/y/src").link("home/dev/y/.git", "../../Documents/y-git");
        assert_eq!(stand.place("home/dev/y/src", &["home/Documents"]), both(Some("src"), Some("src")));
        assert_eq!(stand.place("home/dev/y/src", &[]), both(Some("src"), Some("y")), "unguarded");
    }

    #[test]
    fn the_guard_touches_nothing_inside_and_tells_it_from_nothing() {
        let stand = Stand::new("guard");
        stand.file("home/Documents/x/.git", "gitdir: y\n").file("home/dev/.git", "gitdir: y\n");
        let shielded = stand.shielded(&["home/Documents"]);
        let inside = stand.at("home/Documents/x/.git");
        assert_eq!(probe(&inside, &shielded), Look::Shielded, "there, and not looked at");
        assert_eq!(read_small(&inside, &shielded), Look::Shielded);
        assert_eq!(probe(&stand.at("home/dev/../Documents/x/.git"), &shielded), Look::Shielded, "through ..");
        assert_eq!(probe(&stand.at("home/dev/none"), &shielded), Look::Missing);
        assert_eq!(read_small(&stand.at("home/dev/none"), &shielded), Look::Missing);
        let outside = stand.at("home/dev/.git");
        assert_eq!(probe(&outside, &shielded), Look::Found((Kind::File, outside.clone())));
        assert_eq!(read_small(&outside, &shielded), Look::Found("gitdir: y\n".into()));
        assert_eq!(read_small(&stand.at("home/dev"), &shielded), Look::Missing, "a folder is no file");
        #[cfg(unix)]
        {
            stand.link("home/dev/link", ".git");
            assert_eq!(read_small(&stand.at("home/dev/link"), &shielded), Look::Missing, "a link is not followed");
            stand.link("home/dev/into", "../Documents/x/.git");
            assert_eq!(probe(&stand.at("home/dev/into"), &shielded), Look::Shielded, "a link that leads inside");
            // Put in place of a file after it was looked at: opened, a pipe does not wait for a
            // writer, and is no file; a link is not followed.
            let pipe = stand.at("home/dev/pipe");
            let name = std::ffi::CString::new(pipe.to_string_lossy().as_bytes()).unwrap();
            // SAFETY: a NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            // Opened on a thread of its own, so a pipe that waits fails the test rather than hangs it.
            let (sent, opened) = std::sync::mpsc::channel();
            std::thread::spawn(move || sent.send(open_plain(&pipe).map(|file| file.metadata().unwrap().is_file())));
            let opened = opened.recv_timeout(std::time::Duration::from_secs(5)).expect("opened at once");
            assert!(!opened.expect("opened"), "a pipe is no file");
            assert!(open_plain(&stand.at("home/dev/link")).is_err(), "a link is not followed");
        }
    }

    #[test]
    fn a_session_keeps_its_place_from_look_to_look_until_it_is_gone() {
        let stand = Stand::new("places");
        stand.dir("home/dev/quotum/.git");
        let gitdir = "home/dev/quotum/.git/worktrees/wt";
        stand.worktree("home/dev/wt", gitdir, &stand.abs(gitdir));
        let mut activity = Activity {
            homes: vec![stand.at("home")],
            temps: vec![stand.at("tmp")],
            shielded: Vec::new(),
            last: HashMap::new(),
            places: HashMap::new(),
            placing: true,
            lifetimes: HashMap::new(),
            bases: HashMap::new(),
            scopes: HashMap::new(),
            pending_unsafe: HashSet::new(),
        };
        let (key, other) = ((7, 1), (8, 1));
        let worktree = both(Some("wt"), Some("quotum"));
        // A look at sessions in these folders (none: not told), each its own process.
        let look = |activity: &mut Activity, folders: Vec<((u32, Millis), Option<PathBuf>)>| {
            let dirs: HashMap<u32, PathBuf> =
                folders.iter().filter_map(|(key, dir)| Some((key.0, dir.clone()?))).collect();
            let sessions = folders.iter().map(|(key, _)| (cache_key(key.0, key.1, None), key.0)).collect();
            let placed = activity.placed(sessions, &|pid| dirs.get(&pid).cloned());
            placed.iter().map(|p| (p.folder.clone(), p.project.clone())).collect::<Vec<_>>()
        };
        let wt = stand.at("home/dev/wt");
        assert_eq!(look(&mut activity, vec![(key, Some(wt.clone()))]), vec![worktree.clone()]);
        // The worktree is removed under the session; Linux tells its folder so.
        fs::remove_dir_all(&wt).unwrap();
        let deleted = PathBuf::from(format!("{} (deleted)", wt.display()));
        for _ in 0..2 {
            let placed = look(&mut activity, vec![(key, Some(deleted.clone())), (other, Some(deleted.clone()))]);
            assert_eq!(placed, vec![worktree.clone(), both(None, None)]);
        }
        // Not seen in a look, a session is forgotten.
        look(&mut activity, Vec::new());
        assert_eq!(look(&mut activity, vec![(key, Some(deleted))]), vec![both(None, None)]);
        // A folder the agent cannot see (a client in a container of its own) is named by
        // itself, as far as it may be: not home, nor a temporary folder.
        let unseen = vec![
            (other, Some(stand.at("home/box/app"))),
            ((9, 1), Some(stand.at("tmp/box"))),
            ((10, 1), Some(stand.at("home"))),
        ];
        assert_eq!(
            look(&mut activity, unseen),
            vec![both(Some("app"), Some("app")), both(None, None), both(None, None)]
        );
        assert_eq!(look(&mut activity, vec![(other, None)]), vec![both(None, None)], "no folder told");
        // With project names turned off, no folder is read.
        activity.placing = false;
        let placed = activity.placed(vec![(cache_key(key.0, key.1, None), 7)], &|_| panic!("a folder read"));
        assert_eq!(
            placed.iter().map(|p| (p.folder.clone(), p.project.clone())).collect::<Vec<_>>(),
            vec![both(None, None)]
        );
    }

    #[test]
    fn a_session_is_placed_again_only_when_its_folder_changes() {
        let stand = Stand::new("placing");
        stand.dir("home/dev/quotum").dir("home/Documents/notes");
        let dir = stand.at("home/dev/quotum");
        let shielded = stand.shielded(&["home/Documents"]);
        assert_eq!(placing(&dir, None, &shielded), Placing::Anew, "a new session");
        assert_eq!(placing(&dir, Some(dir.as_path()), &shielded), Placing::Kept, "the same folder");
        assert_eq!(placing(&dir, Some(stand.at("home/dev").as_path()), &shielded), Placing::Anew, "another folder");
        let gone = stand.at("home/dev/quotum.feat-18");
        assert_eq!(placing(&gone, Some(dir.as_path()), &shielded), Placing::Kept, "removed: as it was");
        assert_eq!(placing(&gone, None, &shielded), Placing::Named, "not seen before: not visible to the agent");
        let deleted = PathBuf::from(format!("{} (deleted)", dir.display()));
        assert_eq!(placing(&deleted, Some(dir.as_path()), &shielded), Placing::Kept, "removed, as Linux tells it");
        assert_eq!(placing(&deleted, None, &shielded), Placing::Unknown);
        let named = stand.at("home/dev/old (deleted)");
        fs::create_dir_all(&named).unwrap();
        assert_eq!(placing(&named, None, &shielded), Placing::Anew, "a folder that is there, whatever its name");
        // A guarded folder is not checked for being there, and is named by itself.
        let guarded = stand.at("home/Documents/gone");
        assert_eq!(placing(&guarded, None, &shielded), Placing::Anew);
        let homes = [stand.at("home")];
        let Place { folder, project } = place(&guarded, &homes, &[], &shielded);
        assert_eq!((folder, project), both(Some("gone"), Some("gone")));
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
        let Times { started, own: cpu, .. } = own.times.or_else(|| sys::times(me)).expect("its times");
        let now = crate::model::now_ms();
        assert!(started <= now + 1_000 && now - started < 3_600_000, "started within the hour: {started} vs {now}");
        let spin = Instant::now();
        let mut spun = 0u64;
        while spin.elapsed().as_millis() < 300 {
            spun = std::hint::black_box(spun.wrapping_add(1));
        }
        let later = sys::times(me).expect("its times again").own;
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
        let first = judged(None, 1_000, at(0), 0, 0.05);
        assert_eq!(first.working, None, "one look cannot tell");
        // 15 s at 10% of a core: working.
        let busy = judged(Some(&first), 2_500, at(15), 15_000, 0.05);
        assert_eq!(busy.working, Some(true));
        assert_eq!(
            judged(Some(&busy), 2_600, at(15) + Duration::from_millis(300), 15_300, 0.05).working,
            Some(true),
            "too soon to tell anew"
        );
        // Then quiet: still working for a minute, idle after.
        let pause = judged(Some(&busy), 2_510, at(45), 45_000, 0.05);
        assert_eq!(pause.working, Some(true));
        let quiet = judged(Some(&pause), 2_520, at(80), 80_000, 0.05);
        assert_eq!(quiet.working, Some(false));
    }

    #[test]
    fn last_work_is_a_fixed_date_only_for_an_idle_session() {
        use std::time::Duration;
        let start = Instant::now();
        let look =
            |before: Option<&Seen>, cpu, ms| judged(before, cpu, start + Duration::from_millis(ms), ms as Millis, 0.05);
        let first = look(None, 0, 0);
        assert_eq!(first.last_worked(0, 0), None);
        let busy = look(Some(&first), 1_500, 15_000);
        assert_eq!(busy.last_worked(0, 15_000), None);
        let hold = look(Some(&busy), 1_500, 45_000);
        assert_eq!(hold.last_worked(0, 45_000), None);
        let idle = look(Some(&hold), 1_500, 75_000);
        assert_eq!(idle.last_worked(0, 75_000), Some(15_000));
        let early = look(Some(&idle), 1_500, 75_300);
        assert_eq!(early.last_worked(0, 75_300), Some(15_000));
        assert_eq!((early.cpu, early.at, early.wall), (idle.cpu, idle.at, idle.wall));
        let later = look(Some(&early), 1_500, 90_000);
        assert_eq!(later.last_worked(0, 90_000), idle.last_worked(0, 75_000));
        assert_eq!(later.last_worked(16_000, 90_000), None, "a process start on a different clock scale");
        assert_eq!(later.last_worked(0, 14_000), None, "never a future date");
    }

    #[test]
    fn clock_corrections_forget_dates_but_keep_working_and_its_hold() {
        use std::time::Duration;
        let start = Instant::now();
        for jump in [-3_600_000, 3_600_000] {
            let wall = 10 * 3_600_000;
            let look = |before: Option<&Seen>, cpu, ms, shift| {
                judged(before, cpu, start + Duration::from_millis(ms), wall + ms as Millis + shift, 0.05)
            };
            let first = look(None, 0, 0, 0);
            let busy = look(Some(&first), 1_500, 15_000, 0);
            let early = look(Some(&busy), 1_500, 15_300, jump);
            assert_eq!(early.busy_wall, None, "even a look too early invalidates a date");
            assert_eq!(early.working, Some(true));
            assert_eq!((early.cpu, early.at, early.wall), (busy.cpu, busy.at, busy.wall));
            let hold = look(Some(&busy), 1_500, 45_000, jump);
            assert_eq!(hold.busy_wall, None);
            assert_eq!(hold.working, Some(true), "the hold uses monotonic time");
            let idle = look(Some(&hold), 1_500, 75_000, jump);
            let later = look(Some(&idle), 1_500, 90_000, jump);
            assert_eq!(idle.working, Some(false));
            assert_eq!(idle.last_worked(0, wall + 75_000 + jump), None);
            assert_eq!(later.last_worked(0, wall + 90_000 + jump), None, "a bad date never becomes recent work");
            let again = look(Some(&later), 3_000, 105_000, jump);
            let quiet = look(Some(&again), 3_000, 165_000, jump);
            assert_eq!(quiet.last_worked(0, wall + 165_000 + jump), Some(wall + 105_000 + jump));
            let busy_at_jump = look(Some(&busy), 3_000, 30_000, jump);
            assert_eq!(busy_at_jump.busy_wall, Some(wall + 30_000 + jump), "new work already uses the corrected clock");
        }
    }

    #[test]
    fn native_birth_of_own_process_is_stable_or_explicit_windows_fallback() {
        let pid = std::process::id();
        let before = sys::birth(pid);
        let after = sys::birth(pid);
        assert!(before == after, "native process birth changed during own-process probe");
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert!(before.is_some(), "own process must have a native boot and birth token");
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        eprintln!("Native boot and process birth: supported");
        #[cfg(windows)]
        eprintln!(
            "Windows fixed 96-byte telemetry prefix: {}",
            if before.is_some() { "supported" } else { "unavailable; sessionId omitted, live credit unknown" }
        );
    }

    #[test]
    fn native_cache_identity_ignores_wall_corrections_and_rejects_birth_reuse() {
        let native = crate::session_identity::birth(b"boot", 7, 123);
        assert_eq!(cache_key(7, 100, Some(&native)), cache_key(7, 200, Some(&native)));
        assert_ne!(
            cache_key(7, 100, Some(&native)),
            cache_key(7, 100, Some(&crate::session_identity::birth(b"boot", 7, 124)))
        );
        assert_ne!(cache_key(7, 100, None), cache_key(7, 200, None));
        let before = Proc {
            times: Some(Times { started: 100, own: 20, reaped: 0 }),
            native_birth: Some(native),
            ..p(7, 1, "codex")
        };
        let shifted = Proc { times: Some(Times { started: 200, own: 30, reaped: 0 }), ..before.clone() };
        assert!(with_role(before.clone(), Role::Service, Some(shifted)).is_some());
        let reused = Proc { native_birth: Some(crate::session_identity::birth(b"boot", 7, 124)), ..before.clone() };
        assert!(with_role(before, Role::Service, Some(reused)).is_none());
    }

    #[test]
    fn this_machine_is_looked_at_twice_to_tell_working() {
        let mut activity = Activity::new(PathBuf::from("/nowhere"), true);
        let first = activity.look();
        assert!(first.iter().all(|s| s.working.is_none()), "one look cannot tell");
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let second = activity.look();
        assert!(second.iter().filter(|s| first.iter().any(|f| f.pid == s.pid)).all(|s| s.working.is_some()));
    }
}

#[cfg(test)]
pub(crate) mod attribution;
