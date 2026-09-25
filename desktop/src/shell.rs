//! The app's state, shared by the GUI's main thread and the worker threads (the hub, the
//! agent, window creation, the ticker, quitting). The state mutex is only ever held to
//! read or write fields: never across a call into Tauri that goes to the main thread
//! (building, navigating or closing a window, reading a web view's URL), or the worker
//! would wait for the main thread while the main thread waits for the mutex.

use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use quotum_core::config::Paths;

use crate::agent::Agent;
use crate::files::{AppJson, Dirs, Log, free_port};
use crate::hub::{self, Event, HubState, Proc, Ready, Restarts, Secrets, Signal};
use crate::{agent, ipc, smoke, window};

/// How long a start of the hub may take until it says it listens.
const START_LIMIT: Duration = Duration::from_secs(20);
/// A hub that stopped listening but did not exit is ended after this.
const EXIT_LIMIT: Duration = Duration::from_secs(3);
/// The pause before the hub is started again.
const RESTART_PAUSE: Duration = Duration::from_secs(1);

pub struct Shell {
    pub dirs: Dirs,
    /// The agent's files, the same as `quotum`'s: config.toml, state, machine id.
    pub paths: Paths,
    pub hub_log: Arc<Log>,
    pub agent_log: Arc<Log>,
    pub agent: Mutex<Agent>,
    /// Puts the agent's operations one after another (see agent.rs).
    pub agent_ops: Mutex<()>,
    /// Node, next to the app's executable.
    pub node: PathBuf,
    /// The hub of this commit in the app's resources.
    pub hub_dir: PathBuf,
    pub smoke: Option<smoke::Smoke>,
    app: OnceLock<AppHandle>,
    state: Mutex<State>,
    /// Held by a worker thread while it creates the window, never by the main thread.
    pub window_lock: Mutex<()>,
    exiting: AtomicBool,
    proc: Mutex<Option<Arc<Proc>>>,
    app_json: Mutex<AppJson>,
    /// The lock of this copy of the app, a second line behind single-instance.
    app_lock: Mutex<Option<File>>,
}

pub struct State {
    pub hub: HubState,
    /// Grows with every change of the hub's state: whoever decided on a snapshot checks it
    /// after calling into Tauri and follows the current state if it moved on.
    pub generation: u64,
    /// Ports that got the `hub` capability: capabilities can be added, never removed.
    pub capabilities: Vec<u16>,
}

impl Shell {
    pub fn new(dirs: Dirs, node: PathBuf, hub_dir: PathBuf, smoke: Option<smoke::Smoke>, app_lock: File) -> Shell {
        let app_json = AppJson::load(&dirs.app_json());
        Shell {
            hub_log: Arc::new(Log::new(dirs.hub_log())),
            agent_log: Arc::new(Log::new(dirs.agent_log())),
            agent: Mutex::new(Agent::new()),
            agent_ops: Mutex::new(()),
            paths: Paths::resolve(),
            dirs,
            node,
            hub_dir,
            smoke,
            app: OnceLock::new(),
            state: Mutex::new(State { hub: HubState::Starting, generation: 0, capabilities: Vec::new() }),
            window_lock: Mutex::new(()),
            exiting: AtomicBool::new(false),
            proc: Mutex::new(None),
            app_json: Mutex::new(app_json),
            app_lock: Mutex::new(Some(app_lock)),
        }
    }

    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub fn app(&self) -> &AppHandle {
        self.app.get().expect("the app handle is attached in setup")
    }

    pub fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The hub's state and its generation, as of now.
    pub fn hub(&self) -> (HubState, u64) {
        let state = self.state();
        (state.hub.clone(), state.generation)
    }

    pub fn generation(&self) -> u64 {
        self.state().generation
    }

    pub fn exiting(&self) -> bool {
        self.exiting.load(Ordering::SeqCst)
    }

    fn app_json(&self) -> MutexGuard<'_, AppJson> {
        self.app_json.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Changes what `app.json` remembers and writes it.
    fn remember(&self, change: impl FnOnce(&mut AppJson)) {
        let mut json = self.app_json();
        change(&mut json);
        if let Err(e) = json.save(&self.dirs.app_json()) {
            self.agent_log.line(&format!("app: {}: {e}", self.dirs.app_json().display()));
        }
    }

    pub fn take_over_confirmed(&self) -> bool {
        self.app_json().take_over_confirmed
    }

    pub fn confirm_take_over(&self) {
        self.remember(|json| json.take_over_confirmed = true);
    }

    pub fn autostart_defaulted(&self) -> bool {
        self.app_json().autostart_defaulted
    }

    pub fn mark_autostart_defaulted(&self) {
        self.remember(|json| json.autostart_defaulted = true);
    }

    /// Changes the hub's state and follows it: the capability of a new port, the window,
    /// the agent.
    fn set_hub(self: &Arc<Self>, hub: HubState) {
        let (port, generation) = {
            let mut state = self.state();
            if state.hub == hub {
                return;
            }
            state.hub = hub.clone();
            state.generation += 1;
            let generation = state.generation;
            let port = match &hub {
                HubState::Ready(ready) if !state.capabilities.contains(&ready.port) => {
                    state.capabilities.push(ready.port);
                    Some(ready.port)
                }
                _ => None,
            };
            (port, generation)
        };
        if let Some(port) = port {
            if let Err(e) = self.app().add_capability(ipc::hub_capability(port)) {
                self.hub_log.line(&format!("app: the board on port {port} gets no commands: {e}"));
            }
        }
        window::follow(self);
        if let (HubState::Ready(ready), Some(smoke)) = (&hub, &self.smoke) {
            smoke.hub_ready(self, ready);
        }
        // On a thread of their own: the agent's operations wait for runs to end.
        let shell = self.clone();
        thread::spawn(move || match hub {
            HubState::Ready(_) => {
                agent::start(&shell);
                agent::hub_ready(&shell);
            }
            HubState::Starting => agent::hub_starting(&shell, generation),
            HubState::Down => agent::hub_down(&shell),
        });
    }

    /// The port remembered for the hub, or a new free one.
    fn port(&self) -> u16 {
        let mut json = self.app_json();
        match json.port {
            Some(port) => port,
            None => self.new_port(&mut json),
        }
    }

    fn new_port(&self, json: &mut AppJson) -> u16 {
        let port = free_port(random_u32).unwrap_or(*crate::files::PORTS.start());
        json.port = Some(port);
        if let Err(e) = json.save(&self.dirs.app_json()) {
            self.hub_log.line(&format!("app: {}: {e}", self.dirs.app_json().display()));
        }
        port
    }
}

pub fn random_u32() -> u32 {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("the system's random source");
    u32::from_le_bytes(bytes)
}

/// How one start of the hub ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ending {
    /// It stopped listening or exited by itself.
    Ended,
    /// Its port is taken (or not allowed to it).
    PortInUse,
    /// The app is quitting.
    Quit,
}

/// What comes after a start of the hub ended.
#[derive(Debug, PartialEq)]
pub enum Next {
    /// At once, on a new port: once per start.
    NewPort,
    /// After a pause, with a new key and token.
    Again,
    /// For good: three restarts within five minutes.
    Down,
    /// The app is quitting: the hub is not started again.
    Stop,
}

pub fn next(ending: Ending, port_retried: bool, exiting: bool, restarts: &mut Restarts, now: Instant) -> Next {
    match ending {
        _ if exiting => Next::Stop,
        Ending::Quit => Next::Stop,
        Ending::PortInUse if !port_retried => Next::NewPort,
        _ if restarts.allow(now) => Next::Again,
        _ => Next::Down,
    }
}

/// Runs the hub for as long as the app runs: starts it, and after an end nobody asked
/// for starts it again, with a new key and token, up to three times in five minutes.
/// A new start waits until the one before exited: two would share the database.
pub fn run_hub(shell: Arc<Shell>) {
    let mut restarts = Restarts::default();
    let mut port_retried = false;
    loop {
        let ending = attempt(&shell);
        // Moved off the port at once: the window must not ask a port another user may take next.
        if !shell.exiting() {
            shell.set_hub(HubState::Starting);
        }
        if let Some(proc) = shell.proc.lock().unwrap_or_else(|e| e.into_inner()).take() {
            proc.finish(EXIT_LIMIT);
        }
        match next(ending, port_retried, shell.exiting(), &mut restarts, Instant::now()) {
            Next::Stop => return,
            Next::NewPort => {
                port_retried = true;
                let port = shell.new_port(&mut shell.app_json());
                shell.hub_log.line(&format!("app: the hub's port is taken; trying port {port}"));
            }
            Next::Again => {
                port_retried = false;
                thread::sleep(RESTART_PAUSE);
            }
            Next::Down => {
                shell.hub_log.line("app: the hub stopped three times within five minutes; not starting it again");
                shell.set_hub(HubState::Down);
                return;
            }
        }
    }
}

fn attempt(shell: &Arc<Shell>) -> Ending {
    let port = shell.port();
    let secrets = Secrets::new();
    let (script, cwd) = hub::script(&shell.hub_dir);
    let data = shell.dirs.hub_data();
    let port_text = port.to_string();
    let data_text = data.to_string_lossy().into_owned();
    let mut own = vec![
        ("QUOTUM_DATA_DIR", data_text.as_str()),
        ("QUOTUM_PORT", port_text.as_str()),
        ("QUOTUM_BIND", "127.0.0.1"),
        ("QUOTUM_LOCAL_KEY", secrets.key.as_str()),
        ("QUOTUM_LOCAL_TOKEN", secrets.token.as_str()),
        ("NODE_ENV", "production"),
    ];
    own.retain(|(_, value)| !value.is_empty());
    let env = hub::environment(std::env::vars_os(), cfg!(windows), &own);
    let (signals, received) = mpsc::channel();
    let proc = match Proc::start(&shell.node, &script, &cwd, env, shell.hub_log.clone(), signals) {
        Ok(proc) => proc,
        Err(e) => {
            shell.hub_log.line(&format!("app: cannot start {}: {e}", shell.node.display()));
            return Ending::Ended;
        }
    };
    shell.hub_log.line(&format!("app: the hub starts (pid {}, port {port})", proc.pid));
    *shell.proc.lock().unwrap_or_else(|e| e.into_inner()) = Some(proc);

    let started = Instant::now();
    let mut ready = false;
    loop {
        if shell.exiting() {
            return Ending::Quit;
        }
        if !ready && started.elapsed() > START_LIMIT {
            shell.hub_log.line("app: the hub did not start within 20 s");
            return Ending::Ended;
        }
        match received.recv_timeout(Duration::from_millis(200)) {
            Ok(Signal::Event(Event::Start { port, .. })) if !ready => {
                ready = true;
                shell.set_hub(HubState::Ready(Ready { port, key: secrets.key.clone(), token: secrets.token.clone() }));
            }
            Ok(Signal::Event(Event::Error { code })) if code == "port_in_use" && !ready => return Ending::PortInUse,
            Ok(Signal::Event(Event::Stop { reason })) => {
                shell.hub_log.line(&format!("app: the hub stopped ({reason})"));
                return Ending::Ended;
            }
            Ok(Signal::Eof) => return Ending::Ended,
            Ok(Signal::Exited(status)) => {
                shell.hub_log.line(&format!("app: the hub exited ({})", describe(status)));
                return Ending::Ended;
            }
            Ok(Signal::Event(_)) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ending::Ended,
        }
    }
}

fn describe(status: Option<std::process::ExitStatus>) -> String {
    status.map(|s| s.to_string()).unwrap_or_else(|| "status unknown".into())
}

/// Quits the app, once: the first caller does it all and ends the app last; whoever comes
/// second returns at once. `fast` is for the end of the system's session, where the
/// system ends the process soon after: shorter waits and no navigation.
pub fn shutdown(shell: &Arc<Shell>, fast: bool, from_exit_event: bool) {
    if shell.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    // 1. No more restarts; the window leaves the hub's pages.
    {
        let mut state = shell.state();
        state.hub = HubState::Down;
        state.generation += 1;
    }
    if !fast {
        window::leave(shell);
    }
    // 2–3. The agent stops and lets the machine go; then this copy's lock.
    agent::quit(shell, if fast { Duration::from_secs(1) } else { Duration::from_secs(5) });
    shell.app_lock.lock().unwrap_or_else(|e| e.into_inner()).take();
    // 4. The hub ends by itself once its stdin closes.
    if let Some(proc) = shell.proc.lock().unwrap_or_else(|e| e.into_inner()).take() {
        proc.close_stdin();
        proc.finish(if fast { Duration::from_secs(1) } else { Duration::from_secs(5) });
    }
    // 5. Windows go, then the app.
    for (_, window) in shell.app().webview_windows() {
        let _ = window.destroy();
    }
    if !from_exit_event {
        shell.app().exit(0);
    }
}

/// Every five seconds while the app runs, window or not (see `agent::tick`).
pub fn run_ticker(shell: Arc<Shell>) {
    while !shell.exiting() {
        thread::sleep(Duration::from_secs(5));
        agent::tick(&shell);
    }
}

/// `shutdown` on a thread of its own, for handlers that must not block.
pub fn quit(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || shutdown(&shell, false, false));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hub_that_ends_is_started_again_three_times_then_stays_down() {
        let (mut restarts, now) = (Restarts::default(), Instant::now());
        assert_eq!(next(Ending::PortInUse, false, false, &mut restarts, now), Next::NewPort);
        assert_eq!(next(Ending::PortInUse, true, false, &mut restarts, now), Next::Again, "one new port per start");
        assert_eq!(next(Ending::Ended, false, false, &mut restarts, now), Next::Again);
        assert_eq!(next(Ending::Ended, false, false, &mut restarts, now), Next::Again);
        assert_eq!(next(Ending::Ended, false, false, &mut restarts, now), Next::Down);
        assert_eq!(next(Ending::Ended, false, true, &mut Restarts::default(), now), Next::Stop, "never while quitting");
        assert_eq!(next(Ending::Quit, false, false, &mut Restarts::default(), now), Next::Stop);
    }
}
