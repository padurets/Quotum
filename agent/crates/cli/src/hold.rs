//! `quotum run` and the machine: it measures while it holds it, and makes way for the
//! desktop app when asked (`yield` in the stop file): it lets the machine go at once, waits
//! until the app quits, then takes the machine back and measures again, with its settings
//! read afresh. Started while the app measures, it waits the same way. One agent at a time
//! waits; `quotum stop` stops it (see quotum_core::holder).

use std::thread;
use std::time::{Duration, Instant};

use quotum_core::config::Paths;
use quotum_core::holder::{Holder, LockError, RunInfo, RunLock, Running, WaitSlot};
use quotum_core::stop::{self, How, Stop};

/// How often the machine is looked at while waiting, and when first after making way.
pub struct Timing {
    /// The app takes the machine right after asking: not looked at before this.
    pub first_look: Duration,
    pub look: Duration,
    /// How soon a signal or a stop file is noticed.
    pub step: Duration,
}

impl Timing {
    pub const REAL: Timing =
        Timing { first_look: Duration::from_secs(5), look: Duration::from_secs(3), step: Duration::from_millis(200) };
}

/// Measuring, ready to start once the machine is held: `job` measures until the run's stop
/// is asked, and returns why the hub refused this device, if it did.
pub struct Prepared {
    pub job: Box<dyn FnOnce() -> Option<String> + Send>,
    /// Where it delivers, without the token (for `run.info`).
    pub hub: Option<String>,
}

fn another_run(paths: &Paths) -> String {
    format!(
        "another `quotum run` uses {} already; stop it first (`quotum stop`), or give this one its own QUOTUM_STATE_DIR",
        paths.state.display()
    )
}

const ANOTHER_WAITS: &str = "another `quotum run` waits for the Quotum app already; `quotum stop` stops it";

/// Measures on this machine until stopped, making way for the app whenever it asks.
/// `prepare` reads the settings and gets a run ready, each time the machine is taken.
pub fn run(
    paths: &Paths,
    timing: &Timing,
    log: &dyn Fn(&str),
    prepare: &mut dyn FnMut(&Stop) -> Result<Prepared, String>,
) -> Result<(), String> {
    let mut lock = match paths.lock_run(Holder::Cli) {
        Ok(lock) => lock,
        Err(LockError::Held(Running { app: true, .. })) => {
            let slot = paths.take_wait_slot().map_err(|_| ANOTHER_WAITS.to_string())?;
            match wait(paths, slot, Duration::ZERO, timing, log)? {
                Some(lock) => lock,
                None => return Ok(()),
            }
        }
        Err(LockError::Held(_)) => return Err(another_run(paths)),
        Err(LockError::Io(e)) => return Err(e),
    };
    loop {
        let stop = Stop::new();
        let prepared = prepare(&stop)?;
        let info = RunInfo { pid: std::process::id(), version: env!("CARGO_PKG_VERSION").into(), hub: prepared.hub };
        if let Err(e) = paths.write_run_info(&info) {
            log(&format!("warning: {}: {e}", paths.state.join("run.info").display()));
        }
        let measuring = thread::spawn(prepared.job);
        while !stop::relay(&stop, &paths.stop_file()) {
            if measuring.is_finished() {
                return match measuring.join() {
                    Ok(Some(reason)) => Err(format!("stopped: {reason}")),
                    Ok(None) => Ok(()),
                    Err(_) => Err("the agent stopped unexpectedly".into()),
                };
            }
            thread::sleep(timing.step);
        }
        if stop.how() == Some(How::Exit) {
            let _ = measuring.join();
            return Ok(());
        }
        // Making way: the place to wait in first, so the waiting agent is seen without a gap,
        // then the machine goes at once; the measurement under way ends by itself.
        let slot = match paths.take_wait_slot() {
            Ok(slot) => slot,
            Err(_) => {
                drop(lock);
                let _ = measuring.join();
                return Err(ANOTHER_WAITS.into());
            }
        };
        drop(lock);
        log("making way for the Quotum app, which measures this machine from now on");
        let _ = measuring.join();
        lock = match wait(paths, slot, timing.first_look, timing, log)? {
            Some(lock) => lock,
            None => return Ok(()),
        };
    }
}

/// Waits in `slot` until the app lets the machine go, then takes it (`None`: stopped
/// while waiting, by a signal or `quotum stop`).
fn wait(
    paths: &Paths,
    slot: WaitSlot,
    first: Duration,
    timing: &Timing,
    log: &dyn Fn(&str),
) -> Result<Option<RunLock>, String> {
    log("the Quotum app measures this machine; waiting until it quits");
    let mut look_at = Instant::now() + first;
    loop {
        if stop::signalled() || stop::take_stop_file(&paths.wait_stop_file()).is_some() {
            drop(slot);
            return Ok(None);
        }
        if Instant::now() >= look_at {
            match paths.lock_run(Holder::Cli) {
                Ok(lock) => {
                    drop(slot);
                    log("the Quotum app quit; measuring again");
                    return Ok(Some(lock));
                }
                Err(LockError::Held(Running { app: true, .. })) => look_at = Instant::now() + timing.look,
                Err(LockError::Held(_)) => return Err(another_run(paths)),
                Err(LockError::Io(e)) => return Err(e),
            }
        }
        thread::sleep(timing.step);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quotum_core::config::Config;
    use quotum_core::holder::{Stopped, Waits};
    use quotum_core::model::Provider;
    use quotum_core::runner::Runner;
    use quotum_core::sink::Discard;
    use std::fs;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    const QUICK: Timing = Timing {
        first_look: Duration::from_millis(100),
        look: Duration::from_millis(50),
        step: Duration::from_millis(20),
    };
    const WAITS: Waits = Waits {
        exit: Duration::from_secs(3),
        yielding: Duration::from_secs(3),
        after_kill: Duration::from_millis(100),
        step: Duration::from_millis(20),
    };

    fn state(name: &str) -> Paths {
        let state = std::env::temp_dir().join(format!("quotum-hold-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&state);
        fs::create_dir_all(&state).unwrap();
        Paths { config: state.join("config.toml"), work: state.join("work"), state }
    }

    /// How a `quotum run` of a test ended, the settings of each preparation, its log.
    type Started = (mpsc::Receiver<Result<(), String>>, mpsc::Receiver<Config>, Arc<Mutex<Vec<String>>>);

    /// `quotum run` in a thread: it measures with a client that is not there (nothing is
    /// started), and tells each preparation, with the settings it read, to the test.
    fn start(paths: &Paths) -> Started {
        let (done, ended) = mpsc::channel();
        let (read, prepared) = mpsc::channel();
        let logged = Arc::new(Mutex::new(Vec::new()));
        let (paths, lines) = (paths.clone(), logged.clone());
        thread::spawn(move || {
            let log = |line: &str| lines.lock().unwrap().push(line.to_string());
            let mut prepare = |stop: &Stop| {
                let config = Config::load(&paths.config)?;
                let _ = read.send(config.clone());
                let mut runner = Runner::new(config, paths.clone(), &[Provider::Antigravity], stop.clone());
                Ok(Prepared { job: Box::new(move || runner.run(&mut Discard, |_| {})), hub: None })
            };
            let _ = done.send(run(&paths, &QUICK, &log, &mut prepare));
        });
        (ended, prepared, logged)
    }

    fn client_missing(paths: &Paths, interval: u64) {
        fs::write(
            &paths.config,
            format!("interval = {interval}\n[providers.antigravity]\npath = \"/nonexistent/agy\"\n"),
        )
        .unwrap();
    }

    fn eventually(what: &str, done: impl Fn() -> bool) {
        let until = Instant::now() + Duration::from_secs(3);
        while !done() {
            assert!(Instant::now() < until, "{what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn asked_to_make_way_it_lets_go_at_once_waits_and_measures_again_with_new_settings() {
        let paths = state("yield");
        client_missing(&paths, 120);
        let (ended, prepared, logged) = start(&paths);
        assert_eq!(prepared.recv_timeout(Duration::from_secs(3)).unwrap().interval, Some(120));
        eventually("it holds the machine", || paths.run_info().is_some());
        let me = std::process::id();
        assert_eq!(paths.run_info().unwrap().pid, me, "and says it can make way");

        // The app asks and takes the machine: the agent went to wait first, and let go at once.
        let asked = paths.stop_running_with(How::Yield, &WAITS, &|_| panic!("no kill"));
        assert_eq!(asked, Ok(Stopped::Asked(Some(me))));
        assert_eq!(paths.waiting(), Some(Some(me)), "waiting before the machine was free");
        let app = paths.lock_run(Holder::App).unwrap();
        client_missing(&paths, 300);
        thread::sleep(Duration::from_millis(200));
        assert!(ended.try_recv().is_err(), "it waits while the app measures");

        drop(app);
        assert_eq!(prepared.recv_timeout(Duration::from_secs(3)).unwrap().interval, Some(300), "settings read afresh");
        eventually("it holds the machine again", || paths.running() == Some(Running { pid: Some(me), app: false }));
        assert_eq!(paths.waiting(), None, "and no longer waits");
        assert_eq!(paths.stop_running_with(How::Exit, &WAITS, &|_| panic!("no kill")), Ok(Stopped::Asked(Some(me))));
        assert_eq!(ended.recv_timeout(Duration::from_secs(3)), Ok(Ok(())));
        let log = logged.lock().unwrap().join("\n");
        assert!(log.contains("making way") && log.contains("measuring again"), "{log}");
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn started_while_the_app_measures_it_waits_and_quotum_stop_ends_the_wait() {
        let paths = state("wait");
        client_missing(&paths, 120);
        let app = paths.lock_run(Holder::App).unwrap();
        let (ended, _, _) = start(&paths);
        eventually("it waits", || paths.waiting().is_some());

        // A second one does not wait too.
        let (second, _, _) = start(&paths);
        assert_eq!(second.recv_timeout(Duration::from_secs(3)), Ok(Err(ANOTHER_WAITS.into())));

        assert_eq!(
            paths.stop_waiting_with(&WAITS, &|_| panic!("no kill")),
            Ok(Stopped::Asked(Some(std::process::id())))
        );
        assert_eq!(ended.recv_timeout(Duration::from_secs(3)), Ok(Ok(())));
        drop(app);
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn a_machine_another_quotum_run_holds_is_refused_not_waited_for() {
        let paths = state("another");
        client_missing(&paths, 120);
        let other = paths.lock_run(Holder::Cli).unwrap();
        let (ended, _, _) = start(&paths);
        let refused = ended.recv_timeout(Duration::from_secs(3)).unwrap().unwrap_err();
        assert!(refused.contains("another `quotum run` uses"), "{refused}");
        drop(other);
        fs::remove_dir_all(&paths.state).unwrap();
    }

    #[test]
    fn a_stop_left_for_an_earlier_waiter_does_not_end_a_new_one() {
        let paths = state("stale");
        client_missing(&paths, 120);
        fs::write(paths.wait_stop_file(), "").unwrap();
        let app = paths.lock_run(Holder::App).unwrap();
        let (ended, _, _) = start(&paths);
        eventually("it waits", || paths.waiting().is_some());
        thread::sleep(Duration::from_millis(100));
        assert!(ended.try_recv().is_err(), "still waiting");
        drop(app);
        eventually("it measures", || paths.run_info().is_some());
        let _ = paths.stop_running_with(How::Exit, &WAITS, &|_| {});
        assert_eq!(ended.recv_timeout(Duration::from_secs(3)), Ok(Ok(())));
        fs::remove_dir_all(&paths.state).unwrap();
    }
}
