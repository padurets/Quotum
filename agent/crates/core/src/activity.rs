//! Which coding agents run on this machine, and whether they are working: read from the
//! process table alone. Nothing of the clients is read or changed (no settings, hooks or
//! session files): a session is a client's process, and it works while it and what it
//! started (tools, builds, tests) spend CPU time.
//!
//! The agent may check this often, so a check is one pass over the process list for
//! names and parents; start times, CPU times and folders are read only for the clients'
//! own process trees. No program is started for it.
//!
//! A session's project is the git repository its folder is in, found once per session and
//! folder by the `.git` above it (see [`place`]); git is not run and none of its settings
//! is read.

use std::collections::HashMap;
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
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub provider: Provider,
    pub pid: u32,
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

/// Looks at the running clients again and again; working or idle is told by the CPU time
/// spent between two looks.
pub struct Activity {
    /// Folders that are not projects, as given and as the system resolves them.
    homes: Vec<PathBuf>,
    temps: Vec<PathBuf>,
    /// Folders not to be looked into for a repository (macOS guards them).
    shielded: Vec<PathBuf>,
    /// Each session at the last look, by pid and start (pids are reused).
    last: HashMap<(u32, Millis), Seen>,
    /// Each session's folder at the last look, and where that placed it.
    places: HashMap<(u32, Millis), (PathBuf, Place)>,
    /// Whether sessions are placed at all: with project names turned off, no folder is looked at.
    placing: bool,
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
        Activity { homes: both(home), temps, shielded, last: HashMap::new(), places: HashMap::new(), placing }
    }

    pub fn look(&mut self) -> Vec<Session> {
        let now = Instant::now();
        let wall = crate::model::now_ms();
        let procs = sys::processes();
        let listed: HashMap<u32, Option<(Millis, u64)>> = procs.iter().map(|p| (p.pid, p.times)).collect();
        let times = |pid: u32| listed.get(&pid).copied().flatten().or_else(|| sys::times(pid));
        let mut seen = HashMap::new();
        let mut folders = Vec::new();
        let mut sessions: Vec<Session> = sessions(&procs, std::process::id(), &sys::exe)
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
                let next = judged(self.last.get(&key), cpu, now, wall, working_share(provider));
                let working = next.working;
                let last_worked = next.last_worked(started_at, wall);
                seen.insert(key, next);
                folders.push((key, pid));
                Some(Session { provider, pid, started_at, project: None, folder: None, working, last_worked, origin })
            })
            .collect();
        for (session, Place { folder, project }) in sessions.iter_mut().zip(self.placed(folders, &sys::cwd)) {
            (session.folder, session.project) = (folder, project);
        }
        self.last = seen;
        sessions
    }

    /// Where the sessions of a look are, by their folders now (`cwd` tells a process's, none
    /// when not known) and where the last look placed them, which is kept for the next one:
    /// a session's folder is looked into once, and again when it changes. Not placing, no
    /// folder is read at all.
    fn placed(&mut self, sessions: Vec<((u32, Millis), u32)>, cwd: &dyn Fn(u32) -> Option<PathBuf>) -> Vec<Place> {
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
                kept.extend(entry.clone().map(|entry| (key, entry)));
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

/// The sessions among `procs`. Not sessions: clients started by the agent itself to measure (below this
/// process `own` or any `quotum`), and a client under another of the same kind (a
/// launcher and the program it runs). A session under a session of another kind is its
/// own, and its tree is not counted in the one above. `exe` gives the path of a program,
/// asked only of what runs a session and its name does not tell (see [`origin`]).
pub fn sessions(procs: &[Proc], own: u32, exe: &dyn Fn(u32) -> Option<String>) -> Vec<Found> {
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
        (!measuring && !launched).then(|| (provider, origin(&above, exe)))
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
                let linked = name.starts_with(|c: char| c.is_ascii_digit()) || name.starts_with("codex-");
                if let Some(client) =
                    linked.then(|| path(pid as u32)).flatten().as_deref().and_then(super::client_by_path)
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
        Proc { pid, parent, name: name.into(), times: None }
    }

    fn found(procs: &[Proc]) -> Vec<(Provider, u32, Vec<u32>)> {
        sessions(procs, 900, &|_| None).into_iter().map(|f| (f.provider, f.pid, f.tree)).collect()
    }

    fn origins(procs: &[Proc]) -> Vec<(u32, Origin)> {
        sessions(procs, 900, &|_| None).into_iter().map(|f| (f.pid, f.origin)).collect()
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
            let opened = open_plain(&pipe).expect("opened at once");
            assert!(!opened.metadata().unwrap().is_file());
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
        };
        let (key, other) = ((7, 1), (8, 1));
        let worktree = both(Some("wt"), Some("quotum"));
        // A look at sessions in these folders (none: not told), each its own process.
        let look = |activity: &mut Activity, folders: Vec<((u32, Millis), Option<PathBuf>)>| {
            let dirs: HashMap<u32, PathBuf> =
                folders.iter().filter_map(|(key, dir)| Some((key.0, dir.clone()?))).collect();
            let sessions = folders.iter().map(|(key, _)| (*key, key.0)).collect();
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
        let placed = activity.placed(vec![(key, 7)], &|_| panic!("a folder read"));
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
    fn this_machine_is_looked_at_twice_to_tell_working() {
        let mut activity = Activity::new(PathBuf::from("/nowhere"), true);
        let first = activity.look();
        assert!(first.iter().all(|s| s.working.is_none()), "one look cannot tell");
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        let second = activity.look();
        assert!(second.iter().filter(|s| first.iter().any(|f| f.pid == s.pid)).all(|s| s.working.is_some()));
    }
}
