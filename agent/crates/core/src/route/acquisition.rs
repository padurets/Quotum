//! Nonblocking acquisition, driven only by the existing activity look.
use super::{Route, claude_machine};
use crate::clients::{ClientId, Image, executable_image};
use crate::config::Config;
use crate::stop::{How, Stop};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime};

const TTL: Duration = Duration::from_secs(60);

#[derive(PartialEq)]
struct Stamp {
    path: PathBuf,
    modified: Option<SystemTime>,
    length: Option<u64>,
    #[cfg(unix)]
    identity: Option<(u64, u64)>,
}
impl Stamp {
    fn at(path: PathBuf) -> Self {
        let meta = std::fs::metadata(&path).ok();
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            path,
            modified: meta.as_ref().and_then(|m| m.modified().ok()),
            length: meta.as_ref().map(|m| m.len()),
            #[cfg(unix)]
            identity: meta.as_ref().map(|m| (m.dev(), m.ino())),
        }
    }
}
#[derive(PartialEq)]
struct Key {
    image: Image,
    metadata: Vec<Stamp>,
}
struct Pending {
    key: Key,
    answer: Receiver<Route>,
    stop: Stop,
}
struct Complete {
    key: Key,
    route: Route,
    due: Instant,
}

type HookRoutes = std::collections::BTreeMap<(u32, Vec<u8>), Route>;
pub(crate) struct Tracker {
    pending: Option<Pending>,
    complete: Option<Complete>,
    read_hooks: fn(&[crate::activity::Session]) -> HookRoutes,
}
impl Default for Tracker {
    fn default() -> Self {
        Self {
            pending: None,
            complete: None,
            read_hooks: |sessions| {
                crate::hook::Lifecycle::for_user().and_then(|service| service.routes(sessions)).unwrap_or_default()
            },
        }
    }
}
impl Drop for Tracker {
    fn drop(&mut self) {
        if let Some(p) = self.pending.take() {
            p.stop.request(How::Exit);
        }
    }
}
impl Tracker {
    #[cfg(all(test, unix))]
    pub(crate) fn fixture_probe(&mut self, program: &Path, work: &Path) -> Option<Route> {
        self.machine(Key { image: executable_image(program).unwrap(), metadata: Vec::new() }, program, work)
    }
    #[cfg(all(test, unix))]
    pub(crate) fn fixture_expire(&mut self) {
        self.complete.as_mut().unwrap().due = Instant::now();
    }
    pub fn look(
        &mut self,
        config: &Config,
        sessions: &mut [crate::activity::Session],
        home: &Path,
        work: &Path,
        running: &std::collections::BTreeMap<ClientId, PathBuf>,
    ) {
        for session in sessions.iter_mut() {
            session.route = None;
        }
        if !config.sessions()
            || !config.routes(ClientId::Claude)
            || !config.tracks(ClientId::Claude)
            || !sessions.iter().any(|s| s.client == ClientId::Claude)
        {
            if let Some(p) = self.pending.take() {
                p.stop.request(How::Exit);
            }
            self.complete = None;
            return;
        }
        let program = config
            .client_program(ClientId::Claude)
            .map(Path::to_owned)
            .or_else(|| ClientId::Claude.find(home))
            .or_else(|| running.get(&ClientId::Claude).cloned());
        let machine = program.map_or_else(
            || Some(claude_machine(None)),
            |program| {
                let Some(image) = executable_image(&program) else { return Some(claude_machine(None)) };
                // The environment is immutable for this tracker generation; a restarted
                // runner gets a fresh cache. Files contribute metadata only.
                let config_dir =
                    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
                let identity = if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() {
                    config_dir.join(".claude.json")
                } else {
                    home.join(".claude.json")
                };
                let key = Key {
                    image,
                    metadata: vec![
                        Stamp::at(identity),
                        Stamp::at(config_dir.join(".credentials.json")),
                        Stamp::at(config_dir.join("settings.json")),
                    ],
                };
                self.machine(key, &program, work)
            },
        );
        // No root lookup occurs for a disabled client or for an empty process set.
        let hooks = (self.read_hooks)(sessions);
        for session in sessions.iter_mut().filter(|s| s.client == ClientId::Claude) {
            session.route = session
                .native_birth
                .as_ref()
                .and_then(|birth| hooks.get(&(session.pid, birth.clone())))
                .cloned()
                .or_else(|| machine.clone());
        }
        // Codex 0.162.1 exposes no proven runtime/thread binding. Omission preserves
        // the released account fallback; global thread history cannot improve it.
    }
    fn machine(&mut self, key: Key, program: &Path, work: &Path) -> Option<Route> {
        if self.pending.as_ref().is_some_and(|pending| pending.key != key) {
            // At most one client runs. Cancellation is observed by its bounded reader;
            // discard its answer before starting another generation on the next look.
            let pending = self.pending.as_ref().unwrap();
            pending.stop.request(How::Exit);
            match pending.answer.try_recv() {
                Ok(_) | Err(mpsc::TryRecvError::Disconnected) => self.pending = None,
                Err(mpsc::TryRecvError::Empty) => (),
            }
            self.complete = None;
            return None;
        }
        if let Some(pending) = &self.pending {
            match pending.answer.try_recv() {
                Ok(route) => {
                    self.complete =
                        Some(Complete { key: self.pending.take().unwrap().key, route, due: Instant::now() + TTL });
                }
                Err(mpsc::TryRecvError::Empty) => return None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.complete = Some(Complete {
                        key: self.pending.take().unwrap().key,
                        route: claude_machine(None),
                        due: Instant::now() + TTL,
                    });
                }
            }
        }
        if let Some(complete) = &self.complete {
            if complete.key == key && Instant::now() < complete.due {
                return Some(complete.route.clone());
            }
        }
        self.complete = None;
        let program = program.to_owned();
        let work = work.to_owned();
        let stop = Stop::new();
        let worker_stop = stop.clone();
        let (sender, answer) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new().name("claude-route".into()).spawn(move || {
            let output = crate::process::Client::bounded_output(
                &program,
                &["auth", "status", "--json"],
                &[("DISABLE_AUTOUPDATER", "1"), ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")],
                &work,
                &worker_stop,
                64 * 1024,
            );
            let route = claude_machine(output.as_deref().ok());
            let _ = sender.send(route);
        });
        if worker.is_err() {
            let route = claude_machine(None);
            self.complete = Some(Complete { key, route: route.clone(), due: Instant::now() + TTL });
            return Some(route);
        }
        self.pending = Some(Pending { key, answer, stop });
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::route::{By, Class};
    use std::os::unix::fs::PermissionsExt;
    struct Fixture {
        root: PathBuf,
        program: PathBuf,
    }
    impl Fixture {
        fn new(command: &str) -> Self {
            let root = std::env::temp_dir().join(format!("quotum-route-probe-{}", crate::config::random_hex()));
            std::fs::create_dir(&root).unwrap();
            let program = root.join("claude-standin");
            std::fs::write(&program, format!("#!/bin/sh\n{command}\n")).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self { root, program }
        }
        fn key(&self) -> Key {
            Key {
                image: executable_image(&self.program).unwrap(),
                metadata: vec![Stamp::at(self.root.join("identity"))],
            }
        }
        fn look(&self, cache: &mut Tracker) -> Option<Route> {
            cache.machine(self.key(), &self.program, &self.root)
        }
        fn completed(&self, cache: &mut Tracker) -> Route {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                if let Some(route) = self.look(cache) {
                    return route;
                }
                assert!(Instant::now() < deadline, "probe never completed");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn real_bounded_probe_distinguishes_pending_refresh_and_terminal_failure() {
        let f = Fixture::new("printf '{\"authMethod\":\"claude.ai\",\"apiProvider\":\"firstParty\"}'");
        let mut cache = Tracker::default();
        assert_eq!(f.look(&mut cache), None, "cold acquisition is not unknown");
        let subscription = Route::new(Class::Subscription, By::Machine);
        assert_eq!(f.completed(&mut cache), subscription);
        assert_eq!(f.look(&mut cache), Some(subscription.clone()));
        cache.complete.as_mut().unwrap().due = Instant::now();
        assert_eq!(f.look(&mut cache), None, "TTL refresh is not unknown");
        assert_eq!(f.completed(&mut cache), subscription);
        std::fs::write(f.root.join("identity"), b"new generation metadata").unwrap();
        assert_eq!(f.look(&mut cache), None, "metadata invalidation is not unknown");
        assert_eq!(f.completed(&mut cache), subscription);
        for command in ["printf '{'", "exit 1", "head -c 65537 /dev/zero", "sleep 10"] {
            let f = Fixture::new(command);
            let mut cache = Tracker::default();
            assert_eq!(f.look(&mut cache), None);
            assert_eq!(f.completed(&mut cache), Route::new(Class::Unknown, By::Machine));
            assert!(cache.pending.is_none());
            assert_eq!(f.look(&mut cache).unwrap().class, Class::Unknown, "terminal failures are cached");
        }
    }
    #[test]
    fn a_late_completion_cannot_cross_executable_or_metadata_generations() {
        let f = Fixture::new(
            "answer=\"$(cat answer)\"; touch entered; while [ ! -f ready ]; do sleep 0.01; done; printf '%s' \"$answer\"",
        );
        std::fs::write(f.root.join("answer"), br#"{"authMethod":"api_key"}"#).unwrap();
        let mut cache = Tracker::default();
        assert!(f.look(&mut cache).is_none());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !f.root.join("entered").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::write(f.root.join("identity"), b"new identity").unwrap();
        std::fs::write(f.root.join("answer"), br#"{"authMethod":"claude.ai","apiProvider":"firstParty"}"#).unwrap();
        std::fs::write(f.root.join("ready"), b"ready").unwrap();
        assert_eq!(f.look(&mut cache), None, "a stale completion is discarded");
        assert_eq!(f.completed(&mut cache).class, Class::Subscription);
    }

    #[test]
    fn opt_out_and_absent_claude_start_no_probe_and_never_look_up_the_shared_root() {
        let f = Fixture::new("touch called");
        for mode in 0..4 {
            let mut config = Config::default();
            config.clients.insert(
                "claude".into(),
                crate::config::ClientSettings {
                    path: Some(f.program.clone()),
                    route: Some(mode != 1),
                    enabled: Some(mode != 2),
                },
            );
            if mode == 0 {
                config.sessions = Some(false);
            }
            let mut session = crate::activity::attribution::corrected_sessions()[0].clone();
            session.client = if mode == 3 { ClientId::Codex } else { ClientId::Claude };
            session.route = Some(Route::new(Class::Api, By::Session));
            let mut cache = Tracker {
                pending: None,
                complete: None,
                read_hooks: |_| panic!("opt-out must precede shared-root lookup"),
            };
            cache.look(&config, std::slice::from_mut(&mut session), &f.root, &f.root, &Default::default());
            assert!(session.route.is_none());
            assert!(cache.pending.is_none());
            assert!(!f.root.join("called").exists());
        }
    }
}
