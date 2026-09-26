//! Drives the adapters: once for a status check, or continuously on the schedule.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::activity::Activity;
use crate::config::{Config, Paths, home, jitter};
use crate::model::{Millis, Outcome, Provider, RunningSession, STALE_LIMIT_MS, now_ms};
use crate::providers::{Adapter, Context, adapter, find_client, last_activity};
use crate::schedule::Schedule;
use crate::sink::Sink;
use crate::stop::Stop;

/// A single measurement may take this long before the client is killed.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
/// The loop wakes at least this often, to notice a stop request or a jump of the clock.
const TICK: Duration = Duration::from_secs(1);
/// A wall clock set back by less than this is not worth correcting for.
const CLOCK_SLACK_MS: Millis = 2_000;

/// How often the agent looks at which coding agents run here, and how often it tells the
/// hub at least while any run (the hub keeps a list for five minutes).
const LOOK_EVERY: Duration = Duration::from_secs(15);
const REPORT_EVERY: Duration = Duration::from_secs(120);

/// Which coding agents run on this machine, told to the hub when that changes.
struct Watch {
    activity: Activity,
    looked: Option<Instant>,
    reported: Option<(Instant, Vec<RunningSession>)>,
}

impl Watch {
    /// Whether `now` is a new list to send: the first one, a change, or one repeated in time.
    fn worth_sending(&self, sessions: &[RunningSession]) -> bool {
        match &self.reported {
            None => true,
            Some((at, before)) => before != sessions || (!sessions.is_empty() && at.elapsed() >= REPORT_EVERY),
        }
    }
}

/// The wall clock as last seen, with the monotonic clock at that moment.
struct Clock {
    at: Instant,
    wall: Millis,
}

impl Clock {
    fn new(wall: Millis) -> Clock {
        Clock { at: Instant::now(), wall }
    }

    /// How far the wall clock went back since the last look, measured against the
    /// monotonic clock; 0 when it did not. A jump forward is left alone: after a
    /// sleep everything is overdue anyway.
    fn went_back(&mut self, wall: Millis) -> Millis {
        let back = self.at.elapsed().as_millis() as Millis - (wall - self.wall);
        *self = Clock::new(wall);
        if back > CLOCK_SLACK_MS { back } else { 0 }
    }
}

pub struct Runner {
    config: Config,
    paths: Paths,
    home: PathBuf,
    adapters: Vec<Box<dyn Adapter>>,
    /// Ends this run, a measurement under way included.
    stop: Stop,
}

impl Runner {
    /// Adapters for the enabled providers, cheapest first: Codex, Claude, Antigravity.
    pub fn new(config: Config, paths: Paths, only: &[Provider], stop: Stop) -> Runner {
        let order = [Provider::Codex, Provider::Claude, Provider::Antigravity];
        let adapters = order
            .into_iter()
            .filter(|p| config.enabled(*p) && (only.is_empty() || only.contains(p)))
            .map(adapter)
            .collect();
        Runner { config, paths, home: home(), adapters, stop }
    }

    pub fn providers(&self) -> Vec<Provider> {
        self.adapters.iter().map(|a| a.provider()).collect()
    }

    fn measure(&mut self, index: usize) -> Outcome {
        let adapter = &mut self.adapters[index];
        let provider = adapter.provider();
        let ctx = Context {
            home: &self.home,
            work_dir: &self.paths.work,
            state_dir: &self.paths.state,
            program: self.config.program(provider),
            timeout: CLIENT_TIMEOUT,
            stop: &self.stop,
        };
        let mut outcome = adapter.measure(&ctx);
        if let Ok(snapshot) = &mut outcome {
            if snapshot.account.is_none() {
                snapshot.account_name = self.config.account_name(provider).map(str::to_string);
            }
            snapshot.tidy();
        }
        outcome
    }

    /// Whether the provider's client is on this machine: a device checks in only for
    /// what it can measure, or it would keep duty from one that can.
    fn installed(&self, index: usize) -> bool {
        let adapter = &self.adapters[index];
        match self.config.program(adapter.provider()) {
            Some(path) => path.exists(),
            None => find_client(adapter.as_ref(), &self.home).is_some(),
        }
    }

    /// Measures every provider once, one after another, reporting each as it finishes.
    pub fn measure_all(&mut self, mut each: impl FnMut(&Outcome)) {
        for index in 0..self.adapters.len() {
            let mut outcome = self.measure(index);
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = self.config.interval_ms(snapshot.provider).min(STALE_LIMIT_MS);
            }
            each(&outcome);
        }
    }

    /// Measures on the schedule until its stop is requested or the hub refuses this device
    /// for good (then its reason is returned). Before each measurement the device checks
    /// in with the hub (when there is one): if another device measures the same
    /// subscription, this one only waits.
    pub fn run(&mut self, sink: &mut dyn Sink, mut each: impl FnMut(Event)) -> Option<String> {
        let intervals: Vec<u64> = self.adapters.iter().map(|a| self.config.interval_ms(a.provider())).collect();
        let mut schedule = Schedule::new(&intervals, now_ms(), self.config.eco());
        let activity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.activity_paths(&self.home)).collect();
        let identity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.identity_paths(&self.home)).collect();
        let mut seen: Vec<Option<SystemTime>> = vec![None; self.adapters.len()];
        // The account each provider last reported, and the state of its sign-in files then.
        let mut accounts: Vec<Option<(Option<String>, Option<SystemTime>)>> = vec![None; self.adapters.len()];
        let mut clock = Clock::new(now_ms());
        let mut watch = self.config.sessions().then(|| Watch {
            activity: Activity::new(self.home.clone(), self.config.projects()),
            looked: None,
            reported: None,
        });

        while !self.stop.requested() {
            if let Some(reason) = sink.refused() {
                return Some(reason.to_string());
            }
            // Only while the list can go somewhere: no looking for a hub that does not take it
            // (now: an older one is asked again later, and looking starts over then).
            if let Some(watch) = watch.as_mut().filter(|_| !sink.takes_sessions()) {
                watch.looked = None;
            }
            if let Some(watch) =
                watch.as_mut().filter(|w| sink.takes_sessions() && w.looked.is_none_or(|at| at.elapsed() >= LOOK_EVERY))
            {
                let first = watch.looked.is_none();
                watch.looked = Some(Instant::now());
                let seen = watch.activity.look();
                // The first look cannot tell working from idle: the list goes out from the second.
                if !first {
                    let sessions = self.running(seen, &accounts, &identity_paths);
                    // A list the hub did not take goes out again at the next look.
                    if watch.worth_sending(&sessions) && sink.sessions(&sessions) {
                        watch.reported = Some((Instant::now(), sessions));
                    }
                }
            }
            // A clock set back (by hand, or synced after a wrong start) would leave every
            // due time far ahead: move them back with it.
            let back = clock.went_back(now_ms());
            if back > 0 {
                schedule.shift(-back);
            }
            let (index, due) = schedule.next()?;
            let wait = due - now_ms();
            if wait > 0 {
                thread::sleep(Duration::from_millis(wait as u64).min(TICK));
                continue;
            }
            let adapter = &self.adapters[index];
            let provider = adapter.provider();
            let before = seen[index];
            let latest = last_activity(&activity_paths[index]);
            let active = before.is_some() && latest > before;
            seen[index] = latest.or(Some(SystemTime::UNIX_EPOCH));

            // Which subscription this is, if known without starting the client.
            let signed_in = last_activity(&identity_paths[index]);
            let account = if !self.installed(index) {
                // Measured right away: it fails without starting anything and is asked less often.
                None
            } else if !adapter.identifies_account() {
                Some(None)
            } else if let Some(local) = adapter.local_account(&self.home) {
                Some(Some(local))
            } else {
                accounts[index].clone().filter(|(_, at)| *at == signed_in).map(|(account, _)| account)
            };
            if let Some(account) = account {
                let name = self.config.account_name(provider);
                let waiting = sink.checkin(provider, account.as_deref(), name.filter(|_| account.is_none()), active);
                // Refused just now: measuring would only start a client for nothing.
                if let Some(reason) = sink.refused() {
                    return Some(reason.to_string());
                }
                if let Some(until) = waiting {
                    let next = schedule.postpone(index, now_ms(), until);
                    each(Event::Waiting(provider, next));
                    continue;
                }
            }

            // A run asked to stop starts no client, whatever it waited for until now.
            if self.stop.requested() {
                break;
            }
            let mut outcome = self.measure(index);
            if self.stop.requested() {
                break;
            }
            // Taken after the measurement, so the client's own writes do not count as use.
            seen[index] = last_activity(&activity_paths[index]).or(Some(SystemTime::UNIX_EPOCH));
            // As the sign-in files were before it: a sign-in during the measurement (or a token
            // it refreshed) leaves the account unknown until the next one, never another's.
            if let Ok(snapshot) = &outcome {
                accounts[index] = Some((snapshot.account.clone(), signed_in));
            }

            let now = now_ms();
            let next = schedule.complete(index, now, &outcome, active, jitter());
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = schedule.stale_after_ms(index, now);
            }
            sink.deliver(&outcome);
            each(Event::Measured(&outcome, next));
        }
        None
    }
}

impl Runner {
    /// The coding agents seen running, as the hub is told: of the providers measured here,
    /// each with its subscription as far as it is known, the project's name only if allowed.
    fn running(
        &self,
        seen: Vec<crate::activity::Session>,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> Vec<RunningSession> {
        let sessions = seen
            .into_iter()
            .filter_map(|session| {
                let index = self.adapters.iter().position(|a| a.provider() == session.provider)?;
                let adapter = &self.adapters[index];
                let (account, account_name) = if adapter.identifies_account() {
                    let signed_in = last_activity(&identity_paths[index]);
                    // Not known (signed in anew since measured): left out rather than filed
                    // under whatever the hub last saw from this machine.
                    (current_account(adapter.local_account(&self.home), &accounts[index], signed_in)?, None)
                } else {
                    (None, self.config.account_name(session.provider).map(str::to_string))
                };
                let (project, folder) = names(session.project, session.folder, self.config.projects());
                Some(RunningSession {
                    provider: session.provider,
                    account,
                    account_name,
                    origin: session.origin.id(),
                    project,
                    folder,
                    started_at: session.started_at,
                    last_worked_at: session.last_worked,
                    working: session.working == Some(true),
                })
            })
            .collect();
        capped(sessions)
    }
}

/// The names a session is reported with: none when project names are turned off; its
/// folder only where it is not its project. Each as long as a hub takes it (spec: text
/// fields); the hub would cut it too.
fn names(project: Option<String>, folder: Option<String>, allowed: bool) -> (Option<String>, Option<String>) {
    if !allowed {
        return (None, None);
    }
    let cut = |name: String| name.chars().take(120).collect::<String>();
    let (project, folder) = (project.map(cut), folder.map(cut));
    let folder = folder.filter(|folder| project.as_ref() != Some(folder));
    (project, folder)
}

/// A hub takes at most this many sessions of a machine at once (spec: Reporting running agents).
const MAX_SESSIONS: usize = 200;

/// A list the hub can take: working first, then those that worked most recently, then the newest.
fn capped(mut sessions: Vec<RunningSession>) -> Vec<RunningSession> {
    if sessions.len() > MAX_SESSIONS {
        sessions.sort_by_key(|s| {
            std::cmp::Reverse((s.working, if s.working { None } else { s.last_worked_at }, s.started_at))
        });
        sessions.truncate(MAX_SESSIONS);
    }
    sessions
}

/// The account the client is signed in to now: the one it names on this machine, else
/// the one it last reported while its sign-in files are as they were then; no account
/// (`Some(None)`) when it named none or has not been measured yet, and the hub takes the
/// one this machine last delivered. A sign-in since the measurement makes it unknown
/// (`None`) until measured again.
fn current_account(
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
) -> Option<Option<String>> {
    match (local, measured) {
        (Some(local), _) => Some(Some(local)),
        (None, None) => Some(None),
        (None, Some((account, at))) => (*at == signed_in).then(|| account.clone()),
    }
}

/// What happened to one scheduled slot.
pub enum Event<'a> {
    /// Measured (or failed); the next run is due at the given time.
    Measured(&'a Outcome, Millis),
    /// Another device measures this subscription; ask again at the given time.
    Waiting(Provider, Millis),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_list_keeps_the_working_sessions_and_then_the_newest() {
        let session = |working, started_at| RunningSession {
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at,
            last_worked_at: None,
            working,
        };
        let list: Vec<_> = (0..250).map(|i| session(i % 50 == 0, i)).collect();
        let mut recent = session(false, 1);
        recent.last_worked_at = Some(300);
        let mut older = session(false, 2);
        older.last_worked_at = Some(290);
        let kept = capped([list, vec![older, recent]].concat());
        assert_eq!(kept.len(), MAX_SESSIONS);
        assert_eq!(kept.iter().filter(|s| s.working).count(), 5, "every working one");
        assert_eq!(kept[0].started_at, 200, "newest working first");
        assert_eq!(kept[5].last_worked_at, Some(300), "recent work precedes newer sessions never seen working");
        assert_eq!(kept[6].last_worked_at, Some(290));
        assert_eq!(kept.last().map(|s| s.started_at), Some(54), "then the newest idle ones");
        assert_eq!(capped(vec![session(false, 1)]).len(), 1, "a short list as it is");
    }

    #[test]
    fn a_session_is_reported_with_its_folder_only_where_that_is_not_its_project() {
        let some = |name: &str| Some(name.to_string());
        assert_eq!(names(some("quotum"), some("hub"), false), (None, None), "turned off");
        assert_eq!(names(some("quotum"), some("quotum"), true), (some("quotum"), None));
        assert_eq!(names(some("quotum"), some("hub"), true), (some("quotum"), some("hub")));
        assert_eq!(names(None, some("scratch"), true), (None, some("scratch")), "a folder of no project");
        let long = "й".repeat(130);
        let cut = "й".repeat(120);
        assert_eq!(names(some(&long), some(&format!("{long}-feat")), true), (Some(cut), None), "alike once cut");
    }

    #[test]
    fn a_session_is_filed_under_the_account_signed_in_now() {
        let then = Some(SystemTime::UNIX_EPOCH);
        let later = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let measured = Some((Some("a".to_string()), then));
        assert_eq!(
            current_account(Some("b".into()), &measured, later),
            Some(Some("b".into())),
            "what the client names now"
        );
        assert_eq!(current_account(None, &measured, then), Some(Some("a".into())), "measured, and not signed in since");
        assert_eq!(current_account(None, &measured, later), None, "signed in again since: not known");
        assert_eq!(current_account(None, &None, later), Some(None), "not measured yet: the hub's guess");
        assert_eq!(current_account(None, &Some((None, then)), then), Some(None), "measured, and named no account");
    }

    #[test]
    fn a_list_of_running_agents_goes_out_first_on_change_and_then_in_time() {
        let session = |working| RunningSession {
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at: 0,
            last_worked_at: None,
            working,
        };
        let mut watch =
            Watch { activity: Activity::new(PathBuf::from("/nowhere"), true), looked: None, reported: None };
        assert!(watch.worth_sending(&[]), "the first, even empty: the hub may still hold an older one");
        watch.reported = Some((Instant::now(), vec![session(true)]));
        assert!(!watch.worth_sending(&[session(true)]));
        assert!(watch.worth_sending(&[session(false)]));
        assert!(watch.worth_sending(&[]), "none runs any more");
        let mut idle = session(false);
        idle.last_worked_at = Some(15_000);
        watch.reported = Some((Instant::now(), vec![idle.clone()]));
        assert!(!watch.worth_sending(&[idle.clone()]), "a remembered date stays equal on later idle looks");
        idle.last_worked_at = None;
        assert!(watch.worth_sending(&[idle.clone()]), "a clock correction can send one changed list");
        watch.reported = Some((Instant::now(), vec![idle.clone()]));
        assert!(!watch.worth_sending(&[idle]), "then idle dates stay unknown until new work");
        watch.reported = Some((Instant::now() - REPORT_EVERY, vec![session(true)]));
        assert!(watch.worth_sending(&[session(true)]), "in time, so the hub keeps it");
        watch.reported = Some((Instant::now() - REPORT_EVERY, vec![]));
        assert!(!watch.worth_sending(&[]), "an empty list said once is enough");
    }

    #[test]
    fn a_clock_set_back_is_noticed_and_a_jump_forward_is_not() {
        let start = 10 * 3_600_000;
        let mut clock = Clock::new(start);
        assert_eq!(clock.went_back(start + 5), 0);
        let back = clock.went_back(start - 3_600_000);
        assert!((3_600_000..3_601_000).contains(&back), "{back}");
        assert_eq!(clock.went_back(start + 3_600_000), 0);
    }

    /// A hub that refuses the device at its first check-in.
    #[derive(Default)]
    struct Refusing {
        delivered: usize,
        refused: Option<String>,
    }

    impl Sink for Refusing {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered += 1;
        }

        fn checkin(&mut self, _: Provider, _: Option<&str>, _: Option<&str>, _: bool) -> Option<Millis> {
            self.refused = Some("removed".into());
            None
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_device_refused_at_check_in_starts_no_client() {
        // Any file that exists stands for the client: it is never started.
        let client = std::env::current_exe().unwrap();
        let config: Config = toml::from_str(&format!("[providers.antigravity]\npath = {:?}", client)).unwrap();
        let state = std::env::temp_dir().join("quotum-runner-refused");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[Provider::Antigravity], Stop::new());
        let mut sink = Refusing::default();
        let mut events = 0;
        assert_eq!(runner.run(&mut sink, |_| events += 1).as_deref(), Some("removed"));
        assert_eq!((events, sink.delivered), (0, 0));
    }

    /// Counts check-ins; the first delivery ends the run.
    #[derive(Default)]
    struct Counting {
        checkins: usize,
        refused: Option<String>,
    }

    impl Sink for Counting {
        fn deliver(&mut self, _: &Outcome) {
            self.refused = Some("done".into());
        }

        fn checkin(&mut self, _: Provider, _: Option<&str>, _: Option<&str>, _: bool) -> Option<Millis> {
            self.checkins += 1;
            None
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_client_that_is_not_there_is_not_checked_in_for() {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join("quotum-runner-missing");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[Provider::Antigravity], Stop::new());
        let mut sink = Counting::default();
        assert_eq!(runner.run(&mut sink, |_| {}).as_deref(), Some("done"));
        assert_eq!(sink.checkins, 0, "no duty is claimed for a client this machine lacks");
    }

    /// Takes whatever it is given, and counts what it delivers.
    #[derive(Default)]
    struct Taking {
        delivered: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Sink for Taking {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A runner of one provider whose client is not there: it measures (and fails) at
    /// once, without starting anything, and then waits for the next time.
    fn missing_client(name: &str, stop: Stop) -> Runner {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join(name);
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        Runner::new(config, paths, &[Provider::Antigravity], stop)
    }

    #[test]
    fn a_stopped_run_ends_and_a_new_run_with_a_new_stop_measures_again() {
        for round in 0..2 {
            let stop = Stop::new();
            let mut runner = missing_client("quotum-runner-stop", stop.clone());
            let sink = Taking::default();
            let delivered = sink.delivered.clone();
            let (done, ended) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let mut sink = sink;
                let _ = done.send(runner.run(&mut sink, |_| {}));
            });
            let until = Instant::now() + Duration::from_secs(3);
            while delivered.load(std::sync::atomic::Ordering::SeqCst) == 0 && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 1, "round {round}: measured");
            stop.request(crate::stop::How::Exit);
            let result = ended.recv_timeout(Duration::from_secs(3));
            assert!(matches!(result, Ok(None)), "round {round}: the run ended on its stop");
        }
    }

    #[test]
    fn a_run_asked_to_stop_measures_nothing_more() {
        let stop = Stop::new();
        stop.request(crate::stop::How::Yield);
        let mut runner = missing_client("quotum-runner-stopped", stop);
        let mut sink = Taking::default();
        assert_eq!(runner.run(&mut sink, |_| {}), None);
        assert_eq!(sink.delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
